/** One source file's share of an output chunk. `source` indexes `Snapshot.sources`. */
export type ChunkPart = [source: number, raw: number, gz: number];

export interface RouteChunks {
  /** Client chunk files loaded eagerly: de-duplicated union of `bootstrap` and `render_dependent` group outputs. THE GATED SET. */
  eager: string[];
  /** Client chunk files of `async` groups that are not eager. Reported, never gated. */
  async: string[];
  /** Client chunk files of the route that belong to no group. Reported as "unattributed", never gated. */
  other: string[];
}

export interface SnapshotMeta {
  nextVersion: string;
  /** `schema_version` of the analyzer export this snapshot was built from. */
  analyzerSchemaVersion: number;
  snapshotName: string;
  appDirOnly: boolean;
  noMangling: boolean;
  createdAt: string;
  commit?: string;
}

/** Our own small snapshot. Chunks are stored once; routes only list chunk files. */
export interface Snapshot {
  schemaVersion: 1;
  meta: SnapshotMeta;
  /** Normalised source keys, e.g. "app/page.js", "node_modules:lodash", "(runtime)", "(unattributed)". */
  sources: string[];
  /** Chunk file name (without the `[client-fs]/` prefix) -> its parts. */
  chunks: Record<string, ChunkPart[]>;
  /** Next route name (e.g. "/blog/[slug]") -> chunk lists. */
  routes: Record<string, RouteChunks>;
}

export interface Size {
  raw: number;
  gz: number;
}

/** One term of a limit, in bytes / percent. */
export type Term =
  | { kind: "growth"; maxBytes: number } // "+30 KB": fails iff head - base > maxBytes
  | { kind: "growth-percent"; maxPercent: number } // "+10%": fails iff (head - base) * 100 > base * maxPercent
  | { kind: "max-size"; maxBytes: number }; // "<= 400 KB": fails iff head > maxBytes

export type Limit = "ignore" | Term[];

export interface Rule {
  match: string[];
  limit: Limit;
}

export interface Config {
  rules: Rule[];
}
