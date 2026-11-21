import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ConfigError,
  judge,
  lintRules,
  matchRoute,
  parseConfig,
  parseLimit,
  resolveRule,
} from "../../src/rules.ts";
import type { Config } from "../../src/types.ts";

const KB = 1024;

describe("parseLimit", () => {
  test("ignore", () => {
    assert.equal(parseLimit("ignore"), "ignore");
  });

  test("single terms", () => {
    assert.deepEqual(parseLimit("+30 KB"), [{ kind: "growth", maxBytes: 30 * KB }]);
    assert.deepEqual(parseLimit("+2%"), [{ kind: "growth-percent", maxPercent: 2 }]);
    assert.deepEqual(parseLimit("+2.5%"), [{ kind: "growth-percent", maxPercent: 2.5 }]);
    assert.deepEqual(parseLimit("<= 400 KB"), [{ kind: "max-size", maxBytes: 400 * KB }]);
    assert.deepEqual(parseLimit("<=400KB"), [{ kind: "max-size", maxBytes: 400 * KB }]);
  });

  test("several terms, whitespace ignored", () => {
    assert.deepEqual(parseLimit(" +20% ,  <= 300 KB "), [
      { kind: "growth-percent", maxPercent: 20 },
      { kind: "max-size", maxBytes: 300 * KB },
    ]);
  });

  test("errors name the bad term", () => {
    assert.throws(() => parseLimit("+30 KB or +2%"), (e: unknown) => e instanceof ConfigError && /"\+30 KB or \+2%"/.test(e.message));
    assert.throws(() => parseLimit("+30 KB and <= 1 MB"), ConfigError);
    assert.throws(() => parseLimit("+30 KB,"), /empty term/);
    assert.throws(() => parseLimit(""), /empty term/);
    assert.throws(() => parseLimit("ignore, +2%"), /ignore/);
    assert.throws(() => parseLimit("+2%, ignore"), /ignore/);
    assert.throws(() => parseLimit("30 KB"), /bad term "30 KB"/);
    assert.throws(() => parseLimit("+30"), /bad term "\+30"/);
    assert.throws(() => parseLimit("+30 TB"), /unknown unit/);
    assert.throws(() => parseLimit("+abc%"), /bad term/);
    assert.throws(() => parseLimit("-5 KB"), ConfigError);
    assert.throws(() => parseLimit("<= 300"), /bad term "<= 300"/);
  });
});

describe("parseConfig", () => {
  test("valid config", () => {
    const cfg = parseConfig({
      rules: [
        { match: "/admin/**", limit: "ignore" },
        { match: ["/blog/[slug]", "/docs/**"], limit: "+20%, <= 300 KB" },
      ],
    });
    assert.equal(cfg.rules.length, 2);
    assert.deepEqual(cfg.rules[0], { match: ["/admin/**"], limit: "ignore" });
    assert.deepEqual(cfg.rules[1]!.match, ["/blog/[slug]", "/docs/**"]);
  });

  test("empty rules are allowed", () => {
    assert.deepEqual(parseConfig({ rules: [] }), { rules: [] });
  });

  test("errors carry the path", () => {
    assert.throws(() => parseConfig({ rules: [], extra: 1 }), /unknown key "extra"/);
    assert.throws(() => parseConfig({ rules: [{ match: "/a", limit: "+1 KB", note: "x" }] }), /rules\[0\]: unknown key "note"/);
    assert.throws(
      () => parseConfig({ rules: [{ match: "/a", limit: "+1 KB" }, { match: "/b", limit: "+1 KB or +2%" }] }),
      /^ConfigError: rules\[1\]\.limit: /,
    );
    assert.throws(() => parseConfig({ rules: [{ match: [], limit: "ignore" }] }), /rules\[0\]\.match: must not be empty/);
    assert.throws(() => parseConfig({ rules: [{ match: "", limit: "ignore" }] }), /rules\[0\]\.match/);
    assert.throws(() => parseConfig({ rules: [{ match: ["/a", 3], limit: "ignore" }] }), /rules\[0\]\.match\[1\]/);
    assert.throws(() => parseConfig({ rules: [{ match: 3, limit: "ignore" }] }), /rules\[0\]\.match/);
    assert.throws(() => parseConfig({ rules: [{ match: "/a", limit: 5 }] }), /rules\[0\]\.limit: must be a string/);
    assert.throws(() => parseConfig({ rules: [{ match: "/a" }] }), /rules\[0\]\.limit/);
    assert.throws(() => parseConfig({ rules: [{ limit: "ignore" }] }), /rules\[0\]\.match/);
    assert.throws(() => parseConfig({ rules: "x" }), /rules: must be an array/);
    assert.throws(() => parseConfig({}), /rules/);
    assert.throws(() => parseConfig([]), ConfigError);
    assert.throws(() => parseConfig(null), ConfigError);
    assert.throws(() => parseConfig({ rules: [null] }), /rules\[0\]: must be an object/);
    assert.throws(() => parseConfig({ rules: [{ match: "/a", limit: "30" }] }), /rules\[0\]\.limit: bad term "30"/);
  });
});

describe("matchRoute", () => {
  test("literal routes", () => {
    assert.equal(matchRoute("/", "/"), true);
    assert.equal(matchRoute("/about", "/about"), true);
    assert.equal(matchRoute("/about", "/about/team"), false);
    assert.equal(matchRoute("/about", "/"), false);
    assert.equal(matchRoute("/", "/about"), false);
  });

  test("brackets, parentheses and dots are literal", () => {
    assert.equal(matchRoute("/blog/[slug]", "/blog/[slug]"), true);
    assert.equal(matchRoute("/blog/[slug]", "/blog/hello"), false);
    assert.equal(matchRoute("/blog/[slug]", "/blog/s"), false);
    assert.equal(matchRoute("/docs/[...rest]", "/docs/[...rest]"), true);
    assert.equal(matchRoute("/docs/[...rest]", "/docs/a/b"), false);
    assert.equal(matchRoute("/(group)/x", "/(group)/x"), true);
    assert.equal(matchRoute("/a.b", "/a.b"), true);
    assert.equal(matchRoute("/a.b", "/axb"), false);
  });

  test("* is exactly one segment", () => {
    assert.equal(matchRoute("/blog/*", "/blog/x"), true);
    assert.equal(matchRoute("/blog/*", "/blog"), false);
    assert.equal(matchRoute("/blog/*", "/blog/x/y"), false);
    assert.equal(matchRoute("/*/edit", "/post/edit"), true);
  });

  test("partial wildcards are literal", () => {
    assert.equal(matchRoute("/a*", "/a*"), true);
    assert.equal(matchRoute("/a*", "/abc"), false);
  });

  test("** is zero or more segments", () => {
    assert.equal(matchRoute("/admin/**", "/admin"), true);
    assert.equal(matchRoute("/admin/**", "/admin/x"), true);
    assert.equal(matchRoute("/admin/**", "/admin/x/y"), true);
    assert.equal(matchRoute("/admin/**", "/administrator"), false);
    assert.equal(matchRoute("/admin/**", "/other"), false);
    assert.equal(matchRoute("/a/**/z", "/a/z"), true);
    assert.equal(matchRoute("/a/**/z", "/a/b/c/z"), true);
    assert.equal(matchRoute("/a/**/z", "/a/b/c"), false);
  });

  test("** alone matches every route including /", () => {
    assert.equal(matchRoute("**", "/"), true);
    assert.equal(matchRoute("**", "/a"), true);
    assert.equal(matchRoute("**", "/a/b/[c]"), true);
    assert.equal(matchRoute("/**", "/"), true);
  });
});

describe("resolveRule", () => {
  const config: Config = {
    rules: [
      { match: ["/admin/**"], limit: "ignore" },
      { match: ["/checkout"], limit: [{ kind: "growth", maxBytes: 60 * KB }] },
      { match: ["/blog/[slug]", "/docs/**"], limit: [{ kind: "growth-percent", maxPercent: 20 }] },
    ],
  };

  test("first matching rule wins and is labelled", () => {
    assert.deepEqual(resolveRule(config, "/admin/x"), { limit: "ignore", rule: 'rules[0] "/admin/**"' });
    assert.equal(resolveRule(config, "/checkout").rule, 'rules[1] "/checkout"');
    assert.equal(resolveRule(config, "/blog/[slug]").rule, 'rules[2] "/blog/[slug]"');
    assert.equal(resolveRule(config, "/docs").rule, 'rules[2] "/docs/**"');
  });

  test("first rule wins over later overlapping ones", () => {
    const c: Config = {
      rules: [
        { match: ["/a/**"], limit: "ignore" },
        { match: ["/a/b"], limit: [{ kind: "growth", maxBytes: 1 }] },
      ],
    };
    assert.equal(resolveRule(c, "/a/b").limit, "ignore");
  });

  test("implicit default is +2%", () => {
    assert.deepEqual(resolveRule(config, "/pricing"), {
      limit: [{ kind: "growth-percent", maxPercent: 2 }],
      rule: "default (+2%)",
    });
    assert.equal(resolveRule({ rules: [] }, "/").rule, "default (+2%)");
  });

  test("an explicit ** rule overrides the default", () => {
    const c: Config = { rules: [{ match: ["**"], limit: "ignore" }] };
    assert.deepEqual(resolveRule(c, "/x"), { limit: "ignore", rule: 'rules[0] "**"' });
  });
});

describe("judge", () => {
  test("ignore never fails", () => {
    assert.deepEqual(judge("ignore", 0, 1e9), []);
    assert.deepEqual(judge("ignore", undefined, 1e9), []);
  });

  test("growth boundary: equal passes, one byte more fails", () => {
    const limit = parseLimit("+30 KB");
    assert.deepEqual(judge(limit, 1000, 1000 + 30 * KB), []);
    const f = judge(limit, 1000, 1000 + 30 * KB + 1);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.term, "+30.00 KB");
    assert.equal(f[0]!.message, "grew +30.00 KB, limit +30.00 KB");
  });

  test("growth message", () => {
    const f = judge(parseLimit("+30 KB"), 100_000, 100_000 + 40 * KB);
    assert.equal(f[0]!.message, "grew +40.00 KB, limit +30.00 KB");
  });

  test("shrinking and unchanged never fail growth terms", () => {
    const limit = parseLimit("+0 B, +0%");
    assert.deepEqual(judge(limit, 5000, 4000), []);
    assert.deepEqual(judge(limit, 5000, 5000), []);
    assert.deepEqual(judge(parseLimit("+1 B"), 5000, 0), []);
  });

  test("percent boundary with an odd base", () => {
    // base 1001, +2%: limit is 20.02 bytes -> growth 20 passes, 21 fails
    const limit = parseLimit("+2%");
    assert.deepEqual(judge(limit, 1001, 1001 + 20), []);
    const f = judge(limit, 1001, 1001 + 21);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.term, "+2%");
    assert.match(f[0]!.message, /^grew \+21 B \(\+2\.10%\), limit \+2%$/);
    // exact: base 50, +2% -> 1 byte allowed exactly
    assert.deepEqual(judge(limit, 50, 51), []);
    assert.equal(judge(limit, 50, 52).length, 1);
  });

  test("percent with decimals", () => {
    const limit = parseLimit("+2.5%");
    assert.deepEqual(judge(limit, 4000, 4100), []); // exactly 2.5%
    assert.equal(judge(limit, 4000, 4101).length, 1);
    assert.equal(judge(limit, 4000, 4101)[0]!.term, "+2.5%");
  });

  test("percent with a zero base fails on any growth", () => {
    const limit = parseLimit("+50%");
    assert.deepEqual(judge(limit, 0, 0), []);
    const f = judge(limit, 0, 1);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.message, "grew +1 B, limit +50%");
  });

  test("max-size boundary", () => {
    const limit = parseLimit("<= 400 KB");
    assert.deepEqual(judge(limit, 1, 400 * KB), []);
    const f = judge(limit, 1, 400 * KB + 1);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.term, "<= 400.00 KB");
    assert.match(f[0]!.message, /limit <= 400\.00 KB/);
  });

  test("new route: only max-size applies", () => {
    const limit = parseLimit("+1 B, +1%, <= 100 KB");
    assert.deepEqual(judge(limit, undefined, 100 * KB), []);
    const f = judge(limit, undefined, 100 * KB + 1);
    assert.deepEqual(f.map((x) => x.term), ["<= 100.00 KB"]);
    assert.deepEqual(judge(parseLimit("+1 B, +1%"), undefined, 1e9), []);
  });

  test("all failing terms are reported", () => {
    const f = judge(parseLimit("+1 KB, +1%, <= 10 KB"), 10 * KB, 20 * KB);
    assert.deepEqual(f.map((x) => x.term), ["+1.00 KB", "+1%", "<= 10.00 KB"]);
  });

  test("default rule: +2%", () => {
    const { limit } = resolveRule({ rules: [] }, "/x");
    assert.deepEqual(judge(limit, 100_000, 102_000), []);
    assert.equal(judge(limit, 100_000, 102_001).length, 1);
  });
});

describe("lintRules", () => {
  const rule = (match: string[]) => ({ match, limit: "ignore" as const });

  test("no warnings for a clean config", () => {
    const c: Config = { rules: [rule(["/a"]), rule(["/b/**"])] };
    assert.deepEqual(lintRules(c, ["/a", "/b/x"]), []);
  });

  test("rule after a ** rule is unreachable", () => {
    const c: Config = { rules: [rule(["/a"]), rule(["**"]), rule(["/b"])] };
    const w = lintRules(c, ["/a", "/b"]);
    assert.equal(w.length, 1);
    assert.match(w[0]!, /rules\[2\] "\/b".*unreachable.*rules\[1\]/);
  });

  test('"/**" is a catch-all too', () => {
    const c: Config = { rules: [rule(["/**"]), { match: ["/a"], limit: [{ kind: "growth", maxBytes: 1 }] }] };
    const w = lintRules(c, ["/a"]);
    assert.equal(w.length, 1);
    assert.match(w[0]!, /rules\[1\] "\/a": unreachable, rules\[0\] pattern "\/\*\*" matches every route/);
    // A longer pattern with "**" is not a catch-all.
    assert.deepEqual(lintRules({ rules: [rule(["/a/**"]), rule(["/a"])] }, ["/a"]), []);
  });

  test("pattern that matches no route", () => {
    const c: Config = { rules: [rule(["/a", "/gone"]), rule(["/x/**"])] };
    const w = lintRules(c, ["/a"]);
    assert.equal(w.length, 2);
    assert.match(w[0]!, /rules\[0\] pattern "\/gone": matches no route/);
    assert.match(w[1]!, /rules\[1\] pattern "\/x\/\*\*": matches no route/);
  });

  test("empty config", () => {
    assert.deepEqual(lintRules({ rules: [] }, ["/a"]), []);
  });
});
