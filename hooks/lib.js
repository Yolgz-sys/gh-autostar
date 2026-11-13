/**
 * 宿主 hook 的公共实现。
 *
 * hook 的价值：MCP 靠模型"记得调用"，hook 是宿主层面的确定性拦截 ——
 * 只要工具调用里出现 github 仓库，就一定被记账，不依赖模型自觉。
 *
 * 读取 stdin 的 JSON 事件（Claude Code / 兼容宿主），提取 GitHub 仓库后逐一点星。
 * 单次最多处理 3 个仓库，hook 有时间预算，不能拖住主流程。
 */

import { loadConfig, ledgerPath } from '../src/core/config.js';
import { createLedger } from '../src/core/ledger.js';
import { createGitHub } from '../src/core/github.js';
import { createStarService } from '../src/core/star.js';
import { extractRepos } from '../src/core/repo.js';

/** 递归收集对象里的所有字符串，用于从任意 tool_input 结构里挖 URL/命令 */
function collectStrings(value, out = [], depth = 0) {
  if (depth > 6 || out.length > 200) return out;
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  }
  return out;
}

export async function runHook({ quiet = true } = {}) {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    return 0;
  }

  if (!raw.trim()) return 0;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return 0;
  }

  const strings = collectStrings(event.tool_input ?? event);
  const toolName = event.tool_name ?? event.hook_event_name ?? 'hook';
  const repos = extractRepos(strings.join('\n'), 3);

  if (!repos.length) return 0;

  const config = loadConfig();
  if (!config.enabled) return 0;

  const ledger = createLedger(ledgerPath());
  const gh = createGitHub({ apiBase: config.apiBase });
  const service = createStarService({ config, ledger, gh });

  const lines = [];
  for (const repo of repos) {
    // 已经点过就不必再走网络，hook 越快越好
    if (ledger.starredSet().has(repo)) continue;
    try {
      const r = await service.ensure({
        repo,
        source: `hook:${toolName}`,
        reason: `通过 ${toolName} 使用`,
      });
      lines.push(r.message);
    } catch (err) {
      lines.push(`点星失败 ${repo}: ${err.message}`);
    }
  }

  // PostToolUse 的 stdout 会作为附加上下文回给模型；这里刻意保持极简，
  // 否则每调用一次工具就多一段噪音。用户想看得详细可以查 `gh-autostar log`。
  if (!quiet && lines.length) {
    console.log(lines.join('\n'));
  }
  return 0;
}
