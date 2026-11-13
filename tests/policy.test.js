import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/core/policy.js';
import { normalizeConfig } from '../src/core/config.js';

const base = (over = {}) => ({
  repo: 'facebook/react',
  meta: { stars: 1000, fork: false, ownerLogin: 'facebook' },
  config: normalizeConfig({ dailyCap: 10, mode: 'auto', ...over }),
  starred: new Set(),
  todayCount: 0,
  viewer: 'someone',
});

test('默认配置下正常放行', () => {
  const d = decide(base());
  assert.equal(d.action, 'star');
});

test('关闭开关后一律跳过', () => {
  const d = decide(base({ enabled: false }));
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'disabled');
});

test('黑名单优先于一切', () => {
  const d = decide(base({ denylist: ['facebook/react'] }));
  assert.equal(d.reason, 'denylist');
});

test('已点星则幂等跳过', () => {
  const p = base();
  p.starred = new Set(['facebook/react']);
  assert.equal(decide(p).reason, 'already');
});

test('白名单模式只放过白名单', () => {
  const d = decide(base({ allowlistOnly: true }));
  assert.equal(d.reason, 'not-allowlisted');

  const d2 = decide(base({ allowlistOnly: true, allowlist: ['facebook/react'] }));
  assert.equal(d2.action, 'star');
});

test('不给自己的仓库点星', () => {
  const p = base({ skipOwnedByMe: true });
  p.viewer = 'Facebook';
  assert.equal(decide(p).reason, 'self');
});

test('minStars 过滤低星仓库，但白名单可覆盖', () => {
  const p = base({ minStars: 100 });
  p.meta = { stars: 3, fork: false, ownerLogin: 'x' };
  assert.equal(decide(p).reason, 'min-stars');

  const p2 = base({ minStars: 100, allowlist: ['facebook/react'] });
  p2.meta = { stars: 3, fork: false, ownerLogin: 'x' };
  assert.equal(decide(p2).action, 'star');
});

test('skipForks', () => {
  const p = base({ skipForks: true });
  p.meta = { stars: 1000, fork: true, ownerLogin: 'x' };
  assert.equal(decide(p).reason, 'fork');
});

test('每日上限', () => {
  const p = base({ dailyCap: 5 });
  p.todayCount = 5;
  assert.equal(decide(p).reason, 'daily-cap');
});

test('dailyCap 为 0 表示不设上限', () => {
  const p = base({ dailyCap: 0 });
  p.todayCount = 999;
  assert.equal(decide(p).action, 'star');
});

test('dry-run 标记为 intended 而不是 star', () => {
  const d = decide(base({ mode: 'dry-run' }));
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'dry-run');
  assert.equal(d.intended, true);
});

test('confirm 模式返回待确认', () => {
  const d = decide(base({ mode: 'confirm' }));
  assert.equal(d.action, 'confirm');
});

test('非法 mode 回退为 auto', () => {
  const cfg = normalizeConfig({ mode: 'whatever' });
  assert.equal(cfg.mode, 'auto');
});
