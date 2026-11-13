#!/usr/bin/env node
/**
 * 接入自检脚本。
 *
 * 解决一个具体问题："我把 MCP 配置写进去了，但它到底通没通？"
 * 它做三件事：校验配置文件、真的拉起 server 走完握手、调一个只读工具看返回。
 *
 * 全程强制 GH_AUTOSTAR_MODE=dry-run，不会在你的 GitHub 账号上点任何星。
 *
 * 用法：
 *   node scripts/verify-install.mjs                  # 默认检查 WorkBuddy
 *   node scripts/verify-install.mjs --config=<path>  # 检查其它宿主的配置文件
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const configArg = args.find((a) => a.startsWith('--config='));
const configPath = configArg
  ? configArg.slice('--config='.length)
  : path.join(os.homedir(), '.workbuddy', 'mcp.json');

const RESULTS = [];
const ok = (label, detail = '') => RESULTS.push({ pass: true, label, detail });
const bad = (label, detail = '') => RESULTS.push({ pass: false, label, detail });

function fail(label, detail, hint) {
  bad(label, detail);
  print(hint);
  process.exit(1);
}

function print(hint) {
  console.log('\n自检结果');
  console.log('─'.repeat(52));
  for (const r of RESULTS) {
    console.log(`${r.pass ? '✓' : '✗'}  ${r.label}${r.detail ? `  ${r.detail}` : ''}`);
  }
  console.log('─'.repeat(52));
  const failed = RESULTS.filter((r) => !r.pass).length;
  if (failed === 0) {
    console.log('全部通过。');
  } else {
    console.log(`${failed} 项未通过。`);
  }
  if (hint) {
    console.log('');
    console.log(hint);
  }
}

// ── 1. 配置文件 ────────────────────────────────────────────
if (!fs.existsSync(configPath)) {
  fail('配置文件存在', configPath, `没有找到 ${configPath}。请先把 MCP 配置写进去。`);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  ok('配置文件是合法 JSON', configPath);
} catch (err) {
  fail('配置文件是合法 JSON', err.message, 'JSON 解析失败，检查是否多了尾逗号或注释。');
}

const entry = config.mcpServers?.['gh-autostar'];
if (!entry) {
  fail(
    'mcpServers 里有 gh-autostar',
    Object.keys(config.mcpServers ?? {}).join(', ') || '（空）',
    '在 mcpServers 下补一个 "gh-autostar" 条目，参考 adapters/mcp-configs.md。',
  );
}
ok('mcpServers 里有 gh-autostar');

// ── 2. 启动路径可解析 ──────────────────────────────────────
if (!entry.command) {
  fail('command 字段存在', '', '缺少 command 字段。');
}

const serverScript = (entry.args ?? []).find((a) => String(a).endsWith('.js')) ?? (entry.args ?? [])[0];
if (!serverScript || !fs.existsSync(serverScript)) {
  fail('server 脚本路径存在', serverScript ?? '（未指定）', 'args 里的路径不对，必须是绝对路径且文件真实存在。');
}
ok('server 脚本路径存在', serverScript);

// ── 3. 真的拉起进程走协议 ──────────────────────────────────
const messages = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-install', version: '0.0.0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'star_status', arguments: {} } },
];

const child = spawn(entry.command, entry.args ?? [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GH_AUTOSTAR_MODE: 'dry-run' },
  shell: false,
});

const responses = [];
let stdoutBuf = '';
let stderrBuf = '';

const timeout = setTimeout(() => {
  child.kill();
  print(`超时未收到完整响应。stderr:\n${stderrBuf.slice(-600)}`);
  process.exit(1);
}, 25000);

child.stderr.on('data', (c) => {
  stderrBuf += c.toString('utf8');
});

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf8');
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      clearTimeout(timeout);
      child.kill();
      print(`stdout 被非协议内容污染了：${line.slice(0, 200)}\n这通常意味着 server 里用了 console.log。`);
      process.exit(1);
    }
  }
  if (responses.length >= 3) {
    clearTimeout(timeout);
    child.kill();

    const init = responses.find((r) => r.id === 1);
    if (!init?.result) {
      fail('完成 MCP 握手', init?.error?.message ?? '无响应');
    }
    ok('完成 MCP 握手', `协议 ${init.result.protocolVersion} · ${init.result.serverInfo.name}`);

    if (init.result.instructions?.includes('ensure_starred')) {
      ok('instructions 已注入', '模型会看到"用到了就点星"这条规则');
    } else {
      bad('instructions 已注入', '宿主可能需要重新加载才会带上');
    }

    const tools = responses.find((r) => r.id === 2)?.result?.tools ?? [];
    ok('工具已注册', `${tools.length} 个：${tools.map((t) => t.name).join(', ')}`);

    const call = responses.find((r) => r.id === 3);
    const text = call?.result?.content?.[0]?.text ?? '';
    if (call?.error) {
      bad('star_status 可调用', call.error.message);
      print(stderrBuf.slice(-600));
      process.exit(1);
    }
    ok('star_status 可调用');
    console.log('');
    console.log('工具返回：');
    for (const line of text.split('\n')) console.log(`  ${line}`);

    console.log('');
    print();
    process.exit(0);
  }
});

child.on('error', (err) => {
  clearTimeout(timeout);
  fail('启动 server 进程', err.message, '检查 command 路径是否正确、Node 是否可执行。');
});

for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
