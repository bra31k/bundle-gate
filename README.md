# bundle-gate

Fail a pull request when a Next.js route gets too heavy.

`bundle-gate` runs the official `next analyze` on two commits, compares the client JavaScript and CSS each route loads up front, and applies your limits. When a route is over its limit, it names the modules that caused the growth.

Needs Next.js 16.4+ (the analyzer only works with Turbopack) and Node.js 22.18+.

## Quick start

Run these in the app directory, once on the commit you compare against and once on the commit you check:

```sh
npx bundle-gate snapshot --name base --out base.json.gz   # on the base commit
npx bundle-gate snapshot --name head --out head.json.gz   # on the changed commit
npx bundle-gate diff base.json.gz head.json.gz
```

`snapshot` does not need `next build`. It runs `next analyze` itself, which takes about a second on a small app.

```text
✗ bundle-gate: 1 route over the limit
  Next 16.4.6 · eager client JS, gzip · base → head

Over the limit
✗ /about  167.3 KiB → 191.79 KiB  +24.49 KiB  +14.64%  limit +2%
    lodash             +24.38 KiB
    app/about/page.js      +104 B

3 routes: 1 changed · 2 unchanged
```

Sizes are printed in 1024-based units (`B`, `KiB`, `MiB`, `GiB`) with up to two decimals. The last digit is cut off, not rounded.

## What is measured

For each route, the gzip size of the client chunks it loads eagerly (JavaScript and CSS), as reported by `next analyze`. Chunks that load later through `next/dynamic` or `import()` are counted separately as async and never judged. Routes with no client code, such as route handlers, are counted as "without client JS" and never judged.

## Config

Limits live in `bundle-gate.config.json` (or the file passed with `--config`). The file is optional.

```json
{
  "rules": [
    { "match": ["/admin/**", "/_not-found", "/_global-error"], "limit": "ignore" },
    { "match": "/checkout", "limit": "+60 KB" },
    { "match": "/blog/[slug]", "limit": "+20%, <= 300 KB" }
  ]
}
```

Rules are checked in order and the first one that matches a route decides. A route that no rule matches gets the default rule, `+2%`.

**`match`** is a route name or a list of them, as Next names routes (`/blog/[slug]`, not a real URL). Patterns use [picomatch](https://github.com/micromatch/picomatch) with brackets, braces, extglobs and negation turned off. `*` matches any characters inside one path segment (`/blog-*`), `**` matches zero or more segments (`/admin/**` also matches `/admin`), and `?` matches one character. Everything else is literal, including `[`, `]` and `(`, so `/blog/[slug]` matches only that route. A pattern without a leading `/` is rooted at `/`.

**`limit`** is `"ignore"`, or one or more terms separated by commas. All terms must hold.

| Term | The route fails when |
|---|---|
| `+30 KB` | it grew by more than 30 KB |
| `+10%` | it grew by more than 10% of its base size |
| `<= 400 KB` | its size is above 400 KB |

Sizes accept `B`, `KB`, `KiB`, `MB`, `MiB`, `GB` and `GiB`, all 1024-based. A number without a unit is an error. Percentages are compared on exact bytes.

A route that is new in the change is judged only by `<=` terms, since it has nothing to grow from. A removed route is counted as removed and never fails. A route that shrinks never fails.

Unknown keys, bad units and bad terms are errors. `diff` warns about rules that can never apply: a rule after a `**` catch-all, and a pattern that matches no route in either snapshot.

## Commands

### `snapshot`

```sh
npx bundle-gate snapshot [--dir <app>] [--name <name>] [--out <file>]
                         [--dist-dir <dir>] [--prepare <cmd>]
                         [--app-dir-only] [--no-mangling]
```

Runs `next analyze` in the app directory, reads its export and writes a small snapshot (gzip-compressed JSON when the name ends in `.gz`). The analyzer's own report stays in `<distDir>/diagnostics/analyze`.

- `--dir`: the app directory. Default: the current directory. In a monorepo, point it at the app.
- `--name`: snapshot name inside the analyzer report. Default `head`.
- `--out`: output file. Default `bundle-gate-<name>.json.gz`.
- `--dist-dir`: the app's `distDir`, when it is not `.next`.
- `--prepare`: a shell command to run in the app directory first, for example code generation.
- `--app-dir-only`: analyze only App Router routes. Pages Router routes are included by default.
- `--no-mangling`: passed to `next analyze`.

### `diff`

```sh
npx bundle-gate diff <base> <head> [--config <file>] [--format text|markdown|json]
                     [--output <file>] [--json <file>] [--top <n>]
                     [--min-change <size>] [--all] [--no-fail]
                     [--annotations error|warning|off]
```

- `--format`: `text` (default), `markdown` or `json`. With `--output`, the formatted result goes to the file and a text summary still goes to stdout.
- `--json`: also write the JSON result to this file, with any `--format`.
- `--top`: rows in each module list (eager and async, for each route), in every format, including JSON. Default 10.
- `--min-change`: changes below this size are counted as unchanged, so a smaller decrease is not shown as smaller. Module lists of routes that exist on both sides leave such modules out. Limits are still judged on exact bytes. Default `100 B`.
- `--all`: also list unchanged routes and routes without client JS. The "Other changes" group is then named "All other routes". Text output also shows module lists under every route that has them, not only under failing ones.
- `--no-fail`: exit 0 even when a route is over its limit. Errors still exit 2.
- `--annotations`: the GitHub Actions annotation level for failing routes. Default `error`. Only used when `GITHUB_ACTIONS=true`.

`diff` skips the comparison, with a warning and exit code 0, when the two snapshots cannot be compared: different Next.js versions, different analyzer flags or a different analyzer format.

### Report

Text and Markdown reports start with the result, show routes in three groups and count all routes. The groups are routes over the limit, smaller routes (unless over a limit or ignored) and other changes, such as growth within the limit, new and removed routes, and async-only changes. Empty groups are left out. Markdown shows the first two as alert blocks and the third as a table.

Text output lists modules under failing routes. It is colored only on a terminal, and `NO_COLOR` turns the color off. Files get plain text.

Markdown keeps the eager and async module lists of changed routes in one collapsed block. GitHub limits a job summary to 1 MiB per step. If your report gets close to that, lower `--top` when you run the CLI yourself. The action has no input for it.

The JSON result has a `kind` in each item of `failures` (`growth`, `growth-percent` or `max-size`). A route with client JS also has `asyncModules` and `asyncModulesHidden` when it is new, or when it exists on both sides and its async size changed by at least `--min-change`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | no route is over its limit, or the comparison was skipped |
| `1` | at least one route is over its limit |
| `2` | an error: bad config, unreadable snapshot, analyzer failure |

## GitHub Action

The action starts from the merge commit that `actions/checkout` fetches for a pull request. That commit has two parents: the base branch tip and the PR's own latest commit.

It compares the PR's latest commit (head) with the merge base, the point where the branch left the base branch. Commits that land on the base branch later never change the result, so the same PR gives the same numbers whenever it runs.

The merge base needs the full history, so use `fetch-depth: 0` in `actions/checkout`. With a shallow checkout the action fetches the rest once, and skips with a warning if it still finds no merge base.

```yaml
name: Bundle size

on:
  pull_request:

permissions:
  contents: read

jobs:
  bundle-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0

      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24

      - uses: bra31k/bundle-gate@main # pin a commit SHA in real use
        with:
          working-directory: apps/web
```

The action installs the CLI version it was released with, so `uses: bra31k/bundle-gate@v0.2.0` always runs CLI 0.2.0. It snapshots base and head, each in its own git worktree, runs `diff` and writes the Markdown result to the job summary. Both sides run in the same job with the same environment, and nothing is cached between runs.

Inputs, all optional:

| Input | Default | |
|---|---|---|
| `working-directory` | `.` | The Next.js app directory. |
| `config` | empty | Path to the config. Empty means `bundle-gate.config.json` in the workspace root if it exists. |
| `install-command` | `npm ci` | Installs dependencies, run in the app directory on both sides. Empty skips it. |
| `prepare` | empty | Runs before each snapshot. Use it to generate files that exist only in your head checkout, such as `.env.production`. |
| `dist-dir` | empty | The app's `distDir`, when it is not `.next`. |
| `package` | `bundle-gate@0.2.0` | The CLI version released with this action. A version, a tarball path or any npm spec works. |
| `fail-on-breach` | `true` | Set to `false` to report breaches without failing the job. |

Outputs: `breached` (`true` or `false`), `exit-code` (the exit code of `diff`), and `head-sha` and `base-sha` (the commits that were compared, empty when the action skipped).

If the base commit cannot be analyzed, for example because it uses an older Next.js, the action prints a warning and succeeds without a check. The same happens when HEAD is not a merge commit or a parent is missing. A failure on the head side, or a tool error, fails the job.

### Analyzer report

When a route is over its limit, the action uploads the head analyzer folder as the artifact `bundle-gate-analyzer-report`. It contains both the `base` and `head` snapshots. To look at it:

1. Download and unzip the artifact.
2. Run `npx serve <folder>`. The report needs a web server at the root of a domain and does not work from `file://`.
3. Open the compare view (`/compare`) and select the `base` and `head` snapshots.

## Limitations

- The action needs the PR merge commit that `actions/checkout` fetches. It does not work on `push` events, or on pull requests with merge conflicts, because GitHub creates no merge commit for them.
- It does not catch problems that appear only when the PR is combined with newer commits on the base branch, because it compares against the merge base.
- Next.js 16.4 or newer, and the analyzer always compiles with Turbopack. If you ship a webpack build, the numbers describe a Turbopack build of the same code.
- The analyzer is experimental. `bundle-gate` checks the export's `schema_version` and stops with an error when it changes.
- Only eager client JavaScript and CSS are judged. Async chunks, server code and middleware are not.
- Routes are matched by name. A renamed route shows up as one removed and one new route, and only `<=` limits apply to it.
- Snapshots from different Next.js versions are not compared.
- Small shifts happen between builds even when a route's code did not change, mostly from chunk reshuffling. Use `--min-change` to count them as unchanged.

## Development

```sh
npm ci
npm run types
npm test
npm run build
```

Unit tests are in `test/unit`. `test/fixtures` holds trimmed analyzer exports from real builds and a small Next.js app for the Action's self-test.

## License

MIT
