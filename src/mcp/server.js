#!/usr/bin/env node
/**
 * MCP server 入口。
 *
 * 跨 agent 的关键就在这个文件的 instructions 字段：MCP 宿主会把 server 声明的
 * instructions 注入到模型上下文里，于是"用到 GitHub 项目就点星"这条规则会跟着
 * server 一起走 —— 不管宿主是 WorkBuddy、Claude Code、Cursor 还是 Cline。
 *
 * 注意：stdio 传输下 stdout 是协议通道，任何日志必须走 stderr。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig, saveConfig } from '../core/config.js';
import { ledgerPath } from '../core/config.js';
import { createLedger } from '../core/ledger.js';
import { createGitHub } from '../core/github.js';
import { createStarService } from '../core/star.js';
import { explain } from '../core/policy.js';

const INSTRUCTIONS = `gh-autostar 已启用：当你在本次会话中"实际用到"某个 GitHub 仓库时，调用 ensure_starred 给它点一个 star，作为对开源作者的支持。

"实际用到"指：克隆仓库、把它装成依赖、读它的源码/README、抓取它的文档、采纳它的方案作为答案的落地方案。

规则：
1. 同一个仓库每轮对话只需调用一次；工具自身幂等，重复调用不会产生副作用。
2. 只在确实用到时调用。不要为了凑数去遍历搜索结果、trending 或依赖树批量点星。
3. 调用时尽量带上 reason（一句话说明用途），便于用户事后回溯。
4. 返回"未点星 xxx：已达今日上限 / 黑名单 / dry-run / 已点过"都是正常结果，不要重试，也不要换个写法绕过策略。
5. 不要主动向用户汇报每一次点星；只在 failed 时说明，或用户问起时再讲。
6. 用户明确表示"别点星"后，本轮对话不要再调用 ensure_starred。`;

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const asError = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function bootstrap() {
  const config = loadConfig();
  const ledger = createLedger(ledgerPath());
  const gh = createGitHub({ apiBase: config.apiBase });
  const service = createStarService({ config, ledger, gh });
  return { config, ledger, gh, service };
}

async function main() {
  const { config, ledger, service } = bootstrap();

  const server = new McpServer(
    { name: 'gh-autostar', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  server.tool(
    'ensure_starred',
    '当你在本轮对话中实际使用、阅读或采纳了某个 GitHub 仓库时调用，为该仓库点一个 star。幂等，可安全重复调用。',
    {
      repo: z
        .string()
        .describe('仓库引用，支持 owner/repo、完整 URL、git@github.com:owner/repo.git 等形式'),
      reason: z.string().optional().describe('一句话说明你为什么使用它，会记入审计账本'),
    },
    async ({ repo, reason }) => {
      try {
        const r = await service.ensure({ repo, reason, source: 'mcp' });
        if (r.action === 'failed') return asError(r.message);
        if (r.action === 'confirm') return text(r.message);
        return text(r.message);
      } catch (err) {
        return asError(`gh-autostar 内部错误：${err.message}`);
      }
    },
  );

  server.tool(
    'check_star',
    '查询某个 GitHub 仓库当前是否已被当前账号点星（同时检查 GitHub 远端与本地账本）。只读操作。',
    { repo: z.string().describe('仓库引用，如 owner/repo') },
    async ({ repo }) => {
      try {
        const r = await service.ensure({ repo, source: 'mcp:check' });
        if (r.action === 'skipped' && r.reason === 'already') return text(`已点星：${r.repo}`);
        if (r.action === 'skipped' && r.reason === 'remote-already') return text(`已点星（远端确认）：${r.repo}`);
        if (r.action === 'skipped' && r.reason === 'not-found') return text(`仓库不存在：${r.repo}`);
        return text(`${r.repo} 尚未点星（当前策略：${explain(r.reason)}）。如需点星请调用 ensure_starred。`);
      } catch (err) {
        return asError(`查询失败：${err.message}`);
      }
    },
  );

  server.tool(
    'unstar',
    '撤销对某个 GitHub 仓库的星标（误点或用户要求取消时使用）。',
    { repo: z.string().describe('仓库引用，如 owner/repo') },
    async ({ repo }) => {
      const r = await service.unstar({ repo, source: 'mcp' });
      return r.action === 'unstarred' ? text(r.message) : asError(r.message);
    },
  );

  server.tool(
    'star_status',
    '查看自动点星的状态：总开关、模式、今日已用配额、账号登录情况、黑名单等。',
    {},
    async () => {
      const s = await service.status();
      const lines = [
        `开关: ${s.enabled ? '开启' : '关闭'}`,
        `模式: ${s.mode}`,
        `今日: ${s.todayCount}/${s.dailyCap}（剩余 ${s.remaining}）`,
        `累计点星: ${s.totalStarred}`,
        `认证: ${s.authenticated ? `已登录 ${s.viewer ?? ''}`.trim() : '未认证（无法点星，请先 gh auth login 或设置 GITHUB_TOKEN）'}`,
        `白名单模式: ${s.allowlistOnly ? '开启' : '关闭'}`,
        `白名单: ${s.allowlist.length ? s.allowlist.join(', ') : '（空）'}`,
        `黑名单: ${s.denylist.length ? s.denylist.join(', ') : '（空）'}`,
        `账本: ${s.ledgerPath}`,
      ];
      return text(lines.join('\n'));
    },
  );

  server.tool(
    'list_recent_stars',
    '列出最近的点星记录（审计用），包含时间、仓库、来源与原因。',
    { limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 10') },
    async ({ limit }) => {
      const rows = ledger.last(limit ?? 10);
      if (!rows.length) return text('还没有任何记录。');
      const lines = rows.map((r) => {
        const t = String(r.ts).replace('T', ' ').slice(0, 19);
        const why = r.note ? ` — ${r.note}` : '';
        const stars = r.stars !== undefined ? ` ★${r.stars}` : '';
        return `${t}  [${r.action}]  ${r.repo}${stars}  (${r.source ?? '-'})${why}`;
      });
      return text(lines.join('\n'));
    },
  );

  server.tool(
    'configure_autostar',
    '修改自动点星配置：开关、模式、每日上限、白名单/黑名单增删。用户要求"别点星了""只给某几个仓库点"时使用。',
    {
      enabled: z.boolean().optional().describe('总开关'),
      mode: z.enum(['auto', 'confirm', 'dry-run']).optional().describe('auto 直接点、confirm 先问用户、dry-run 只记录'),
      dailyCap: z.number().int().min(0).max(200).optional().describe('每日上限，0 表示不限制之外的全部拦截'),
      allowlistAdd: z.string().optional().describe('加入白名单的仓库'),
      allowlistRemove: z.string().optional(),
      denylistAdd: z.string().optional().describe('加入黑名单的仓库，永不点星'),
      denylistRemove: z.string().optional(),
    },
    async (args) => {
      const current = loadConfig();
      const patch = {};
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.mode !== undefined) patch.mode = args.mode;
      if (args.dailyCap !== undefined) patch.dailyCap = args.dailyCap;

      const norm = (s) => String(s).toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/.*$/, (m, i, str) => (str.split('/').length > 2 ? '' : m));
      if (args.allowlistAdd) patch.allowlist = [...new Set([...current.allowlist, norm(args.allowlistAdd)])];
      if (args.allowlistRemove) patch.allowlist = (patch.allowlist ?? current.allowlist).filter((r) => r !== norm(args.allowlistRemove));
      if (args.denylistAdd) patch.denylist = [...new Set([...current.denylist, norm(args.denylistAdd)])];
      if (args.denylistRemove) patch.denylist = (patch.denylist ?? current.denylist).filter((r) => r !== norm(args.denylistRemove));

      if (!Object.keys(patch).length) return text('没有需要修改的项。');

      const next = saveConfig(patch);
      return text(
        `配置已更新：开关=${next.enabled ? '开' : '关'}，模式=${next.mode}，每日上限=${next.dailyCap}，白名单=${next.allowlist.length}项，黑名单=${next.denylist.length}项。`,
      );
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[gh-autostar] 已就绪（mode=${config.mode}, enabled=${config.enabled}）`);
}

main().catch((err) => {
  console.error(`[gh-autostar] 启动失败: ${err?.stack || err}`);
  process.exit(1);
});
