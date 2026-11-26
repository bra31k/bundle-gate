import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { buildSnapshot, type SnapshotInfo } from "../../src/export.ts";
import { writeSnapshot } from "../../src/snapshot.ts";
import type { Snapshot } from "../../src/types.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

const info = (snapshotName: string, nextVersion = "16.4.6"): SnapshotInfo => ({
  snapshotName,
  nextVersion,
  appDirOnly: false,
  noMangling: false,
  createdAt: "2026-11-21T00:00:00.000Z",
});

function fixtureLines(name: string): AsyncIterable<string> {
  const input = createReadStream(new URL(`../fixtures/${name}`, import.meta.url));
  return createInterface({ input, crlfDelay: Infinity });
}

let dir: string;

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", BUNDLE_GATE_DEBUG: "", ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "bundle-gate-cli-"));
  await writeSnapshot(join(dir, "base.json.gz"), await buildSnapshot(fixtureLines("export-base.jsonl"), info("base")));
  await writeSnapshot(join(dir, "head.json.gz"), await buildSnapshot(fixtureLines("export-head.jsonl"), info("head")));
  await writeSnapshot(
    join(dir, "next17.json"),
    await buildSnapshot(fixtureLines("export-head.jsonl"), info("head", "17.0.0")),
  );
  const handler: Snapshot = {
    schemaVersion: 1,
    meta: { ...info("handler"), analyzerSchemaVersion: 1 },
    sources: ["app/page.js"],
    chunks: { "page.js": [[0, 3000, 1000]] },
    routes: {
      "/": { eager: ["page.js"], async: [], other: [] },
      "/api/health": { eager: [], async: [], other: [] },
    },
  };
  await writeSnapshot(join(dir, "handler.json.gz"), handler);
  await writeFile(join(dir, "ignore.json"), JSON.stringify({ rules: [{ match: "/about", limit: "ignore" }] }));
  await writeFile(join(dir, "bad.json"), JSON.stringify({ rules: [{ match: "/", limit: "+30" }] }));
  await writeFile(join(dir, "lint.json"), JSON.stringify({ rules: [{ match: "/nothing", limit: "+1 KB" }] }));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("help and usage errors", () => {
  for (const args of [[], ["--help"], ["diff", "--help"]]) {
    const r = run(args);
    assert.equal(r.code, 0, args.join(" "));
    assert.match(r.stdout, /Usage:\n {2}bundle-gate snapshot/);
  }
  const unknown = run(["report"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command "report"/);
  const flag = run(["diff", "base.json.gz", "head.json.gz", "--bogus"]);
  assert.equal(flag.code, 2);
  assert.match(flag.stderr, /--bogus/);
  assert.equal(run(["diff", "base.json.gz"]).code, 2);
  assert.equal(run(["diff", "base.json.gz", "head.json.gz", "--format", "html"]).code, 2);
  assert.equal(run(["diff", "base.json.gz", "head.json.gz", "--min-change", "100"]).code, 2);
  const level = run(["diff", "base.json.gz", "head.json.gz", "--annotations", "notice"]);
  assert.equal(level.code, 2);
  assert.match(level.stderr, /--annotations must be error, warning or off, got "notice"/);
});

test("breach exits 1 and prints the text report", () => {
  const r = run(["diff", "base.json.gz", "head.json.gz"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^✗ \/about /m);
  assert.match(r.stdout, /^✗ \/about .* {2}limit \+2%$/m);
  assert.equal(r.stderr, "");
});

test("--no-fail exits 0, an ignore rule passes", () => {
  assert.equal(run(["diff", "base.json.gz", "head.json.gz", "--no-fail"]).code, 0);
  const r = run(["diff", "base.json.gz", "head.json.gz", "--config", "ignore.json"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^✓ bundle-gate: all routes within limits$/m);
});

test("the default config file is picked up from the working directory", async () => {
  await writeFile(join(dir, "bundle-gate.config.json"), await readFile(join(dir, "ignore.json")));
  try {
    assert.equal(run(["diff", "base.json.gz", "head.json.gz"]).code, 0);
  } finally {
    await rm(join(dir, "bundle-gate.config.json"));
  }
});

test("--format json to stdout, --output writes the file and prints text", async () => {
  const r = run(["diff", "base.json.gz", "head.json.gz", "--format", "json", "--top", "1"]);
  assert.equal(r.code, 1);
  const json = JSON.parse(r.stdout);
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.totals.failed, 1);
  assert.equal(json.routes.find((x: { route: string }) => x.route === "/about").modules.length, 1);

  const o = run(["diff", "base.json.gz", "head.json.gz", "--format", "markdown", "--output", "out.md"]);
  assert.equal(o.code, 1);
  assert.match(o.stdout, /^✗ bundle-gate: 1 route over the limit\n {2}Next 16\.4\.6/);
  assert.match(await readFile(join(dir, "out.md"), "utf8"), /^### ❌ bundle-gate: 1 route over the limit/);
});

test("--json writes the JSON result next to the markdown file", async () => {
  const r = run(["diff", "base.json.gz", "head.json.gz", "--format", "markdown", "--output", "out.md", "--json", "out.json"]);
  assert.equal(r.code, 1);
  const json = run(["diff", "base.json.gz", "head.json.gz", "--format", "json"]).stdout;
  assert.equal(await readFile(join(dir, "out.json"), "utf8"), json);
  assert.match(await readFile(join(dir, "out.md"), "utf8"), /^### ❌ bundle-gate/);
});

test("text in a file or a pipe has no color codes", async () => {
  const r = run(["diff", "base.json.gz", "head.json.gz", "--output", "out.txt"], { FORCE_COLOR: "1" });
  assert.equal(r.code, 1);
  assert.ok(!r.stdout.includes("\u001b["));
  const file = await readFile(join(dir, "out.txt"), "utf8");
  assert.ok(!file.includes("\u001b["));
  assert.equal(file, r.stdout);
});

test("errors exit 2 without a stack trace", () => {
  const missing = run(["diff", "nope.json.gz", "head.json.gz"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /^bundle-gate: .*nope\.json\.gz/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);
  assert.equal(run(["diff", "nope.json.gz", "head.json.gz", "--no-fail"]).code, 2);

  const bad = run(["diff", "base.json.gz", "head.json.gz", "--config", "bad.json"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /config bad\.json: rules\[0\]\.limit: .*missing unit/);
  assert.equal(run(["diff", "base.json.gz", "head.json.gz", "--config", "none.json"]).code, 2);

  const debug = run(["diff", "nope.json.gz", "head.json.gz"], { BUNDLE_GATE_DEBUG: "1" });
  assert.match(debug.stderr, /\n\s+at /);
});

test("skipped comparison exits 0 with a warning", () => {
  const r = run(["diff", "base.json.gz", "next17.json"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /skipped the comparison: Next versions differ/);
  assert.match(r.stderr, /^warning: comparison skipped: Next versions differ/m);
  const gh = run(["diff", "base.json.gz", "next17.json"], { GITHUB_ACTIONS: "true" });
  assert.match(gh.stderr, /^::warning::comparison skipped: Next versions differ/m);
});

test("GitHub annotations and lint warnings", () => {
  const r = run(["diff", "base.json.gz", "head.json.gz", "--config", "lint.json"], { GITHUB_ACTIONS: "true" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^warning: rules\[0\] pattern "\/nothing": matches no route$/m);
  assert.match(r.stderr, /^::warning::rules\[0\] pattern "\/nothing": matches no route$/m);
  assert.match(r.stderr, /^::error::bundle-gate: \/about is over its limit: grew \+24\.49 KiB/m);
  assert.equal(r.stderr.match(/^::error::/gm)?.length, 1);
  const local = run(["diff", "base.json.gz", "head.json.gz"]);
  assert.doesNotMatch(local.stderr, /::error::/);
});

test("--annotations sets the level of the per-route annotation", () => {
  const gh = { GITHUB_ACTIONS: "true" };
  const warning = run(["diff", "base.json.gz", "head.json.gz", "--config", "lint.json", "--annotations", "warning"], gh);
  assert.equal(warning.code, 1);
  assert.doesNotMatch(warning.stderr, /::error::/);
  assert.match(warning.stderr, /^::warning::bundle-gate: \/about is over its limit/m);
  assert.match(warning.stderr, /^::warning::rules\[0\] pattern "\/nothing": matches no route$/m);

  const off = run(["diff", "base.json.gz", "head.json.gz", "--config", "lint.json", "--annotations", "off"], gh);
  assert.equal(off.code, 1);
  assert.doesNotMatch(off.stderr, /::error::|is over its limit/);
  assert.match(off.stderr, /^::warning::rules\[0\] pattern "\/nothing": matches no route$/m);

  const error = run(["diff", "base.json.gz", "head.json.gz", "--annotations", "error"], gh);
  assert.equal(error.stderr.match(/^::error::bundle-gate: \/about/gm)?.length, 1);
});

test("a route handler without client JS passes", () => {
  const r = run(["diff", "handler.json.gz", "handler.json.gz"]);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^2 routes: 1 unchanged · 1 without client JS$/m);
  assert.doesNotMatch(r.stdout, /\/api\/health/);
  const json = JSON.parse(run(["diff", "handler.json.gz", "handler.json.gz", "--format", "json"]).stdout);
  assert.equal(json.status, "compared");
  assert.equal(json.totals.noClient, 1);
  assert.equal(json.totals.failed, 0);
});

test("snapshot fails with exit 2 when Next is not installed", () => {
  const r = run(["snapshot", "--dir", "."]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Next\.js is not installed/);
});
