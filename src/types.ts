export type ChunkPart = [source: number, raw: number, gz: number];

export interface RouteChunks {
  eager: string[];
  async: string[];
  other: string[];
}

export interface SnapshotMeta {
  nextVersion: string;
  analyzerSchemaVersion: number;
  snapshotName: string;
  appDirOnly: boolean;
  noMangling: boolean;
  createdAt: string;
  commit?: string;
}

export interface Snapshot {
  schemaVersion: 1;
  meta: SnapshotMeta;
  sources: string[];
  chunks: Record<string, ChunkPart[]>;
  routes: Record<string, RouteChunks>;
}

export interface Size {
  raw: number;
  gz: number;
}

export type Term =
  | { kind: "growth"; maxBytes: number }
  | { kind: "growth-percent"; maxPercent: number }
  | { kind: "max-size"; maxBytes: number };

export type Limit = "ignore" | Term[];

export interface Rule {
  match: string[];
  limit: Limit;
}

export interface Config {
  rules: Rule[];
}
