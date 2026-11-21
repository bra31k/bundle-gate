import prettyBytes from "pretty-bytes";

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

export function parseSize(input: string): number {
  const text = input.trim();
  if (text === "") throw new Error("size is empty");
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*([A-Za-z]*)$/.exec(text);
  if (!m) throw new Error(`invalid size "${input}": expected a number and a unit, e.g. "30 KB"`);
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "") {
    throw new Error(`invalid size "${input}": missing unit (use B, KB, KiB, MB, MiB, GB or GiB)`);
  }
  const factor = UNITS[unit];
  if (factor === undefined) {
    throw new Error(`invalid size "${input}": unknown unit "${m[2]}" (use B, KB, KiB, MB, MiB, GB or GiB)`);
  }
  return Math.round(Number(m[1]) * factor);
}

const FORMAT = { binary: true, maximumFractionDigits: 2 } as const;

export function formatBytes(bytes: number): string {
  return bytes < 0 ? `-${prettyBytes(-bytes, FORMAT)}` : prettyBytes(bytes, FORMAT);
}

export function formatDelta(bytes: number): string {
  if (bytes === 0) return "+0 B";
  return bytes < 0 ? formatBytes(bytes) : `+${formatBytes(bytes)}`;
}
