import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { before, test } from "node:test";
import { diffSnapshots, type DiffResult } from "../../src/diff.ts";
import { buildSnapshot, type SnapshotInfo } from "../../src/export.ts";
import { displaySource, formatJson, formatMarkdown, formatText } from "../../src/format.ts";
import { parseConfig } from "../../src/rules.ts";
import type { Snapshot } from "../../src/types.ts";

const info = (snapshotName: string, commit: string): SnapshotInfo => ({
  snapshotName,
  nextVersion: "16.4.6",
  appDirOnly: false,
  noMangling: false,
  createdAt: "2026-11-21T00:00:00.000Z",
  commit,
});

function fixtureLines(name: string): AsyncIterable<string> {
  const input = createReadStream(new URL(`../fixtures/${name}`, import.meta.url));
  return createInterface({ input, crlfDelay: Infinity });
}

let base: Snapshot;
let head: Snapshot;
let result: DiffResult;

before(async () => {
  base = await buildSnapshot(fixtureLines("export-base.jsonl"), info("base", "1111111aaaaaaa"));
  head = await buildSnapshot(fixtureLines("export-head.jsonl"), info("head", "2222222bbbbbbb"));
  result = diffSnapshots(base, head, parseConfig({ rules: [{ match: "/about", limit: "+10 KB" }] }));
});

test("text: header, failing route with rule and modules, footer", () => {
  const text = formatText(result, { all: false });
  const lines = text.split("\n");
  assert.equal(lines[0], "bundle-gate  Next 16.4.6 · eager client JS (gzip)");
  assert.equal(lines[1], "base 1111111 -> head 2222222");
  assert.match(text, /^✗ \/about +167\.31 KB -> 191\.80 KB +\+24\.49 KB +\+14\.64%$/m);
  assert.match(text, /^ {4}rule rules\[0\] "\/about": grew \+24\.49 KB, limit \+10\.00 KB$/m);
  assert.match(text, /^ {4}\+ lodash +\+24\.39 KB$/m);
  assert.match(text, /^ {4}\+ app\/about\/page\.js +\+104 B$/m);
  assert.doesNotMatch(text, /\/reports/);
  assert.match(text, /^1 failed · 1 changed · 0 new · 0 removed · 2 unchanged \(2 hidden, --all shows them\)$/m);
  assert.ok(text.endsWith("\n"));
});

test("text --all lists unchanged routes", () => {
  const text = formatText(result, { all: true });
  assert.match(text, /^✓ \/reports +191\.81 KB -> 191\.80 KB +-9 B +-0\.00%$/m);
  assert.match(text, /^✓ \/ +170\.01 KB -> 170\.01 KB +\+0 B +\+0\.00%$/m);
  assert.match(text, /2 unchanged$/m);
});

test("text: exact bytes when the rounded delta equals the limit", () => {
  const delta = 25078;
  const r = diffSnapshots(base, head, parseConfig({ rules: [{ match: "/about", limit: `+${delta - 1} B` }] }));
  const text = formatText(r, { all: false });
  assert.match(text, /grew \+24\.49 KB, limit \+24\.49 KB \(exact: \+25078 B\)/);
});

test("text: skipped prints only the reasons", () => {
  const other = { ...head, meta: { ...head.meta, nextVersion: "16.5.0" } };
  const text = formatText(diffSnapshots(base, other, { rules: [] }), { all: false });
  assert.equal(text.split("\n\n").length, 1);
  assert.match(text, /^bundle-gate skipped the comparison: Next versions differ \(base 16\.4\.6, head 16\.5\.0\)\./);
  assert.match(text, /this is not a failure\.\n$/);
  assert.doesNotMatch(text, /eager client JS/);
  assert.match(formatMarkdown(diffSnapshots(base, other, { rules: [] }), { all: false }), /comparison skipped/);
});

test("markdown: route table, details per failing route, report note", () => {
  const md = formatMarkdown(result, { all: false });
  assert.match(md, /^### bundle-gate: ✗ 1 route over the limit$/m);
  assert.match(md, /^Next 16\.4\.6 · eager client JS \(gzip\) · `base 1111111` -> `head 2222222`$/m);
  assert.match(md, /^\| \| Route \| Before \| After \| Delta \| % \| Rule \|$/m);
  assert.match(
    md,
    /^\| ✗ \| `\/about` \| 167\.31 KB \| 191\.80 KB \| \+24\.49 KB \| \+14\.64% \| rules\[0\] "\/about": grew \+24\.49 KB, limit \+10\.00 KB \|$/m,
  );
  assert.match(md, /<details><summary>✗ <code>\/about<\/code>: module changes<\/summary>/);
  assert.match(md, /^\| `lodash` \| \+24\.39 KB \| 0 B \| 24\.39 KB \|$/m);
  assert.match(md, /<\/details>/);
  assert.match(md, /^Download the analyzer report artifact, then run `npx serve <folder>` and open the compare view\.$/m);
  assert.doesNotMatch(md, /<!--/);

  const pass = formatMarkdown(diffSnapshots(base, head, parseConfig({ rules: [{ match: "/about", limit: "ignore" }] })), {
    all: false,
  });
  assert.match(pass, /^### bundle-gate: ✓ all routes within limits$/m);
  assert.doesNotMatch(pass, /<details>|Download the analyzer/);
});

test("new and removed routes in text and markdown", () => {
  const extra: Snapshot = {
    ...head,
    routes: { ...head.routes, "/extra": head.routes["/about"]! },
  };
  delete (extra.routes as Record<string, unknown>)["/reports"];
  const r = diffSnapshots(base, extra, { rules: [] });
  const text = formatText(r, { all: false });
  assert.match(text, /^✓ \/extra +- -> 191\.80 KB +new$/m);
  assert.match(text, /^ {4}\+ lodash +24\.39 KB$/m);
  assert.match(text, /^✓ \/reports +191\.81 KB -> + - +removed$/m);
  assert.match(text, /1 new · 1 removed/);
  const md = formatMarkdown(r, { all: false });
  assert.match(md, /<code>\/extra<\/code>: heaviest modules/);
});

test("json round trip", () => {
  const json = formatJson(result);
  assert.deepEqual(JSON.parse(json), result);
  assert.equal(JSON.parse(json).schemaVersion, 1);
});

test("displaySource prints node_modules as the package name", () => {
  assert.equal(displaySource("node_modules:@scope/pkg"), "@scope/pkg");
  assert.equal(displaySource("app/page.js"), "app/page.js");
});

test("routes without client JS: no lines unless --all, counted in the footer", () => {
  const withHandler = (s: Snapshot): Snapshot => ({
    ...s,
    routes: { ...s.routes, "/api/health": { eager: [], async: [], other: [] } },
  });
  const r = diffSnapshots(withHandler(base), withHandler(head), parseConfig({ rules: [{ match: "/about", limit: "ignore" }] }));
  const footer = /^0 failed · 1 changed · 0 new · 0 removed · 2 unchanged.* · 1 route without client JS \(not gated\)$/m;

  const text = formatText(r, { all: false });
  assert.doesNotMatch(text, /\/api\/health/);
  assert.match(text, footer);
  const all = formatText(r, { all: true });
  assert.match(all, /^- \/api\/health {2}no client JS \(not gated\)$/m);
  assert.match(all, /^0 failed · 1 changed · 0 new · 0 removed · 2 unchanged · 1 route without client JS \(not gated\)$/m);

  const md = formatMarkdown(r, { all: false });
  assert.match(md, /^### bundle-gate: ✓ all routes within limits$/m);
  assert.doesNotMatch(md, /\/api\/health/);
  assert.match(md, footer);
  assert.match(formatMarkdown(r, { all: true }), /^- `\/api\/health` {2}no client JS \(not gated\)$/m);

  const json = JSON.parse(formatJson(r));
  assert.equal(json.totals.noClient, 1);
  assert.equal(json.routes.find((x: { route: string }) => x.route === "/api/health").kind, "no-client");
});
