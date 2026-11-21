import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  analyzeArgs,
  analyzeDirOf,
  exportArgs,
  git,
  metadataPath,
  parseMetadata,
  resolveNext,
  runAnalyzer,
} from "../../src/analyzer.ts";
import { SnapshotError } from "../../src/export.ts";

const fixture = fileURLToPath(new URL("../fixtures/export-edge.jsonl", import.meta.url));

/**
 * A stand-in for `next/dist/bin/next`: `analyze -o --snapshot <n>` writes metadata.json,
 * `analyze export` prints a fixture (or fails when FAKE_EXPORT_FAIL is set).
 */
const FAKE_NEXT = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync("calls.log", JSON.stringify(args) + "\\n");
const name = args[args.indexOf("--snapshot") + 1];
if (args[1] === "export") {
  if (process.env.FAKE_EXPORT_FAIL) { console.error("no snapshot named " + name); process.exit(3); }
  process.stdout.write(fs.readFileSync(${JSON.stringify(fixture)}));
} else {
  console.log("analyzing...");
  if (process.env.FAKE_ANALYZE_FAIL) process.exit(1);
  const dir = path.join(".next", "diagnostics", "analyze", "history", "snapshot-" + encodeURIComponent(name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({
    name, createdAt: "2026-11-21T01:02:03.000Z", nextVersion: "16.4.6",
    appDirOnly: args.includes("--experimental-app-only"), noMangling: args.includes("--no-mangling"), routeCount: 2,
  }));
}
`;

let app: string;

before(async () => {
  app = await mkdtemp(join(tmpdir(), "bundle-gate-analyzer-"));
  const bin = join(app, "node_modules", "next", "dist", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(app, "node_modules", "next", "package.json"), JSON.stringify({ name: "next", version: "16.4.6" }));
  await writeFile(join(bin, "next"), FAKE_NEXT);
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "app", type: "commonjs" }));
});

after(async () => {
  await rm(app, { recursive: true, force: true });
});

test("argument construction", () => {
  assert.deepEqual(analyzeArgs("/n", { name: "base" }), ["/n", "analyze", "-o", "--snapshot", "base"]);
  assert.deepEqual(analyzeArgs("/n", { name: "head", appDirOnly: true, noMangling: true }), [
    "/n",
    "analyze",
    "-o",
    "--snapshot",
    "head",
    "--experimental-app-only",
    "--no-mangling",
  ]);
  assert.deepEqual(exportArgs("/n", { name: "head" }), ["/n", "analyze", "export", "--snapshot", "head"]);
  assert.deepEqual(exportArgs("/n", { name: "head", distDir: "build" }), [
    "/n",
    "analyze",
    "export",
    "--snapshot",
    "head",
    "--dist-dir",
    "build",
  ]);
  assert.equal(analyzeDirOf("/app", "build"), "/app/build/diagnostics/analyze");
  assert.equal(metadataPath("/a", "pr 1/x"), "/a/history/snapshot-pr%201%2Fx/metadata.json");
});

test("parseMetadata", () => {
  const ok = { name: "b", createdAt: "t", nextVersion: "16.4.6", appDirOnly: false, noMangling: true, routeCount: 1 };
  assert.deepEqual(parseMetadata(JSON.stringify(ok), "m.json"), {
    nextVersion: "16.4.6",
    appDirOnly: false,
    noMangling: true,
    createdAt: "t",
  });
  assert.throws(() => parseMetadata("{", "m.json"), /m\.json: not valid JSON/);
  assert.throws(() => parseMetadata("[]", "m.json"), SnapshotError);
  assert.throws(() => parseMetadata(JSON.stringify({ ...ok, appDirOnly: "no" }), "m.json"), /"appDirOnly" is not a boolean/);
  assert.throws(() => parseMetadata(JSON.stringify({ ...ok, nextVersion: 16 }), "m.json"), /"nextVersion"/);
});

test("resolveNext finds the installed binary or explains", async () => {
  assert.equal(resolveNext(app), join(app, "node_modules", "next", "dist", "bin", "next"));
  const empty = await mkdtemp(join(tmpdir(), "bundle-gate-nonext-"));
  try {
    assert.throws(() => resolveNext(empty), /Next\.js is not installed in/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("git returns undefined outside a repository", () => {
  assert.equal(git(tmpdir(), ["rev-parse", "--show-prefix"]), undefined);
});

test("runAnalyzer with a fake next binary", async () => {
  const { snapshot, analyzeDir } = await runAnalyzer({
    dir: app,
    name: "head",
    noMangling: true,
    prepare: "echo prepared > prepared.txt",
  });
  assert.equal(analyzeDir, join(app, ".next", "diagnostics", "analyze"));
  assert.equal(snapshot.meta.snapshotName, "head");
  assert.equal(snapshot.meta.nextVersion, "16.4.6");
  assert.equal(snapshot.meta.noMangling, true);
  assert.equal(snapshot.meta.appDirOnly, false);
  assert.equal(snapshot.meta.createdAt, "2026-11-21T01:02:03.000Z");
  assert.deepEqual(Object.keys(snapshot.routes).sort(), ["/docs", "/docs/guide"]);
  assert.equal(await readFile(join(app, "prepared.txt"), "utf8"), "prepared\n");
  const calls = (await readFile(join(app, "calls.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls, [
    ["analyze", "-o", "--snapshot", "head", "--no-mangling"],
    ["analyze", "export", "--snapshot", "head"],
  ]);
});

test("runAnalyzer reports analyzer and export failures", async () => {
  process.env.FAKE_ANALYZE_FAIL = "1";
  try {
    await assert.rejects(runAnalyzer({ dir: app, name: "x" }), /next analyze failed \(exit code 1\)/);
  } finally {
    delete process.env.FAKE_ANALYZE_FAIL;
  }
  process.env.FAKE_EXPORT_FAIL = "1";
  try {
    await assert.rejects(
      runAnalyzer({ dir: app, name: "y" }),
      /next analyze export failed \(exit code 3\):\nno snapshot named y/,
    );
  } finally {
    delete process.env.FAKE_EXPORT_FAIL;
  }
  await assert.rejects(runAnalyzer({ dir: app, name: "z", distDir: "elsewhere" }), /elsewhere.*metadata\.json not found/);
});
