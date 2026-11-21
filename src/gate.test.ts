import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "./gate.ts";

test("passes when every route fits its budget", () => {
  const result = evaluate([{ route: "/", bytes: 100 }], [{ route: "*", maxBytes: 100 }]);
  assert.deepEqual(result, { ok: true, violations: [] });
});

test("reports routes over budget", () => {
  const result = evaluate([{ route: "/checkout", bytes: 150 }], [{ route: "*", maxBytes: 100 }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    { route: "/checkout", bytes: 150, maxBytes: 100, overBy: 50 },
  ]);
});

test("a route's own budget wins over the default", () => {
  const result = evaluate(
    [{ route: "/heavy", bytes: 150 }],
    [
      { route: "*", maxBytes: 100 },
      { route: "/heavy", maxBytes: 200 },
    ],
  );
  assert.equal(result.ok, true);
});

test("routes without any budget are not gated", () => {
  const result = evaluate([{ route: "/free", bytes: 1_000_000 }], []);
  assert.equal(result.ok, true);
});
