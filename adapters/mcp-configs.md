# 各宿主接入配置

MCP 是通用路径 —— 同一个 server 进程，复制一份配置到对应宿主的配置文件即可。
下面把 `/ABS/PATH/gh-autostar` 换成本仓库在你机器上的实际绝对路径。

---

## WorkBuddy

配置文件：`~/.workbuddy/mcp.json`（注意不是 `.mcp.json`）

```json
{
  "mcpServers": {
    "gh-autostar": {
      "command": "node",
      "args": ["/ABS/PATH/gh-autostar/src/mcp/server.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxx"
      }
    }
  }
}
```

写入后需要到「连接器管理 → 自定义连接器」里对新出现的 server 点一次 **信任**，否则不会生效。
`env` 里的 token 可以省略 —— 省略时会自动读取 `gh auth login` 的登录态。

---

## Claude Code

项目级 `.mcp.json`（放在项目根目录，可入库）：

```json
{
  "mcpServers": {
    "gh-autostar": {
      "command": "node",
      "args": ["/ABS/PATH/gh-autostar/src/mcp/server.js"]
    }
  }
}
```

或一行命令：

```bash
claude mcp add gh-autostar -- node /ABS/PATH/gh-autostar/src/mcp/server.js
```

另外还有一条**确定性**路径（不依赖模型自觉）：把 `adapters/claude-code/hooks/hooks.json`
的 `PostToolUse` 段合并进 `~/.claude/settings.json`，每次 Bash / WebFetch 调用后
自动从命令行和 URL 里抠出 GitHub 仓库并点星。详见该目录下的 README。

---

## Cursor

`~/.cursor/mcp.json`（全局）或 `<project>/.cursor/mcp.json`（项目级），结构同上：

```json
{
  "mcpServers": {
    "gh-autostar": {
      "command": "node",
      "args": ["/ABS/PATH/gh-autostar/src/mcp/server.js"]
    }
  }
}
```

---

## Cline / Roo Code（VS Code 插件）

`cline_mcp_settings.json`：

```json
{
  "mcpServers": {
    "gh-autostar": {
      "command": "node",
      "args": ["/ABS/PATH/gh-autostar/src/mcp/server.js"],
      "disabled": false,
      "autoApprove": ["ensure_starred", "check_star", "star_status", "list_recent_stars"]
    }
  }
}
```

`autoApprove` 里放只读或低风险工具，避免每点一颗星都弹一次确认。

---

## Windsurf

`~/.codeium/windsurf/mcp_config.json`：

```json
{
  "mcpServers": {
    "gh-autostar": {
      "command": "node",
      "args": ["/ABS/PATH/gh-autostar/src/mcp/server.js"]
    }
  }
}
```

---

## Claude Desktop

`claude_desktop_config.json`（macOS 在 `~/Library/Application Support/Claude/`，
Windows 在 `%APPDATA%\Claude\`）：

```json
{
  "mcpServers": {
    "gh-autostar": {
      "command": "node",
      "args": ["/ABS/PATH/gh-autostar/src/mcp/server.js"]
    }
  }
}
```

---

## Codex CLI

`~/.codex/config.toml`：

```toml
[mcp_servers.gh-autostar]
command = "node"
args = ["/ABS/PATH/gh-autostar/src/mcp/server.js"]
```

---

## 任何其它 MCP 宿主

只要支持 stdio 传输，配置就是这两行：启动 `node <repo>/src/mcp/server.js`，
协议内容全部走 stdin/stdout，不需要端口，不需要后台常驻。

## 一句提醒

不同宿主的配置文件路径与字段名会随版本变化。判断标准只有一条：
**配置写完后，在宿主里问一句"你能看到 gh-autostar 的 ensure_starred 工具吗"** ——
能看到就说明接上了。看不到时优先检查路径是否为绝对路径、Node 是否 ≥ 18。
