import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { stripVTControlCharacters, styleText } from "node:util";
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

const ANSI = "\u001b[";

let base: Snapshot;
let head: Snapshot;
let shopBase: Snapshot;
let shopHead: Snapshot;
let result: DiffResult;
let shop: DiffResult;

before(async () => {
  base = await buildSnapshot(fixtureLines("export-base.jsonl"), info("base", "1111111aaaaaaa"));
  head = await buildSnapshot(fixtureLines("export-head.jsonl"), info("head", "2222222bbbbbbb"));
  shopBase = { ...base, routes: { ...base.routes, "/shop": base.routes["/reports"]! } };
  shopHead = { ...head, routes: { ...head.routes, "/shop": head.routes["/"]! } };
  result = diffSnapshots(base, head, parseConfig({ rules: [{ match: "/about", limit: "+10 KB" }] }));
  shop = diffSnapshots(shopBase, shopHead, { rules: [] });
});

test("text: a failing and a shrunk route", () => {
  assert.equal(
    formatText(shop, { all: false }),
    [
      "✗ bundle-gate: 1 route over the limit",
      "  Next 16.4.6 · eager client JS, gzip · base 1111111 → head 2222222",
      "",
      "Over the limit",
      "✗ /about  167.3 KiB → 191.79 KiB  +24.49 KiB  +14.64%  limit +2%",
      "    lodash             +24.38 KiB",
      "    app/about/page.js      +104 B",
      "",
      "Smaller",
      "↓ /shop   191.8 KiB → 170.01 KiB  -21.79 KiB  -11.36%",
      "",
      "4 routes: 2 changed · 2 unchanged",
      "",
    ].join("\n"),
  );
});

test("markdown: a failing and a shrunk route", () => {
  assert.equal(
    formatMarkdown(shop, { all: false }),
    [
      "### ❌ bundle-gate: 1 route over the limit",
      "",
      "Next 16.4.6 · eager client JS, gzip · `base 1111111` → `head 2222222`",
      "",
      "> [!CAUTION]",
      "> - **`/about`**: **+24.49 KiB (+14.64%)**, limit +2% · 167.3 KiB → 191.79 KiB",
      "",
      "> [!TIP]",
      "> **1 route got smaller**",
      ">",
      "> - **`/shop`**: **-21.79 KiB (-11.36%)** · 191.8 KiB → 170.01 KiB",
      "",
      "4 routes: 2 changed · 2 unchanged",
      "",
      "<details><summary>Module changes for 2 routes</summary>",
      "",
      "**`/about`** · eager 167.3 KiB → 191.79 KiB, +24.49 KiB",
      "",
      "| Eager module | Change | Before | After |",
      "|---|---:|---:|---:|",
      "| `lodash` | +24.38 KiB | 0 B | 24.38 KiB |",
      "| `app/about/page.js` | +104 B | 0 B | 104 B |",
      "",
      "**`/shop`** · eager 191.8 KiB → 170.01 KiB, -21.79 KiB",
      "",
      "| Eager module | Change | Before | After |",
      "|---|---:|---:|---:|",
      "| `lodash` | -21.79 KiB | 24.38 KiB | 2.59 KiB |",
      "| `app/page.js` | +112 B | 0 B | 112 B |",
      "| `app/reports/page.js` | -110 B | 110 B | 0 B |",
      "",
      "</details>",
      "",
      "Download the analyzer report artifact, then run `npx serve <folder>` and open the compare view.",
      "",
    ].join("\n"),
  );
});

test("flipped snapshots: the shrunk route fails, the failing route shrinks", () => {
  const r = diffSnapshots(shopHead, shopBase, { rules: [] });
  assert.equal(
    formatText(r, { all: false }),
    [
      "✗ bundle-gate: 1 route over the limit",
      "  Next 16.4.6 · eager client JS, gzip · head 2222222 → base 1111111",
      "",
      "Over the limit",
      "✗ /shop   170.01 KiB → 191.8 KiB  +21.79 KiB  +12.82%  limit +2%",
      "    lodash               +21.79 KiB",
      "    app/page.js              -112 B",
      "    app/reports/page.js      +110 B",
      "",
      "Smaller",
      "↓ /about  191.79 KiB → 167.3 KiB  -24.49 KiB  -12.77%",
      "",
      "4 routes: 2 changed · 2 unchanged",
      "",
    ].join("\n"),
  );
  assert.equal(
    formatMarkdown(r, { all: false }),
    [
      "### ❌ bundle-gate: 1 route over the limit",
      "",
      "Next 16.4.6 · eager client JS, gzip · `head 2222222` → `base 1111111`",
      "",
      "> [!CAUTION]",
      "> - **`/shop`**: **+21.79 KiB (+12.82%)**, limit +2% · 170.01 KiB → 191.8 KiB",
      "",
      "> [!TIP]",
      "> **1 route got smaller**",
      ">",
      "> - **`/about`**: **-24.49 KiB (-12.77%)** · 191.79 KiB → 167.3 KiB",
      "",
      "4 routes: 2 changed · 2 unchanged",
      "",
      "<details><summary>Module changes for 2 routes</summary>",
      "",
      "**`/shop`** · eager 170.01 KiB → 191.8 KiB, +21.79 KiB",
      "",
      "| Eager module | Change | Before | After |",
      "|---|---:|---:|---:|",
      "| `lodash` | +21.79 KiB | 2.59 KiB | 24.38 KiB |",
      "| `app/page.js` | -112 B | 112 B | 0 B |",
      "| `app/reports/page.js` | +110 B | 0 B | 110 B |",
      "",
      "**`/about`** · eager 191.79 KiB → 167.3 KiB, -24.49 KiB",
      "",
      "| Eager module | Change | Before | After |",
      "|---|---:|---:|---:|",
      "| `lodash` | -24.38 KiB | 24.38 KiB | 0 B |",
      "| `app/about/page.js` | -104 B | 104 B | 0 B |",
      "",
      "</details>",
      "",
      "Download the analyzer report artifact, then run `npx serve <folder>` and open the compare view.",
      "",
    ].join("\n"),
  );
});

test("fixtures: /reports with -9 B is unchanged, not smaller", () => {
  const text = formatText(result, { all: false });
  assert.doesNotMatch(text, /\/reports|Smaller/);
  assert.match(text, /^3 routes: 1 changed · 2 unchanged$/m);
  const md = formatMarkdown(result, { all: false });
  assert.doesNotMatch(md, /\/reports|\[!TIP\]/);
  assert.match(formatText(result, { all: true }), /^· \/reports +191\.8 KiB → 191\.79 KiB +-9 B +-0\.00%$/m);
});

test("exact bytes when the printed head size equals the printed max-size; the size is highlighted", () => {
  const headBytes = 196403;
  const r = diffSnapshots(base, head, parseConfig({ rules: [{ match: "/about", limit: `<= ${headBytes - 1} B` }] }));
  const text = formatText(r, { all: false });
  assert.match(text, /^✗ \/about +167\.3 KiB → 191\.79 KiB +\+24\.49 KiB +\+14\.64% {2}limit <= 191\.79 KiB \(exact: 196403 B\)$/m);
  const colored = formatText(r, { all: false, color: true });
  assert.ok(colored.includes(styleText(["bold", "red"], "191.79 KiB", { validateStream: false })));
  assert.ok(!colored.includes(styleText(["bold", "red"], "+24.49 KiB", { validateStream: false })));
  assert.match(
    formatMarkdown(r, { all: false }),
    /^> - \*\*`\/about`\*\*: \*\*191\.79 KiB\*\*, limit <= 191\.79 KiB \(exact: 196403 B\) · 167\.3 KiB → 191\.79 KiB$/m,
  );
});

test("exact bytes when the printed growth equals the printed max-growth", () => {
  const tiny = (name: string, gz: number): Snapshot => ({
    schemaVersion: 1,
    meta: { ...info(name, `${name}0000000`), analyzerSchemaVersion: 1 },
    sources: ["app/page.js"],
    chunks: { "page.js": [[0, gz * 3, gz]] },
    routes: { "/": { eager: ["page.js"], async: [], other: [] } },
  });
  const r = diffSnapshots(tiny("base", 10000), tiny("head", 35105), parseConfig({ rules: [{ match: "/", limit: "+25100 B" }] }));
  assert.match(formatText(r, { all: false }), /\+24\.51 KiB +\+251\.05% {2}limit \+24\.51 KiB \(exact: \+25105 B\)$/m);
  assert.match(formatMarkdown(r, { all: false }), /\*\*\+24\.51 KiB \(\+251\.05%\)\*\*, limit \+24\.51 KiB \(exact: \+25105 B\) ·/);
});

test("two failing terms on one route", () => {
  const r = diffSnapshots(base, head, parseConfig({ rules: [{ match: "/about", limit: "+10 KB, <= 150 KB" }] }));
  assert.match(formatText(r, { all: false }), /\+14\.64% {2}limit \+10 KiB, <= 150 KiB$/m);
  assert.match(
    formatMarkdown(r, { all: false }),
    /^> - \*\*`\/about`\*\*: \*\*\+24\.49 KiB \(\+14\.64%\)\*\*, \*\*191\.79 KiB\*\*, limit \+10 KiB, <= 150 KiB · 167\.3 KiB → 191\.79 KiB$/m,
  );
});

test("a route where only async chunks changed", () => {
  const lazy: Snapshot = {
    ...head,
    routes: {
      ...head.routes,
      "/": { ...head.routes["/"]!, async: ["_next/static/chunks/1vh3bif77m226.js", "_next/static/chunks/0at_-9wrel0-o.js"] },
    },
  };
  const r = diffSnapshots(base, lazy, parseConfig({ rules: [{ match: "/about", limit: "ignore" }] }));
  const text = formatText(r, { all: false });
  assert.match(text, /^Other changes\n↑ \/about .*\(ignored\)\n· \/ +170\.01 KiB → 170\.01 KiB +\+0 B +\+0\.00% {2}async \+24\.49 KiB \(not gated\)$/m);
  assert.doesNotMatch(text, /async lodash/);
  const all = formatText(r, { all: true });
  assert.match(all, /^ {4}async lodash +\+24\.38 KiB\n {4}async app\/about\/page\.js +\+104 B$/m);

  const md = formatMarkdown(r, { all: false });
  assert.match(md, /^\| `\/` \| 170\.01 KiB \| 170\.01 KiB \| \+0 B \| \+0\.00% \| async \+24\.49 KiB \|$/m);
  assert.match(md, /^<details><summary>Module changes for 2 routes<\/summary>$/m);
  assert.match(
    md,
    /^\*\*`\/`\*\* · async 0 B → 24\.49 KiB, \+24\.49 KiB\n\n\| Async module \| Change \| Before \| After \|\n\|---\|---:\|---:\|---:\|\n\| `lodash` \| \+24\.38 KiB \| 0 B \| 24\.38 KiB \|$/m,
  );
});

test("new, removed and ignored routes", () => {
  const extra: Snapshot = { ...head, routes: { ...head.routes, "/extra": head.routes["/about"]! } };
  delete (extra.routes as Record<string, unknown>)["/reports"];
  const r = diffSnapshots(base, extra, parseConfig({ rules: [{ match: "/about", limit: "ignore" }] }));
  const text = formatText(r, { all: false });
  assert.match(text, /^\+ \/extra +- → 191\.79 KiB +new +unattributed \+38\.5 KiB \(not gated\)$/m);
  assert.match(text, /^↑ \/about +167\.3 KiB → 191\.79 KiB +\+24\.49 KiB +\+14\.64% {2}\(ignored\)$/m);
  assert.match(text, /^- \/reports +191\.8 KiB → +- +removed +unattributed -38\.5 KiB \(not gated\)$/m);
  assert.match(text, /^4 routes: 1 changed · 1 new · 1 removed · 1 unchanged$/m);

  const md = formatMarkdown(r, { all: false });
  assert.match(md, /^\| `\/extra` \| \| 191\.79 KiB \| new \| \| unattributed \+38\.5 KiB \|$/m);
  assert.match(md, /^\| `\/about` \| 167\.3 KiB \| 191\.79 KiB \| \+24\.49 KiB \| \+14\.64% \| ignored \|$/m);
  assert.match(md, /^\| `\/reports` \| 191\.8 KiB \| \| removed \| \| unattributed -38\.5 KiB \|$/m);
  assert.match(md, /^\*\*`\/extra`\*\* · new, eager 191\.79 KiB\n\n\| Eager module \| Size \|\n\|---\|---:\|\n\| `next` \| /m);

  const shrunk = formatMarkdown(diffSnapshots(shopHead, shopBase, parseConfig({ rules: [{ match: "/about", limit: "ignore" }] })), {
    all: false,
  });
  assert.doesNotMatch(shrunk, /\[!TIP\]/);
  assert.match(shrunk, /^\| `\/about` \| 191\.79 KiB \| 167\.3 KiB \| -24\.49 KiB \| -12\.77% \| ignored \|$/m);
});

test("top 1: the last row sums the hidden modules", () => {
  const r = diffSnapshots(shopBase, shopHead, { rules: [] }, { top: 1 });
  const text = formatText(r, { all: false });
  assert.match(text, /^ {4}lodash {6}\+24\.38 KiB\n {4}\.\.\. 1 more {6}\+104 B$/m);
  const md = formatMarkdown(r, { all: false });
  assert.match(md, /^\| `lodash` \| \+24\.38 KiB \| 0 B \| 24\.38 KiB \|\n\| \.\.\. 1 more \| \+104 B \| \| \|$/m);
  assert.match(md, /^\| `lodash` \| -21\.79 KiB \| 24\.38 KiB \| 2\.59 KiB \|\n\| \.\.\. 2 more \| \+2 B \| \| \|$/m);
});

test("top 0: a failing route shows only the row that sums the hidden modules", () => {
  const r = diffSnapshots(shopBase, shopHead, { rules: [] }, { top: 0 });
  assert.match(formatText(r, { all: false }), /^✗ \/about .*\n {4}\.\.\. 2 more {2}\+24\.49 KiB\n\nSmaller$/m);
  assert.match(
    formatMarkdown(r, { all: false }),
    /^\| Eager module \| Change \| Before \| After \|\n\|---\|---:\|---:\|---:\|\n\| \.\.\. 2 more \| \+24\.49 KiB \| \| \|$/m,
  );
});

test("--all: every route in order, modules of every listed route", () => {
  const withRoutes = (s: Snapshot, extra: Snapshot["routes"]): Snapshot => ({ ...s, routes: { ...s.routes, ...extra } });
  const handler = { eager: [], async: [], other: [] };
  const r = diffSnapshots(
    withRoutes(shopBase, { "/api/health": handler }),
    withRoutes(shopHead, { "/api/health": handler, "/extra": head.routes["/about"]! }),
    { rules: [] },
  );
  const text = formatText(r, { all: true });
  const rows = text.split("\n").filter((l) => /^(\S+ \/|[A-Z])/.test(l));
  assert.deepEqual(
    rows.map((l) => l.split(/ {2,}/)[0]),
    [
      "Over the limit",
      "✗ /about",
      "Smaller",
      "↓ /shop",
      "All other routes",
      "+ /extra",
      "· /",
      "· /reports",
      "· /api/health",
    ],
  );
  assert.match(text, /^· \/api\/health {2}no client JS \(not gated\)$/m);
  assert.match(text, /^↓ \/shop .*\n {4}lodash +-21\.79 KiB$/m);
  assert.match(text, /^\+ \/extra .*\n {4}next +162\.46 KiB$/m);
  assert.match(text, /^6 routes: 2 changed · 1 new · 2 unchanged · 1 without client JS$/m);

  const md = formatMarkdown(r, { all: true });
  assert.match(md, /^\*\*All other routes\*\*$/m);
  const table = md.split("\n").filter((l) => l.startsWith("| `/"));
  assert.deepEqual(
    table.map((l) => l.split(" | ")[0]),
    ["| `/extra`", "| `/`", "| `/reports`", "| `/api/health`"],
  );
  assert.match(md, /^\| `\/api\/health` \| \| \| no client JS \| \| not gated \|$/m);
  assert.match(md, /^<details><summary>Module changes for 3 routes<\/summary>$/m);
  assert.doesNotMatch(formatMarkdown(r, { all: false }), /\/api\/health|`\/reports`/);
});

test("nothing changed: status, Next line and counts", () => {
  const r = diffSnapshots(base, base, { rules: [] });
  const text = formatText(r, { all: false });
  assert.deepEqual(
    text.split("\n").filter((l) => l !== ""),
    [
      "✓ bundle-gate: all routes within limits",
      "  Next 16.4.6 · eager client JS, gzip · base 1111111 → base 1111111",
      "3 routes: 3 unchanged",
    ],
  );
  assert.equal(
    formatMarkdown(r, { all: false }),
    [
      "### ✅ bundle-gate: all routes within limits",
      "",
      "Next 16.4.6 · eager client JS, gzip · `base 1111111` → `base 1111111`",
      "",
      "3 routes: 3 unchanged",
      "",
    ].join("\n"),
  );
});

test("config warnings: a WARNING block, the only place with rules[", () => {
  const r = diffSnapshots(
    base,
    head,
    parseConfig({
      rules: [
        { match: "/about", limit: "+10 KB" },
        { match: "/nothing", limit: "+1 KB" },
      ],
    }),
  );
  assert.doesNotMatch(formatText(r, { all: true }), /rules\[/);
  const md = formatMarkdown(r, { all: true });
  assert.ok(md.endsWith('\n\n> [!WARNING]\n> - rules[1] pattern "/nothing": matches no route\n'));
  assert.equal(md.match(/rules\[/g)?.length, 1);
  assert.match(md, /^> \[!CAUTION\]\n> - \*\*`\/about`\*\*: \*\*\+24\.49 KiB \(\+14\.64%\)\*\*, limit \+10 KiB · /m);
});

test("skipped: text prints only the reasons, markdown uses NOTE and WARNING blocks", () => {
  const other = { ...head, meta: { ...head.meta, nextVersion: "16.5.0", appDirOnly: true } };
  const r = diffSnapshots(base, other, parseConfig({ rules: [{ match: "/nothing", limit: "+1 KB" }] }));
  const text = formatText(r, { all: false });
  assert.equal(text.split("\n\n").length, 2);
  assert.match(text, /^bundle-gate skipped the comparison: Next versions differ \(base 16\.4\.6, head 16\.5\.0\)\./);
  assert.match(text, /this is not a failure\.\n$/);
  assert.doesNotMatch(text, /eager client JS/);

  const md = formatMarkdown(r, { all: false });
  assert.match(
    md,
    /^### bundle-gate: comparison skipped\n\n> \[!NOTE\]\n> bundle-gate skipped the comparison: Next versions differ .*\n>\n> bundle-gate skipped the comparison: Analyzer flag --experimental-app-only differs .*\n\n> \[!WARNING\]\n> - rules\[0\] pattern "\/nothing": matches no route\n$/,
  );
});

test("color: only text with color: true has ANSI codes, and they do not change the layout", () => {
  for (const all of [false, true]) {
    const plain = formatText(shop, { all });
    const colored = formatText(shop, { all, color: true });
    assert.ok(colored.includes(ANSI));
    assert.equal(stripVTControlCharacters(colored), plain);
    assert.ok(!plain.includes(ANSI));
    assert.ok(!formatMarkdown(shop, { all, color: true }).includes(ANSI));
  }
  const colored = formatText(shop, { all: false, color: true });
  assert.ok(colored.includes(styleText(["bold", "red"], "+24.49 KiB", { validateStream: false })));
  assert.ok(colored.includes(styleText(["bold", "green"], "-21.79 KiB", { validateStream: false })));
  assert.ok(colored.includes(styleText("bold", "Over the limit", { validateStream: false })));
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

test("routes without client JS: no lines unless --all, counted in the counts line", () => {
  const withHandler = (s: Snapshot): Snapshot => ({
    ...s,
    routes: { ...s.routes, "/api/health": { eager: [], async: [], other: [] } },
  });
  const r = diffSnapshots(withHandler(base), withHandler(head), parseConfig({ rules: [{ match: "/about", limit: "ignore" }] }));
  const counts = /^4 routes: 1 changed · 2 unchanged · 1 without client JS$/m;

  const text = formatText(r, { all: false });
  assert.doesNotMatch(text, /\/api\/health/);
  assert.match(text, counts);
  assert.match(formatText(r, { all: true }), /^· \/api\/health {2}no client JS \(not gated\)$/m);

  const md = formatMarkdown(r, { all: false });
  assert.match(md, /^### ✅ bundle-gate: all routes within limits$/m);
  assert.doesNotMatch(md, /\/api\/health/);
  assert.match(md, counts);
  assert.match(formatMarkdown(r, { all: true }), /^\| `\/api\/health` \| \| \| no client JS \| \| not gated \|$/m);

  const json = JSON.parse(formatJson(r));
  assert.equal(json.totals.noClient, 1);
  assert.equal(json.routes.find((x: { route: string }) => x.route === "/api/health").kind, "no-client");
});
