import assert from 'node:assert/strict';
import { collectFiles, findFiles } from '../src/lib/file-search.ts';

const root = {
  name: 'workspace', path: '', type: 'dir', children: [
    { name: 'readme.md', path: 'readme.md', type: 'file' },
    { name: 'src', path: 'src', type: 'dir', children: [
      { name: 'main.ts', path: 'src/main.ts', type: 'file' },
      { name: 'readme.ts', path: 'src/readme.ts', type: 'file' },
      { name: 'lib', path: 'src/lib', type: 'dir', children: [
        { name: 'parser.ts', path: 'src/lib/parser.ts', type: 'file' },
      ] },
    ] },
    { name: 'README', path: 'docs/README', type: 'file' },
  ],
};

const files = collectFiles(root);
assert.equal(files.length, 5);
assert.equal(files.some((file) => file.path === 'src/lib'), false);
assert.deepEqual(collectFiles(null), []);
assert.deepEqual(findFiles(files, 'README').map((file) => file.path),
  ['docs/README', 'readme.md', 'src/readme.ts']);
assert.deepEqual(findFiles(files, 'src/lib').map((file) => file.path), ['src/lib/parser.ts']);
assert.deepEqual(findFiles(files, 'not-found'), []);
assert.equal(findFiles(files, '', 2).length, 2);
assert.deepEqual(findFiles(files, ' main.ts ').map((file) => file.path), ['src/main.ts']);

console.log('[quick-open-smoke] PASS: file-only index, name ranking, path and case matching, result cap');
