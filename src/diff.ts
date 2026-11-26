import { judge, lintRules, resolveRule, type Failure } from "./rules.ts";
import { diffModules, routeModules, routeSize, type RouteSize } from "./snapshot.ts";
import type { Config, Size, Snapshot } from "./types.ts";

export interface DiffOptions {
  minChange?: number;
  top?: number;
}

export interface DiffSide {
  name: string;
  nextVersion: string;
  createdAt: string;
  commit?: string;
}

export interface SizeChange {
  base?: Size;
  head?: Size;
  deltaGz: number;
}

export interface ModuleRow {
  source: string;
  gz: number;
  raw: number;
  baseGz: number;
  headGz: number;
}

export type RouteKind = "changed" | "unchanged" | "new" | "removed" | "no-client";

export interface RouteDiff {
  route: string;
  kind: RouteKind;
  eager: SizeChange;
  async: SizeChange;
  other: SizeChange;
  percent: number | null;
  rule?: string;
  ignored: boolean;
  failed: boolean;
  failures: Failure[];
  modules?: ModuleRow[];
  modulesHidden?: number;
  asyncModules?: ModuleRow[];
  asyncModulesHidden?: number;
}

export interface DiffTotals {
  routes: number;
  failed: number;
  changed: number;
  new: number;
  removed: number;
  unchanged: number;
  noClient: number;
}

export interface ComparedDiff {
  schemaVersion: 1;
  status: "compared";
  base: DiffSide;
  head: DiffSide;
  minChange: number;
  routes: RouteDiff[];
  totals: DiffTotals;
  warnings: string[];
}

export interface SkippedDiff {
  schemaVersion: 1;
  status: "skipped";
  base: DiffSide;
  head: DiffSide;
  reasons: string[];
  warnings: string[];
}

export type DiffResult = ComparedDiff | SkippedDiff;

function side(s: Snapshot): DiffSide {
  const out: DiffSide = { name: s.meta.snapshotName, nextVersion: s.meta.nextVersion, createdAt: s.meta.createdAt };
  if (s.meta.commit !== undefined) out.commit = s.meta.commit;
  return out;
}

export function incomparableReasons(base: Snapshot, head: Snapshot): string[] {
  const b = base.meta;
  const h = head.meta;
  const reasons: string[] = [];
  if (b.nextVersion !== h.nextVersion) {
    reasons.push(
      `Next versions differ (base ${b.nextVersion}, head ${h.nextVersion}). ` +
        "A Next upgrade changes the framework chunks of every route, so sizes are not compared.",
    );
  }
  if (b.analyzerSchemaVersion !== h.analyzerSchemaVersion) {
    reasons.push(
      `Analyzer export schema versions differ (base ${b.analyzerSchemaVersion}, head ${h.analyzerSchemaVersion}).`,
    );
  }
  if (b.appDirOnly !== h.appDirOnly) {
    reasons.push(
      `Analyzer flag --experimental-app-only differs (base ${b.appDirOnly}, head ${h.appDirOnly}). ` +
        "Use the same flags on both sides.",
    );
  }
  if (b.noMangling !== h.noMangling) {
    reasons.push(
      `Analyzer flag --no-mangling differs (base ${b.noMangling}, head ${h.noMangling}). ` +
        "Use the same flags on both sides.",
    );
  }
  return reasons;
}

function hasEager(s: Snapshot, route: string): boolean {
  return Object.hasOwn(s.routes, route) && s.routes[route]!.eager.length > 0;
}

function change(base: Size | undefined, head: Size | undefined): SizeChange {
  const out: SizeChange = { deltaGz: (head?.gz ?? 0) - (base?.gz ?? 0) };
  if (base !== undefined) out.base = base;
  if (head !== undefined) out.head = head;
  return out;
}

function rows(deltas: ModuleRow[], top: number): { modules: ModuleRow[]; modulesHidden: number } {
  return { modules: deltas.slice(0, top), modulesHidden: Math.max(0, deltas.length - top) };
}

function toRow(d: { source: string; gz: number; raw: number; baseGz: number; headGz: number }): ModuleRow {
  return { source: d.source, gz: d.gz, raw: d.raw, baseGz: d.baseGz, headGz: d.headGz };
}

export function diffSnapshots(base: Snapshot, head: Snapshot, config: Config, opts: DiffOptions = {}): DiffResult {
  const minChange = opts.minChange ?? 100;
  const top = opts.top ?? 10;
  const names = [...new Set([...Object.keys(base.routes), ...Object.keys(head.routes)])].sort();
  const warnings = lintRules(config, names);

  const reasons = incomparableReasons(base, head);
  if (reasons.length > 0) {
    return { schemaVersion: 1, status: "skipped", base: side(base), head: side(head), reasons, warnings };
  }

  const routes: RouteDiff[] = [];
  for (const route of names) {
    const inBase = Object.hasOwn(base.routes, route);
    const inHead = Object.hasOwn(head.routes, route);
    const b: RouteSize | undefined = inBase ? routeSize(base, route) : undefined;
    const h: RouteSize | undefined = inHead ? routeSize(head, route) : undefined;
    const eagerBase = inBase && hasEager(base, route);
    const eagerHead = inHead && hasEager(head, route);

    if ((inBase && !eagerBase) || (inHead && !eagerHead)) {
      if (eagerBase || eagerHead) {
        warnings.push(`route ${route} has client assets in ${eagerBase ? "base" : "head"} only, not gated`);
      }
      const eager: SizeChange = { deltaGz: 0 };
      if (eagerBase) eager.base = b!.eager;
      if (eagerHead) eager.head = h!.eager;
      routes.push({
        route,
        kind: "no-client",
        eager,
        async: change(b?.async, h?.async),
        other: change(b?.other, h?.other),
        percent: null,
        ignored: false,
        failed: false,
        failures: [],
      });
      continue;
    }

    const entry: RouteDiff = {
      route,
      kind: "unchanged",
      eager: change(b?.eager, h?.eager),
      async: change(b?.async, h?.async),
      other: change(b?.other, h?.other),
      percent: null,
      ignored: false,
      failed: false,
      failures: [],
    };

    if (h === undefined) {
      entry.kind = "removed";
      routes.push(entry);
      continue;
    }

    const { limit, rule } = resolveRule(config, route);
    entry.rule = rule;
    entry.ignored = limit === "ignore";
    entry.failures = judge(limit, b?.eager.gz, h.eager.gz);
    entry.failed = entry.failures.length > 0;

    if (b === undefined) {
      entry.kind = "new";
      const heaviest = diffModules(new Map(), routeModules(head, route, "eager")).map(toRow);
      Object.assign(entry, rows(heaviest, top));
      const heaviestAsync = rows(diffModules(new Map(), routeModules(head, route, "async")).map(toRow), top);
      entry.asyncModules = heaviestAsync.modules;
      entry.asyncModulesHidden = heaviestAsync.modulesHidden;
    } else {
      const delta = h.eager.gz - b.eager.gz;
      entry.kind = Math.abs(delta) < minChange ? "unchanged" : "changed";
      if (b.eager.gz > 0) entry.percent = (delta / b.eager.gz) * 100;
      if (entry.kind === "changed" || entry.failed) {
        const deltas = diffModules(routeModules(base, route, "eager"), routeModules(head, route, "eager"))
          .filter((m) => Math.abs(m.gz) >= minChange)
          .map(toRow);
        Object.assign(entry, rows(deltas, top));
      }
      if (Math.abs(entry.async.deltaGz) >= minChange) {
        const deltas = diffModules(routeModules(base, route, "async"), routeModules(head, route, "async"))
          .filter((m) => Math.abs(m.gz) >= minChange)
          .map(toRow);
        const changed = rows(deltas, top);
        entry.asyncModules = changed.modules;
        entry.asyncModulesHidden = changed.modulesHidden;
      }
    }
    routes.push(entry);
  }

  const totals: DiffTotals = {
    routes: routes.length,
    failed: 0,
    changed: 0,
    new: 0,
    removed: 0,
    unchanged: 0,
    noClient: 0,
  };
  for (const r of routes) {
    totals[r.kind === "no-client" ? "noClient" : r.kind]++;
    if (r.failed) totals.failed++;
  }

  return { schemaVersion: 1, status: "compared", base: side(base), head: side(head), minChange, routes, totals, warnings };
}
