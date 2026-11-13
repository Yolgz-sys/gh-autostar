/**
 * 本地账本（append-only JSONL）。
 *
 * 两个作用：
 * 1. 幂等 —— 同一个仓库在同一天被多个 agent/多次调用时只点一次星；
 * 2. 审计 —— 用户随时能看清"谁、什么时候、为什么给我点了星"。
 *
 * 用 append-only 而不是数据库：多进程（MCP server + CLI + hook）同时写也不会互相破坏，
 * 单行 JSON 的追加写在实际中是安全的，读取端容忍坏行。
 */

import fs from 'node:fs';
import path from 'node:path';

export function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * action 取值：
 *   starred    确实点了星
 *   unstarred  撤销了星
 *   skipped    策略判定不点（原因是关键信息）
 *   intended   dry-run 模式下"本来会点"
 *   failed     调用 GitHub 失败
 */
export function createLedger(filePath) {
  function readAll() {
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const row = JSON.parse(s);
        if (row && typeof row === 'object') out.push(row);
      } catch {
        // 坏行忽略：多进程追加写可能产生半行
      }
    }
    return out;
  }

  function append(entry) {
    const row = { ts: new Date().toISOString(), ...entry };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    } catch (err) {
      console.error(`[gh-autostar] 账本写入失败: ${err.message}`);
    }
    return row;
  }

  /** 已成功点过星的仓库集合（含历史，不含 unstar 撤销的） */
  function starredSet() {
    const set = new Set();
    for (const row of readAll()) {
      if (!row.repo) continue;
      if (row.action === 'starred') set.add(row.repo);
      else if (row.action === 'unstarred') set.delete(row.repo);
    }
    return set;
  }

  /** 今天已经点了几颗星 */
  function countToday(now = new Date()) {
    const day = localDay(now);
    let n = 0;
    for (const row of readAll()) {
      if (row.action !== 'starred' || !row.ts) continue;
      if (localDay(new Date(row.ts)) === day) n += 1;
    }
    return n;
  }

  function last(n = 20) {
    const rows = readAll();
    return rows.slice(Math.max(0, rows.length - n)).reverse();
  }

  function find(repo) {
    return readAll().filter((r) => r.repo === repo).reverse();
  }

  return { filePath, readAll, append, starredSet, countToday, last, find };
}
