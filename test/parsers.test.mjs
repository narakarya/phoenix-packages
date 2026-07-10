import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPureFns } from './harness.mjs';

const { newTaskStatus, parseResolutionLine, reconcileVersions, applyReconciliation, expectedState, buildDepsFromResults } = loadPureFns([
  'newTaskStatus',
  'parseResolutionLine',
  'reconcileVersions',
  'applyReconciliation',
  'expectedState',
  'buildDepsFromResults',
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

test('moved packages are detected from the version diff', () => {
  const rec = reconcileVersions(
    { phoenix: '1.7.10', castore: '1.0.8' },
    { phoenix: '1.7.14', castore: '1.0.8' },
    {},
  );
  assert.deepEqual(rec.moved, [{ name: 'phoenix', from: '1.7.10', to: '1.7.14' }]);
  assert.deepEqual(rec.unchanged, [{ name: 'castore', version: '1.0.8' }]);
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

test('a real downgrade ends downgraded, not upgraded, with correct from/to', () => {
  const st = newTaskStatus(['phoenix']);
  st.status.phoenix = { state: 'queued', from: null, to: null, extra: false };
  const rec = reconcileVersions({ phoenix: '1.7.14' }, { phoenix: '1.7.10' }, st.status);
  const log = [];
  applyReconciliation(st, rec, log);

  assert.equal(st.status.phoenix.state, 'downgraded');
  assert.equal(st.status.phoenix.from, '1.7.14');
  assert.equal(st.status.phoenix.to, '1.7.10');
});

test('a real upgrade ends upgraded with correct from/to', () => {
  const st = newTaskStatus(['phoenix']);
  const rec = reconcileVersions({ phoenix: '1.7.10' }, { phoenix: '1.7.14' }, st.status);
  const log = [];
  applyReconciliation(st, rec, log);

  assert.equal(st.status.phoenix.state, 'upgraded');
  assert.equal(st.status.phoenix.from, '1.7.10');
  assert.equal(st.status.phoenix.to, '1.7.14');
});

test('a false upgraded claim on an unmoved package is corrected to unchanged, from equals to, and logs once', () => {
  const st = newTaskStatus(['phoenix']);
  st.status.phoenix = { state: 'upgraded', from: '1.7.10', to: '1.7.14', extra: false };
  const rec = reconcileVersions({ phoenix: '1.7.10' }, { phoenix: '1.7.10' }, st.status);
  const log = [];
  applyReconciliation(st, rec, log);

  assert.equal(st.status.phoenix.state, 'unchanged');
  assert.equal(st.status.phoenix.from, st.status.phoenix.to);
  assert.equal(log.length, 1);
});

test('a false new claim on an unchanged package is corrected to unchanged and logged', () => {
  const st = newTaskStatus(['phoenix']);
  st.status.phoenix = { state: 'new', from: null, to: '1.7.10', extra: false };
  const rec = reconcileVersions({ phoenix: '1.7.10' }, { phoenix: '1.7.10' }, st.status);
  const log = [];
  applyReconciliation(st, rec, log);

  assert.equal(st.status.phoenix.state, 'unchanged');
  assert.equal(log.length, 1);
});

test('a settled unchanged claim that actually moved logs once; an unsettled queued claim that moved logs nothing', () => {
  const st = newTaskStatus(['phoenix', 'ecto']);
  st.status.phoenix = { state: 'unchanged', from: '1.7.10', to: '1.7.10', extra: false };
  // st.status.ecto.state stays 'queued' — the stream never reported it.
  const rec = reconcileVersions(
    { phoenix: '1.7.10', ecto: '3.11.0' },
    { phoenix: '1.7.14', ecto: '3.12.4' },
    st.status,
  );
  const log = [];
  applyReconciliation(st, rec, log);

  assert.equal(st.status.phoenix.state, 'upgraded');
  assert.equal(st.status.ecto.state, 'upgraded');
  assert.equal(log.length, 1);
});

test('a git dep the parser claimed settled cannot be verified and is marked unverified', () => {
  const st = newTaskStatus(['my_git_dep']);
  st.status.my_git_dep = { state: 'upgraded', from: 'abc123', to: 'def456', extra: false };
  const rec = reconcileVersions({}, {}, st.status);
  const log = [];
  applyReconciliation(st, rec, log);

  assert.equal(st.status.my_git_dep.state, 'unverified');
  assert.equal(log.length, 1);
  assert.match(log[0], /cannot verify/);
});

test('a git dep left at queued with no version data stays queued and logs nothing', () => {
  const st = newTaskStatus(['my_git_dep']);
  // st.status.my_git_dep.state stays 'queued'.
  const rec = reconcileVersions({}, {}, st.status);
  const log = [];
  applyReconciliation(st, rec, log);

  assert.equal(st.status.my_git_dep.state, 'queued');
  assert.equal(log.length, 0);
});

test('a prerelease bump compares equal numerically and ends changed, not downgraded', () => {
  const st = newTaskStatus(['phoenix']);
  const rec = reconcileVersions({ phoenix: '1.7.10-rc.1' }, { phoenix: '1.7.10-rc.2' }, st.status);
  const log = [];
  applyReconciliation(st, rec, log);

  assert.equal(st.status.phoenix.state, 'changed');
  assert.equal(st.status.phoenix.from, '1.7.10-rc.1');
  assert.equal(st.status.phoenix.to, '1.7.10-rc.2');
});

test('an unchanged package with a blank parser entry gets its version backfilled', () => {
  const st = newTaskStatus(['castore']);
  // st.status.castore stays { state: 'queued', from: null, to: null } — parser never reported it.
  const rec = reconcileVersions({ castore: '1.0.8' }, { castore: '1.0.8' }, st.status);
  const log = [];
  applyReconciliation(st, rec, log);

  assert.equal(st.status.castore.from, '1.0.8');
  assert.equal(st.status.castore.to, '1.0.8');
});

const OUTDATED_STDOUT = [
  'Dependency   Current  Latest   Status',
  'castore      1.0.8    1.0.8    Up-to-date',
  'phoenix      1.7.10   1.7.14   Update possible',
  'ecto         3.11.0   3.12.4   Update not possible',
].join('\n');

test('exit 1 with stdout is the normal case and must still be parsed', () => {
  // mix hex.outdated exits 1 whenever anything is outdated. Gating on
  // code === 0 discarded the result on exactly the runs that changed something.
  const { deps } = buildDepsFromResults(
    { code: 1, stdout: OUTDATED_STDOUT, stderr: '' },
    '',
    { retiredMap: {}, vulnMap: {} },
  );
  const byName = Object.fromEntries(deps.map(d => [d.name, d]));

  assert.equal(deps.length, 3);
  assert.equal(byName.phoenix.outdated, true);
  assert.equal(byName.phoenix.latest, '1.7.14');
  assert.equal(byName.ecto.outdated, false);
  assert.equal(byName.castore.outdated, false);
});

test('a non-zero exit with no stdout is a real failure and throws', () => {
  assert.throws(
    () => buildDepsFromResults(
      { code: 1, stdout: '', stderr: '** (Mix) Could not find a Mix project' },
      '',
      { retiredMap: {}, vulnMap: {} },
    ),
    /Could not find a Mix project/,
  );
});

test('constraints from mix.exs are attached to matching deps', () => {
  const { deps, constraints } = buildDepsFromResults(
    { code: 1, stdout: OUTDATED_STDOUT, stderr: '' },
    '{:phoenix, "~> 1.7"},\n{:ecto, "~> 3.11"}',
    { retiredMap: {}, vulnMap: {} },
  );
  const byName = Object.fromEntries(deps.map(d => [d.name, d]));

  assert.equal(constraints.phoenix, '~> 1.7');
  assert.equal(byName.phoenix.constraint, '~> 1.7');
  assert.equal(byName.castore.constraint, null);
});

test('retired and vulnerability flags survive the rebuild', () => {
  const { deps } = buildDepsFromResults(
    { code: 1, stdout: OUTDATED_STDOUT, stderr: '' },
    '',
    {
      retiredMap: { castore: { version: '1.0.8', reason: 'security' } },
      vulnMap: { phoenix: { advisory: 'CVE-1', url: 'https://x' } },
    },
  );
  const byName = Object.fromEntries(deps.map(d => [d.name, d]));

  assert.equal(byName.castore.retired.reason, 'security');
  assert.equal(byName.phoenix.vuln.advisory, 'CVE-1');
  assert.equal(byName.ecto.vuln, null);
});
