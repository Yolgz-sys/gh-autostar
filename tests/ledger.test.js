import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, localDay } from '../src/core/ledger.js';

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-autostar-'));
  return createLedger(path.join(dir, 'ledger.jsonl'));
}

test('空账本安全返回', () => {
  const l = tmpLedger();
  assert.deepEqual(l.readAll(), []);
  assert.equal(l.countToday(), 0);
  assert.equal(l.starredSet().size, 0);
});

test('写入与读取', () => {
  const l = tmpLedger();
  l.append({ repo: 'a/b', action: 'starred' });
  l.append({ repo: 'c/d', action: 'skipped', reason: 'daily-cap' });
  assert.equal(l.readAll().length, 2);
  assert.equal(l.starredSet().size, 1);
  assert.equal(l.countToday(), 1);
});

test('unstar 会把仓库移出已点星集合', () => {
  const l = tmpLedger();
  l.append({ repo: 'a/b', action: 'starred' });
  l.append({ repo: 'a/b', action: 'unstarred' });
  assert.equal(l.starredSet().has('a/b'), false);
});

test('重复点星同一仓库只计一次幂等状态，但今天计数如实累计', () => {
  const l = tmpLedger();
  l.append({ repo: 'a/b', action: 'starred' });
  l.append({ repo: 'a/b', action: 'starred' });
  assert.equal(l.starredSet().size, 1);
  assert.equal(l.countToday(), 2);
});

test('坏行被忽略而不抛错', () => {
  const l = tmpLedger();
  l.append({ repo: 'a/b', action: 'starred' });
  fs.appendFileSync(l.filePath, '{"repo":"broken"\n', 'utf8');
  assert.equal(l.readAll().length, 1);
});

test('last 返回倒序且限量', () => {
  const l = tmpLedger();
  for (let i = 0; i < 5; i++) l.append({ repo: `a/r${i}`, action: 'starred' });
  const rows = l.last(3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].repo, 'a/r4');
});

test('localDay 使用本地时区', () => {
  const d = new Date(2026, 0, 5, 23, 30);
  assert.equal(localDay(d), '2026-01-05');
});
