# DSH Subagent for Claude Code

把 **DeepSeek Harness（DSH）** 作为 Claude Code 的 subagent 调用。

Claude Code 通过一个 MCP 工具 `dsh_delegate` 启动独立的 `dsh --profile headless` 进程。DSH 在自己的上下文里使用 DeepSeek 模型和完整的文件 / Shell / 搜索工具完成任务，只把**最终答案**返回给 Claude Code。DSH 的推理过程、工具调用和 stderr 都不会进入 Claude Code 的上下文。

```
Claude Code
  └─ MCP (stdio) ──> plugins/dsh/mcp/server.mjs
                        └─ spawn ──> dsh --profile headless --json
                                       └─ DeepSeek 模型 + DSH 工具（在 cwd 中工作）
                        <── final 事件中的最终答案
```

## 包含什么

| 组件 | 用法 | 作用 |
|---|---|---|
| MCP 工具 `dsh_delegate` | Claude 自动调用 | 把一段独立任务交给 DSH 执行，返回最终答案 |
| Subagent `dsh` | Task 工具，类型 `dsh` / `dsh:dsh` | 一层很薄的代理：整理任务、调用工具、原样返回答案 |
| `/dsh:delegate <任务>` | 斜杠命令 | 手动把任务交给 DSH |
| `/dsh:doctor` | 斜杠命令 | 用一次只读调用检查 DSH 是否可达、认证是否正常 |

每次调用都是**独立的 DSH session**：DSH 看不到 Claude Code 的对话，也不能反问。把路径、约束、期望输出格式都写进任务描述里。

## 环境要求

- Claude Code 2.1+（需要插件和 MCP 支持）
- DeepSeek Harness 桌面版已安装并登录，或者有 `DEEPSEEK_API_KEY`
- `node` 18+ 在 `PATH` 中（MCP server 零依赖，只需要 Node）
- macOS 会自动找到 `/Applications/DeepSeek Harness.app/.../runtime/cli/bin/dsh`；其他平台把 `dsh` 放进 `PATH`，或设置 `DSH_BIN`

`node -v` 可以确认版本。MCP server 不需要安装任何 npm 包。

## 安装

### 方式一：从 GitHub 安装（推荐）

在终端：

```sh
claude plugin marketplace add abersheeran/dsh-claude-plugin
claude plugin install dsh@dsh-plugins
```

或者在 Claude Code 里：

```text
/plugin marketplace add abersheeran/dsh-claude-plugin
/plugin install dsh@dsh-plugins
```

重启 Claude Code（或执行 `/reload-plugins`）后生效。用 `/dsh:doctor` 验证。

本地开发时也可以把 `abersheeran/dsh-claude-plugin` 换成仓库目录的路径：

```sh
claude plugin marketplace add ./dsh-claude-plugin
```

### 方式二：只对当前会话加载

```sh
git clone https://github.com/abersheeran/dsh-claude-plugin.git
claude --plugin-dir ./dsh-claude-plugin/plugins/dsh
```

适合开发调试，不会安装到 `~/.claude`。

### 卸载

```text
/plugin
```

在插件界面里禁用或移除 `dsh@dsh-plugins`。

## 快速验证

```text
/dsh:doctor
```

成功时 Claude 会告诉你 DSH 返回了 `DSH_OK`。也可以直接说：

> 用 dsh subagent 回复 DSH_OK

## 使用方式

### 自然语言委派

```text
用 dsh subagent 审查 src/auth.ts 的安全问题，只读，不要改文件。
```

```text
让 dsh subagent 在这个仓库里找出所有未处理的 Promise rejection，给出文件:行号列表。
```

```text
并行让两个 dsh subagent 分别评估 PostgreSQL 和 SQLite 方案，然后对比结论。
```

### 斜杠命令

```text
/dsh:delegate 把 README 里的安装步骤改写成更短的版本，只输出改写后的 Markdown。
```

命令会把 `$ARGUMENTS` 交给 Claude，由 Claude 整理成完整任务后调用 `dsh_delegate`。命令已声明 `allowed-tools`，第一次使用时通常不需要额外授权。

### Subagent

Claude Code 的 Task 工具里有 `dsh` 这个 subagent 类型。它只做一件事：调用 `dsh_delegate` 并把答案原样带回。适合希望“委派动作”本身也独立在子上下文里完成的场景。

## 认证

插件按以下顺序选择 DSH 的模型路由：

1. 设置了 `DSH_SUBAGENT_PROVIDER`：直接使用它（可配 `DSH_SUBAGENT_MODEL`）。
2. 环境变量、`<cwd>/.env` 或 `$DSH_HOME/.env` 里有 `DEEPSEEK_API_KEY`：使用 DSH 默认的 `deepseek-official`（API Key）路由。
3. `$DSH_HOME/.credentials.yaml` 里有 `deepseek-account-platform/...` 登录凭据：复用 DSH 桌面版的登录，路由固定为 `deepseek-account`，模型默认 `deepseek-flash`。
4. 都没有：按默认路由运行，并以 `MISSING_CREDENTIAL` 失败，同时返回修复建议。

最省事的方式是**先登录 DSH 桌面版**。插件会通过一个临时 patch 重新启用 headless profile 中被默认关闭的 credentials / authorization / deepseek-account 行。

如果使用 API Key：

```sh
export DEEPSEEK_API_KEY='<your-key>'
claude
```

也可以写进 `~/.claude/settings.json` 的 `env`，或放在项目 `.env` 里。

## 配置

所有配置都是环境变量。可以在启动 Claude Code 的 shell 里 `export`，也可以写进 `~/.claude/settings.json`：

```json
{
  "env": {
    "DSH_SUBAGENT_PERMISSION_MODE": "read-only",
    "DSH_SUBAGENT_TIMEOUT_MS": "1800000"
  }
}
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_BIN` | 自动查找 | `dsh` 启动器的路径；也可以只写命令名，从 `PATH` 查找 |
| `DSH_HOME` | `~/.dsh` | DSH 的 profile、session 和凭据目录 |
| `DSH_SUBAGENT_PERMISSION_MODE` | `workspace-write` | 默认权限边界；工具参数 `mode` 可覆盖 |
| `DSH_SUBAGENT_TIMEOUT_MS` | `900000` | 单次委派默认超时（15 分钟），工具参数 `timeout_ms` 可覆盖 |
| `DSH_SUBAGENT_PROVIDER` | 自动 | 强制模型路由，例如 `deepseek-account`、`deepseek-official` |
| `DSH_SUBAGENT_MODEL` | 自动 | 强制模型名，例如 `deepseek-flash` |
| `DSH_SUBAGENT_SAVED_AUTH` | `auto` | 设为 `off` 时不自动改用桌面版登录的 `deepseek-account` 路由 |
| `DSH_SUBAGENT_DEBUG` | 未设置 | 设为 `1` 时把插件和 DSH 的诊断写到 stderr |

工具参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `task` | 是 | 完整、独立的任务说明；DSH 只能看到这段话和它的工作目录 |
| `cwd` | 否 | 工作目录的绝对路径；默认是 Claude Code 的当前目录 |
| `mode` | 否 | `read-only` / `workspace-write`（默认）/ `danger-full-access` |
| `timeout_ms` | 否 | 10000–3300000，默认 900000 |

## 权限与安全

- **`read-only`**：适合审查、分析、问答。不能改文件。
- **`workspace-write`（默认）**：可以在 `cwd` 下创建和修改文件；Shell 命令受 DSH 沙箱限制。需要越界写入或联网的操作会失败关闭（headless 没有交互式审批器，`ask` 策略会直接拒绝）。
- **`danger-full-access`**：取消沙箱和审批限制，允许任意路径写入和联网。只在信任任务内容时使用。

任务文本会被发送到 DeepSeek 的 API。不要把密钥、token 或其他敏感信息写进 `task`，除非你明确希望模型看到。

Claude Code 第一次调用 MCP 工具时会请求授权。可以只允许一次，也可以选择“始终允许”。`/dsh:delegate` 和 `/dsh:doctor` 已经把自己的工具加入 `allowed-tools`。

插件不会打印或写入 `DEEPSEEK_API_KEY`；它只把环境变量原样传给 DSH 子进程。

## 故障排查

**`DeepSeek Harness CLI not found.`**

安装 DSH 桌面版，或者设置：

```sh
export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
```

**`MISSING_CREDENTIAL` / `no API key`**

登录 DSH 桌面版，或者 `export DEEPSEEK_API_KEY=...`。如果两者都有但想强制使用 API Key，设置 `DSH_SUBAGENT_PROVIDER=deepseek-official`。

**`sandbox-exec: sandbox_apply: Operation not permitted`**

Claude Code 本身运行在另一个沙箱里（例如从 DSH 的 Shell 工具里启动 Claude Code），嵌套的 macOS `sandbox-exec` 无法工作。请在普通终端里启动 Claude Code，或改用不需要 Shell 的只读任务。

**`EPERM ... .dsh/profiles/headless` 或 `EPERM ... .claude/plugins/data`**

同样是嵌套沙箱导致的：Claude Code 无法写自己的插件数据目录，DSH 子进程也无法写 `$DSH_HOME`。在普通终端里运行 Claude Code；如果必须嵌套，至少把 `DSH_HOME` 指向可写目录（profile、session、凭据都会放在那里）。

**任务太大 / 超时**

提高 `timeout_ms`（最大 3300000，约 55 分钟），或把任务拆小。`.mcp.json` 里给这个 MCP server 设置了 1 小时的硬上限。

**`/mcp` 里看不到 `dsh`**

确认：

```sh
node /绝对路径/dsh-claude-plugin/plugins/dsh/mcp/server.mjs
```

手动启动时不应立即退出；它会在 stdin 上等待 JSON-RPC。再检查 `claude --debug-file /tmp/claude.log`，搜索 `Plugin MCP server error`。最常见的原因是 `node` 不在 `PATH`，或 `--plugin-dir` 指错了目录。

**第一次运行很慢**

DSH 会在 `$DSH_HOME/profiles/headless` 初始化 headless profile；之后会快很多。

## 限制

- 一次性委派：每次调用都是新 session，不支持多轮追问、中途插话或恢复。
- 只返回最终答案，不返回中间消息和工具日志。
- DSH 使用自己的模型和权限设置，不继承 Claude Code 的模型选择或工具权限。
- macOS 有一等支持；Linux / Windows 依赖 `dsh` 在 `PATH` 中，未做完整测试。
- `task` 通过 stdin 传入，单次任务的文本大小受系统内存限制；答案超过 4 MiB 会被截断。

## 项目结构

```text
dsh-claude-plugin/
├── .claude-plugin/marketplace.json     # marketplace 清单
├── plugins/dsh/
│   ├── .claude-plugin/plugin.json      # 插件清单
│   ├── .mcp.json                       # MCP server 定义（1 小时超时）
│   ├── mcp/server.mjs                  # 零依赖 MCP server
│   ├── agents/dsh.md                   # subagent 定义
│   └── commands/
│       ├── delegate.md                 # /dsh:delegate
│       └── doctor.md                   # /dsh:doctor
├── scripts/install.sh
└── README.md
```

`server.mjs` 自己实现了 MCP 的 stdio 传输（按行分隔的 JSON-RPC 2.0），支持 `initialize`、`tools/list`、`tools/call`、进度通知和取消，因此插件没有 `node_modules`。

## 开发

```sh
# 语法检查
node --check plugins/dsh/mcp/server.mjs

# 只对当前会话加载
claude --plugin-dir "$PWD/plugins/dsh"

# 打开调试日志
DSH_SUBAGENT_DEBUG=1 claude --debug-file /tmp/claude.log
```

修改 `server.mjs` 后重启 Claude Code 或 `/reload-plugins`。

## License

MIT
