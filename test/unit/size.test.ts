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
    assert.equal(parseSize("1.0004 KB"), 1024);
    assert.equal(parseSize("1.0006 KB"), 1025);
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
  test("binary units with KiB, MiB and GiB labels and dropped trailing zeros", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1), "1 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1023), "1023 B");
    assert.equal(formatBytes(1024), "1 KiB");
    assert.equal(formatBytes(1536), "1.5 KiB");
    assert.equal(formatBytes(25078), "24.49 KiB");
    assert.equal(formatBytes(1048576), "1 MiB");
    assert.equal(formatBytes(1073741824), "1 GiB");
    assert.equal(formatBytes(3 * 1073741824), "3 GiB");
    assert.equal(formatBytes(5e9), "4.65 GiB");
  });

  test("the last digit is truncated, so values just below a unit boundary stay in the lower unit", () => {
    assert.equal(formatBytes(25077), "24.48 KiB");
    assert.equal(formatBytes(1048570), "1023.99 KiB");
    assert.equal(formatBytes(1048571), "1023.99 KiB");
    assert.equal(formatBytes(1048575), "1023.99 KiB");
    assert.equal(formatBytes(1048576), "1 MiB");
    assert.equal(formatBytes(1073741823), "1023.99 MiB");
  });

  test("negative values", () => {
    assert.equal(formatBytes(-5), "-5 B");
    assert.equal(formatBytes(-2048), "-2 KiB");
    assert.equal(formatBytes(-1048575), "-1023.99 KiB");
  });
});

describe("formatDelta", () => {
  test("signs", () => {
    assert.equal(formatDelta(0), "+0 B");
    assert.equal(formatDelta(12), "+12 B");
    assert.equal(formatDelta(-12), "-12 B");
    assert.equal(formatDelta(40 * 1024), "+40 KiB");
    assert.equal(formatDelta(-40 * 1024), "-40 KiB");
    assert.equal(formatDelta(1048575), "+1023.99 KiB");
    assert.equal(formatDelta(-1048575), "-1023.99 KiB");
    assert.equal(formatDelta(1048576), "+1 MiB");
  });
});
