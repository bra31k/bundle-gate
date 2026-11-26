import { styleText } from "node:util";
import type { ComparedDiff, DiffResult, DiffSide, DiffTotals, ModuleRow, RouteDiff, SizeChange } from "./diff.ts";
import { formatBytes, formatDelta } from "./size.ts";
import type { Size } from "./types.ts";

export interface FormatOptions {
  all: boolean;
  color?: boolean;
}

type Style = Parameters<typeof styleText>[0];

const FAIL = "✗";
const OK = "✓";
const BAD: Style = ["bold", "red"];
const GOOD: Style = ["bold", "green"];
const REPORT_NOTE =
  "Download the analyzer report artifact, then run `npx serve <folder>` and open the compare view.";

function paint(color: boolean | undefined, style: Style, text: string): string {
  return color ? styleText(style, text, { validateStream: false }) : text;
}

function label(s: DiffSide): string {
  return s.commit ? `${s.name} ${s.commit.slice(0, 7)}` : s.name;
}

function nextLabel(result: DiffResult): string {
  const { base, head } = result;
  return base.nextVersion === head.nextVersion ? base.nextVersion : `${base.nextVersion} -> ${head.nextVersion}`;
}

export function displaySource(source: string): string {
  return source.startsWith("node_modules:") ? source.slice("node_modules:".length) : source;
}

function percent(p: number | null): string {
  if (p === null) return "";
  return `${p < 0 ? "-" : "+"}${Math.abs(p).toFixed(2)}%`;
}

const NO_CLIENT_NOTE = "no client JS (not gated)";

function size(s: Size | undefined, missing: string): string {
  return s === undefined ? missing : formatBytes(s.gz);
}

function sizes(c: SizeChange): string {
  return `${size(c.base, "-")} → ${size(c.head, "-")}`;
}

function deltaText(r: RouteDiff): string {
  if (r.kind === "new") return "new";
  if (r.kind === "removed") return "removed";
  if (r.kind === "no-client") return "no client JS";
  return formatDelta(r.eager.deltaGz);
}

function changeText(r: RouteDiff): string {
  const p = percent(r.percent);
  return p === "" ? formatDelta(r.eager.deltaGz) : `${formatDelta(r.eager.deltaGz)} (${p})`;
}

function limitText(r: RouteDiff): string {
  const head = r.eager.head?.gz ?? 0;
  const growth = r.eager.deltaGz;
  const terms = r.failures.map((f) => {
    if (f.term === formatDelta(growth)) return `${f.term} (exact: ${growth > 0 ? "+" : ""}${growth} B)`;
    if (f.term === `<= ${formatBytes(head)}`) return `${f.term} (exact: ${head} B)`;
    return f.term;
  });
  return `limit ${terms.join(", ")}`;
}

function breaches(r: RouteDiff): { change: boolean; size: boolean } {
  return {
    change: r.failures.some((f) => f.kind !== "max-size"),
    size: r.failures.some((f) => f.kind === "max-size"),
  };
}

function extraParts(r: RouteDiff, minChange: number): string[] {
  const parts: string[] = [];
  if (Math.abs(r.async.deltaGz) >= minChange) parts.push(`async ${formatDelta(r.async.deltaGz)}`);
  if (Math.abs(r.other.deltaGz) >= minChange) parts.push(`unattributed ${formatDelta(r.other.deltaGz)}`);
  return parts;
}

function extraText(r: RouteDiff, minChange: number): string | undefined {
  const parts = extraParts(r, minChange);
  return parts.length > 0 ? `${parts.join(", ")} (not gated)` : undefined;
}

function routeCount(n: number): string {
  return `${n} route${n === 1 ? "" : "s"}`;
}

function statusText(result: ComparedDiff): string {
  const failed = result.totals.failed;
  return failed > 0 ? `bundle-gate: ${routeCount(failed)} over the limit` : "bundle-gate: all routes within limits";
}

function countsText(t: DiffTotals): string {
  const parts: Array<[number, string]> = [
    [t.changed, "changed"],
    [t.new, "new"],
    [t.removed, "removed"],
    [t.unchanged, "unchanged"],
    [t.noClient, "without client JS"],
  ];
  const counts = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  return `${routeCount(t.routes)}: ${counts.join(" · ")}`;
}

function isSmaller(r: RouteDiff): boolean {
  return !r.failed && !r.ignored && r.kind === "changed" && r.eager.deltaGz < 0;
}

function isOtherChange(r: RouteDiff, minChange: number): boolean {
  if (r.kind === "no-client") return false;
  return r.kind !== "unchanged" || extraText(r, minChange) !== undefined;
}

function byChange(routes: RouteDiff[]): RouteDiff[] {
  return [...routes].sort((a, b) => b.eager.deltaGz - a.eager.deltaGz);
}

interface Sections {
  failed: RouteDiff[];
  smaller: RouteDiff[];
  other: RouteDiff[];
}

function sections(result: ComparedDiff, all: boolean): Sections {
  const rest = result.routes.filter((r) => !r.failed && !isSmaller(r));
  const other = byChange(rest.filter((r) => isOtherChange(r, result.minChange)));
  if (all) {
    other.push(...byChange(rest.filter((r) => r.kind !== "no-client" && !isOtherChange(r, result.minChange))));
    other.push(...rest.filter((r) => r.kind === "no-client"));
  }
  return {
    failed: byChange(result.routes.filter((r) => r.failed)),
    smaller: byChange(result.routes.filter(isSmaller)),
    other,
  };
}

function otherTitle(all: boolean): string {
  return all ? "All other routes" : "Other changes";
}

interface ModuleList {
  name: "Eager" | "Async";
  change: SizeChange;
  rows: ModuleRow[];
  hidden: number;
}

function moduleLists(r: RouteDiff): ModuleList[] {
  const lists: ModuleList[] = [];
  if (r.modules !== undefined) {
    lists.push({ name: "Eager", change: r.eager, rows: r.modules, hidden: r.modulesHidden ?? 0 });
  }
  if (r.asyncModules !== undefined) {
    lists.push({ name: "Async", change: r.async, rows: r.asyncModules, hidden: r.asyncModulesHidden ?? 0 });
  }
  return lists.filter((list) => list.rows.length > 0 || list.hidden > 0);
}

function more(list: ModuleList): { label: string; gz: number } | undefined {
  if (list.hidden === 0) return undefined;
  return { label: `... ${list.hidden} more`, gz: list.rows.reduce((sum, m) => sum - m.gz, list.change.deltaGz) };
}

function moduleValue(r: RouteDiff, gz: number): string {
  return r.kind === "new" ? formatBytes(gz) : formatDelta(gz);
}

function pad(text: string, width: number, right = false): string {
  const fill = " ".repeat(Math.max(0, width - text.length));
  return right ? fill + text : text + fill;
}

function skippedParagraphs(result: Extract<DiffResult, { status: "skipped" }>): string[] {
  return result.reasons.map(
    (reason) => `bundle-gate skipped the comparison: ${reason} No route was judged; this is not a failure.`,
  );
}

function sign(r: RouteDiff): string {
  if (r.failed) return FAIL;
  if (r.kind === "new") return "+";
  if (r.kind === "removed") return "-";
  if (r.kind === "changed") return r.eager.deltaGz < 0 ? "↓" : "↑";
  return "·";
}

function textCells(r: RouteDiff): string[] {
  if (r.kind === "no-client") return [r.route];
  return [r.route, size(r.eager.base, "-"), size(r.eager.head, "-"), deltaText(r), percent(r.percent)];
}

function textRow(r: RouteDiff, widths: number[], minChange: number, color: boolean | undefined): string {
  if (r.kind === "no-client") return `${sign(r)} ${pad(r.route, widths[0]!)}  ${NO_CLIENT_NOTE}`;
  const [route, b, a, d, p] = textCells(r).map((c, i) => pad(c, widths[i]!, i > 0));
  const hit = breaches(r);
  const smaller = isSmaller(r);
  const changeStyle = smaller ? GOOD : BAD;
  const highlightChange = color && (smaller || hit.change);
  const row = [
    `${paint(color && (r.failed || smaller), r.failed ? "red" : GOOD, sign(r))} ${paint(color && r.failed, "bold", route!)}`,
    `${b} → ${paint(color && hit.size, BAD, a!)}`,
    paint(highlightChange, changeStyle, d!),
    paint(highlightChange, changeStyle, p!),
  ];
  if (r.failed) row.push(limitText(r));
  const extra = extraText(r, minChange);
  if (extra !== undefined) row.push(paint(color, "dim", extra));
  if (r.ignored) row.push(paint(color, "dim", "(ignored)"));
  return row.join("  ").trimEnd();
}

function textModules(r: RouteDiff, list: ModuleList): string[] {
  const prefix = list.name === "Async" ? "async " : "";
  const items = list.rows.map((m) => [`${prefix}${displaySource(m.source)}`, moduleValue(r, m.gz)] as const);
  const rest = more(list);
  if (rest !== undefined) items.push([`${prefix}${rest.label}`, moduleValue(r, rest.gz)]);
  const nameWidth = Math.max(...items.map(([name]) => name.length));
  const valueWidth = Math.max(...items.map(([, value]) => value.length));
  return items.map(([name, value]) => `    ${pad(name, nameWidth)}  ${pad(value, valueWidth, true)}`);
}

export function formatText(result: DiffResult, opts: FormatOptions): string {
  if (result.status === "skipped") return `${skippedParagraphs(result).join("\n\n")}\n`;

  const { color } = opts;
  const failed = result.totals.failed > 0;
  const lines: string[] = [
    paint(color, failed ? BAD : GOOD, `${failed ? FAIL : OK} ${statusText(result)}`),
    paint(color, "dim", `  Next ${nextLabel(result)} · eager client JS, gzip · ${label(result.base)} → ${label(result.head)}`),
  ];
  const s = sections(result, opts.all);
  const cells = [...s.failed, ...s.smaller, ...s.other].map(textCells);
  const widths = [0, 1, 2, 3, 4].map((i) => Math.max(0, ...cells.map((c) => c[i]?.length ?? 0)));
  const groups: Array<[string, RouteDiff[]]> = [
    ["Over the limit", s.failed],
    ["Smaller", s.smaller],
    [otherTitle(opts.all), s.other],
  ];
  for (const [title, routes] of groups) {
    if (routes.length === 0) continue;
    lines.push("", paint(color, "bold", title));
    for (const r of routes) {
      lines.push(textRow(r, widths, result.minChange, color));
      if (opts.all || r.failed) for (const list of moduleLists(r)) lines.push(...textModules(r, list));
    }
  }
  lines.push("", paint(color, "dim", countsText(result.totals)));
  return `${lines.join("\n")}\n`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

function tableLine(cells: string[]): string {
  return `|${cells.map((c) => (c === "" ? " " : ` ${c} `)).join("|")}|`;
}

function extraTail(r: RouteDiff, minChange: number): string {
  const extra = extraText(r, minChange);
  return extra === undefined ? "" : ` · ${extra}`;
}

function cautionItem(r: RouteDiff, minChange: number): string {
  const hit = breaches(r);
  const values: string[] = [];
  if (hit.change) values.push(`**${changeText(r)}**`);
  if (hit.size) values.push(`**${size(r.eager.head, "-")}**`);
  return `> - **${code(r.route)}**: ${values.join(", ")}, ${limitText(r)} · ${sizes(r.eager)}${extraTail(r, minChange)}`;
}

function tipItem(r: RouteDiff, minChange: number): string {
  return `> - **${code(r.route)}**: **${changeText(r)}** · ${sizes(r.eager)}${extraTail(r, minChange)}`;
}

function tableRow(r: RouteDiff, minChange: number): string {
  const note = r.kind === "no-client" ? ["not gated"] : extraParts(r, minChange);
  if (r.ignored) note.push("ignored");
  return tableLine([
    cell(code(r.route)),
    size(r.eager.base, ""),
    size(r.eager.head, ""),
    deltaText(r),
    percent(r.percent),
    note.join(", "),
  ]);
}

function listSummary(r: RouteDiff, list: ModuleList): string {
  const name = list.name.toLowerCase();
  if (r.kind === "new") return `${name} ${size(list.change.head, "-")}`;
  return `${name} ${sizes(list.change)}, ${formatDelta(list.change.deltaGz)}`;
}

function moduleTable(r: RouteDiff, list: ModuleList): string[] {
  const isNew = r.kind === "new";
  const columns = isNew ? ["Size"] : ["Change", "Before", "After"];
  const lines = [tableLine([`${list.name} module`, ...columns]), `|---${"|---:".repeat(columns.length)}|`];
  for (const m of list.rows) {
    const cells = [cell(code(displaySource(m.source))), moduleValue(r, m.gz)];
    if (!isNew) cells.push(formatBytes(m.baseGz), formatBytes(m.headGz));
    lines.push(tableLine(cells));
  }
  const rest = more(list);
  if (rest !== undefined) {
    lines.push(tableLine([rest.label, moduleValue(r, rest.gz), ...columns.slice(1).map(() => "")]));
  }
  return lines;
}

function warningBlock(warnings: string[]): string[] {
  return ["> [!WARNING]", ...warnings.map((w) => `> - ${w}`)];
}

export function formatMarkdown(result: DiffResult, opts: FormatOptions): string {
  if (result.status === "skipped") {
    const out = [
      "### bundle-gate: comparison skipped",
      "",
      "> [!NOTE]",
      skippedParagraphs(result)
        .map((p) => `> ${p}`)
        .join("\n>\n"),
    ];
    if (result.warnings.length > 0) out.push("", ...warningBlock(result.warnings));
    return `${out.join("\n")}\n`;
  }

  const { minChange } = result;
  const failed = result.totals.failed > 0;
  const out: string[] = [
    `### ${failed ? "❌" : "✅"} ${statusText(result)}`,
    "",
    `Next ${nextLabel(result)} · eager client JS, gzip · ${code(label(result.base))} → ${code(label(result.head))}`,
    "",
  ];
  const s = sections(result, opts.all);
  if (s.failed.length > 0) out.push("> [!CAUTION]", ...s.failed.map((r) => cautionItem(r, minChange)), "");
  if (s.smaller.length > 0) {
    out.push(
      "> [!TIP]",
      `> **${routeCount(s.smaller.length)} got smaller**`,
      ">",
      ...s.smaller.map((r) => tipItem(r, minChange)),
      "",
    );
  }
  if (s.other.length > 0) {
    out.push(
      `**${otherTitle(opts.all)}**`,
      "",
      "| Route | Before | After | Change | % | Note |",
      "|---|---:|---:|---:|---:|---|",
      ...s.other.map((r) => tableRow(r, minChange)),
      "",
    );
  }
  out.push(countsText(result.totals), "");

  const detailed = [...s.failed, ...s.smaller, ...s.other].filter((r) => moduleLists(r).length > 0);
  if (detailed.length > 0) {
    out.push(`<details><summary>${escapeHtml(`Module changes for ${routeCount(detailed.length)}`)}</summary>`, "");
    for (const r of detailed) {
      const lists = moduleLists(r);
      const summary = [...(r.kind === "new" ? ["new"] : []), ...lists.map((list) => listSummary(r, list))];
      out.push(`**${code(r.route)}** · ${summary.join(", ")}`, "");
      for (const list of lists) out.push(...moduleTable(r, list), "");
    }
    out.push("</details>", "");
  }

  if (failed) out.push(REPORT_NOTE, "");
  if (result.warnings.length > 0) out.push(...warningBlock(result.warnings), "");
  return `${out.join("\n").trimEnd()}\n`;
}

export function formatJson(result: DiffResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
