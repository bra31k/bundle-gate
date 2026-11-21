import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatBytes, formatDelta, parseSize } from "../../src/size.ts";

describe("parseSize", () => {
  test("units are 1024-based and case-insensitive", () => {
    assert.equal(parseSize("10 B"), 10);
    assert.equal(parseSize("1 KB"), 1024);
    assert.equal(parseSize("1 KiB"), 1024);
    assert.equal(parseSize("1 kb"), 1024);
    assert.equal(parseSize("2 MB"), 2 * 1048576);
    assert.equal(parseSize("2 mib"), 2 * 1048576);
    assert.equal(parseSize("1 GB"), 1073741824);
    assert.equal(parseSize("1 GiB"), 1073741824);
  });

  test("whitespace between number and unit is optional", () => {
    assert.equal(parseSize("30KB"), 30720);
    assert.equal(parseSize("  30   KB "), 30720);
  });

  test("decimals round to the nearest byte", () => {
    assert.equal(parseSize("1.5 KB"), 1536);
    assert.equal(parseSize("0.5 KB"), 512);
    assert.equal(parseSize("1.0004 KB"), 1024); // 1024.4096
    assert.equal(parseSize("1.0006 KB"), 1025); // 1024.6144
  });

  test("rejects bare numbers, negatives, empty and unknown units", () => {
    assert.throws(() => parseSize("30"), /missing unit/);
    assert.throws(() => parseSize("-1 KB"), /invalid size/);
    assert.throws(() => parseSize(""), /empty/);
    assert.throws(() => parseSize("   "), /empty/);
    assert.throws(() => parseSize("5 TB"), /unknown unit "TB"/);
    assert.throws(() => parseSize("KB"), /invalid size/);
    assert.throws(() => parseSize("1 K B"), /invalid size/);
  });
});

describe("formatBytes", () => {
  test("matches the analyzer format", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1), "1 B");
    assert.equal(formatBytes(1023), "1023 B");
    assert.equal(formatBytes(1024), "1.00 KB");
    assert.equal(formatBytes(156467), "152.80 KB");
    assert.equal(formatBytes(1048576), "1.00 MB");
    assert.equal(formatBytes(1073741824), "1.00 GB");
    assert.equal(formatBytes(3 * 1073741824), "3.00 GB");
  });

  test("the unit is chosen after rounding", () => {
    assert.equal(formatBytes(1023), "1023 B");
    assert.equal(formatBytes(1024), "1.00 KB");
    assert.equal(formatBytes(1048575), "1.00 MB");
    // 1048570 B = 1023.994 KB stays in KB, 1048571 B = 1023.995 KB rounds up to 1.00 MB.
    assert.equal(formatBytes(1048570), "1023.99 KB");
    assert.equal(formatBytes(1048571), "1.00 MB");
    assert.equal(formatBytes(1073741823), "1.00 GB");
    // GB is the last unit.
    assert.equal(formatBytes(1024 ** 4), "1024.00 GB");
    assert.equal(formatBytes(-1048575), "-1.00 MB");
  });

  test("negative values", () => {
    assert.equal(formatBytes(-5), "-5 B");
    assert.equal(formatBytes(-2048), "-2.00 KB");
  });
});

describe("formatDelta", () => {
  test("signs", () => {
    assert.equal(formatDelta(0), "+0 B");
    assert.equal(formatDelta(12), "+12 B");
    assert.equal(formatDelta(-12), "-12 B");
    assert.equal(formatDelta(40 * 1024), "+40.00 KB");
    assert.equal(formatDelta(-40 * 1024), "-40.00 KB");
    assert.equal(formatDelta(1048575), "+1.00 MB");
    assert.equal(formatDelta(-1048575), "-1.00 MB");
  });
});
