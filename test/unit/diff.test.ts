import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { before, test } from "node:test";
import { diffSnapshots, type ComparedDiff, type DiffResult, type RouteDiff } from "../../src/diff.ts";
import { buildSnapshot, type SnapshotInfo } from "../../src/export.ts";
import { parseConfig } from "../../src/rules.ts";
import type { Config, Snapshot } from "../../src/types.ts";

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

function snap(name: string, routes: Record<string, Array<[string, number]>>, meta: Partial<Snapshot["meta"]> = {}): Snapshot {
  const sources: string[] = [];
  const chunks: Snapshot["chunks"] = {};
  const out: Snapshot["routes"] = {};
  for (const [route, parts] of Object.entries(routes)) {
    const file = `chunk${route.replace(/\W/g, "_")}.js`;
    chunks[file] = parts.map(([source, gz]) => {
      let idx = sources.indexOf(source);
      if (idx === -1) idx = sources.push(source) - 1;
      return [idx, gz * 3, gz];
    });
    out[route] = { eager: parts.length > 0 ? [file] : [], async: [], other: [] };
  }
  return {
    schemaVersion: 1,
    meta: { ...info(name), analyzerSchemaVersion: 1, ...meta },
    sources,
    chunks,
    routes: out,
  };
}

const compared = (r: DiffResult): ComparedDiff => {
  assert.equal(r.status, "compared");
  return r as ComparedDiff;
};
const route = (r: DiffResult, name: string): RouteDiff => {
  const found = compared(r).routes.find((x) => x.route === name);
  assert.ok(found, `route ${name}`);
  return found;
};
const config = (rules: unknown[]): Config => parseConfig({ rules });

let base: Snapshot;
let head: Snapshot;

before(async () => {
  base = await buildSnapshot(fixtureLines("export-base.jsonl"), info("base"));
  head = await buildSnapshot(fixtureLines("export-head.jsonl"), info("head"));
});

test("fixtures: /about breaches its own rule, module deltas name lodash", () => {
  const r = diffSnapshots(base, head, config([{ match: "/about", limit: "+10 KB" }]));
  const c = compared(r);
  assert.equal(c.schemaVersion, 1);
  const about = route(r, "/about");
  assert.equal(about.kind, "changed");
  assert.equal(about.eager.deltaGz, 25078);
  assert.equal(about.eager.base?.gz, 171325);
  assert.equal(about.eager.head?.gz, 196403);
  assert.equal(about.failed, true);
  assert.equal(about.rule, 'rules[0] "/about"');
  assert.deepEqual(about.failures, [{ term: "+10 KiB", message: "grew +24.49 KiB, limit +10 KiB" }]);
  assert.deepEqual(
    about.modules?.map((m) => [m.source, m.gz]),
    [
      ["node_modules:lodash", 24974],
      ["app/about/page.js", 104],
    ],
  );
  assert.equal(about.modulesHidden, 0);
  assert.deepEqual(about.async, { base: { raw: 0, gz: 0 }, head: { raw: 0, gz: 0 }, deltaGz: 0 });
  assert.equal(about.other.deltaGz, 0);

  const reports = route(r, "/reports");
  assert.equal(reports.kind, "unchanged");
  assert.equal(reports.eager.deltaGz, -9);
  assert.equal(reports.failed, false);
  assert.equal(reports.rule, "default (+2%)");
  assert.equal(reports.modules, undefined);

  assert.equal(route(r, "/").eager.deltaGz, 0);
  assert.deepEqual(c.totals, { routes: 3, failed: 1, changed: 1, new: 0, removed: 0, unchanged: 2, noClient: 0 });
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test("fixtures: ignore passes, the default +2% fails", () => {
  const ignored = route(diffSnapshots(base, head, config([{ match: "/about", limit: "ignore" }])), "/about");
  assert.equal(ignored.failed, false);
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.kind, "changed");
  assert.ok(ignored.modules && ignored.modules.length > 0, "changed routes keep module rows");

  const r = diffSnapshots(base, head, { rules: [] });
  const about = route(r, "/about");
  assert.equal(about.failed, true);
  assert.equal(about.rule, "default (+2%)");
  assert.equal(about.failures[0]?.term, "+2%");
  assert.equal(compared(r).totals.failed, 1);
});

test("top limits module rows and counts the rest", () => {
  const about = route(diffSnapshots(base, head, { rules: [] }, { top: 1 }), "/about");
  assert.deepEqual(about.modules?.map((m) => m.source), ["node_modules:lodash"]);
  assert.equal(about.modulesHidden, 1);
});

test("new and removed routes", () => {
  const b = snap("base", { "/": [["app/page.js", 1000]], "/old": [["app/old/page.js", 500]] });
  const h = snap("head", {
    "/": [["app/page.js", 1000]],
    "/new": [
      ["app/new/page.js", 300],
      ["node_modules:react", 5000],
      ["(runtime)", 50],
    ],
  });
  const r = diffSnapshots(b, h, config([{ match: "/new", limit: "+1 B, <= 5000 B" }]), { top: 2 });
  const added = route(r, "/new");
  assert.equal(added.kind, "new");
  assert.equal(added.eager.base, undefined);
  assert.equal(added.percent, null);
  assert.deepEqual(added.failures.map((f) => f.term), ["<= 4.88 KiB"]);
  assert.deepEqual(added.modules?.map((m) => [m.source, m.headGz]), [
    ["node_modules:react", 5000],
    ["app/new/page.js", 300],
  ]);
  assert.equal(added.modulesHidden, 1);

  const removed = route(r, "/old");
  assert.equal(removed.kind, "removed");
  assert.equal(removed.failed, false);
  assert.equal(removed.rule, undefined);
  assert.equal(removed.eager.head, undefined);
  assert.equal(removed.eager.deltaGz, -500);
  assert.deepEqual(compared(r).totals, { routes: 3, failed: 1, changed: 0, new: 1, removed: 1, unchanged: 1, noClient: 0 });
});

test("minChange hides small changes but they are still judged with exact bytes", () => {
  const b = snap("base", { "/": [["app/page.js", 1000]] });
  const h = snap("head", { "/": [["app/page.js", 1050]] });
  const ok = route(diffSnapshots(b, h, config([{ match: "/", limit: "+50 B" }])), "/");
  assert.equal(ok.kind, "unchanged");
  assert.equal(ok.failed, false);

  const r = diffSnapshots(b, h, config([{ match: "/", limit: "+49 B" }]));
  const bad = route(r, "/");
  assert.equal(bad.kind, "unchanged");
  assert.equal(bad.failed, true);
  assert.deepEqual(bad.failures, [{ term: "+49 B", message: "grew +50 B, limit +49 B" }]);
  assert.deepEqual(bad.modules, []);
  assert.equal(compared(r).totals.unchanged, 1);
  assert.equal(compared(r).totals.failed, 1);

  const shown = route(diffSnapshots(b, h, { rules: [] }, { minChange: 10 }), "/");
  assert.equal(shown.kind, "changed");
  assert.deepEqual(shown.modules?.map((m) => m.gz), [50]);
});

test("incomparable snapshots are skipped, not failed", () => {
  const b = snap("base", { "/": [["app/page.js", 1000]] });
  const cases: Array<[Partial<Snapshot["meta"]>, RegExp]> = [
    [{ nextVersion: "16.5.0" }, /Next versions differ \(base 16\.4\.6, head 16\.5\.0\)/],
    [{ appDirOnly: true }, /--experimental-app-only differs/],
    [{ noMangling: true }, /--no-mangling differs/],
    [{ analyzerSchemaVersion: 2 }, /schema versions differ/],
  ];
  for (const [meta, reason] of cases) {
    const h = snap("head", { "/": [["app/page.js", 900000]] }, meta);
    const r = diffSnapshots(b, h, config([{ match: "/", limit: "+1 B" }]));
    assert.equal(r.status, "skipped");
    assert.equal(r.schemaVersion, 1);
    if (r.status === "skipped") {
      assert.equal(r.reasons.length, 1);
      assert.match(r.reasons[0]!, reason);
    }
  }
});

test("a route without client JS (route handler) is listed as no-client, never judged", () => {
  const b = snap("base", { "/": [["app/page.js", 1000]], "/api/health": [] });
  const h = snap("head", { "/": [["app/page.js", 1000]], "/api/health": [] });
  const r = diffSnapshots(b, h, config([{ match: "/api/**", limit: "<= 0 B" }]));
  const c = compared(r);
  const api = route(r, "/api/health");
  assert.equal(api.kind, "no-client");
  assert.equal(api.failed, false);
  assert.deepEqual(api.failures, []);
  assert.equal(api.rule, undefined);
  assert.equal(api.percent, null);
  assert.deepEqual(api.eager, { deltaGz: 0 });
  assert.deepEqual(c.totals, { routes: 2, failed: 0, changed: 0, new: 0, removed: 0, unchanged: 1, noClient: 1 });
  assert.deepEqual(c.warnings, []);

  const added = diffSnapshots(snap("base", { "/": [["a", 1]] }), h, { rules: [] });
  assert.equal(route(added, "/api/health").kind, "no-client");
  assert.equal(compared(added).totals.new, 0);
  const removed = diffSnapshots(b, snap("head", { "/": [["a", 1]] }), { rules: [] });
  assert.equal(route(removed, "/api/health").kind, "no-client");
  assert.equal(compared(removed).totals.removed, 0);
});

test("client JS on one side only: no-client with a warning", () => {
  const ok = snap("x", { "/": [["app/page.js", 1000]] });
  const empty = snap("x", { "/": [] });
  const lost = diffSnapshots(ok, empty, config([{ match: "/", limit: "<= 1 B" }]));
  const r = route(lost, "/");
  assert.equal(r.kind, "no-client");
  assert.equal(r.failed, false);
  assert.equal(r.eager.base?.gz, 1000);
  assert.equal(r.eager.head, undefined);
  assert.equal(r.eager.deltaGz, 0);
  assert.deepEqual(lost.warnings, ["route / has client assets in base only, not gated"]);
  assert.equal(compared(lost).totals.noClient, 1);
  assert.equal(compared(lost).totals.failed, 0);

  const gained = diffSnapshots(empty, ok, { rules: [] });
  assert.equal(route(gained, "/").kind, "no-client");
  assert.deepEqual(gained.warnings, ["route / has client assets in head only, not gated"]);
});

test("lint warnings use the routes of both snapshots", () => {
  const b = snap("base", { "/old": [["a", 1]] });
  const h = snap("head", { "/new": [["a", 1]] });
  const r = diffSnapshots(b, h, config([{ match: ["/old", "/new", "/none"], limit: "+1 KB" }]));
  assert.deepEqual(r.warnings, ['rules[0] pattern "/none": matches no route']);
});
