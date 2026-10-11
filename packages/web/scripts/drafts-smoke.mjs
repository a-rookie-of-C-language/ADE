import assert from 'node:assert/strict';
import { draftKey, dirtyDrafts, parseDrafts, restoreDraft, serializeDrafts, MAX_DRAFTS } from '../src/lib/drafts.ts';

const rev1 = 'a'.repeat(64);
const rev2 = 'b'.repeat(64);
const draft = { path: 'src/example.ts', content: 'draft edit', saved: 'original', revision: rev1 };
const clean = { ...draft, path: 'clean.ts', content: 'original' };

assert.notEqual(draftKey('workspace-a', 'tab-a'), draftKey('workspace-b', 'tab-a'));
assert.notEqual(draftKey('workspace-a', 'tab-a'), draftKey('workspace-a', 'tab-b'));
assert.deepEqual(dirtyDrafts([{ ...draft, sessionId: '1' }, { ...clean, sessionId: '2' }]), [draft]);
assert.deepEqual(parseDrafts(serializeDrafts([{ ...draft, sessionId: '1' }, { ...clean, sessionId: '2' }])), [draft]);
assert.deepEqual(parseDrafts('not json'), []);
assert.deepEqual(parseDrafts(JSON.stringify([{ ...draft, revision: 'broken' }, { ...draft, path: '../secret' }])), []);
assert.throws(() => serializeDrafts(Array.from({ length: MAX_DRAFTS + 1 }, (_, i) =>
  ({ ...draft, path: `${i}.ts`, sessionId: `${i}` }))));

const same = restoreDraft(draft, { content: 'original', revision: rev1 });
assert.equal(same.content, 'draft edit');
assert.equal(same.conflict, undefined);
assert.equal(same.saved, 'original');
assert.deepEqual(restoreDraft(draft, { content: 'remote edit', revision: rev2 }).conflict,
  { content: 'remote edit', revision: rev2 });
assert.deepEqual(restoreDraft(draft, null).conflict, { content: null, revision: null });
assert.equal(restoreDraft(draft, { content: 'draft edit', revision: rev2 }), null);

console.log('[drafts-smoke] PASS: workspace/tab isolation, dirty-only storage, validation, revision-safe recovery');
