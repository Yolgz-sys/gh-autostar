/**
 * 协议层冒烟测试：真的把 MCP server 拉起来，走一遍 initialize + tools/list。
 * 不调用任何工具，因此不触网 —— 只验证 stdio 握手、instructions 注入、工具清单。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, 'src', 'mcp', 'server.js');

function runSession(messages, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-autostar-mcp-'));
    const child = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, GH_AUTOSTAR_HOME: home, GH_AUTOSTAR_DISABLED: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const responses = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`握手超时，已收到 ${responses.length} 条响应；stderr: ${buf.slice(-500)}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          // 非 JSON 输出说明有东西污染了 stdout —— 直接失败
          clearTimeout(timer);
          child.kill();
          reject(new Error(`stdout 出现非协议内容: ${line.slice(0, 200)}`));
          return;
        }
        if (responses.length >= messages.filter((m) => m.id !== undefined).length) {
          clearTimeout(timer);
          child.kill();
          resolve(responses);
          return;
        }
      }
    });

    child.on('error', reject);
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gh-autostar-test', version: '0.0.0' },
  },
};

test('MCP server 完成握手并暴露工具与 instructions', async () => {
  const responses = await runSession([
    INIT,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);

  const init = responses.find((r) => r.id === 1);
  assert.ok(init?.result, 'initialize 应有 result');
  assert.equal(init.result.serverInfo.name, 'gh-autostar');
  assert.ok(init.result.protocolVersion, '应返回协商后的协议版本');

  // instructions 是跨 agent 生效的关键，必须真的出现在 initialize 结果里
  assert.match(init.result.instructions || '', /ensure_starred/);

  const list = responses.find((r) => r.id === 2);
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'check_star',
    'configure_autostar',
    'ensure_starred',
    'list_recent_stars',
    'star_status',
    'unstar',
  ]);

  const ensure = list.result.tools.find((t) => t.name === 'ensure_starred');
  assert.equal(ensure.inputSchema.required.includes('repo'), true);
  assert.ok(ensure.description.length > 10);
});
