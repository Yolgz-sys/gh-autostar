import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepo, extractRepos, isValidRepo } from '../src/core/repo.js';

test('parseRepo 处理常见引用形式', () => {
  const cases = [
    ['facebook/react', 'facebook/react'],
    ['https://github.com/facebook/react', 'facebook/react'],
    ['https://github.com/facebook/react.git', 'facebook/react'],
    ['https://github.com/facebook/react/tree/main/packages', 'facebook/react'],
    ['http://www.github.com/facebook/react?tab=readme', 'facebook/react'],
    ['git@github.com:facebook/react.git', 'facebook/react'],
    ['github.com/facebook/react', 'facebook/react'],
    ['  `https://github.com/facebook/react`  ', 'facebook/react'],
    ['https://github.com/Facebook/React', 'facebook/react'],
    ['git+https://github.com/vercel/next.js.git', 'vercel/next.js'],
    ['(https://github.com/tj/commander.js).', 'tj/commander.js'],
    ['github:pmndrs/zustand', 'pmndrs/zustand'],
    ['react@github:facebook/react', 'facebook/react'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseRepo(input), expected, `输入: ${input}`);
  }
});

test('parseRepo 拒绝非仓库引用', () => {
  const bad = [
    'https://gitlab.com/a/b',
    'https://github.com/features',
    'https://github.com/facebook',
    '',
    null,
    undefined,
    42,
    '不是仓库',
    'https://example.com',
  ];
  for (const input of bad) {
    assert.equal(parseRepo(input), null, `应拒绝: ${input}`);
  }
});

test('extractRepos 从命令与文本里挖仓库', () => {
  const text = `
    git clone https://github.com/expressjs/express.git
    npm i zustand   # 文档见 https://github.com/pmndrs/zustand
    cd /home/user/project && cat README.md
    git clone git@github.com:colinhacks/zod.git
  `;
  const repos = extractRepos(text, 5);
  assert.deepEqual(repos, ['expressjs/express', 'pmndrs/zustand', 'colinhacks/zod']);
});

test('extractRepos 识别 npm 的 github: 简写', () => {
  assert.deepEqual(extractRepos('npm i github:pmndrs/zustand'), ['pmndrs/zustand']);
});

test('extractRepos 遵守数量上限', () => {
  const text = Array.from({ length: 10 }, (_, i) => `https://github.com/a/repo${i}`).join('\n');
  assert.equal(extractRepos(text, 3).length, 3);
});

test('extractRepos 不把文件路径当仓库', () => {
  assert.deepEqual(extractRepos('cat src/index.js && ls ./lib/utils.ts'), []);
});

test('isValidRepo', () => {
  assert.equal(isValidRepo('facebook/react'), true);
  assert.equal(isValidRepo('Facebook/React'), false);
  assert.equal(isValidRepo('facebook'), false);
});
