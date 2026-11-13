/**
 * 编排层：把解析、策略、GitHub 调用、账本串起来。
 * MCP server / CLI / hook 都只调这里，保证三条入口行为完全一致。
 */

import { parseRepo } from './repo.js';
import { decide, explain } from './policy.js';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {ReturnType<import('./ledger.js').createLedger>} deps.ledger
 * @param {ReturnType<import('./github.js').createGitHub>} deps.gh
 * @param {() => Date} [deps.now]
 */
export function createStarService({ config, ledger, gh, now = () => new Date() }) {
  let viewerCache;
  async function viewer() {
    if (viewerCache !== undefined) return viewerCache;
    try {
      const v = await gh.getViewer();
      viewerCache = v ? v.login : null;
    } catch {
      viewerCache = null;
    }
    return viewerCache;
  }

  /**
   * 确保某个因使用而接触到的仓库被点星。
   * @param {object} p
   * @param {string} p.repo      仓库引用（任意形式）
   * @param {string} [p.reason]  为什么用它（写进账本，便于回溯）
   * @param {string} [p.source]  来源：mcp / cli / hook:xxx
   * @param {boolean} [p.force]  跳过策略直接点（仍不越过黑名单与总开关）
   */
  async function ensure({ repo: repoInput, reason = '', source = 'mcp', force = false } = {}) {
    const repo = parseRepo(repoInput);
    if (!repo) {
      return {
        repo: String(repoInput ?? ''),
        action: 'skipped',
        reason: 'invalid',
        message: `无法识别的 GitHub 仓库：${repoInput}`,
      };
    }

    // 幂等出口：本地已记录就不必再打 GitHub
    const starredNow = ledger.starredSet();
    if (!force && starredNow.has(repo)) {
      return { repo, action: 'skipped', reason: 'already', message: `★ 已点过 ${repo}，跳过` };
    }

    let meta = null;
    try {
      meta = await gh.getRepo(repo);
    } catch (err) {
      ledger.append({ repo, action: 'failed', reason: 'meta-failed', source, detail: err.message });
      return { repo, action: 'failed', reason: 'meta-failed', message: `获取仓库信息失败：${err.message}` };
    }

    if (!meta) {
      ledger.append({ repo, action: 'skipped', reason: 'not-found', source });
      return { repo, action: 'skipped', reason: 'not-found', message: `仓库不存在或无权访问：${repo}` };
    }

    const decision = decide({
      repo,
      meta,
      config,
      starred: starredNow,
      todayCount: ledger.countToday(now()),
      viewer: await viewer(),
    });

    if (decision.action === 'skip') {
      ledger.append({
        repo,
        action: decision.intended ? 'intended' : 'skipped',
        reason: decision.reason,
        source,
        stars: meta.stars,
      });
      const tail = decision.intended ? '（dry-run：没有真的点）' : '';
      return {
        repo,
        action: 'skipped',
        reason: decision.reason,
        message: `未点星 ${repo}：${explain(decision.reason)}${tail}`,
      };
    }

    if (decision.action === 'confirm') {
      return {
        repo,
        action: 'confirm',
        reason: 'confirm',
        message: `是否给 ${repo}（★${meta.stars}）点星？当前是 confirm 模式，请先询问用户。`,
      };
    }

    // 以 GitHub 远端状态为最终依据，避免本地账本被删导致重复 PUT
    try {
      if (!force && (await gh.isStarred(repo))) {
        ledger.append({ repo, action: 'starred', reason: 'remote-already', source, stars: meta.stars });
        return { repo, action: 'skipped', reason: 'remote-already', message: `★ ${repo} 在 GitHub 上已是星标状态` };
      }
    } catch (err) {
      // 查不到状态不阻断点星，继续尝试
      console.error(`[gh-autostar] 查询远端星标状态失败，继续点星: ${err.message}`);
    }

    try {
      await gh.star(repo);
    } catch (err) {
      ledger.append({ repo, action: 'failed', reason: 'star-failed', source, detail: err.message });
      return { repo, action: 'failed', reason: 'star-failed', message: `点星失败 ${repo}：${err.message}` };
    }

    const row = ledger.append({
      repo,
      action: 'starred',
      reason: 'ok',
      source,
      stars: meta.stars,
      note: reason ? String(reason).slice(0, 200) : undefined,
    });

    const n = ledger.countToday(now());
    return {
      repo,
      action: 'starred',
      reason: 'ok',
      stars: meta.stars,
      today: n,
      ts: row.ts,
      message: `★ 已给 ${repo} 点星（★${meta.stars}，今天第 ${n}/${config.dailyCap} 颗）`,
    };
  }

  async function unstar({ repo: repoInput, source = 'mcp' } = {}) {
    const repo = parseRepo(repoInput);
    if (!repo) {
      return { repo: String(repoInput ?? ''), action: 'failed', reason: 'invalid', message: `无法识别的仓库：${repoInput}` };
    }
    try {
      await gh.unstar(repo);
      ledger.append({ repo, action: 'unstarred', source });
      return { repo, action: 'unstarred', message: `已取消 ${repo} 的星标` };
    } catch (err) {
      return { repo, action: 'failed', reason: 'unstar-failed', message: `取消星标失败：${err.message}` };
    }
  }

  async function status() {
    const v = await viewer();
    return {
      enabled: config.enabled,
      mode: config.mode,
      dailyCap: config.dailyCap,
      todayCount: ledger.countToday(now()),
      remaining: Math.max(0, config.dailyCap - ledger.countToday(now())),
      totalStarred: ledger.starredSet().size,
      authenticated: gh.hasToken,
      viewer: v,
      allowlistOnly: config.allowlistOnly,
      allowlist: config.allowlist,
      denylist: config.denylist,
      ledgerPath: ledger.filePath,
    };
  }

  return { ensure, unstar, status, viewer };
}
