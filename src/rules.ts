import { formatBytes, formatDelta, parseSize } from "./size.ts";
import type { Config, Limit, Rule, Term } from "./types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Failure {
  term: string;
  message: string;
}

const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

function parseTerm(raw: string): Term {
  const term = raw.trim();
  if (term === "") throw new ConfigError("empty term (stray comma?)");
  if (term === "ignore") throw new ConfigError(`"ignore" cannot be combined with other terms`);
  if (/\b(or|and)\b/i.test(term)) {
    throw new ConfigError(`bad term "${term}": "or"/"and" are not supported, separate terms with "," (all terms must hold)`);
  }
  try {
    if (term.startsWith("<=")) {
      return { kind: "max-size", maxBytes: parseSize(term.slice(2)) };
    }
    if (term.startsWith("+")) {
      const rest = term.slice(1).trim();
      if (rest.endsWith("%")) {
        const num = rest.slice(0, -1).trim();
        if (!NUMBER.test(num)) throw new Error(`invalid percentage "${rest}"`);
        return { kind: "growth-percent", maxPercent: Number(num) };
      }
      return { kind: "growth", maxBytes: parseSize(rest) };
    }
  } catch (e) {
    throw new ConfigError(`bad term "${term}": ${(e as Error).message}`);
  }
  throw new ConfigError(`bad term "${term}": expected "+<size>", "+<number>%" or "<=<size>"`);
}

export function parseLimit(input: string): Limit {
  if (input.trim() === "ignore") return "ignore";
  return input.split(",").map(parseTerm);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${path}: unknown key "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

export function parseConfig(json: unknown): Config {
  if (!isObject(json)) throw new ConfigError("config: must be an object");
  checkKeys(json, ["rules"], "config");
  const rawRules = json["rules"];
  if (!Array.isArray(rawRules)) throw new ConfigError("rules: must be an array");
  const rules: Rule[] = rawRules.map((raw: unknown, i): Rule => {
    const path = `rules[${i}]`;
    if (!isObject(raw)) throw new ConfigError(`${path}: must be an object`);
    checkKeys(raw, ["match", "limit"], path);

    const m = raw["match"];
    let match: string[];
    if (typeof m === "string") match = [m];
    else if (Array.isArray(m)) match = m as unknown[] as string[];
    else throw new ConfigError(`${path}.match: must be a string or an array of strings`);
    if (match.length === 0) throw new ConfigError(`${path}.match: must not be empty`);
    match.forEach((p: unknown, j) => {
      const where = Array.isArray(m) ? `${path}.match[${j}]` : `${path}.match`;
      if (typeof p !== "string") throw new ConfigError(`${where}: must be a string`);
      if (p === "") throw new ConfigError(`${where}: must not be empty`);
    });

    const l = raw["limit"];
    if (typeof l !== "string") throw new ConfigError(`${path}.limit: must be a string`);
    let limit: Limit;
    try {
      limit = parseLimit(l);
    } catch (e) {
      throw new ConfigError(`${path}.limit: ${(e as Error).message}`);
    }
    return { match, limit };
  });
  return { rules };
}

function segments(path: string): string[] {
  const s = path.startsWith("/") ? path.slice(1) : path;
  return s === "" ? [] : s.split("/");
}

/**
 * Whole-route match. A pattern segment "*" matches exactly one segment, "**" matches
 * zero or more segments, everything else is literal (including [ ] ( ) and .).
 * Partial wildcards such as "a*" are NOT supported: a "*" inside a longer segment is literal.
 */
export function matchRoute(pattern: string, route: string): boolean {
  const pat = segments(pattern);
  const rt = segments(route);
  const walk = (p: number, r: number): boolean => {
    if (p === pat.length) return r === rt.length;
    const seg = pat[p];
    if (seg === "**") {
      for (let k = r; k <= rt.length; k++) if (walk(p + 1, k)) return true;
      return false;
    }
    if (r === rt.length) return false;
    return (seg === "*" || seg === rt[r]) && walk(p + 1, r + 1);
  };
  return walk(0, 0);
}

const DEFAULT_LIMIT: Limit = [{ kind: "growth-percent", maxPercent: 2 }];

export function resolveRule(config: Config, route: string): { limit: Limit; rule: string } {
  for (let i = 0; i < config.rules.length; i++) {
    const rule = config.rules[i]!;
    const pattern = rule.match.find((p) => matchRoute(p, route));
    if (pattern !== undefined) return { limit: rule.limit, rule: `rules[${i}] "${pattern}"` };
  }
  return { limit: DEFAULT_LIMIT, rule: "default (+2%)" };
}

export function judge(limit: Limit, base: number | undefined, head: number): Failure[] {
  if (limit === "ignore") return [];
  const failures: Failure[] = [];
  for (const t of limit) {
    if (t.kind === "max-size") {
      if (head > t.maxBytes) {
        const term = `<= ${formatBytes(t.maxBytes)}`;
        failures.push({ term, message: `size ${formatBytes(head)}, limit ${term}` });
      }
      continue;
    }
    if (base === undefined) continue; // new route: growth terms do not apply
    const growth = head - base;
    if (t.kind === "growth") {
      if (growth > t.maxBytes) {
        const term = `+${formatBytes(t.maxBytes)}`;
        failures.push({ term, message: `grew ${formatDelta(growth)}, limit ${term}` });
      }
    } else {
      // growth * 100 > base * P, scaled to integers (P to 3 decimals)
      const fails = growth > 0 && growth * 100000 > base * Math.round(t.maxPercent * 1000);
      if (fails) {
        const term = `+${t.maxPercent}%`;
        const pct = base > 0 ? ` (+${((growth / base) * 100).toFixed(2)}%)` : "";
        failures.push({ term, message: `grew ${formatDelta(growth)}${pct}, limit ${term}` });
      }
    }
  }
  return failures;
}

/** True for a pattern that matches every route: its only segment is "**" ("**" and "/**"). */
function isCatchAll(pattern: string): boolean {
  const seg = segments(pattern);
  return seg.length === 1 && seg[0] === "**";
}

export function lintRules(config: Config, routes: string[]): string[] {
  const warnings: string[] = [];
  const catchAll = config.rules.findIndex((r) => r.match.some(isCatchAll));
  const catchAllPattern = catchAll === -1 ? undefined : config.rules[catchAll]!.match.find(isCatchAll);
  config.rules.forEach((rule, i) => {
    if (catchAll !== -1 && i > catchAll) {
      warnings.push(
        `rules[${i}] ${rule.match.map((p) => `"${p}"`).join(", ")}: unreachable, rules[${catchAll}] pattern "${catchAllPattern}" matches every route`,
      );
    }
    for (const p of rule.match) {
      if (!routes.some((r) => matchRoute(p, r))) {
        warnings.push(`rules[${i}] pattern "${p}": matches no route`);
      }
    }
  });
  return warnings;
}
