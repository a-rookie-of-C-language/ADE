/** A remote rename must keep drafts, but never attach a stale tab to a different file. */
import assert from 'node:assert/strict';
import { canRelocateActive, relocateFileTabs } from '../src/lib/file-moves.ts';

const tab = { sessionId: 'a', path: 'old.txt', content: 'unsaved draft', saved: 'disk', revision: 'rev1' };
assert.equal(canRelocateActive([tab], 'old.txt', 'new.txt', 'rev1'), true);
const [moved] = relocateFileTabs([tab], 'old.txt', 'new.txt', 'rev1');
assert.equal(moved.path, 'new.txt');
assert.equal(moved.content, 'unsaved draft');
assert.equal(moved.saved, 'disk');
assert.equal(moved.sessionId, tab.sessionId);
assert.deepEqual(relocateFileTabs([moved], 'old.txt', 'new.txt', 'rev1'), [moved]);

const [stale] = relocateFileTabs([tab], 'old.txt', 'new.txt', 'rev2');
assert.equal(canRelocateActive([tab], 'old.txt', 'new.txt', 'rev2'), false);
assert.equal(stale.path, 'old.txt');
assert.equal(stale.content, tab.content);
assert.deepEqual(stale.conflict, { content: null, revision: null });

const alreadyOpen = { ...tab, sessionId: 'b', path: 'new.txt', content: 'different draft' };
const collision = relocateFileTabs([tab, alreadyOpen], 'old.txt', 'new.txt', 'rev1');
assert.equal(canRelocateActive([tab, alreadyOpen], 'old.txt', 'new.txt', 'rev1'), false);
assert.deepEqual(collision.map((item) => item.path), ['old.txt', 'new.txt']);
assert.equal(collision[0].content, tab.content);
assert.equal(collision[1].content, alreadyOpen.content);

const missing = { ...tab, conflict: { content: null, revision: null } };
assert.equal(relocateFileTabs([missing], 'old.txt', 'new.txt', 'rev1')[0].conflict, undefined);
console.log('[file-moves-smoke] PASS: remote move retains drafts, rejects stale/destination collisions, idempotent');
