import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { buildSnapshot, SnapshotError, type SnapshotInfo } from "./export.ts";
import type { Snapshot } from "./types.ts";

export interface AnalyzerOptions {
  dir: string;
  name: string;
  distDir?: string;
  appDirOnly?: boolean;
  noMangling?: boolean;
  prepare?: string;
}

export interface AnalyzerResult {
  snapshot: Snapshot;
  analyzeDir: string;
}

export interface AnalyzerMetadata {
  nextVersion: string;
  appDirOnly: boolean;
  noMangling: boolean;
  createdAt: string;
}

export function resolveNext(dir: string): string {
  const require = createRequire(join(resolve(dir), "package.json"));
  let pkg: string;
  try {
    pkg = require.resolve("next/package.json");
  } catch {
    throw new Error(`Next.js is not installed in ${resolve(dir)} (cannot resolve next/package.json); install dependencies first`);
  }
  const bin = join(dirname(pkg), "dist", "bin", "next");
  if (!existsSync(bin)) throw new Error(`Next.js binary not found at ${bin}`);
  return bin;
}

export function analyzeArgs(next: string, opts: Pick<AnalyzerOptions, "name" | "appDirOnly" | "noMangling">): string[] {
  const args = [next, "analyze", "-o", "--snapshot", opts.name];
  if (opts.appDirOnly) args.push("--experimental-app-only");
  if (opts.noMangling) args.push("--no-mangling");
  return args;
}

export function exportArgs(next: string, opts: Pick<AnalyzerOptions, "name" | "distDir">): string[] {
  const args = [next, "analyze", "export", "--snapshot", opts.name];
  if (opts.distDir !== undefined) args.push("--dist-dir", opts.distDir);
  return args;
}

export function analyzeDirOf(dir: string, distDir?: string): string {
  return resolve(dir, distDir ?? ".next", "diagnostics", "analyze");
}

export function metadataPath(analyzeDir: string, name: string): string {
  return join(analyzeDir, "history", `snapshot-${encodeURIComponent(name)}`, "metadata.json");
}

export function parseMetadata(text: string, path: string): AnalyzerMetadata {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SnapshotError(`${path}: not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SnapshotError(`${path}: not an object`);
  }
  const v = value as Record<string, unknown>;
  const str = (key: string): string => {
    if (typeof v[key] !== "string" || v[key] === "") throw new SnapshotError(`${path}: "${key}" is not a string`);
    return v[key];
  };
  const bool = (key: string): boolean => {
    if (typeof v[key] !== "boolean") throw new SnapshotError(`${path}: "${key}" is not a boolean`);
    return v[key];
  };
  return {
    nextVersion: str("nextVersion"),
    appDirOnly: bool("appDirOnly"),
    noMangling: bool("noMangling"),
    createdAt: str("createdAt"),
  };
}

export function git(dir: string, args: string[]): string | undefined {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error !== undefined || r.status !== 0) return undefined;
  return r.stdout.trim();
}

function runForwarded(command: string, args: string[], cwd: string, what: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(process.stderr, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.on("error", (e) => fail(new Error(`${what}: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) done();
      else fail(new Error(`${what} failed (${signal ? `signal ${signal}` : `exit code ${code}`})`));
    });
  });
}

function exportSnapshot(next: string, opts: AnalyzerOptions, dir: string, info: SnapshotInfo): Promise<Snapshot> {
  const child = spawn(process.execPath, exportArgs(next, opts), { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    if (stderr.length < 64 * 1024) stderr += d;
  });
  const exited = new Promise<void>((done, fail) => {
    child.on("error", (e) => fail(new Error(`next analyze export: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) done();
      else {
        const why = signal ? `signal ${signal}` : `exit code ${code}`;
        fail(new Error(`next analyze export failed (${why})${stderr.trim() ? `:\n${stderr.trim()}` : ""}`));
      }
    });
  });
  exited.catch(() => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return buildSnapshot(lines, info).then(
    async (snapshot) => {
      await exited;
      return snapshot;
    },
    async (e: unknown) => {
      child.stdout.resume();
      await exited;
      throw e;
    },
  );
}

export async function runAnalyzer(opts: AnalyzerOptions): Promise<AnalyzerResult> {
  const dir = resolve(opts.dir);
  const next = resolveNext(dir);

  if (opts.prepare) await runForwarded("sh", ["-c", opts.prepare], dir, `prepare command "${opts.prepare}"`);
  await runForwarded(process.execPath, analyzeArgs(next, opts), dir, "next analyze");

  const analyzeDir = analyzeDirOf(dir, opts.distDir);
  const metaFile = metadataPath(analyzeDir, opts.name);
  let text: string;
  try {
    text = await readFile(metaFile, "utf8");
  } catch {
    throw new SnapshotError(
      `${metaFile} not found after next analyze${opts.distDir ? "" : " (custom distDir? pass --dist-dir)"}`,
    );
  }
  const meta = parseMetadata(text, metaFile);

  const info: SnapshotInfo = { snapshotName: opts.name, ...meta, appDirPrefix: git(dir, ["rev-parse", "--show-prefix"]) ?? "" };
  const commit = git(dir, ["rev-parse", "HEAD"]);
  if (commit) info.commit = commit;

  const snapshot = await exportSnapshot(next, opts, dir, info);
  return { snapshot, analyzeDir };
}
