# Claude Code 适配层

这里给的是**双通道**：MCP 走模型自觉，hook 走宿主拦截。两个可以同时开。

## 通道一：MCP（推荐先开这个）

见 `../mcp-configs.md` 的 Claude Code 段。`.mcp.json` 已经写好，
直接把它拷到项目根目录，或者用 `/ABS/PATH/gh-autostar/adapters/claude-code/.mcp.json`
作为参考。

## 通道二：PostToolUse hook（确定性）

MCP 有个天然缺陷：模型可能忘了调用工具。hook 在宿主层面拦截，只要
Bash / WebFetch / WebSearch 的入参里出现 GitHub 仓库，就一定被处理。

把 `hooks/hooks.json` 的 `PostToolUse` 段合并进 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash|WebFetch|WebSearch",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/ABS/PATH/gh-autostar/hooks/claude-post-tool.js\"",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

> 注意：`hooks/hooks.json` 里用的是 `${CLAUDE_PLUGIN_ROOT}`，那是**作为插件安装**时才有的
> 变量。如果你是手动合并进 settings.json，请把命令换成上面的绝对路径形式。
> 这里没有用 `hooks/lib.js` 直接当命令，是因为 hook 需要读 stdin 并保证异常静默退出，
> `hook.js` 就是这层保护壳。

### 它到底拦什么

`hooks/lib.js` 会递归扫 `tool_input` 里的所有字符串，用 `extractRepos()` 提取仓库：

| 事件 | 会命中的例子 |
|---|---|
| `Bash` | `git clone https://github.com/foo/bar.git`、`npm i github:foo/bar` |
| `WebFetch` | `{"url": "https://github.com/foo/bar/blob/main/README.md"}` |
| `WebSearch` | 搜索回执里带出的仓库链接 |

`cat src/index.js`、`ls /home/user/project` 这类不会误判 —— 裸 `owner/repo`
只在 clone / install 命令的参数位置才被采信。

## 插件形式安装

本目录本身就是一个 Claude Code 插件骨架：

```
adapters/claude-code/
├── .claude-plugin/plugin.json   # 插件清单
├── .mcp.json                    # MCP server 注册
├── hooks/hooks.json             # hook 声明
└── hook.js                      # hook 执行入口
```

用本地路径把它加成插件源即可。因为 `hook.js` 会向上两级找到
`bin/gh-autostar.js`，所以**必须保持本目录在仓库内的相对位置**；
如果你要把插件单独发布，记得把 `bin/` `src/` `hooks/` 一起打进去，
或者设置环境变量 `GH_AUTOSTAR_CLI` 指向 CLI 的绝对路径。
