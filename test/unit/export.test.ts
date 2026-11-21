import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { buildSnapshot, normalizeSource, SnapshotError, type SnapshotInfo } from "../../src/export.ts";

const info: SnapshotInfo = {
  snapshotName: "test",
  nextVersion: "16.4.6",
  appDirOnly: false,
  noMangling: false,
  createdAt: "2026-11-21T00:00:00.000Z",
};

function fixtureLines(name: string): AsyncIterable<string> {
  const input = createReadStream(new URL(`../fixtures/${name}`, import.meta.url));
  return createInterface({ input, crlfDelay: Infinity });
}

const meta = JSON.stringify({ type: "meta", schema_version: 1, snapshot_name: "x" });
const part = (route: string, file: string, source: string, size: number, gz: number) =>
  JSON.stringify({
    type: "part",
    route,
    filename: `[client-fs]/_next/static/chunks/${file}`,
    source_path: source,
    size,
    compressed_size: gz,
  });
const group = (route: string, kind: string, files: string[]) =>
  JSON.stringify({
    type: "group",
    route,
    id: 0,
    kind,
    outputs: files.map((f) => `[client-fs]/_next/static/chunks/${f}`),
  });

test("edge fixture: basePath chunk names, async and ungrouped chunks", async () => {
  const s = await buildSnapshot(fixtureLines("export-edge.jsonl"), { ...info, commit: "abc" });
  assert.equal(s.meta.analyzerSchemaVersion, 1);
  assert.equal(s.meta.commit, "abc");
  assert.deepEqual(s.routes["/docs"], {
    eager: ["docs/_next/static/chunks/x.js", "docs/_next/static/chunks/page.js"],
    async: ["docs/_next/static/chunks/lazy.js"],
    other: ["docs/_next/static/chunks/polyfill.js"],
  });
  assert.deepEqual(s.routes["/docs/guide"], {
    eager: ["docs/_next/static/chunks/x.js"],
    async: [],
    other: [],
  });
  // Server outputs never become chunks; shared x.js is stored once, parts merged per source.
  assert.deepEqual(Object.keys(s.chunks).sort(), [
    "docs/_next/static/chunks/lazy.js",
    "docs/_next/static/chunks/page.js",
    "docs/_next/static/chunks/polyfill.js",
    "docs/_next/static/chunks/x.js",
  ]);
  const x = s.chunks["docs/_next/static/chunks/x.js"]?.map(([i, raw, gz]) => [s.sources[i], raw, gz]);
  assert.deepEqual(x, [
    ["(runtime)", 1000, 400],
    ["node_modules:react-dom", 3050, 1030],
  ]);
  assert.deepEqual(
    s.chunks["docs/_next/static/chunks/polyfill.js"]?.map(([i]) => s.sources[i]),
    ["(unattributed)"],
  );
});

test("an async chunk that is also eager counts as eager only", async () => {
  const s = await buildSnapshot(
    [
      meta,
      group("/", "async", ["a.js", "b.js"]),
      group("/", "bootstrap", ["b.js"]),
      part("/", "a.js", "[project]/app/a.js", 10, 5),
      part("/", "b.js", "[project]/app/b.js", 20, 8),
    ],
    info,
  );
  assert.deepEqual(s.routes["/"], {
    eager: ["_next/static/chunks/b.js"],
    async: ["_next/static/chunks/a.js"],
    other: [],
  });
});

test("unknown schema_version throws", async () => {
  await assert.rejects(
    buildSnapshot([JSON.stringify({ type: "meta", schema_version: 2 })], info),
    (err: unknown) =>
      err instanceof SnapshotError &&
      err.message === "unsupported analyzer schema_version 2, expected 1",
  );
});

test("the first record must be meta", async () => {
  await assert.rejects(buildSnapshot([group("/", "bootstrap", ["a.js"])], info), SnapshotError);
  await assert.rejects(buildSnapshot([], info), SnapshotError);
});

test("a route with client parts but no groups throws", async () => {
  await assert.rejects(
    buildSnapshot([meta, part("/orphan", "a.js", "[project]/app/a.js", 10, 5)], info),
    (err: unknown) => err instanceof SnapshotError && err.message.includes("/orphan"),
  );
});

test("a group output without parts throws", async () => {
  await assert.rejects(
    buildSnapshot([meta, group("/", "bootstrap", ["missing.js"])], info),
    (err: unknown) =>
      err instanceof SnapshotError && err.message.includes("missing.js") && err.message.includes("/"),
  );
});

test("routes that disagree on a chunk's parts throw", async () => {
  await assert.rejects(
    buildSnapshot(
      [
        meta,
        group("/a", "bootstrap", ["shared.js"]),
        part("/a", "shared.js", "[project]/app/x.js", 10, 5),
        group("/b", "bootstrap", ["shared.js"]),
        part("/b", "shared.js", "[project]/app/x.js", 11, 5),
      ],
      info,
    ),
    (err: unknown) => err instanceof SnapshotError && err.message.includes("shared.js"),
  );
});

test("an unknown group kind throws", async () => {
  await assert.rejects(buildSnapshot([meta, group("/", "prefetch", [])], info), SnapshotError);
});

test("two routes sharing a chunk store it once (probe base export)", async () => {
  const s = await buildSnapshot(fixtureLines("export-base.jsonl"), info);
  assert.deepEqual(Object.keys(s.routes).sort(), ["/", "/about", "/reports"]);
  const listed = Object.values(s.routes).flatMap((r) => [...r.eager, ...r.async, ...r.other]);
  const unique = new Set(listed);
  assert.ok(listed.length > unique.size, "fixture routes share chunks");
  assert.deepEqual(Object.keys(s.chunks).sort(), [...unique].sort());
  const shared = s.routes["/"]?.eager.filter((f) => s.routes["/about"]?.eager.includes(f)) ?? [];
  assert.ok(shared.length > 0);
  // Every source key is unique and the probe has no async groups.
  assert.equal(new Set(s.sources).size, s.sources.length);
  for (const r of Object.values(s.routes)) assert.deepEqual(r.async, []);
});

test("normalizeSource", () => {
  const cases: Array<[string, string | undefined, string]> = [
    ["[project]/app/page.js", undefined, "app/page.js"],
    ["[project]/apps/web/app/page.js", "apps/web/", "app/page.js"],
    ["[project]/apps/web/app/page.js", "apps/web", "app/page.js"],
    ["[project]/packages/ui/index.js", "apps/web/", "packages/ui/index.js"],
    ["[project]/node_modules/lodash/chunk.js", undefined, "node_modules:lodash"],
    ["[project]/apps/web/node_modules/lodash/chunk.js", "apps/web/", "node_modules:lodash"],
    [
      "[project]/node_modules/.pnpm/next@16.4.6_react@19.3.1/node_modules/next/dist/client/index.js",
      undefined,
      "node_modules:next",
    ],
    ["[project]/node_modules/@swc/helpers/esm/_interop.js", undefined, "node_modules:@swc/helpers"],
    [
      "[project]/node_modules/.pnpm/@swc+helpers@0.5.1/node_modules/@swc/helpers/esm/x.js",
      undefined,
      "node_modules:@swc/helpers",
    ],
    ["[turbopack]/browser/runtime/base/runtime-base.ts", undefined, "(runtime)"],
    ["[next]/entry/page-loader.ts", undefined, "(runtime)"],
    ["[client-fs]/_next/static/chunks/0cz1d0mv5g_q7.js", undefined, "(unattributed)"],
    ["[output]/.next/static/chunks/abc.js", undefined, "(unattributed)"],
    ["[project]/app/page.js [app-client] (ecmascript)", undefined, "app/page.js"],
    ["[project]/app/page.js?query=1", undefined, "app/page.js"],
    ["[project]/app/page.js { MODULE_0 => x }", undefined, "app/page.js"],
    ["[project]/app/page.js <locals>", undefined, "app/page.js"],
    ["[project]/app/(group)/page.js", undefined, "app/(group)/page.js"],
  ];
  for (const [input, prefix, expected] of cases) {
    assert.equal(normalizeSource(input, prefix), expected, input);
  }
});
