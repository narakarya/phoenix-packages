# Non-blocking update progress with accurate per-package status

Date: 2026-07-10
Status: Approved, ready for implementation plan

## Problem

Three defects in the update flow of `index.html`, reported by the user:

1. **Blocking.** Every bulk update replaces the whole dependency table with a
   single full-screen spinner. The user cannot see which package is being
   processed, which succeeded, and which failed.
2. **Wrong status.** The UI reports failure for updates that in fact succeeded.
   A manual refresh then shows the packages updated after all.
3. **No auto-refresh.** Some paths mutate state without refreshing the view.

## Root causes

**Blocking** — `runWithProgress()` (`index.html:637`) calls
`setContent()` with a spinner, destroying the table for the duration of the
command. Four callers duplicate the same `try/catch → timed_out → code !== 0 →
refreshData → toast` block.

**Wrong status** — `refreshData()` (`index.html:1878`) accepts the result only
when `result.code === 0`:

```js
if (result.code === 0 && result.stdout) { /* parse */ }
```

`mix hex.outdated` exits **1** whenever any dependency is outdated. So any
update that does not bring every package up to date leaves `refreshData()` a
no-op: `deps` keeps its pre-update values, and the caller's toast is computed
from stale data — `updateAll()` reports `"No packages updated (constraint
conflicts)"` (`index.html:2203`) from `prevCount - nowOutdated` where
`nowOutdated` never moved. `load()` does not have this bug, which is why a
manual refresh shows the truth.

The same function swallows every error with `catch (_) {}`, so a genuinely
failed verification is indistinguishable from a successful one.

**No auto-refresh** — `pruneUnused()` (`index.html:2143`) renders without
refreshing. Error paths across the update functions call `render()` on stale
`deps`.

## Constraints

- `index.html` stays a single self-contained file. No build step, no bundler.
- `bridge.shell.spawn` (`porta/src/lib/extensionBridge.ts:381`) streams
  `porta:stream` and `porta:spawn-done`. **There is no kill or abort channel.**
  A cancel button could only stop listening while `mix` keeps running and
  mutating `mix.lock` — strictly worse than no button. Real cancellation
  requires a change to Porta core and is out of scope.
- `mix deps.update --all` is a **single atomic resolution**, not N per-package
  processes. Per-package results arrive together in the resolution block. The
  design accepts this rather than serialising updates, because serialising
  changes the resolver's result: packages that resolve together may fail when
  updated one at a time.

## Design

### 1. One execution engine

Replace `runWithProgress()` and the four duplicated caller blocks with:

```js
async function runTask({ targets, cmd, label, timeoutMs })
```

`targets` is the list of packages expected to change. State lives in one object:

```js
let task = null; // { targets, phase, status: {name → {state, from, to}}, log: [], logOpen }
```

Per-package `state`: `queued` → `resolving` → `upgraded` | `unchanged` | `new`
→ `fetching` → `done`, or `failed`.

While a task runs, `render()` is **not** called. The table stays in the DOM;
only each row's status cell is patched via `renderRowStatus(name)`. No flicker,
no lost scroll position. Non-target rows are dimmed. The toolbar shows a
counter.

The six mutating actions become thin callers: `updateAll`, `updateSafe`,
`updateVulnerable`, `updateTogether`, `updateDep`, `bumpDep`. `bumpDep` keeps
its own `mix.exs` backup/patch/revert steps but routes its `deps.update` through
`runTask`. `pruneUnused` needs no progress UI; it only gains the auto-refresh
fix.

### 2. Streaming parser

`parseResolutionLine(line, task)` is called from `onStdout` and `onStderr`.

| Pattern | Effect |
|---|---|
| `Resolving Hex dependencies...` | all targets → `resolving` |
| `Dependency resolution completed:` | begin reading the result block |
| `Upgraded:` / `Unchanged:` / `New:` / `Downgraded:` | set active section |
| `  ecto 3.11.0 => 3.12.4` | `ecto` → `upgraded`, `from`/`to` filled |
| `  castore 1.0.8` | `castore` → `unchanged` |
| `* Getting ecto (Hex package)` | `ecto` → `fetching` |
| `** (Mix) …` | mark as an error line in the log |

Every line is also appended verbatim to `task.log`.

Packages that appear in the resolution block but are **not** in `targets`
(transitive deps that moved along) are not added to the table: `deps` — and
therefore every row `render()` draws — comes only from `mix hex.outdated`,
which in its default direct-only view does not list them. Such a package
gets no row and no before/after version to check its claim against;
reconciliation marks it `unverified` and writes one log line saying so. In
`Show all` mode (`mix hex.outdated --all`) the package is listed and gets an
ordinary row like any other.

### 3. Reconciliation is the source of truth

`refreshData()` is fixed to mirror `load()`, which is already correct:

```js
if (result.code !== 0 && !result.stdout) throw new Error(…)
```

The `catch (_) {}` is removed. When verification genuinely fails, the UI says
*"could not verify"* rather than inventing a failure.

Sequence after a task:

1. Snapshot each dep's version **before** the task (already present in `deps`).
2. Run the task; the parser drives live per-row status.
3. `refreshData()` → versions **after**.
4. **Diff the snapshot.** This is the final authority for every row badge and
   for the toast.

If the parser said `upgraded` but the version did not move, reality wins: the
row is marked `unchanged` and the mismatch is noted in the log. Mix may change
its output format between versions; the badges will still not lie.

The toast is computed from the count of deps whose version actually moved —
never from `prevCount - nowOutdated` over possibly-stale data.

### 4. Failure, log, verification

**Log panel.** Collapsible, below the table, closed by default. On `code !== 0`
it opens automatically, scrolls to the first error line, and offers a copy
button. This replaces `setContent('<div class="error-box">…')` followed by
`setTimeout(render, 4000)`, which threw away the table and then discarded the
error message after four seconds.

**Failure is not all-or-nothing.** `mix deps.update` can exit non-zero after
some packages have already moved. Reconciliation therefore runs **even when the
exit code is non-zero**: packages that moved keep their green badge, failures go
red, and the log opens. This is the opposite of the current behaviour.

**Timeout.** `timed_out` is treated exactly like a non-zero exit: reconciliation
still runs, because mix may have written `mix.lock` before the timeout fired.

**Auto-refresh.** Every mutating action ends in `refreshData()`. Actions that
affect the security or lock state (`updateVulnerable`, `pruneUnused`) also
re-run `runSecurityAndHousekeeping()`.

### 5. Tests

The repo has no test runner and `index.html` must remain a single file with no
build step. Add `test/parsers.test.mjs` run by `node --test` (built in, zero
dependencies). It reads `index.html`, slices the block between the
`// ── Parsers` and `// ── Load` markers, and evaluates it to obtain the pure
functions under test.

Covered: `parseResolutionLine` and `parseMixOutdated`, plus the reconciliation
diff, which is pure and should be extracted as such.

Fixtures are hand-authored against mix's documented output shapes. Real captured
output is preferable but `mix deps.update` mutates the project it runs in, so no
fixture is captured from the user's projects as part of this work; the first
real run should have its output saved into the fixture directory.

Required cases:

- resolution block with `Upgraded`, `Unchanged`, and `New` sections
- exit code 1 with some packages nevertheless upgraded
- a transitive package appearing in the block but absent from `targets`
- parser claiming `upgraded` while the version diff shows no movement
- `mix hex.outdated` exiting 1 with valid stdout (the `refreshData` bug)

DOM behaviour is not unit-tested. A manual checklist goes in the README.

## Out of scope

- Cancelling a running `mix` process (needs a Porta core kill channel).
- Per-package serialised updates (changes resolver semantics).
- Any change to the conflict-diagnostics or changelog features.

## Files touched

- `index.html` — the whole update section; net removal of duplicated code.
- `test/parsers.test.mjs` — new.
- `README.md` — manual verification checklist.
