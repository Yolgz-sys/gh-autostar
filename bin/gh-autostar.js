#!/usr/bin/env node
/**
 * 命令行入口。存在的意义是给"没有 MCP 也能触发"的场景留一条路：
 *   - 宿主 hook（Claude Code 的 PostToolUse 等）调用 `gh-autostar touch`
 *   - git/gh 包装脚本调用 `gh-autostar touch`
 *   - 用户手动点星 / 取消 / 审计
 *
 * 与 MCP server 共用 src/core，行为完全一致。
 */

import { loadConfig, saveConfig } from '../src/core/config.js';
import { ledgerPath } from '../src/core/config.js';
import { createLedger } from '../src/core/ledger.js';
import { createGitHub } from '../src/core/github.js';
import { createStarService } from '../src/core/star.js';
import { parseRepo } from '../src/core/repo.js';
import { explain } from '../src/core/policy.js';

const USAGE = `gh-autostar — 用到了就给它点颗星

用法:
  gh-autostar touch <repo...> [--reason=文本] [--source=来源] [--quiet]
        记录"用到过"并依照策略点星。hook 与包装脚本调用这个。
  gh-autostar star <repo> [--force]
        点星。--force 跳过本地幂等检查
  gh-autostar unstar <repo>
        取消星标
  gh-autostar status [--json]
        查看开关、模式、今日配额与登录状态
  gh-autostar log [-n 20] [--json]
        查看审计账本
  gh-autostar config                       打印当前配置
  gh-autostar config <key>=<value> ...     修改配置
  gh-autostar config --allow=owner/repo    加入白名单
  gh-autostar config --deny=owner/repo     加入黑名单
  gh-autostar hook                         从 stdin 读取宿主事件并自动点星

环境变量:
  GH_AUTOSTAR_HOME       配置与账本目录（默认 ~/.gh-autostar）
  GH_AUTOSTAR_MODE       auto | confirm | dry-run
  GH_AUTOSTAR_DISABLED   设为 1 临时关闭
  GITHUB_TOKEN / GH_TOKEN  GitHub 令牌；缺省时读取 gh CLI 登录态
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=');
      const v = rest.length ? rest.join('=') : true;
      if (flags[k] === undefined) flags[k] = v;
      else if (Array.isArray(flags[k])) flags[k].push(v);
      else flags[k] = [flags[k], v];
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function mkService() {
  const config = loadConfig();
  const ledger = createLedger(ledgerPath());
  const gh = createGitHub({ apiBase: config.apiBase });
  return { config, ledger, gh, service: createStarService({ config, ledger, gh }) };
}

async function cmdTouch(flags, repos) {
  if (!repos.length) {
    console.error('缺少仓库参数。用法: gh-autostar touch owner/repo');
    return 1;
  }
  const { service } = mkService();
  let code = 0;
  for (const raw of repos) {
    const r = await service.ensure({
      repo: raw,
      reason: typeof flags.reason === 'string' ? flags.reason : '',
      source: typeof flags.source === 'string' ? flags.source : 'cli',
      force: Boolean(flags.force),
    });
    if (!flags.quiet) console.log(r.message);
    if (r.action === 'failed') code = 1;
  }
  return code;
}

async function cmdStar(flags, repos) {
  if (!repos.length) {
    console.error('缺少仓库参数。用法: gh-autostar star owner/repo');
    return 1;
  }
  const { service } = mkService();
  let code = 0;
  for (const raw of repos) {
    const r = await service.ensure({ repo: raw, reason: '手动点星', source: 'cli:manual', force: Boolean(flags.force) });
    console.log(r.message);
    if (r.action === 'failed') code = 1;
  }
  return code;
}

async function cmdUnstar(repos) {
  if (!repos.length) {
    console.error('缺少仓库参数。用法: gh-autostar unstar owner/repo');
    return 1;
  }
  const { service } = mkService();
  let code = 0;
  for (const raw of repos) {
    const r = await service.unstar({ repo: raw, source: 'cli' });
    console.log(r.message);
    if (r.action !== 'unstarred') code = 1;
  }
  return code;
}

async function cmdStatus(flags) {
  const { service } = mkService();
  const s = await service.status();
  if (flags.json) {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }
  console.log(`开关      ${s.enabled ? '开启' : '关闭'}`);
  console.log(`模式      ${s.mode}`);
  console.log(`今日      ${s.todayCount}/${s.dailyCap}（剩余 ${s.remaining}）`);
  console.log(`累计点星  ${s.totalStarred}`);
  console.log(`认证      ${s.authenticated ? `已登录 ${s.viewer ?? ''}`.trim() : '未认证 — 请 gh auth login 或设置 GITHUB_TOKEN'}`);
  console.log(`白名单    ${s.allowlistOnly ? '仅白名单生效；' : ''}${s.allowlist.length ? s.allowlist.join(', ') : '（空）'}`);
  console.log(`黑名单    ${s.denylist.length ? s.denylist.join(', ') : '（空）'}`);
  console.log(`账本      ${s.ledgerPath}`);
  return 0;
}

function cmdLog(flags) {
  const { ledger } = mkService();
  const n = Number(flags.n) || 20;
  const rows = ledger.last(Number.isFinite(n) ? n : 20);
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    console.log('还没有记录。');
    return 0;
  }
  for (const r of rows) {
    const t = String(r.ts).replace('T', ' ').slice(0, 19);
    const stars = r.stars !== undefined ? ` ★${r.stars}` : '';
    const why = r.note ? ` — ${r.note}` : r.detail ? ` — ${r.detail}` : '';
    const reason = r.reason && r.reason !== 'ok' ? ` (${explain(r.reason)})` : '';
    console.log(`${t}  [${r.action}]  ${r.repo}${stars}  ${r.source ?? '-'}${reason}${why}`);
  }
  return 0;
}

function cmdConfig(flags) {
  const assignments = Object.entries(flags).filter(([k]) => !['allow', 'deny', 'show'].includes(k));
  const allow = flags.allow ? (Array.isArray(flags.allow) ? flags.allow : [flags.allow]) : [];
  const deny = flags.deny ? (Array.isArray(flags.deny) ? flags.deny : [flags.deny]) : [];

  if (!assignments.length && !allow.length && !deny.length) {
    console.log(JSON.stringify(loadConfig(), null, 2));
    return 0;
  }

  const patch = {};
  for (const [k, v] of assignments) {
    if (v === true) {
      console.error(`参数 --${k} 需要一个值`);
      return 1;
    }
    if (['dailyCap', 'minStars'].includes(k)) patch[k] = Number(v);
    else if (['enabled', 'allowlistOnly', 'skipForks', 'skipOwnedByMe'].includes(k)) patch[k] = /^(1|true|yes|on)$/i.test(String(v));
    else if (k === 'mode') patch[k] = String(v);
    else {
      console.error(`未知配置项: ${k}`);
      return 1;
    }
  }

  const current = loadConfig();
  const add = (list) => {
    const norm = list.map((s) => parseRepo(s) || String(s).toLowerCase());
    return [...new Set([...current.allowlist, ...norm])];
  };
  if (allow.length) patch.allowlist = add(allow);
  if (deny.length) {
    const norm = deny.map((s) => parseRepo(s) || String(s).toLowerCase());
    patch.denylist = [...new Set([...current.denylist, ...norm])];
  }

  const next = saveConfig(patch);
  console.log('配置已更新：');
  console.log(JSON.stringify(next, null, 2));
  return 0;
}

async function cmdHook(flags) {
  // 延迟引入，避免普通命令加载 stdin 逻辑
  const { runHook } = await import('../hooks/lib.js');
  return runHook({ quiet: Boolean(flags.quiet) });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  switch (cmd) {
    case 'touch':
      return cmdTouch(flags, positional);
    case 'star':
      return cmdStar(flags, positional);
    case 'unstar':
      return cmdUnstar(positional);
    case 'status':
      return cmdStatus(flags);
    case 'log':
      return cmdLog(flags);
    case 'config':
      return cmdConfig(flags);
    case 'hook':
      return cmdHook(flags);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`[gh-autostar] 错误: ${err?.message || err}`);
    process.exit(1);
  });
