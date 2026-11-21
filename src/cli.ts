#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { runAnalyzer } from "./analyzer.ts";
import { diffSnapshots, type DiffResult } from "./diff.ts";
import { formatJson, formatMarkdown, formatText } from "./format.ts";
import { parseConfig } from "./rules.ts";
import { parseSize } from "./size.ts";
import { readSnapshot, writeSnapshot } from "./snapshot.ts";
import type { Config } from "./types.ts";

const DEFAULT_CONFIG = "bundle-gate.config.json";

const USAGE = `bundle-gate: stop Next.js routes from growing by accident.

Usage:
  bundle-gate snapshot [options]          run the Next analyzer and save a snapshot
  bundle-gate diff <base> <head> [options] compare two snapshots and judge each route

snapshot options:
  --dir <app>          app directory (default: current directory)
  --name <name>        snapshot name (default: head)
  --out <file>         output file (default: bundle-gate-<name>.json.gz)
  --dist-dir <dir>     Next distDir, if not .next
  --prepare <cmd>      shell command to run in the app directory first
  --app-dir-only       pass --experimental-app-only to next analyze
  --no-mangling        pass --no-mangling to next analyze

diff options:
  --config <file>      rules file (default: ${DEFAULT_CONFIG} if it exists)
  --format <f>         text | markdown | json (default: text)
  --output <file>      write the formatted result to a file (text still goes to stdout)
  --top <n>            module rows per route (default: 5)
  --min-change <size>  smaller changes are shown as unchanged (default: 100 B)
  --all                also list unchanged routes
  --no-fail            exit 0 even when a route is over its limit
  --annotations <l>    GitHub annotation per failing route: error | warning | off (default: error)

Exit codes: 0 pass or skipped, 1 a route is over its limit, 2 error.
`;

class UsageError extends Error {
  override name = "UsageError";
}

const io = {
  out: (text: string) => process.stdout.write(text),
  err: (line: string) => process.stderr.write(`${line}\n`),
};

const inActions = process.env.GITHUB_ACTIONS === "true";

/** Escape a message for a GitHub workflow command. */
function annotation(kind: "error" | "warning", message: string): string {
  const data = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::${kind}::${data}`;
}

function warn(message: string): void {
  io.err(`warning: ${message}`);
  if (inActions) io.err(annotation("warning", message));
}

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

async function snapshotCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    dir: { type: "string" },
    out: { type: "string" },
    name: { type: "string" },
    "dist-dir": { type: "string" },
    prepare: { type: "string" },
    "app-dir-only": { type: "boolean" },
    "no-mangling": { type: "boolean" },
  });
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (positionals.length > 0) throw new UsageError(`snapshot takes no arguments, got "${positionals[0]}"`);
  const name = values.name ?? "head";
  if (name === "") throw new UsageError("--name must not be empty");
  const out = resolve(values.out ?? `bundle-gate-${name}.json.gz`);

  const opts: Parameters<typeof runAnalyzer>[0] = { dir: values.dir ?? ".", name };
  if (values["dist-dir"] !== undefined) opts.distDir = values["dist-dir"];
  if (values.prepare !== undefined) opts.prepare = values.prepare;
  if (values["app-dir-only"]) opts.appDirOnly = true;
  if (values["no-mangling"]) opts.noMangling = true;

  const { snapshot } = await runAnalyzer(opts);
  await writeSnapshot(out, snapshot);
  io.err(`snapshot written: ${out} (${Object.keys(snapshot.routes).length} routes)`);
  return 0;
}

async function loadConfig(path: string | undefined): Promise<Config> {
  const file = path ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined);
  if (file === undefined) return { rules: [] };
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read config ${file}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`config ${file}: invalid JSON: ${(e as Error).message}`);
  }
  try {
    return parseConfig(json);
  } catch (e) {
    throw new Error(`config ${file}: ${(e as Error).message}`);
  }
}

function render(result: DiffResult, format: string, all: boolean): string {
  if (format === "markdown") return formatMarkdown(result, { all });
  if (format === "json") return formatJson(result);
  return formatText(result, { all });
}

async function diffCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    config: { type: "string" },
    format: { type: "string" },
    output: { type: "string" },
    top: { type: "string" },
    all: { type: "boolean" },
    "no-fail": { type: "boolean" },
    "min-change": { type: "string" },
    annotations: { type: "string" },
  });
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (positionals.length !== 2) {
    throw new UsageError(`diff needs two snapshot files: bundle-gate diff <base> <head>`);
  }
  const format = values.format ?? "text";
  if (!["text", "markdown", "json"].includes(format)) {
    throw new UsageError(`--format must be text, markdown or json, got "${format}"`);
  }
  const level = values.annotations ?? "error";
  if (level !== "error" && level !== "warning" && level !== "off") {
    throw new UsageError(`--annotations must be error, warning or off, got "${level}"`);
  }
  let top = 5;
  if (values.top !== undefined) {
    if (!/^\d+$/.test(values.top)) throw new UsageError(`--top must be a whole number, got "${values.top}"`);
    top = Number(values.top);
  }
  let minChange = 100;
  if (values["min-change"] !== undefined) {
    try {
      minChange = parseSize(values["min-change"]);
    } catch (e) {
      throw new UsageError(`--min-change: ${(e as Error).message}`);
    }
  }

  const config = await loadConfig(values.config);
  const [base, head] = await Promise.all(positionals.map((p) => readSnapshot(p)));
  const result = diffSnapshots(base!, head!, config, { top, minChange });
  const all = values.all ?? false;

  for (const w of result.warnings) warn(w);
  if (result.status === "skipped") {
    for (const reason of result.reasons) warn(`comparison skipped: ${reason}`);
  } else if (inActions && level !== "off") {
    for (const r of result.routes) {
      if (!r.failed) continue;
      const why = r.failures.map((f) => f.message).join("; ");
      io.err(annotation(level, `bundle-gate: ${r.route} is over its limit (${r.rule}): ${why}`));
    }
  }

  if (values.output !== undefined) {
    await writeFile(values.output, render(result, format, all));
    io.out(formatText(result, { all }));
  } else {
    io.out(render(result, format, all));
  }

  const breached = result.status === "compared" && result.totals.failed > 0;
  return breached && !values["no-fail"] ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return 0;
  }
  if (command === "snapshot") return snapshotCommand(rest);
  if (command === "diff") return diffCommand(rest);
  throw new UsageError(`unknown command "${command}"`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  const err = e as Error;
  if (process.env.BUNDLE_GATE_DEBUG) io.err(err.stack ?? String(err));
  io.err(`bundle-gate: ${err.message ?? String(err)}`);
  if (err instanceof UsageError) io.err(`Run "bundle-gate --help" for usage.`);
  process.exitCode = 2;
}
