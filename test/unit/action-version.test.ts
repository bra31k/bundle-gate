import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("action.yml pins the CLI to the package version", () => {
  const actionText = readFileSync(new URL("../../action.yml", import.meta.url), "utf8");
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const match = /^ {2}package:\n(?: {4}.*\n)*? {4}default:\s*["']?([^"'\s#]+)["']?/m.exec(
    actionText,
  );
  assert.ok(match, "action.yml has no `package` input with a default");
  assert.equal(
    match[1],
    `bundle-gate@${pkg.version}`,
    "action.yml default package must be bundle-gate@<package.json version>; update it when bumping the version",
  );
});
