/**
 * 极简 GitHub REST 客户端。只做四件事：取仓库信息、查星、点星、取消星。
 * 不引第三方 HTTP 库 —— Node 18+ 自带 fetch，少一个依赖就少一处跨平台风险。
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

export class GitHubError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

const UA = 'gh-autostar-mcp/0.1 (+https://github.com)';

/**
 * gh 的可执行文件位置。
 *
 * 为什么要写死几个候选路径：MCP server 是被宿主（WorkBuddy / Claude Code / Cursor…）
 * spawn 的子进程，它的 PATH 不一定等于你终端里的 PATH —— 尤其是 GUI 启动的宿主，
 * 常常只继承系统级 PATH，看不到用户级安装的 CLI。只靠 `gh` 两个字大概率在别人的机器上翻车。
 */
function ghCandidates() {
  const list = ['gh'];
  if (process.platform === 'win32') {
    list.push('C:\\Program Files\\GitHub CLI\\gh.exe');
    list.push('C:\\Program Files (x86)\\GitHub CLI\\gh.exe');
    if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'GitHubCLI', 'gh.exe'));
  } else {
    list.push('/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh');
  }
  return list;
}

// 成功解析出的 token 永久缓存；解析失败只缓存 60 秒 ——
// 否则用户中途 `gh auth login` 之后，长驻的 MCP server 要重启才能恢复。
let cachedToken = null;
let cachedAt = 0;
const NEGATIVE_TTL_MS = 60_000;

/** 依次尝试：显式 token → 环境变量 → gh CLI 登录态 */
export function resolveToken(explicit) {
  if (explicit) return explicit;

  const fresh = cachedToken !== null || Date.now() - cachedAt < NEGATIVE_TTL_MS;
  if (fresh && (cachedToken !== null || cachedAt > 0)) return cachedToken;

  for (const key of ['GH_AUTOSTAR_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = process.env[key];
    if (v && v.trim()) {
      cachedToken = v.trim();
      cachedAt = Date.now();
      return cachedToken;
    }
  }

  for (const bin of ghCandidates()) {
    try {
      const out = execFileSync(bin, ['auth', 'token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
      }).trim();
      if (out) {
        cachedToken = out;
        cachedAt = Date.now();
        return cachedToken;
      }
    } catch {
      // 没装 / 没登录 / 路径不对，换下一个候选
    }
  }

  cachedToken = null;
  cachedAt = Date.now();
  return null;
}

export function createGitHub({
  token,
  apiBase = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  tokenResolver = resolveToken,
} = {}) {
  const authToken = tokenResolver(token);

  const headers = () => {
    const h = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
    };
    if (authToken) h.Authorization = `Bearer ${authToken}`;
    return h;
  };

  async function request(method, endpoint, { retries = 1 } = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${apiBase}${endpoint}`;
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: headers(),
          body: method === 'PUT' ? '' : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt < retries) {
          attempt += 1;
          continue;
        }
        throw new GitHubError(`网络请求失败: ${err.message}`, { status: 0 });
      }

      // 5xx / 429 退避重试一次，避免偶发抖动导致漏点星
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        attempt += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : 600;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      return res;
    }
  }

  return {
    hasToken: Boolean(authToken),

    async getRepo(repo) {
      const res = await request('GET', `/repos/${repo}`);
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new GitHubError(`获取仓库失败 ${repo}: HTTP ${res.status}`, { status: res.status });
      }
      const data = await res.json();
      return {
        fullName: data.full_name,
        stars: data.stargazers_count ?? 0,
        forks: data.forks_count ?? 0,
        fork: Boolean(data.fork),
        archived: Boolean(data.archived),
        ownerLogin: data.owner?.login ?? null,
        ownerType: data.owner?.type ?? null,
        description: data.description ?? null,
        htmlUrl: data.html_url ?? null,
      };
    },

    async getViewer() {
      if (!authToken) return null;
      const res = await request('GET', '/user');
      if (!res.ok) return null;
      const data = await res.json();
      return { login: data.login, id: data.id };
    },

    /** 以 GitHub 为准判断是否已点星，避免本地账本丢失后重复操作 */
    async isStarred(repo) {
      if (!authToken) return false;
      const res = await request('GET', `/user/starred/${repo}`);
      if (res.status === 204) return true;
      if (res.status === 404) return false;
      if (res.status === 401 || res.status === 403) {
        throw new GitHubError('GitHub 令牌无效或权限不足（需要 public_repo 或 repo scope）', { status: res.status });
      }
      throw new GitHubError(`查询星标状态失败: HTTP ${res.status}`, { status: res.status });
    },

    async star(repo) {
      if (!authToken) {
        throw new GitHubError('缺少 GitHub 令牌，无法点星。请运行 `gh auth login` 或设置 GITHUB_TOKEN');
      }
      const res = await request('PUT', `/user/starred/${repo}`);
      if (res.status === 204 || res.status === 200) return true;
      if (res.status === 401) throw new GitHubError('GitHub 令牌无效', { status: 401 });
      if (res.status === 403) {
        const body = await res.text().catch(() => '');
        throw new GitHubError(`没有权限点星（可能是仓库已禁用或令牌 scope 不足）: ${body.slice(0, 200)}`, { status: 403 });
      }
      throw new GitHubError(`点星失败: HTTP ${res.status}`, { status: res.status });
    },

    async unstar(repo) {
      if (!authToken) throw new GitHubError('缺少 GitHub 令牌，无法取消星标');
      const res = await request('DELETE', `/user/starred/${repo}`);
      if (res.status === 204 || res.status === 404) return true;
      throw new GitHubError(`取消星标失败: HTTP ${res.status}`, { status: res.status });
    },
  };
}
