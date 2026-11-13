/**
 * 策略引擎：纯函数，不碰网络也不碰磁盘。
 * 所有"到底该不该点这一颗星"的判断都收敛在这里，方便单测和解释。
 *
 * 返回 { action, reason, intended }
 *   action: 'star' | 'skip' | 'confirm'
 *   reason: 机器可读的原因码，会写进账本并回给 agent
 *   intended: dry-run 时表示"本来会点"
 */

export const REASONS = {
  disabled: '功能已关闭',
  denylist: '仓库在黑名单中',
  already: '本地账本已记录点过星',
  'not-allowlisted': '未开启白名单模式：只对白名单仓库生效',
  self: '这是你自己的仓库',
  'min-stars': '仓库星数低于下限（疑似测试或垃圾仓库）',
  fork: '仓库是 fork',
  'daily-cap': '已达今日上限',
  'dry-run': 'dry-run 模式，只记录不执行',
  confirm: 'confirm 模式，需要用户确认',
  ok: '符合策略',
};

/**
 * @param {object} p
 * @param {string} p.repo           规范化后的 owner/repo
 * @param {object} p.meta           GitHub 仓库信息（可为 null）
 * @param {object} p.config
 * @param {Set<string>} p.starred   账本中已点星的仓库
 * @param {number} p.todayCount     今日已点星数
 * @param {string|null} p.viewer    当前登录用户 login
 * @returns {{action:'star'|'skip'|'confirm', reason:string, intended?:boolean}}
 */
export function decide({ repo, meta, config, starred, todayCount, viewer }) {
  const skip = (code) => ({ action: 'skip', reason: code });
  const allowlisted = config.allowlist.includes(repo);

  if (!config.enabled) return skip('disabled');
  if (config.denylist.includes(repo)) return skip('denylist');
  if (starred.has(repo)) return skip('already');

  if (config.allowlistOnly && !allowlisted) return skip('not-allowlisted');

  if (config.skipOwnedByMe && viewer && meta?.ownerLogin && meta.ownerLogin.toLowerCase() === viewer.toLowerCase()) {
    return skip('self');
  }

  // 质量过滤：白名单里的仓库可以用"我就是要支持它"覆盖掉
  if (!allowlisted) {
    if (config.minStars > 0 && meta && meta.stars < config.minStars) return skip('min-stars');
    if (config.skipForks && meta?.fork) return skip('fork');
  }

  if (config.dailyCap > 0 && todayCount >= config.dailyCap) return skip('daily-cap');

  if (config.mode === 'dry-run') return { action: 'skip', reason: 'dry-run', intended: true };
  if (config.mode === 'confirm') return { action: 'confirm', reason: 'confirm' };

  return { action: 'star', reason: 'ok' };
}

export function explain(reason) {
  return REASONS[reason] || reason;
}
