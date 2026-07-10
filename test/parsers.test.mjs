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
