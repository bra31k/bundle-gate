const UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

/** Parses "<number> <unit>" into bytes. All units are 1024-based (KB = KiB = 1024 B). */
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

/** Same format as the Next analyzer UI: "0 B", "512 B", "152.80 KB", "1.25 MB", "2.00 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 0) return `-${formatBytes(-bytes)}`;
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  // The unit is chosen after rounding, so 1048575 B is "1.00 MB", never "1024.00 KB".
  const units = ["KB", "MB", "GB"];
  let i = 0;
  let text = (bytes / 1024).toFixed(2);
  while (i < units.length - 1 && Number(text) >= 1024) {
    i++;
    text = (bytes / 1024 ** (i + 1)).toFixed(2);
  }
  return `${text} ${units[i]}`;
}

/** Signed size: "+1.00 KB", "-12 B", "+0 B". */
export function formatDelta(bytes: number): string {
  if (bytes === 0) return "+0 B";
  return bytes < 0 ? formatBytes(bytes) : `+${formatBytes(bytes)}`;
}
