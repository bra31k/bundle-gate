import type { ComparedDiff, DiffResult, DiffSide, ModuleRow, RouteDiff } from "./diff.ts";
import { formatBytes, formatDelta } from "./size.ts";

export interface FormatOptions {
  all: boolean;
}

const FAIL = "✗";
const OK = "✓";
const REPORT_NOTE =
  "Download the analyzer report artifact, then run `npx serve <folder>` and open the compare view.";

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

function shown(r: RouteDiff, all: boolean): boolean {
  if (r.kind === "no-client") return false;
  return all || r.failed || r.kind !== "unchanged";
}

const NO_CLIENT_NOTE = "no client JS (not gated)";

function noClientRoutes(result: ComparedDiff, all: boolean): RouteDiff[] {
  return all ? result.routes.filter((r) => r.kind === "no-client") : [];
}

function before(r: RouteDiff): string {
  return r.eager.base ? formatBytes(r.eager.base.gz) : "-";
}

function after(r: RouteDiff): string {
  return r.eager.head ? formatBytes(r.eager.head.gz) : "-";
}

function deltaText(r: RouteDiff): string {
  if (r.kind === "new") return "new";
  if (r.kind === "removed") return "removed";
  return formatDelta(r.eager.deltaGz);
}

function failureText(r: RouteDiff): string[] {
  return r.failures.map((f) => {
    const head = r.eager.head?.gz ?? 0;
    const growth = r.eager.deltaGz;
    let exact = "";
    if (f.term === formatDelta(growth)) exact = ` (exact: ${growth > 0 ? "+" : ""}${growth} B)`;
    else if (f.term === `<= ${formatBytes(head)}`) exact = ` (exact: ${head} B)`;
    return `${f.message}${exact}`;
  });
}

function extraText(r: RouteDiff, minChange: number): string | undefined {
  const parts: string[] = [];
  if (Math.abs(r.async.deltaGz) >= minChange) parts.push(`async ${formatDelta(r.async.deltaGz)}`);
  if (Math.abs(r.other.deltaGz) >= minChange) parts.push(`unattributed ${formatDelta(r.other.deltaGz)}`);
  return parts.length > 0 ? `${parts.join(", ")} (not gated)` : undefined;
}

function moduleSign(m: ModuleRow): string {
  return m.gz < 0 ? "-" : "+";
}

function footer(result: ComparedDiff, all: boolean): string {
  const t = result.totals;
  const hidden = all ? 0 : result.routes.filter((r) => r.kind === "unchanged" && !shown(r, all)).length;
  const parts = [
    `${t.failed} failed`,
    `${t.changed} changed`,
    `${t.new} new`,
    `${t.removed} removed`,
    `${t.unchanged} unchanged${hidden > 0 ? ` (${hidden} hidden, --all shows them)` : ""}`,
  ];
  if (t.noClient > 0) {
    parts.push(`${t.noClient} route${t.noClient === 1 ? "" : "s"} without client JS (not gated)`);
  }
  return parts.join(" · ");
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

export function formatText(result: DiffResult, opts: FormatOptions): string {
  if (result.status === "skipped") return `${skippedParagraphs(result).join("\n\n")}\n`;

  const lines: string[] = [
    `bundle-gate  Next ${nextLabel(result)} · eager client JS (gzip)`,
    `${label(result.base)} -> ${label(result.head)}`,
    "",
  ];
  const routes = result.routes.filter((r) => shown(r, opts.all));
  const cols = routes.map((r) => [r.route, before(r), after(r), deltaText(r), percent(r.percent)] as const);
  const width = [0, 1, 2, 3, 4].map((i) => Math.max(0, ...cols.map((c) => c[i]!.length)));

  routes.forEach((r, i) => {
    const [route, b, a, d, p] = cols[i]!;
    let line = `${r.failed ? FAIL : OK} ${pad(route, width[0]!)}  ${pad(b, width[1]!, true)} -> ${pad(a, width[2]!, true)}  ${pad(d, width[3]!, true)}  ${pad(p, width[4]!, true)}`;
    if (r.ignored) line += "  (ignored)";
    lines.push(line.trimEnd());
    if (r.failed) {
      lines.push(`    rule ${r.rule}: ${failureText(r).join("; ")}`);
    }
    const extra = extraText(r, result.minChange);
    if (extra !== undefined) lines.push(`    ${extra}`);
    if ((r.failed || r.kind === "new") && r.modules !== undefined) {
      const mw = Math.max(0, ...r.modules.map((m) => displaySource(m.source).length));
      for (const m of r.modules) {
        const size = r.kind === "new" ? formatBytes(m.headGz) : formatDelta(m.gz);
        lines.push(`    ${moduleSign(m)} ${pad(displaySource(m.source), mw)}  ${size}`);
      }
      if (r.modulesHidden) lines.push(`    ... ${r.modulesHidden} more`);
    }
  });

  for (const r of noClientRoutes(result, opts.all)) lines.push(`- ${r.route}  ${NO_CLIENT_NOTE}`);

  if (lines.length > 3) lines.push("");
  lines.push(footer(result, opts.all));
  return `${lines.join("\n")}\n`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

export function formatMarkdown(result: DiffResult, opts: FormatOptions): string {
  if (result.status === "skipped") {
    const out = ["### bundle-gate: comparison skipped", "", ...skippedParagraphs(result).map((p) => `> ${p}`)];
    for (const w of result.warnings) out.push("", `> warning: ${w}`);
    return `${out.join("\n")}\n`;
  }

  const failed = result.totals.failed;
  const title =
    failed > 0 ? `${FAIL} ${failed} route${failed === 1 ? "" : "s"} over the limit` : `${OK} all routes within limits`;
  const out: string[] = [
    `### bundle-gate: ${title}`,
    "",
    `Next ${nextLabel(result)} · eager client JS (gzip) · ${code(label(result.base))} -> ${code(label(result.head))}`,
    "",
  ];

  const routes = result.routes.filter((r) => shown(r, opts.all));
  if (routes.length > 0) {
    out.push("| | Route | Before | After | Delta | % | Rule |", "|---|---|---:|---:|---:|---:|---|");
    for (const r of routes) {
      let rule = r.rule ?? "";
      if (r.failed) rule += `: ${failureText(r).join("; ")}`;
      else if (r.ignored) rule += " (ignored)";
      const extra = extraText(r, result.minChange);
      if (extra !== undefined) rule += `${rule ? "<br>" : ""}${extra}`;
      out.push(
        `| ${r.failed ? FAIL : OK} | ${cell(code(r.route))} | ${before(r)} | ${after(r)} | ${deltaText(r)} | ${percent(r.percent)} | ${cell(rule)} |`,
      );
    }
    out.push("");
  }
  const noClient = noClientRoutes(result, opts.all);
  for (const r of noClient) out.push(`- ${code(r.route)}  ${NO_CLIENT_NOTE}`);
  if (noClient.length > 0) out.push("");
  out.push(footer(result, opts.all), "");

  for (const r of routes) {
    if (!(r.failed || r.kind === "new") || r.modules === undefined || r.modules.length === 0) continue;
    const what = r.kind === "new" ? "heaviest modules" : "module changes";
    out.push(`<details><summary>${r.failed ? FAIL : OK} <code>${escapeHtml(r.route)}</code>: ${what}</summary>`, "");
    out.push("| Module | Delta | Before | After |", "|---|---:|---:|---:|");
    for (const m of r.modules) {
      out.push(
        `| ${cell(code(displaySource(m.source)))} | ${formatDelta(m.gz)} | ${formatBytes(m.baseGz)} | ${formatBytes(m.headGz)} |`,
      );
    }
    if (r.modulesHidden) out.push(`| ... ${r.modulesHidden} more | | | |`);
    out.push("", "</details>", "");
  }

  if (failed > 0) out.push(REPORT_NOTE, "");
  for (const w of result.warnings) out.push(`> warning: ${w}`, "");
  return `${out.join("\n").trimEnd()}\n`;
}

export function formatJson(result: DiffResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
