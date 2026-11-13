/**
 * GitHub 仓库标识的解析与规范化。
 *
 * 这一步是整条链路的入口，也是最容易出错的地方：agent 传进来的可能是
 * 完整 URL、git clone 的 scp 形式、带 .git 后缀、带 /tree/main 子路径、
 * markdown 里的链接、甚至被引号包裹的字符串。全部收敛成 owner/repo（小写）。
 */

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const REPO_RE = /^[a-z0-9._-]{1,100}$/;

// GitHub 的保留路径，避免把 github.com/features 这类页面当成仓库
const RESERVED_OWNERS = new Set([
  'about', 'apps', 'collections', 'contact', 'customer-stories', 'enterprise',
  'events', 'explore', 'features', 'issues', 'join', 'login', 'marketplace',
  'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls',
  'readme', 'search', 'security', 'settings', 'site', 'sponsors', 'topics',
  'trending', 'users', 'watching',
]);

function normalize(owner, repo) {
  if (!owner || !repo) return null;
  const o = String(owner).toLowerCase();
  let r = String(repo).toLowerCase().replace(/\.git$/, '');
  if (RESERVED_OWNERS.has(o)) return null;
  if (!OWNER_RE.test(o)) return null;
  if (!REPO_RE.test(r)) return null;
  if (r === '.' || r === '..') return null;
  return `${o}/${r}`;
}

/** 去掉字符串两端的引号/尖括号/标点，这些常出现在 markdown 与命令行里 */
function trimWrappers(s) {
  return s
    .replace(/^[\s<("'`[{|]+/, '')
    .replace(/[\s>)"'`\]}.,;:!?|]+$/, '');
}

/**
 * 把任意形式的仓库引用解析成 `owner/repo`，失败返回 null。
 * @param {string} input
 * @returns {string|null}
 */
export function parseRepo(input) {
  if (typeof input !== 'string') return null;
  let s = trimWrappers(input);
  if (!s) return null;

  // git@github.com:owner/repo.git
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(s);
  if (scp) return normalize(scp[1], scp[2]);

  // npm 的 github: 简写：`npm i github:owner/repo`、`pkg@github:owner/repo`
  const ghShorthand = /^(?:[^@\s]+@)?github:([^/\s]+)\/([^/\s]+)$/i.exec(s);
  if (ghShorthand) return normalize(ghShorthand[1], ghShorthand[2]);

  // https://github.com/owner/repo(.git)(/tree/main)(?tab=readme)
  if (/^(https?|git\+https?|ssh):\/\//i.test(s)) {
    try {
      const u = new URL(s.replace(/^git\+/, ''));
      if (!GITHUB_HOSTS.has(u.hostname.toLowerCase())) return null;
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg.length < 2) return null;
      return normalize(seg[0], seg[1]);
    } catch {
      return null;
    }
  }

  // github.com/owner/repo 或 www.github.com/owner/repo
  const bare = /^(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i.exec(s);
  if (bare) return normalize(bare[1], bare[2]);

  // owner/repo 简写
  const short = /^([^/\s#?]+)\/([^/\s#?]+)$/.exec(s);
  if (short) return normalize(short[1], short[2]);

  return null;
}

/**
 * 从一段自由文本中抽出所有 GitHub 仓库（去重，保持出现顺序）。
 *
 * 注意不要用"裸 owner/repo"全局正则兜底 —— URL 里的 github.com/xxx 会被
 * 误切成 com/xxx，shell 里的 /home/user/project 也会被误判。裸写法只在
 * clone / install 这类命令的参数位置才可信。
 */
export function extractRepos(text, limit = 5) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const seen = new Set();

  const push = (owner, repo) => {
    const r = normalize(owner, repo);
    if (r && !seen.has(r) && out.length < limit) {
      seen.add(r);
      out.push(r);
    }
  };

  // 1) 完整 URL
  const urlRe = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;
  let m;
  while ((m = urlRe.exec(text))) push(m[1], m[2]);

  // 2) scp 形式 git@github.com:owner/repo.git
  const scpRe = /git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;
  while ((m = scpRe.exec(text))) push(m[1], m[2]);

  // 3) 命令参数位置上的裸 owner/repo
  const cmdRe = /\b(?:git\s+clone|gh\s+repo\s+clone|npm\s+(?:i|install|add)|pnpm\s+add|yarn\s+add|bun\s+add|go\s+get|pip\s+install)\s+((?:--?[\w-]+(?:=\S+)?\s+)*)(\S+)/gi;
  while ((m = cmdRe.exec(text))) {
    const token = trimWrappers(m[2]);
    const parsed = parseRepo(token);
    if (parsed) push(...parsed.split('/'));
  }

  return out;
}

export function isValidRepo(repo) {
  if (typeof repo !== 'string') return false;
  const parts = repo.split('/');
  return parts.length === 2 && normalize(parts[0], parts[1]) === repo;
}
