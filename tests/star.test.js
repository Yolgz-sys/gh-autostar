import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/core/ledger.js';
import { normalizeConfig } from '../src/core/config.js';
import { createStarService } from '../src/core/star.js';

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-autostar-'));
  return createLedger(path.join(dir, 'ledger.jsonl'));
}

/** 假 GitHub 客户端，记录调用次数 */
function fakeGh(over = {}) {
  const calls = { star: [], unstar: [], isStarred: 0, getRepo: 0 };
  const state = { starredRemotely: false, ...over };
  return {
    calls,
    hasToken: true,
    async getViewer() {
      return { login: 'me' };
    },
    async getRepo(repo) {
      calls.getRepo += 1;
      if (repo === 'ghost/missing') return null;
      return {
        fullName: repo,
        stars: state.stars ?? 1234,
        fork: state.fork ?? false,
        ownerLogin: repo.split('/')[0],
        htmlUrl: `https://github.com/${repo}`,
      };
    },
    async isStarred() {
      calls.isStarred += 1;
      return state.starredRemotely;
    },
    async star(repo) {
      calls.star.push(repo);
      state.starredRemotely = true;
    },
    async unstar(repo) {
      calls.unstar.push(repo);
      state.starredRemotely = false;
    },
  };
}

const mk = (gh, cfg = {}) => {
  const config = normalizeConfig({ dailyCap: 10, mode: 'auto', skipOwnedByMe: false, ...cfg });
  const ledger = tmpLedger();
  return { service: createStarService({ config, ledger, gh }), ledger, config };
};

test('首次调用会真的点星并记账', async () => {
  const gh = fakeGh();
  const { service, ledger } = mk(gh);
  const r = await service.ensure({ repo: 'https://github.com/foo/bar', reason: '读了源码' });
  assert.equal(r.action, 'starred');
  assert.deepEqual(gh.calls.star, ['foo/bar']);
  assert.equal(ledger.starredSet().has('foo/bar'), true);
  assert.equal(ledger.last(1)[0].note, '读了源码');
});

test('第二次调用幂等，不打网络', async () => {
  const gh = fakeGh();
  const { service } = mk(gh);
  await service.ensure({ repo: 'foo/bar' });
  const before = gh.calls.getRepo;
  const r = await service.ensure({ repo: 'foo/bar' });
  assert.equal(r.reason, 'already');
  assert.equal(gh.calls.getRepo, before);
  assert.equal(gh.calls.star.length, 1);
});

test('远端已是星标时不重复 PUT', async () => {
  const gh = fakeGh({ starredRemotely: true });
  const { service } = mk(gh);
  const r = await service.ensure({ repo: 'foo/bar' });
  assert.equal(r.reason, 'remote-already');
  assert.equal(gh.calls.star.length, 0);
});

test('达到每日上限后不再点星', async () => {
  const gh = fakeGh();
  const { service } = mk(gh, { dailyCap: 1 });
  await service.ensure({ repo: 'a/one' });
  const r = await service.ensure({ repo: 'a/two' });
  assert.equal(r.reason, 'daily-cap');
  assert.equal(gh.calls.star.length, 1);
});

test('仓库不存在时安全退出', async () => {
  const gh = fakeGh();
  const { service } = mk(gh);
  const r = await service.ensure({ repo: 'ghost/missing' });
  assert.equal(r.reason, 'not-found');
  assert.equal(gh.calls.star.length, 0);
});

test('无法解析的输入不触网', async () => {
  const gh = fakeGh();
  const { service } = mk(gh);
  const r = await service.ensure({ repo: '这不是仓库' });
  assert.equal(r.reason, 'invalid');
  assert.equal(gh.calls.getRepo, 0);
});

test('点星失败会记 failed 而不是崩', async () => {
  const gh = fakeGh();
  gh.star = async () => {
    throw new Error('boom');
  };
  const { service, ledger } = mk(gh);
  const r = await service.ensure({ repo: 'a/fail' });
  assert.equal(r.action, 'failed');
  assert.equal(ledger.last(1)[0].action, 'failed');
});

test('dry-run 记录 intended 但不调用 GitHub', async () => {
  const gh = fakeGh();
  const { service, ledger } = mk(gh, { mode: 'dry-run' });
  const r = await service.ensure({ repo: 'a/dry' });
  assert.equal(r.action, 'skipped');
  assert.equal(gh.calls.star.length, 0);
  assert.equal(ledger.last(1)[0].action, 'intended');
});

test('黑名单永不点星，force 也不行', async () => {
  const gh = fakeGh();
  const { service } = mk(gh, { denylist: ['a/evil'] });
  const r = await service.ensure({ repo: 'a/evil', force: true });
  assert.equal(gh.calls.star.length, 0);
  assert.equal(r.reason, 'denylist');
});

test('unstar 记账并生效', async () => {
  const gh = fakeGh();
  const { service, ledger } = mk(gh);
  await service.ensure({ repo: 'a/b' });
  const r = await service.unstar({ repo: 'a/b' });
  assert.equal(r.action, 'unstarred');
  assert.deepEqual(gh.calls.unstar, ['a/b']);
  assert.equal(ledger.starredSet().has('a/b'), false);
});

test('status 反映配额与登录状态', async () => {
  const gh = fakeGh();
  const { service } = mk(gh, { dailyCap: 3 });
  await service.ensure({ repo: 'a/b' });
  const s = await service.status();
  assert.equal(s.todayCount, 1);
  assert.equal(s.remaining, 2);
  assert.equal(s.authenticated, true);
  assert.equal(s.viewer, 'me');
});
