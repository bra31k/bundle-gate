import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { buildSnapshot, SnapshotError, type SnapshotInfo } from "../../src/export.ts";
import { diffModules, readSnapshot, routeModules, routeSize, writeSnapshot } from "../../src/snapshot.ts";
import type { Snapshot } from "../../src/types.ts";

const info = (snapshotName: string): SnapshotInfo => ({
  snapshotName,
  nextVersion: "16.4.6",
  appDirOnly: false,
  noMangling: false,
  createdAt: "2026-11-21T00:00:00.000Z",
});

function fixtureLines(name: string): AsyncIterable<string> {
  const input = createReadStream(new URL(`../fixtures/${name}`, import.meta.url));
  return createInterface({ input, crlfDelay: Infinity });
}

let base: Snapshot;
let head: Snapshot;
let edge: Snapshot;
let dir: string;

before(async () => {
  base = await buildSnapshot(fixtureLines("export-base.jsonl"), info("base"));
  head = await buildSnapshot(fixtureLines("export-head.jsonl"), info("head"));
  edge = await buildSnapshot(fixtureLines("export-edge.jsonl"), info("edge"));
  dir = await mkdtemp(join(tmpdir(), "bundle-gate-test-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("/about eager delta equals the sum of its module deltas", () => {
  const delta = routeSize(head, "/about").eager.gz - routeSize(base, "/about").eager.gz;
  const modules = diffModules(routeModules(base, "/about", "eager"), routeModules(head, "/about", "eager"));
  assert.equal(
    modules.reduce((sum, m) => sum + m.gz, 0),
    delta,
  );
  assert.equal(delta, 25078);
  assert.equal(modules[0]?.source, "node_modules:lodash");
  for (let i = 1; i < modules.length; i++) {
    assert.ok(Math.abs(modules[i - 1]!.gz) >= Math.abs(modules[i]!.gz));
  }
});

test("routeSize splits eager, async and other", () => {
  assert.deepEqual(routeSize(edge, "/docs"), {
    eager: { raw: 4250, gz: 1550 },
    async: { raw: 5000, gz: 1800 },
    other: { raw: 110000, gz: 39000 },
  });
  assert.throws(() => routeSize(edge, "/nope"), SnapshotError);
  assert.throws(() => routeSize(edge, "constructor"), SnapshotError);
});

test("routeModules keys by source and keeps async out of eager", () => {
  assert.deepEqual(
    routeModules(edge, "/docs", "eager"),
    new Map([
      ["(runtime)", { raw: 1000, gz: 400 }],
      ["node_modules:react-dom", { raw: 3050, gz: 1030 }],
      ["app/docs/page.js", { raw: 200, gz: 120 }],
    ]),
  );
  assert.deepEqual(
    routeModules(edge, "/docs", "async"),
    new Map([["components/Chart.js", { raw: 5000, gz: 1800 }]]),
  );
});

test("diffModules covers one-sided sources, sorts by |gz| and drops zero rows", () => {
  const b = new Map([
    ["same", { raw: 10, gz: 5 }],
    ["gone", { raw: 100, gz: 40 }],
    ["grew", { raw: 10, gz: 5 }],
  ]);
  const h = new Map([
    ["same", { raw: 10, gz: 5 }],
    ["grew", { raw: 30, gz: 15 }],
    ["new", { raw: 300, gz: 90 }],
  ]);
  assert.deepEqual(diffModules(b, h), [
    { source: "new", raw: 300, gz: 90, baseGz: 0, headGz: 90 },
    { source: "gone", raw: -100, gz: -40, baseGz: 40, headGz: 0 },
    { source: "grew", raw: 20, gz: 10, baseGz: 5, headGz: 15 },
  ]);
});

for (const name of ["snap.json", "snap.json.gz"]) {
  test(`write/read round trip: ${name}`, async () => {
    const path = join(dir, name);
    await writeSnapshot(path, head);
    const bytes = await readFile(path);
    const text = name.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
    assert.deepEqual(JSON.parse(text), head);
    assert.deepEqual(await readSnapshot(path), head);
  });
}

test("readSnapshot rejects other versions and broken shapes", async () => {
  const cases: Array<[string, unknown]> = [
    ["v2.json", { ...edge, schemaVersion: 2 }],
    ["nometa.json", { ...edge, meta: undefined }],
    ["badpart.json", { ...edge, chunks: { "a.js": [[999, 1, 1]] } }],
    ["badroute.json", { ...edge, routes: { "/": { eager: ["missing.js"], async: [], other: [] } } }],
    ["array.json", []],
  ];
  for (const [name, value] of cases) {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readSnapshot(path), SnapshotError, name);
  }
  const garbage = join(dir, "garbage.json");
  await writeFile(garbage, "not json");
  await assert.rejects(readSnapshot(garbage), /not valid JSON/);
  await assert.rejects(readSnapshot(join(dir, "v2.json")), /schemaVersion 2, expected 1/);
});
