import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, GitHubError, resolveToken } from '../src/core/github.js';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const { status = 200, body = '', headers = {} } = handler(url, init) || {};
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => JSON.parse(body || '{}'),
      text: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

process.env.GH_AUTOSTAR_TOKEN = 'test-token';
process.env.GITHUB_TOKEN = '';
process.env.GH_TOKEN = '';

test('getRepo 正常解析字段', async () => {
  const f = fakeFetch(() => ({
    status: 200,
    body: JSON.stringify({
      full_name: 'foo/bar',
      stargazers_count: 42,
      forks_count: 7,
      fork: false,
      archived: false,
      owner: { login: 'foo', type: 'User' },
      description: 'demo',
      html_url: 'https://github.com/foo/bar',
    }),
  }));
  const gh = createGitHub({ token: 't', fetchImpl: f });
  const meta = await gh.getRepo('foo/bar');
  assert.equal(meta.stars, 42);
  assert.equal(meta.ownerLogin, 'foo');
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/foo/bar');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer t');
  assert.equal(f.calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('getRepo 404 返回 null 而不是抛错', async () => {
  const f = fakeFetch(() => ({ status: 404, body: '{"message":"Not Found"}' }));
  const gh = createGitHub({ token: 't', fetchImpl: f });
  assert.equal(await gh.getRepo('no/such'), null);
});

test('isStarred 用 204/404 区分', async () => {
  const yes = createGitHub({ token: 't', fetchImpl: fakeFetch(() => ({ status: 204 })) });
  const no = createGitHub({ token: 't', fetchImpl: fakeFetch(() => ({ status: 404 })) });
  assert.equal(await yes.isStarred('a/b'), true);
  assert.equal(await no.isStarred('a/b'), false);
});

test('star 用 PUT 且带空 body', async () => {
  const f = fakeFetch(() => ({ status: 204 }));
  const gh = createGitHub({ token: 't', fetchImpl: f });
  assert.equal(await gh.star('a/b'), true);
  assert.equal(f.calls[0].method, 'PUT');
  assert.equal(f.calls[0].body, '');
});

test('没有令牌时点星给出可读错误', async () => {
  // 注入一个必定返回 null 的解析器，避免测试结果依赖本机是否登录了 gh
  const bare = createGitHub({ tokenResolver: () => null, fetchImpl: fakeFetch(() => ({ status: 204 })) });
  assert.equal(bare.hasToken, false);
  await assert.rejects(() => bare.star('a/b'), /缺少 GitHub 令牌/);
  assert.equal(await bare.isStarred('a/b'), false);
});

test('403 抛出带状态的 GitHubError', async () => {
  const f = fakeFetch(() => ({ status: 403, body: 'forbidden' }));
  const gh = createGitHub({ token: 't', fetchImpl: f });
  const err = await gh.star('a/b').catch((e) => e);
  assert.ok(err instanceof GitHubError);
  assert.equal(err.status, 403);
});

test('5xx 会重试一次后成功', async () => {
  let n = 0;
  const f = fakeFetch(() => {
    n += 1;
    return n === 1 ? { status: 502 } : { status: 200, body: '{"full_name":"a/b","stargazers_count":1,"owner":{"login":"a"}}' };
  });
  const gh = createGitHub({ token: 't', fetchImpl: f, timeoutMs: 2000 });
  const meta = await gh.getRepo('a/b');
  assert.equal(meta.stars, 1);
  assert.equal(f.calls.length, 2);
});

test('resolveToken 优先显式传入', () => {
  assert.equal(resolveToken('explicit'), 'explicit');
});
