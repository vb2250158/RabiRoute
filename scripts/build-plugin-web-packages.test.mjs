import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { webInputRelativePath } from './build-plugin-web-packages.mjs';

test('web input receipt includes only paths inside the selected root on Windows', () => {
  const root = 'C:\\fixture\\source';
  assert.equal(webInputRelativePath(root, 'C:\\fixture\\source\\src\\module.ts', path.win32), 'src/module.ts');
  assert.equal(webInputRelativePath(root, 'C:\\fixture\\source-other\\module.ts', path.win32), undefined);
  assert.equal(webInputRelativePath(root, 'D:\\shared\\node_modules\\library.js', path.win32), undefined);
  assert.equal(webInputRelativePath(root, root, path.win32), undefined);
  assert.equal(webInputRelativePath('\\\\server\\share\\source', '\\\\server\\other\\library.js', path.win32), undefined);
});

test('web input receipt accepts POSIX children but rejects parent and sibling paths', () => {
  assert.equal(webInputRelativePath('/fixture/source', '/fixture/source/src/a.ts', path.posix), 'src/a.ts');
  assert.equal(webInputRelativePath('/fixture/source', '/fixture/source-other/a.ts', path.posix), undefined);
  assert.equal(webInputRelativePath('/fixture/source', '/fixture/a.ts', path.posix), undefined);
});
