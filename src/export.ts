import type { ChunkPart, RouteChunks, Snapshot } from "./types.ts";

/** A problem with the analyzer export or a stored snapshot. Never a reason to count a size as zero. */
export class SnapshotError extends Error {
  override name = "SnapshotError";
}

export interface SnapshotInfo {
  snapshotName: string;
  nextVersion: string;
  appDirOnly: boolean;
  noMangling: boolean;
  createdAt: string;
  commit?: string;
  /** Path of the app inside the project root, e.g. "apps/web/" in a monorepo. */
  appDirPrefix?: string;
}

const CLIENT_PREFIX = "[client-fs]/";
const SCHEMA_VERSION = 1;
const EAGER_KINDS = new Set(["bootstrap", "render_dependent"]);

/** Order-independent summary of one route's parts of one chunk, used to check that every route sees the same chunk. */
interface Fingerprint {
  count: number;
  raw: number;
  gz: number;
  hash: number;
}

interface RouteState {
  groupCount: number;
  eager: string[];
  eagerSet: Set<string>;
  async: string[];
  asyncSet: Set<string>;
  /** Client chunks this route's part records reference, in first-seen order. */
  parts: Map<string, Fingerprint>;
}

interface ChunkBuild {
  /** The route whose part records define this chunk's stored parts. */
  owner: string;
  /** Source index -> merged part. */
  parts: Map<number, ChunkPart>;
}

/**
 * Turn the output of `next analyze export` (JSON Lines, schema_version 1) into a Snapshot.
 * Lines are processed one at a time; memory grows with the snapshot, not with the export.
 */
export async function buildSnapshot(
  lines: Iterable<string> | AsyncIterable<string>,
  info: SnapshotInfo,
): Promise<Snapshot> {
  const sources: string[] = [];
  const sourceIndex = new Map<string, number>();
  const chunks = new Map<string, ChunkBuild>();
  const routes = new Map<string, RouteState>();

  const routeState = (route: string): RouteState => {
    let state = routes.get(route);
    if (state === undefined) {
      state = {
        groupCount: 0,
        eager: [],
        eagerSet: new Set(),
        async: [],
        asyncSet: new Set(),
        parts: new Map(),
      };
      routes.set(route, state);
    }
    return state;
  };

  const sourceId = (sourcePath: string): number => {
    const key = normalizeSource(sourcePath, info.appDirPrefix);
    let idx = sourceIndex.get(key);
    if (idx === undefined) {
      idx = sources.length;
      sources.push(key);
      sourceIndex.set(key, idx);
    }
    return idx;
  };

  let lineNo = 0;
  let sawMeta = false;
  for await (const line of lines) {
    lineNo++;
    if (line.trim() === "") continue;

    if (sawMeta && isSkippedRecord(line)) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new SnapshotError(`analyzer export line ${lineNo}: invalid JSON`);
    }
    if (!isObject(record) || typeof record.type !== "string") {
      throw new SnapshotError(`analyzer export line ${lineNo}: record without a "type"`);
    }

    if (!sawMeta) {
      if (record.type !== "meta") {
        throw new SnapshotError(
          `analyzer export line ${lineNo}: expected a "meta" record first, got "${record.type}"`,
        );
      }
      if (record.schema_version !== SCHEMA_VERSION) {
        throw new SnapshotError(
          `unsupported analyzer schema_version ${String(record.schema_version)}, expected ${SCHEMA_VERSION}`,
        );
      }
      sawMeta = true;
      continue;
    }

    switch (record.type) {
      case "meta":
        throw new SnapshotError(`analyzer export line ${lineNo}: unexpected second "meta" record`);

      case "route": {
        if (typeof record.route !== "string") badRecord(lineNo, "route", "route");
        routeState(record.route);
        break;
      }

      case "group": {
        const { route, kind, outputs } = record;
        if (typeof route !== "string") badRecord(lineNo, "group", "route");
        if (typeof kind !== "string") badRecord(lineNo, "group", "kind");
        if (!isStringArray(outputs)) badRecord(lineNo, "group", "outputs");
        const state = routeState(route);
        state.groupCount++;
        let target: { list: string[]; set: Set<string> };
        if (EAGER_KINDS.has(kind)) target = { list: state.eager, set: state.eagerSet };
        else if (kind === "async") target = { list: state.async, set: state.asyncSet };
        else {
          throw new SnapshotError(
            `analyzer export line ${lineNo}: unknown group kind "${kind}" in route ${route}`,
          );
        }
        for (const output of outputs) {
          if (!output.startsWith(CLIENT_PREFIX)) continue;
          const file = output.slice(CLIENT_PREFIX.length);
          if (!target.set.has(file)) {
            target.set.add(file);
            target.list.push(file);
          }
        }
        break;
      }

      case "part": {
        const { route, filename, source_path: sourcePath, size, compressed_size: gz } = record;
        if (typeof filename !== "string") badRecord(lineNo, "part", "filename");
        if (!filename.startsWith(CLIENT_PREFIX)) break;
        if (typeof route !== "string") badRecord(lineNo, "part", "route");
        if (typeof sourcePath !== "string") badRecord(lineNo, "part", "source_path");
        if (!isByteCount(size)) badRecord(lineNo, "part", "size");
        if (!isByteCount(gz)) badRecord(lineNo, "part", "compressed_size");
        const file = filename.slice(CLIENT_PREFIX.length);

        const state = routeState(route);
        let fp = state.parts.get(file);
        if (fp === undefined) {
          fp = { count: 0, raw: 0, gz: 0, hash: 0 };
          state.parts.set(file, fp);
        }
        fp.count++;
        fp.raw += size;
        fp.gz += gz;
        fp.hash = (fp.hash + fnv1a(`${sourcePath}\0${size}\0${gz}`)) >>> 0;

        let chunk = chunks.get(file);
        if (chunk === undefined) {
          chunk = { owner: route, parts: new Map() };
          chunks.set(file, chunk);
        }
        if (chunk.owner === route) {
          const src = sourceId(sourcePath);
          const part = chunk.parts.get(src);
          if (part === undefined) chunk.parts.set(src, [src, size, gz]);
          else {
            part[1] += size;
            part[2] += gz;
          }
        }
        break;
      }

      default:
        // module, output and future record types carry nothing we measure.
        break;
    }
  }

  if (!sawMeta) throw new SnapshotError("analyzer export is empty");

  // Every route must see a chunk with exactly the parts of the route that defined it.
  const reference = new Map<string, { route: string; fp: Fingerprint }>();
  for (const [route, state] of routes) {
    for (const [file, fp] of state.parts) {
      const ref = reference.get(file);
      if (ref === undefined) reference.set(file, { route, fp });
      else if (!sameFingerprint(ref.fp, fp)) {
        throw new SnapshotError(
          `chunk ${file} has different parts in routes ${ref.route} and ${route}`,
        );
      }
    }
  }

  const routeOut: Record<string, RouteChunks> = {};
  for (const [route, state] of routes) {
    if (state.groupCount === 0 && state.parts.size > 0) {
      throw new SnapshotError(`route ${route} has client part records but no groups`);
    }
    const async = state.async.filter((file) => !state.eagerSet.has(file));
    for (const file of [...state.eager, ...async]) {
      if (!state.parts.has(file)) {
        throw new SnapshotError(`route ${route}: chunk ${file} is in a group but has no part records`);
      }
    }
    const other = [...state.parts.keys()].filter(
      (file) => !state.eagerSet.has(file) && !state.asyncSet.has(file),
    );
    routeOut[route] = { eager: state.eager, async, other };
  }

  const chunkOut: Record<string, ChunkPart[]> = {};
  for (const [file, chunk] of chunks) chunkOut[file] = [...chunk.parts.values()];

  const meta: Snapshot["meta"] = {
    nextVersion: info.nextVersion,
    analyzerSchemaVersion: SCHEMA_VERSION,
    snapshotName: info.snapshotName,
    appDirOnly: info.appDirOnly,
    noMangling: info.noMangling,
    createdAt: info.createdAt,
  };
  if (info.commit !== undefined) meta.commit = info.commit;

  return { schemaVersion: 1, meta, sources, chunks: chunkOut, routes: routeOut };
}

/**
 * Normalise a `source_path` of a part record to a module key:
 * first-party paths relative to the app, "node_modules:<pkg>", "(runtime)" or "(unattributed)".
 */
export function normalizeSource(sourcePath: string, appDirPrefix?: string): string {
  let path = stripDecorations(sourcePath);

  if (path.startsWith("[turbopack]/") || path.startsWith("[next]/")) return "(runtime)";
  if (path.startsWith(CLIENT_PREFIX) || path.startsWith("[output]/")) return "(unattributed)";

  const nm = `/${path}`.lastIndexOf("/node_modules/");
  if (nm !== -1) {
    const segments = `/${path}`.slice(nm + "/node_modules/".length).split("/");
    const first = segments[0] ?? "";
    const pkg = first.startsWith("@") && segments[1] ? `${first}/${segments[1]}` : first;
    return `node_modules:${pkg}`;
  }

  if (path.startsWith("[project]/")) path = path.slice("[project]/".length);
  if (appDirPrefix) {
    const prefix = appDirPrefix.replace(/^\.?\/+/, "").replace(/\/*$/, "/");
    if (prefix !== "/" && path.startsWith(prefix)) path = path.slice(prefix.length);
  }
  return path;
}

/** Drop ident-style decorations the analyzer may append: "?query", " {...}", " <...>", " [...]", " (...)". */
function stripDecorations(path: string): string {
  const query = path.indexOf("?");
  if (query !== -1) path = path.slice(0, query);
  const decoration = path.search(/ [{<[(]/);
  if (decoration !== -1) path = path.slice(0, decoration);
  return path.trimEnd();
}

/** Cheap pre-check for record types we never read, so large module/output lines are not parsed. */
function isSkippedRecord(line: string): boolean {
  return line.startsWith('{"type":"module"') || line.startsWith('{"type":"output"');
}

function badRecord(lineNo: number, type: string, field: string): never {
  throw new SnapshotError(`analyzer export line ${lineNo}: "${type}" record has an invalid "${field}"`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.count === b.count && a.raw === b.raw && a.gz === b.gz && a.hash === b.hash;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
