import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { SnapshotError } from "./export.ts";
import type { RouteChunks, Size, Snapshot } from "./types.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface RouteSize {
  eager: Size;
  async: Size;
  other: Size;
}

export interface ModuleDelta {
  source: string;
  raw: number;
  gz: number;
  baseGz: number;
  headGz: number;
}

function routeChunks(s: Snapshot, route: string): RouteChunks {
  const chunks = Object.hasOwn(s.routes, route) ? s.routes[route] : undefined;
  if (chunks === undefined) throw new SnapshotError(`route ${route} is not in snapshot ${s.meta.snapshotName}`);
  return chunks;
}

function chunkParts(s: Snapshot, file: string) {
  const parts = Object.hasOwn(s.chunks, file) ? s.chunks[file] : undefined;
  if (parts === undefined) throw new SnapshotError(`chunk ${file} is not in snapshot ${s.meta.snapshotName}`);
  return parts;
}

function sumChunks(s: Snapshot, files: string[]): Size {
  const size: Size = { raw: 0, gz: 0 };
  for (const file of files) {
    for (const [, raw, gz] of chunkParts(s, file)) {
      size.raw += raw;
      size.gz += gz;
    }
  }
  return size;
}

export function routeSize(s: Snapshot, route: string): RouteSize {
  const chunks = routeChunks(s, route);
  return {
    eager: sumChunks(s, chunks.eager),
    async: sumChunks(s, chunks.async),
    other: sumChunks(s, chunks.other),
  };
}

export function routeModules(s: Snapshot, route: string, set: "eager" | "async"): Map<string, Size> {
  const modules = new Map<string, Size>();
  for (const file of routeChunks(s, route)[set]) {
    for (const [idx, raw, gz] of chunkParts(s, file)) {
      const source = s.sources[idx];
      if (source === undefined) throw new SnapshotError(`chunk ${file} references unknown source ${idx}`);
      const size = modules.get(source);
      if (size === undefined) modules.set(source, { raw, gz });
      else {
        size.raw += raw;
        size.gz += gz;
      }
    }
  }
  return modules;
}

export function diffModules(base: Map<string, Size>, head: Map<string, Size>): ModuleDelta[] {
  const zero: Size = { raw: 0, gz: 0 };
  const deltas: ModuleDelta[] = [];
  for (const source of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(source) ?? zero;
    const h = head.get(source) ?? zero;
    const raw = h.raw - b.raw;
    const gz = h.gz - b.gz;
    if (raw === 0 && gz === 0) continue;
    deltas.push({ source, raw, gz, baseGz: b.gz, headGz: h.gz });
  }
  return deltas.sort(
    (x, y) =>
      Math.abs(y.gz) - Math.abs(x.gz) ||
      Math.abs(y.raw) - Math.abs(x.raw) ||
      (x.source < y.source ? -1 : x.source > y.source ? 1 : 0),
  );
}

export async function writeSnapshot(path: string, s: Snapshot): Promise<void> {
  const json = JSON.stringify(s);
  await writeFile(path, path.endsWith(".gz") ? await gzipAsync(json) : json);
}

export async function readSnapshot(path: string): Promise<Snapshot> {
  let data = await readFile(path);
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = await gunzipAsync(data);
    } catch {
      throw new SnapshotError(`${path}: corrupt gzip data`);
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(data.toString("utf8"));
  } catch {
    throw new SnapshotError(`${path}: not valid JSON`);
  }
  validateSnapshot(value, path);
  return value;
}

function validateSnapshot(value: unknown, path: string): asserts value is Snapshot {
  const fail = (what: string): never => {
    throw new SnapshotError(`${path}: not a bundle-gate snapshot (${what})`);
  };
  if (!isObject(value)) fail("not an object");
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) {
    throw new SnapshotError(
      `${path}: unsupported snapshot schemaVersion ${JSON.stringify(v.schemaVersion)}, expected 1`,
    );
  }

  const meta = v.meta;
  if (!isObject(meta)) fail("meta is missing");
  const m = meta as Record<string, unknown>;
  for (const key of ["nextVersion", "snapshotName", "createdAt"]) {
    if (typeof m[key] !== "string") fail(`meta.${key} is not a string`);
  }
  for (const key of ["appDirOnly", "noMangling"]) {
    if (typeof m[key] !== "boolean") fail(`meta.${key} is not a boolean`);
  }
  if (typeof m.analyzerSchemaVersion !== "number") fail("meta.analyzerSchemaVersion is not a number");
  if (m.commit !== undefined && typeof m.commit !== "string") fail("meta.commit is not a string");

  const sources = v.sources;
  if (!Array.isArray(sources) || !sources.every((x) => typeof x === "string")) {
    fail("sources is not a list of strings");
  }
  const sourceCount = (sources as string[]).length;

  if (!isObject(v.chunks)) fail("chunks is missing");
  for (const [file, parts] of Object.entries(v.chunks as Record<string, unknown>)) {
    if (!Array.isArray(parts)) fail(`chunk ${file} is not a list`);
    for (const part of parts as unknown[]) {
      if (
        !Array.isArray(part) ||
        part.length !== 3 ||
        !part.every((n) => Number.isSafeInteger(n) && n >= 0) ||
        part[0] >= sourceCount
      ) {
        fail(`chunk ${file} has an invalid part`);
      }
    }
  }

  if (!isObject(v.routes)) fail("routes is missing");
  const chunks = v.chunks as Record<string, unknown>;
  for (const [route, lists] of Object.entries(v.routes as Record<string, unknown>)) {
    if (!isObject(lists)) fail(`route ${route} is not an object`);
    for (const key of ["eager", "async", "other"]) {
      const files = (lists as Record<string, unknown>)[key];
      if (!Array.isArray(files)) fail(`route ${route} ${key} is not a list`);
      for (const file of files as unknown[]) {
        if (typeof file !== "string" || !Object.hasOwn(chunks, file)) {
          fail(`route ${route} ${key} lists unknown chunk ${String(file)}`);
        }
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
