/**
 * 配置加载。
 *
 * 设计原则：任何配置错误都不能让 MCP server 起不来 —— agent 侧看到一个
 * 崩溃的 server 只会得到难懂的报错。所以这里全部走 fallback + stderr 警告。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = {
  // 总开关
  enabled: true,
  // auto: 直接点星 / confirm: 交给 agent 问用户 / dry-run: 只记录不执行
  mode: 'auto',
  // 每天最多点多少颗，防止失控
  dailyCap: 10,
  // 白名单：命中的仓库跳过质量过滤，但仍受 dailyCap 约束
  allowlist: [],
  // 黑名单：永不点星（也不允许 agent 强行点）
  denylist: [],
  // 开启后只有白名单里的仓库才会被点星
  allowlistOnly: false,
  // 低于该星数的仓库跳过，用来挡掉测试仓库与刷星垃圾
  minStars: 0,
  // 跳过 fork
  skipForks: false,
  // 不给自己名下的仓库点星
  skipOwnedByMe: true,
  apiBase: 'https://api.github.com',
};

export function homeDir() {
  return process.env.GH_AUTOSTAR_HOME || path.join(os.homedir(), '.gh-autostar');
}

export function configPath() {
  return path.join(homeDir(), 'config.json');
}

export function ledgerPath() {
  return path.join(homeDir(), 'ledger.jsonl');
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off)$/i.test(v)) return false;
  }
  return undefined;
}

function asStringArray(v) {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
}

/**
 * 合并并校验配置，永远返回一个可用的对象。
 * @param {object} [raw]
 * @returns {object}
 */
export function normalizeConfig(raw = {}) {
  const warn = [];
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };

  if (!['auto', 'confirm', 'dry-run'].includes(cfg.mode)) {
    warn.push(`未知 mode "${cfg.mode}"，回退为 auto`);
    cfg.mode = DEFAULTS.mode;
  }

  const cap = Number(cfg.dailyCap);
  cfg.dailyCap = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULTS.dailyCap;

  const minStars = Number(cfg.minStars);
  cfg.minStars = Number.isFinite(minStars) && minStars >= 0 ? Math.floor(minStars) : 0;

  for (const key of ['enabled', 'allowlistOnly', 'skipForks', 'skipOwnedByMe']) {
    const b = asBool(cfg[key]);
    cfg[key] = b === undefined ? DEFAULTS[key] : b;
  }

  for (const key of ['allowlist', 'denylist']) {
    const arr = asStringArray(cfg[key]);
    cfg[key] = arr ? arr.map((s) => s.toLowerCase()) : [];
  }

  if (typeof cfg.apiBase !== 'string' || !/^https?:\/\//.test(cfg.apiBase)) {
    cfg.apiBase = DEFAULTS.apiBase;
  }

  Object.defineProperty(cfg, '_warnings', { value: warn, enumerable: false });
  return cfg;
}

/** 读取配置文件；不存在时返回默认配置 */
export function loadConfig() {
  const file = configPath();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[gh-autostar] 配置文件解析失败，使用默认配置: ${err.message}`);
    }
  }

  const cfg = normalizeConfig(raw);

  // 环境变量优先级最高，方便临时开关
  if (process.env.GH_AUTOSTAR_DISABLED !== undefined && asBool(process.env.GH_AUTOSTAR_DISABLED)) {
    cfg.enabled = false;
  }
  if (process.env.GH_AUTOSTAR_MODE) {
    const mode = process.env.GH_AUTOSTAR_MODE;
    if (['auto', 'confirm', 'dry-run'].includes(mode)) cfg.mode = mode;
  }
  if (process.env.GH_AUTOSTAR_DAILY_CAP) {
    const n = Number(process.env.GH_AUTOSTAR_DAILY_CAP);
    if (Number.isFinite(n) && n >= 0) cfg.dailyCap = Math.floor(n);
  }

  return cfg;
}

/** 写回配置（只允许白名单字段，避免把内部状态写进文件） */
export function saveConfig(partial) {
  const file = configPath();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = {};
  }

  const allowed = Object.keys(DEFAULTS);
  for (const [k, v] of Object.entries(partial || {})) {
    if (allowed.includes(k)) raw[k] = v;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return normalizeConfig(raw);
}
