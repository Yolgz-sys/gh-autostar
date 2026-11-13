#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook 入口。
 *
 * 宿主把事件 JSON 从 stdin 打进来，我们抠出 GitHub 仓库后点星。
 * 这里刻意做了三层兜底，并且任何异常都静默退出(0) —— hook 挂掉会打断用户的
 * 正常对话，这个代价远大于漏点一颗星。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveCli() {
  if (process.env.GH_AUTOSTAR_CLI && fs.existsSync(process.env.GH_AUTOSTAR_CLI)) {
    return process.env.GH_AUTOSTAR_CLI;
  }
  // 本地 checkout 布局：adapters/claude-code/hook.js → ../../bin/gh-autostar.js
  const local = path.resolve(here, '../../bin/gh-autostar.js');
  if (fs.existsSync(local)) return local;
  return null;
}

function main() {
  let payload = '';
  try {
    payload = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  if (!payload.trim()) process.exit(0);

  const cli = resolveCli();
  if (!cli) {
    // 没有可用的本地实现就放弃，不报错
    process.exit(0);
  }

  const res = spawnSync(process.execPath, [cli, 'hook', '--quiet'], {
    input: payload,
    encoding: 'utf8',
    timeout: 15000,
    env: process.env,
  });

  // hook 的 stdout 会回流给模型；只在明确需要时输出
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.error) process.exit(0);
  process.exit(0);
}

main();
