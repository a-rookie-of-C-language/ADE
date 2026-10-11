import assert from 'node:assert/strict';
import { observeTaskEvent, observeTaskSnapshot } from '../src/lib/task-notices.ts';

const task = (id, status, endedAt) => ({ id, status, endedAt });
const known = new Map();

assert.deepEqual(observeTaskSnapshot(known, [task('old', 'completed', 10), task('active', 'running')]), []);
assert.equal(observeTaskEvent(known, { type: 'task.completed', taskId: 'active', exitCode: 0, ts: 21 }), 'active');
assert.equal(observeTaskEvent(known, { type: 'task.completed', taskId: 'active', exitCode: 0, ts: 21 }), null);
assert.deepEqual(observeTaskSnapshot(known, [task('active', 'completed', 21)], 15), []);

assert.deepEqual(observeTaskSnapshot(known, [task('during-disconnect', 'failed', 25),
  task('older', 'completed', 12), task('old', 'completed', 10)], 20), ['during-disconnect']);
assert.deepEqual(observeTaskSnapshot(known, [task('during-disconnect', 'failed', 25)], 20), []);

observeTaskEvent(known, { type: 'task.created', taskId: 'next', ts: 30 });
assert.deepEqual(observeTaskSnapshot(known, [task('next', 'failed', 35)], 30), ['next']);
assert.equal(observeTaskEvent(known, { type: 'task.completed', taskId: 'exit-error', exitCode: 1, ts: 40 }), 'exit-error');
assert.equal(known.get('exit-error'), 'failed');
assert.equal(observeTaskEvent(known, { type: 'task.aborted', taskId: 'cancelled', ts: 40 }), null);
assert.deepEqual(observeTaskSnapshot(known, [task('old', 'running')], 40), []);
assert.equal(known.get('old'), 'completed');

console.log('[task-notices] PASS: initial baseline, live dedup, reconnect, failure and stale snapshots');
