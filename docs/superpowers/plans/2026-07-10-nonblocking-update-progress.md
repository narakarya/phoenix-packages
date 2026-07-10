# Non-blocking Update Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocking full-screen spinner in the Mix dependency updater with per-package live status, and make every reported status reflect the actual post-update versions rather than stale data.

**Architecture:** One `runTask()` execution engine replaces `runWithProgress()` and four duplicated caller blocks. A pure streaming parser (`parseResolutionLine`) turns mix's output into per-package state while the command runs; a pure `reconcileVersions()` diff of before/after versions is the final authority for every badge and toast. A collapsible log panel replaces the self-erasing error box.

**Tech Stack:** Vanilla JS in a single self-contained `index.html`, run inside Porta's sandboxed iframe via `window.__portaBridge`. Tests use `node --test` (built in, zero dependencies).

## Global Constraints

- `index.html` MUST remain a single self-contained file. No build step, no bundler, no npm dependencies.
- No cancel button. `bridge.shell.spawn` (`porta/src/lib/extensionBridge.ts:381`) has no kill channel; a cancel could only stop listening while `mix` keeps mutating `mix.lock`.
- Updates stay a single atomic `mix` invocation. Never serialise into N per-package commands — that changes resolver semantics.
- `mix hex.outdated` exits **1** whenever any dependency is outdated. Exit code alone MUST NOT be treated as failure anywhere.
- Reconciliation MUST run even when the command exits non-zero or times out; mix may have written `mix.lock` before failing.
- All pure functions under test MUST live between the `// ── Parsers` and `// ── Security audit` markers in `index.html`. That block is currently function declarations only, with no top-level side effects. Keep it that way.
- Never run `mix deps.update` against one of the user's real projects to capture fixtures — it mutates `mix.lock`.

---

### Task 1: Test harness + resolution-line parser

**Files:**
- Create: `test/harness.mjs`
- Create: `test/parsers.test.mjs`
- Modify: `index.html` — insert into the parsers block, immediately after `parseMixExsConstraints()` (currently ends near line 716)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadPureFns(names: string[]) → object` (test harness)
  - `newTaskStatus(targets: string[]) → {phase, section, status, errorLines, log?}` where `status` is `{[name]: {state, from, to, extra}}`
  - `parseResolutionLine(line: string, st) → st` (mutates and returns `st`)
  - `state` values: `queued` | `resolving` | `fetching` | `upgraded` | `downgraded` | `new` | `unchanged` | `removed` | `failed`

- [ ] **Step 1: Write the test harness**

Create `test/harness.mjs`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'index.html'), 'utf8');

const START = '// ── Parsers';
const END = '// ── Security audit';

// The parsers block is pure function declarations, so evaluating it has no
// side effects and needs no DOM. Keep it that way or this harness breaks.
export function loadPureFns(names) {
  const s = html.indexOf(START);
  const e = html.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    throw new Error('parser block markers not found in index.html');
  }
  const src = html.slice(s, e);
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/parsers.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPureFns } from './harness.mjs';

const { newTaskStatus, parseResolutionLine } = loadPureFns([
  'newTaskStatus',
  'parseResolutionLine',
]);

const feed = (st, text) => {
  for (const line of text.split('\n')) parseResolutionLine(line, st);
  return st;
};

test('resolution block fills upgraded, unchanged, and new packages', () => {
  const st = newTaskStatus(['phoenix', 'ecto', 'castore']);
  feed(st, [
    'Resolving Hex dependencies...',
    'Dependency resolution completed:',
    'Unchanged:',
    '  castore 1.0.8',
    'Upgraded:',
    '  phoenix 1.7.10 => 1.7.14',
    '  ecto 3.11.0 => 3.12.4',
    'New:',
    '  telemetry 1.2.1',
  ].join('\n'));

  assert.equal(st.phase, 'resolved');
  assert.deepEqual(st.status.phoenix, { state: 'upgraded', from: '1.7.10', to: '1.7.14', extra: false });
  assert.deepEqual(st.status.ecto, { state: 'upgraded', from: '3.11.0', to: '3.12.4', extra: false });
  assert.deepEqual(st.status.castore, { state: 'unchanged', from: '1.0.8', to: '1.0.8', extra: false });
});

test('targets enter resolving as soon as resolution starts', () => {
  const st = newTaskStatus(['phoenix']);
  assert.equal(st.status.phoenix.state, 'queued');
  feed(st, 'Resolving Hex dependencies...');
  assert.equal(st.status.phoenix.state, 'resolving');
});

test('a package absent from targets is recorded and flagged extra', () => {
  const st = newTaskStatus(['phoenix']);
  feed(st, [
    'Dependency resolution completed:',
    'Upgraded:',
    '  plug 1.15.0 => 1.16.1',
  ].join('\n'));

  assert.equal(st.status.plug.state, 'upgraded');
  assert.equal(st.status.plug.extra, true);
  assert.equal(st.status.phoenix.extra, false);
});

test('Getting and Updating lines move a package into fetching', () => {
  const st = newTaskStatus(['phoenix']);
  feed(st, '* Getting phoenix (Hex package)');
  assert.equal(st.status.phoenix.state, 'fetching');
});

test('mix error lines are captured and mark the task failed', () => {
  const st = newTaskStatus(['phoenix']);
  feed(st, '** (Mix) Dependency resolution failed');
  assert.equal(st.phase, 'failed');
  assert.equal(st.errorLines.length, 1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `parser block markers not found` is wrong; you should instead see failures from `new Function` returning `undefined` for `newTaskStatus`, e.g. `TypeError: newTaskStatus is not a function`.

- [ ] **Step 4: Implement the parser**

In `index.html`, insert immediately after the closing brace of `parseMixExsConstraints()`:

```js
// ── Task progress parsing ─────────────────────────────────────────────────────
// mix runs one atomic resolution: every per-package outcome arrives inside the
// "Dependency resolution completed:" block. Pure so it can be tested against
// captured mix output — see test/parsers.test.mjs.

const RESOLUTION_SECTIONS = {
  'Unchanged:': 'unchanged',
  'Upgraded:': 'upgraded',
  'Downgraded:': 'downgraded',
  'New:': 'new',
  'Removed:': 'removed',
};

function newTaskStatus(targets) {
  const status = {};
  for (const name of targets) {
    status[name] = { state: 'queued', from: null, to: null, extra: false };
  }
  return { phase: 'starting', section: null, status, errorLines: [] };
}

function ensureEntry(st, name) {
  if (!st.status[name]) {
    st.status[name] = { state: 'queued', from: null, to: null, extra: true };
  }
  return st.status[name];
}

function parseResolutionLine(line, st) {
  const trimmed = line.trim();

  if (/^Resolving .* dependencies/.test(trimmed)) {
    st.phase = 'resolving';
    for (const e of Object.values(st.status)) {
      if (e.state === 'queued') e.state = 'resolving';
    }
    return st;
  }

  if (/^Dependency resolution completed/.test(trimmed)) {
    st.phase = 'resolved';
    st.section = null;
    return st;
  }

  if (RESOLUTION_SECTIONS[trimmed]) {
    st.section = RESOLUTION_SECTIONS[trimmed];
    return st;
  }

  if (trimmed.startsWith('** ')) {
    st.errorLines.push(trimmed);
    st.phase = 'failed';
    return st;
  }

  const fetching = /^\* (?:Getting|Updating) ([a-z_][a-z0-9_]*)/.exec(trimmed);
  if (fetching) {
    ensureEntry(st, fetching[1]).state = 'fetching';
    st.section = null;
    return st;
  }

  // Section entries are indented; the guard stops a stray flush-left line from
  // being read as a package.
  if (st.section && /^\s/.test(line)) {
    const m = /^([a-z_][a-z0-9_]*)\s+(\S+?)(?:\s+=>\s+(\S+))?$/.exec(trimmed);
    if (m) {
      const [, name, v1, v2] = m;
      const e = ensureEntry(st, name);
      e.state = st.section;
      if (v2) {
        e.from = v1;
        e.to = v2;
      } else if (st.section === 'new') {
        e.to = v1;
      } else {
        e.from = v1;
        e.to = v1;
      }
    }
  }

  return st;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add test/harness.mjs test/parsers.test.mjs index.html
git commit -m "feat: pure streaming parser for mix resolution output"
```

---

### Task 2: Version reconciliation

**Files:**
- Modify: `index.html` — append to the task-progress block from Task 1
- Modify: `test/parsers.test.mjs`

**Interfaces:**
- Consumes: `newTaskStatus`, `ensureEntry` from Task 1; the `status` shape `{[name]: {state, from, to, extra}}`.
- Produces:
  - `reconcileVersions(before: {[name]: string}, after: {[name]: string}, status) → {moved: [{name, from, to}], unchanged: string[], added: [{name, to}], removed: [{name, from}], mismatches: [{name, claimed, actual}]}`

This is the fix for "it said it failed but the packages were actually updated". The version diff, not the parser and not the exit code, decides what happened.

- [ ] **Step 1: Write the failing tests**

Append to `test/parsers.test.mjs` (and add `reconcileVersions` to the `loadPureFns([...])` array at the top of the file):

```js
test('moved packages are detected from the version diff', () => {
  const rec = reconcileVersions(
    { phoenix: '1.7.10', castore: '1.0.8' },
    { phoenix: '1.7.14', castore: '1.0.8' },
    {},
  );
  assert.deepEqual(rec.moved, [{ name: 'phoenix', from: '1.7.10', to: '1.7.14' }]);
  assert.deepEqual(rec.unchanged, ['castore']);
});

test('reality overrides a parser that claimed an upgrade that did not happen', () => {
  const st = newTaskStatus(['phoenix']);
  st.status.phoenix = { state: 'upgraded', from: '1.7.10', to: '1.7.14', extra: false };

  const rec = reconcileVersions({ phoenix: '1.7.10' }, { phoenix: '1.7.10' }, st.status);

  assert.deepEqual(rec.moved, []);
  assert.deepEqual(rec.mismatches, [{ name: 'phoenix', claimed: 'upgraded', actual: '1.7.10' }]);
});

test('packages appearing only after the run are reported as added', () => {
  const rec = reconcileVersions({}, { telemetry: '1.2.1' }, {});
  assert.deepEqual(rec.added, [{ name: 'telemetry', to: '1.2.1' }]);
});

test('packages gone after the run are reported as removed', () => {
  const rec = reconcileVersions({ old_dep: '0.1.0' }, {}, { old_dep: { state: 'removed' } });
  assert.deepEqual(rec.removed, [{ name: 'old_dep', from: '0.1.0' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/`
Expected: FAIL with `TypeError: reconcileVersions is not a function`.

- [ ] **Step 3: Implement reconcileVersions**

Append to the task-progress block in `index.html`:

```js
// Pure. `before`/`after` map package name → version. Reality — the version
// diff — overrides whatever the stream parser inferred, because mix's output
// format is not a stable contract and its exit code says nothing about which
// individual packages moved.
function reconcileVersions(before, after, status) {
  const names = new Set([
    ...Object.keys(status || {}),
    ...Object.keys(after || {}),
    ...Object.keys(before || {}),
  ]);
  const moved = [], unchanged = [], added = [], removed = [], mismatches = [];

  for (const name of names) {
    const b = before[name];
    const a = after[name];

    if (b && a && b !== a) moved.push({ name, from: b, to: a });
    else if (a && !b) added.push({ name, to: a });
    else if (b && !a) removed.push({ name, from: b });
    else if (b && a) unchanged.push(name);

    const claimed = status?.[name]?.state;
    const didMove = !!(b && a && b !== a);
    if ((claimed === 'upgraded' || claimed === 'downgraded') && !didMove) {
      mismatches.push({ name, claimed, actual: a || null });
    }
  }

  return { moved, unchanged, added, removed, mismatches };
}

// Rewrite per-package state to match the version diff, and record every place
// the parser and reality disagreed.
function applyReconciliation(st, rec, log) {
  if (!rec) return;
  for (const m of rec.moved) {
    const e = ensureEntry(st, m.name);
    e.state = 'upgraded';
    e.from = m.from;
    e.to = m.to;
  }
  for (const mm of rec.mismatches) {
    ensureEntry(st, mm.name).state = 'unchanged';
    log.push(`[porta] ${mm.name}: mix reported ${mm.claimed} but the version did not move — showing unchanged`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add test/parsers.test.mjs index.html
git commit -m "feat: reconcile per-package status against actual version diff"
```

---

### Task 3: Fix refreshData's exit-code bug

**Files:**
- Modify: `index.html:1875-1901` (`refreshData`)
- Modify: `test/parsers.test.mjs`

**Interfaces:**
- Consumes: `parseMixOutdated` (existing).
- Produces:
  - `refreshData()` now **throws** on genuine failure instead of silently returning. Every caller must handle it.
  - `versionSnapshot() → {[name]: string}` — current version of each known dep.

This is the single highest-value change in the plan. `mix hex.outdated` exits 1 whenever anything is outdated, so the old `if (result.code === 0 && result.stdout)` guard made `refreshData()` a no-op on exactly the runs where it mattered — leaving `deps` stale and every toast computed from pre-update data.

- [ ] **Step 1: Write the failing test**

Append to `test/parsers.test.mjs` (add `parseMixOutdated` to the `loadPureFns([...])` array):

```js
test('hex.outdated stdout parses even when the command exits 1', () => {
  // mix hex.outdated exits 1 whenever anything is outdated. The stdout that
  // accompanies that exit is valid and must be parsed, not discarded.
  const stdout = [
    'Dependency   Current  Latest   Status',
    'castore      1.0.8    1.0.8    Up-to-date',
    'phoenix      1.7.10   1.7.14   Update possible',
    'ecto         3.11.0   3.12.4   Update not possible',
  ].join('\n');

  const deps = parseMixOutdated(stdout);
  const byName = Object.fromEntries(deps.map(d => [d.name, d]));

  assert.equal(byName.phoenix.outdated, true);
  assert.equal(byName.ecto.outdated, false);
  assert.equal(byName.castore.outdated, false);
  assert.equal(byName.phoenix.latest, '1.7.14');
});
```

- [ ] **Step 2: Run test to verify it passes already**

Run: `node --test test/`
Expected: PASS. `parseMixOutdated` is already correct — the bug is in its **caller**, which never hands it this stdout. This test pins the contract that the next step relies on. Do not skip it.

- [ ] **Step 3: Rewrite refreshData**

Replace `refreshData()` in `index.html` in full:

```js
// Snapshot of the currently-known version of every dep, for before/after diffs.
function versionSnapshot() {
  const snap = {};
  for (const d of deps) snap[d.name] = d.current;
  return snap;
}

// Re-read dependency state. Throws when the data genuinely cannot be read —
// callers must say "could not verify" rather than invent a result.
//
// mix hex.outdated exits 1 whenever any dep is outdated, so a non-zero exit
// with stdout is the normal, successful case. This mirrors load().
async function refreshData() {
  const cmd = showAll ? 'mix hex.outdated --all' : 'mix hex.outdated';
  const result = await bridge.shell.run(cmd, { timeout: 120000 });

  if (result.code !== 0 && !result.stdout) {
    throw new Error((result.stderr || 'mix hex.outdated failed').trim());
  }

  deps = parseMixOutdated(result.stdout);

  try {
    const mixResult = await bridge.shell.run('cat mix.exs', { timeout: 5000 });
    if (mixResult.code === 0) mixConstraints = parseMixExsConstraints(mixResult.stdout);
  } catch (_) {
    mixConstraints = {};
  }

  deps = deps.map(d => ({
    ...d,
    constraint: mixConstraints[d.name] || null,
    retired: retiredMap[d.name] || null,
    vuln: vulnMap[d.name] || null,
  }));

  lockCache = null;
  const outdatedDeps = deps.filter(d => d.outdated);
  setTitle(outdatedDeps.length);

  const btn = document.getElementById('btn-update-all');
  if (btn) btn.style.display = outdatedDeps.length > 0 ? 'inline-flex' : 'none';
  const safeBtn = document.getElementById('btn-update-safe');
  const safeCount = outdatedDeps.filter(d => updateType(d.current, d.latest) !== 'major').length;
  if (safeBtn) safeBtn.style.display = safeCount > 0 ? 'inline-flex' : 'none';
}
```

- [ ] **Step 4: Verify no caller is left assuming refreshData swallows errors**

Run: `grep -n "refreshData()" index.html`
Expected: five call sites (`updateDep`, `updateTogether`, `bumpDep`, `updateSafe`, `updateVulnerable`, `updateAll`). They are rewritten in Task 6; leave them for now. Confirm none of them wraps `refreshData()` in a `try` that discards the error — they currently do not.

- [ ] **Step 5: Run tests**

Run: `node --test test/`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add index.html test/parsers.test.mjs
git commit -m "fix: refreshData discarded results when hex.outdated exits 1

hex.outdated exits 1 whenever any dep is outdated, so the code===0 guard
made refresh a no-op on exactly the runs that changed something. Toasts
were then computed from pre-update deps and reported false failures."
```

---

### Task 4: Per-row status rendering

**Files:**
- Modify: `index.html` — CSS near `.updating-indicator` (line ~567); `render()` (line ~1776); toolbar markup (line ~581)

**Interfaces:**
- Consumes: `task` state object; `newTaskStatus`, `renderRowStatus`.
- Produces:
  - module-level `let task = null;`
  - `renderRowStatus(name: string) → string` (HTML)
  - `paintTask() → void` — patches only status cells and the counter, no full re-render
  - `taskCounterText() → string`

- [ ] **Step 1: Add the task state and CSS**

Next to the other module-level state (near `let loading = false;`, line ~610) add:

```js
let task = null; // { phase, section, status, errorLines, log, logOpen, label, done, code, timedOut, verifyError }
```

Add CSS after the `.mini-spinner` rule:

```css
.task-status { font-size: 10px; font-family: monospace; }
.task-status.ok { color: var(--green); }
.task-status.warn { color: var(--amber); }
.task-status.err { color: var(--red); }
.task-status.muted { color: var(--text-muted); }
.task-status.queued { color: var(--text-muted); }
tr.dep-row.dimmed { opacity: 0.35; }
#task-counter { font-size: 11px; color: var(--text-dim); margin-left: auto; }
```

- [ ] **Step 2: Add the counter to the toolbar**

In the toolbar `<div>`, immediately before `<button id="btn-toggle-all">`:

```html
<span id="task-counter" style="display:none"></span>
```

- [ ] **Step 3: Implement the row status renderer**

Add just above `// ── Render`:

```js
function taskCounterText() {
  if (!task) return '';
  const entries = Object.values(task.status);
  const settled = entries.filter(e =>
    ['upgraded', 'downgraded', 'new', 'unchanged', 'removed', 'failed'].includes(e.state)).length;
  return `${settled}/${entries.length}`;
}

function renderRowStatus(name) {
  const e = task?.status?.[name];
  if (!e) return '';
  switch (e.state) {
    case 'queued':     return '<span class="task-status queued">queued</span>';
    case 'resolving':  return '<span class="updating-indicator"><span class="mini-spinner"></span>resolving…</span>';
    case 'fetching':   return '<span class="updating-indicator"><span class="mini-spinner"></span>fetching…</span>';
    case 'upgraded':   return `<span class="task-status ok">${htmlEscape(e.from)} → ${htmlEscape(e.to)}</span>`;
    case 'downgraded': return `<span class="task-status warn">${htmlEscape(e.from)} → ${htmlEscape(e.to)}</span>`;
    case 'new':        return `<span class="task-status ok">new ${htmlEscape(e.to)}</span>`;
    case 'unchanged':  return '<span class="task-status muted">unchanged</span>';
    case 'removed':    return '<span class="task-status muted">removed</span>';
    case 'failed':     return '<span class="task-status err">failed</span>';
    default:           return '';
  }
}

// Patch only what changed. A full render() here would destroy scroll position
// and any open review panel on every streamed line.
function paintTask() {
  if (!task) return;
  const counter = document.getElementById('task-counter');
  if (counter) {
    counter.style.display = 'inline';
    counter.textContent = `${task.label} ${taskCounterText()}`;
  }
  for (const name of Object.keys(task.status)) {
    const cell = document.getElementById('action-' + name);
    if (cell) cell.innerHTML = renderRowStatus(name);
  }
}
```

Note: packages discovered mid-stream that have no row yet (transitive `extra` entries) simply have no cell to patch. They appear as rows on the next full `render()` after reconciliation. That is intended.

- [ ] **Step 4: Teach render() about an active task**

In `render()`, inside the `for (const dep of sorted)` loop, replace the opening of the action-cell logic. Find:

```js
    let actionHtml = '';
    if (dep.outdated) {
```

Replace with:

```js
    let actionHtml = '';
    if (task && task.status[dep.name]) {
      actionHtml = renderRowStatus(dep.name);
    } else if (dep.outdated) {
```

Then, in the same loop, change the `<tr>` opening tag. Find:

```js
    html += `<tr class="dep-row" data-name="${dep.name}">
```

Replace with:

```js
    const dimmed = task && !task.status[dep.name] ? ' dimmed' : '';
    html += `<tr class="dep-row${dimmed}" data-name="${dep.name}">
```

Finally, hide the counter when no task is active. At the top of `render()`, after `const outdated = ...`:

```js
  const counter = document.getElementById('task-counter');
  if (counter) counter.style.display = task ? 'inline' : 'none';
```

- [ ] **Step 5: Verify by hand**

There is no DOM test. In Porta, open the extension on a Phoenix app with outdated deps. Nothing should look different yet — `task` is always `null` until Task 6 wires it up. Confirm the table renders exactly as before and no console errors appear.

Run: `node --test test/`
Expected: PASS, 10 tests (no regressions).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: per-row task status rendering, patched without full re-render"
```

---

### Task 5: Log panel

**Files:**
- Modify: `index.html` — CSS block; `render()`; new functions above `// ── Render`

**Interfaces:**
- Consumes: `task.log`, `task.logOpen`, `task.verifyError`.
- Produces:
  - `renderLogPanel() → string`
  - `toggleTaskLog() → void`
  - `copyTaskLog() → void`
  - `scrollToFirstLogError() → void`

Replaces `setContent('<div class="error-box">…')` + `setTimeout(render, 4000)`, which threw the table away and then discarded the error text after four seconds.

- [ ] **Step 1: Add CSS**

Append to the `<style>` block:

```css
.log-panel {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(0,0,0,0.22);
}
.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.log-body {
  max-height: 260px;
  overflow: auto;
  padding: 8px;
  font-family: monospace;
  font-size: 10px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.log-panel.collapsed .log-body { display: none; }
.log-panel.collapsed .log-head { border-bottom: none; }
.log-line { color: var(--text-dim); }
.log-line.log-error { color: var(--red); }
```

- [ ] **Step 2: Implement the panel**

Add above `// ── Render`:

```js
function firstLogErrorIndex() {
  if (!task) return -1;
  return task.log.findIndex(l => l.trim().startsWith('** '));
}

function renderLogPanel() {
  if (!task || !task.log.length) return '';
  const errIdx = firstLogErrorIndex();
  const body = task.log
    .map((l, i) => `<div class="log-line${i === errIdx ? ' log-error' : ''}" id="log-line-${i}">${htmlEscape(l)}</div>`)
    .join('');
  const verify = task.verifyError
    ? `<span class="task-status err">could not verify: ${htmlEscape(task.verifyError)}</span>`
    : '';
  return `<div class="log-panel${task.logOpen ? '' : ' collapsed'}" id="log-panel">
    <div class="log-head">
      <button onclick="toggleTaskLog()">${task.logOpen ? 'Hide' : 'Show'} output (${task.log.length} lines)</button>
      <button onclick="copyTaskLog()">Copy</button>
      ${verify}
    </div>
    <div class="log-body">${body}</div>
  </div>`;
}

function toggleTaskLog() {
  if (!task) return;
  task.logOpen = !task.logOpen;
  render();
  if (task.logOpen) scrollToFirstLogError();
}

function copyTaskLog() {
  if (!task) return;
  navigator.clipboard.writeText(task.log.join('\n'))
    .then(() => bridge.ui.toast('Output copied to clipboard', 'success'))
    .catch(() => {});
}

function scrollToFirstLogError() {
  const idx = firstLogErrorIndex();
  if (idx < 0) return;
  document.getElementById('log-line-' + idx)?.scrollIntoView({ block: 'center' });
}
```

- [ ] **Step 3: Render the panel under the table**

In `render()`, find the final line:

```js
  html += `</tbody></table>`;
  document.getElementById('content').innerHTML = html;
```

Replace with:

```js
  html += `</tbody></table>`;
  html += renderLogPanel();
  document.getElementById('content').innerHTML = html;
  if (task?.logOpen) scrollToFirstLogError();
```

- [ ] **Step 4: Verify**

Run: `node --test test/`
Expected: PASS, 10 tests. The panel is still unreachable (`task` stays `null`); Task 6 wires it.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: collapsible mix output log panel"
```

---

### Task 6: The runTask engine, and migrate all six callers

**Files:**
- Modify: `index.html` — delete `runWithProgress` (lines ~637-656); rewrite `updateDep`, `updateTogether`, `bumpDep`, `updateSafe`, `updateVulnerable`, `updateAll`

**Interfaces:**
- Consumes: `newTaskStatus`, `parseResolutionLine`, `reconcileVersions`, `applyReconciliation`, `versionSnapshot`, `refreshData`, `paintTask`, `renderRowStatus`, `runStream`.
- Produces:
  - `runTask({targets, cmd, label, timeoutMs}) → {result, rec, verifyError} | null` (null when a task is already running)
  - `summariseTask(rec, verifyError) → void` — emits the single, truthful toast

- [ ] **Step 1: Delete runWithProgress**

Remove the whole `runWithProgress()` function (`index.html:637-656`). `runStream()` directly above it stays.

Run: `grep -n "runWithProgress" index.html`
Expected: no output. If any remains, Step 2 will not compile — fix before continuing.

- [ ] **Step 2: Implement runTask**

Add immediately after `runStream()`:

```js
// One execution path for every mutating mix command.
//
// The table stays on screen for the whole run; only status cells are patched.
// Reconciliation runs even on a non-zero exit or a timeout, because mix may
// have written mix.lock before it failed — a hard failure does not mean
// nothing changed.
async function runTask({ targets, cmd, label, timeoutMs = 300000 }) {
  if (loading) return null;
  loading = true;
  selectedReview = null;

  const before = versionSnapshot();
  task = newTaskStatus(targets);
  task.label = label;
  task.log = [];
  task.logOpen = false;
  task.done = false;
  render();

  let result;
  try {
    result = await runStream(cmd, (line) => {
      task.log.push(line);
      parseResolutionLine(line, task);
      paintTask();
    }, timeoutMs);
  } catch (e) {
    const msg = String(e?.message || e);
    task.log.push(msg);
    result = { code: -1, timed_out: false, stdout: '', stderr: msg };
  }

  let verifyError = null;
  try {
    await refreshData();
  } catch (e) {
    verifyError = String(e?.message || e);
  }

  const rec = verifyError ? null : reconcileVersions(before, versionSnapshot(), task.status);
  applyReconciliation(task, rec, task.log);

  task.done = true;
  task.code = result.code;
  task.timedOut = !!result.timed_out;
  task.verifyError = verifyError;
  if (result.code !== 0 || result.timed_out || verifyError) task.logOpen = true;

  loading = false;
  render();
  return { result, rec, verifyError };
}

// The only place an update outcome is announced. Counts come from the version
// diff, never from the exit code and never from a stale `deps`.
function summariseTask(rec, verifyError) {
  if (verifyError) {
    bridge.ui.toast(`Command ran, but could not verify the result: ${verifyError}`, 'error');
    return;
  }
  const n = rec.moved.length;
  if (n === 0) {
    bridge.ui.toast('No package versions changed', 'info');
  } else if (task.timedOut) {
    bridge.ui.toast(`Timed out after updating ${n} package${n > 1 ? 's' : ''}`, 'error');
  } else if (task.code !== 0) {
    bridge.ui.toast(`${n} package${n > 1 ? 's' : ''} updated, but mix exited with an error`, 'error');
  } else {
    bridge.ui.toast(`${n} package${n > 1 ? 's' : ''} updated`, 'success');
  }
}
```

- [ ] **Step 3: Rewrite updateAll, updateSafe, updateVulnerable, updateTogether**

Replace each function body in full:

```js
async function updateAll() {
  if (loading) return;
  const outdated = deps.filter(d => d.outdated);
  if (!outdated.length) return;
  const unreviewedMajor = outdated.find(d =>
    updateType(d.current, d.latest) === 'major' && !reviewedDeps.has(d.name));
  if (unreviewedMajor) {
    await showPackageReview(unreviewedMajor.name);
    bridge.ui.toast(`${unreviewedMajor.name} is a major update. Review it before updating all.`, 'info');
    return;
  }
  const names = outdated.map(d => d.name);
  const out = await runTask({
    targets: names,
    cmd: 'mix deps.update --all && mix deps.get',
    label: `Updating ${names.length} package${names.length > 1 ? 's' : ''}`,
  });
  if (out) summariseTask(out.rec, out.verifyError);
}

async function updateSafe() {
  if (loading) return;
  const safe = deps.filter(d => d.outdated && updateType(d.current, d.latest) !== 'major');
  if (!safe.length) {
    bridge.ui.toast('No patch/minor updates available', 'info');
    return;
  }
  const names = safe.map(d => d.name);
  const { cmd } = buildUpdateCommand(names);
  const out = await runTask({
    targets: names,
    cmd,
    label: `Updating ${names.length} safe package${names.length > 1 ? 's' : ''} (patch + minor)`,
  });
  if (out) {
    summariseTask(out.rec, out.verifyError);
    runSecurityAndHousekeeping();
  }
}

async function updateVulnerable() {
  if (loading) return;
  const names = Object.keys(vulnMap);
  if (!names.length) return;
  const { cmd, transitive } = buildUpdateCommand(names);
  const note = transitive.length ? ` (${transitive.length} transitive)` : '';
  const out = await runTask({
    targets: names,
    cmd,
    label: `Updating ${names.length} vulnerable package${names.length > 1 ? 's' : ''}${note}`,
  });
  if (out) {
    summariseTask(out.rec, out.verifyError);
    // Re-audit: a transitive dep pinned by its parent may still be vulnerable.
    runSecurityAndHousekeeping();
  }
}

async function updateTogether(names) {
  if (loading || !Array.isArray(names) || !names.length) return;
  const { cmd } = buildUpdateCommand(names);
  const out = await runTask({
    targets: names,
    cmd,
    label: `Updating ${names.join(', ')}`,
  });
  if (out) summariseTask(out.rec, out.verifyError);
}
```

- [ ] **Step 4: Rewrite updateDep**

```js
async function updateDep(name, reviewed = false) {
  if (loading) return;
  const dep = deps.find(d => d.name === name);
  if (dep && updateType(dep.current, dep.latest) === 'major' && !reviewed && !reviewedDeps.has(name)) {
    await showPackageReview(name);
    bridge.ui.toast(`${name} is a major update. Review release notes before updating.`, 'info');
    return;
  }

  const out = await runTask({
    targets: [name],
    cmd: `mix deps.update ${shellQuote(name)} && mix deps.get`,
    label: `Updating ${name}`,
    timeoutMs: 120000,
  });
  if (!out) return;

  const combined = (out.result.stderr || '') + (out.result.stdout || '');
  if (out.result.code !== 0 && combined.includes('Unknown dependency')) {
    bridge.ui.toast(`${name} is a transitive dep — use "Update all" instead`, 'info');
    return;
  }

  summariseTask(out.rec, out.verifyError);

  // Only diagnose when the version genuinely did not move.
  const movedIt = out.rec?.moved.some(m => m.name === name);
  const stillOutdated = deps.find(d => d.name === name && d.outdated);
  if (!out.verifyError && !movedIt && stillOutdated) {
    await showConflictDiagnostics(
      name,
      `${name} stayed at ${stillOutdated.current} after mix deps.update ${name}. Analyzing what holds it back:`,
    );
  }
}
```

- [ ] **Step 5: Rewrite bumpDep**

```js
async function bumpDep(name, newConstraint, reviewed = false) {
  if (loading) return;
  if (!reviewed && !reviewedDeps.has(name)) {
    await showPackageReview(name);
    bridge.ui.toast(`${name} needs a constraint bump. Review release notes before editing mix.exs.`, 'info');
    return;
  }

  const backupResult = await bridge.shell.run('cp mix.exs mix.exs.bump.bak', { timeout: 5000 });
  if (backupResult.code !== 0) {
    bridge.ui.toast('Failed to backup mix.exs', 'error');
    return;
  }

  const perlScript = `BEGIN{$n=$ENV{DEP};$c=$ENV{C}}s/(\\{:\\Q$n\\E,\\s*")[^"]+(")/$1$c$2/`;
  const bumpResult = await bridge.shell.run(
    `DEP=${shellQuote(name)} C=${shellQuote(newConstraint)} perl -0pi -e '${perlScript}' mix.exs`,
    { timeout: 5000 },
  );
  if (bumpResult.code !== 0) {
    await bridge.shell.run('mv mix.exs.bump.bak mix.exs', { timeout: 5000 });
    bridge.ui.toast('Failed to edit mix.exs', 'error');
    return;
  }

  const out = await runTask({
    targets: [name],
    cmd: `mix deps.update ${shellQuote(name)} && mix deps.get`,
    label: `Bumping ${name} to ${newConstraint}`,
    timeoutMs: 120000,
  });
  if (!out) {
    await bridge.shell.run('mv mix.exs.bump.bak mix.exs', { timeout: 5000 });
    return;
  }

  const movedIt = out.rec?.moved.some(m => m.name === name);
  if (out.result.code !== 0 && !movedIt) {
    // Nothing moved and mix failed — the constraint edit bought us nothing.
    await bridge.shell.run('mv mix.exs.bump.bak mix.exs', { timeout: 5000 });
    await refreshData().catch(() => {});
    render();
    bridge.ui.toast(`${name} bump reverted — see output below`, 'error');
    return;
  }

  await bridge.shell.run('rm -f mix.exs.bump.bak', { timeout: 5000 });
  if (out.verifyError) {
    bridge.ui.toast(`Bumped ${name}, but could not verify: ${out.verifyError}`, 'error');
  } else if (movedIt) {
    bridge.ui.toast(`${name} bumped to ${newConstraint} and updated`, 'success');
  } else {
    bridge.ui.toast(`${name} constraint bumped, but the version did not move`, 'info');
  }
}
```

Note the behaviour change: the bump is now kept whenever the version actually moved, even if mix exited non-zero afterwards. Reverting a successful edit because a later step complained is precisely the class of lie this plan removes.

- [ ] **Step 6: Verify no dead code and no stale error boxes remain**

Run: `grep -n "setTimeout(() => render()" index.html`
Expected: no output.

Run: `grep -n "prevCount\|nowOutdated" index.html`
Expected: no output.

Run: `node --test test/`
Expected: PASS, 10 tests.

- [ ] **Step 7: Manual verification in Porta**

Open the extension on a Phoenix app with at least two outdated deps. Click **Update all**. Confirm:
- the table stays visible; target rows go `resolving…` → `fetching…` → `1.7.10 → 1.7.14`
- non-target rows are dimmed
- the toolbar counter climbs
- the toast count matches the number of green rows
- the log panel stays closed on success

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat: non-blocking per-package update progress

Replaces the full-screen spinner and four near-identical caller blocks
with one runTask engine. Status and toasts now come from the before/after
version diff, so a non-zero exit no longer reports failure for packages
that actually updated."
```

---

### Task 7: pruneUnused auto-refresh + README checklist

**Files:**
- Modify: `index.html` — `pruneUnused()` (line ~2143)
- Modify: `README.md`

**Interfaces:**
- Consumes: `refreshData`, `runSecurityAndHousekeeping`.
- Produces: nothing new.

- [ ] **Step 1: Rewrite pruneUnused**

```js
// Remove unused entries from mix.lock. Fast enough not to need progress UI,
// but it changes the lock — so the view must be re-read, not just re-rendered.
async function pruneUnused() {
  if (loading || !unusedDeps.length) return;
  const names = unusedDeps.slice();

  let result;
  try {
    result = await bridge.shell.run(`mix deps.unlock ${names.map(shellQuote).join(' ')}`, { timeout: 30000 });
  } catch (e) {
    bridge.ui.toast(`Error: ${e}`, 'error');
    return;
  }
  if (result.code !== 0) {
    bridge.ui.toast('Failed to prune lock', 'error');
    return;
  }

  unusedDeps = [];
  lockCache = null;
  try {
    await refreshData();
  } catch (e) {
    bridge.ui.toast(`Pruned, but could not verify: ${e.message}`, 'error');
    render();
    return;
  }
  render();
  runSecurityAndHousekeeping();
  bridge.ui.toast(`Pruned ${names.length} unused dep${names.length > 1 ? 's' : ''} from mix.lock`, 'success');
}
```

- [ ] **Step 2: Add the manual checklist to README.md**

Append a section:

```markdown
## Verifying a change

Parser and reconciliation logic is unit-tested:

    node --test test/

The DOM is not. After touching the update flow, check by hand in Porta against
a Phoenix app with at least two outdated deps:

- [ ] **Update all** — table stays visible, target rows step through
      `resolving…` → `fetching…` → `old → new`, non-targets dim, counter climbs.
- [ ] Toast count equals the number of green rows.
- [ ] On success the log panel stays closed.
- [ ] Force a failure (e.g. add an impossible constraint to `mix.exs`) — the log
      panel opens itself, scrolls to the `** (Mix)` line, and the table remains.
- [ ] A package that mix reports as upgraded but whose version does not move
      shows `unchanged`, and the log records the mismatch.
- [ ] **Prune from lock** refreshes the list without a manual refresh.

Fixtures in `test/` are hand-authored against mix's documented output shapes.
When you next run a real update, save its output into a fixture — do not run
`mix deps.update` against a project just to capture one, it rewrites `mix.lock`.
```

- [ ] **Step 3: Run tests**

Run: `node --test test/`
Expected: PASS, 10 tests.

- [ ] **Step 4: Commit**

```bash
git add index.html README.md
git commit -m "fix: prune unused refreshes deps; document manual checks"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 One execution engine | 6 |
| §2 Streaming parser | 1 |
| §3 Reconciliation is the source of truth | 2, 3, 6 |
| §3 `refreshData` exit-code fix | 3 |
| §4 Log panel | 5 |
| §4 Failure is not all-or-nothing | 6 (`runTask` reconciles on non-zero exit) |
| §4 Timeout treated like non-zero exit | 6 |
| §4 Auto-refresh everywhere | 6, 7 |
| §5 Tests | 1, 2, 3 |
| Per-row status, dimming, counter | 4 |

Every spec section maps to a task. The spec's "transitive package appears in the block but absent from targets" case is Task 1's `extra` flag test; such rows surface on the post-reconciliation `render()`.

**Type consistency:** `status` entries are `{state, from, to, extra}` throughout Tasks 1, 2, 4, 6. `reconcileVersions` returns `{moved, unchanged, added, removed, mismatches}` and only `moved` and `mismatches` are consumed (Tasks 2, 6). `runTask` returns `{result, rec, verifyError}`; `summariseTask(rec, verifyError)` matches its call sites. `ensureEntry(st, name)` takes the task-status object in both Task 1 and Task 2 (`applyReconciliation` passes `st`, not `st.status`).

**Known deliberate gaps:** DOM behaviour is verified by the README checklist, not tests. No cancel button (no kill channel exists). Fixtures are hand-authored, not captured.
