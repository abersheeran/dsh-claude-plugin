# DSH Subagent for Claude Code

把 **DeepSeek Harness（DSH）** 作为 Claude Code 的持久 subagent 使用，支持：

- **多轮追问**：同一个 DSH session 内继续对话，上下文保留。
- **中途插话**：DSH 正在运行时追加消息，不必等当前调用返回。
- **中断**：停止当前回合，保留 session，然后换方向继续。
- **恢复**：Claude Code 重启、MCP server 崩溃后，按 session id 恢复之前的对话。
- **列出/查看/停止**：管理已落盘的 DSH session。

```
Claude Code
  └─ MCP (stdio) ──> plugins/dsh/mcp/server.mjs
                        └─ 每个 DSH session 一个常驻进程：
                           dsh --profile sdk  (JSON-RPC stdio)
                             └─ DeepSeek 模型 + DSH 工具（在 cwd 中）
                        <── session.event / session.status
```

每个 DSH session 对应一个 `dsh --profile sdk` 常驻进程。MCP server 负责把 `dsh_delegate` / `dsh_wait` / `dsh_control` 翻译成 DSH 的 SDK JSON-RPC，并把 DSH 的最终回答返回 Claude Code。

## 为什么不用 Haiku？

Haiku 5.5 价格和 Deepseek v4.1 flash 1017 一致，推理速度很接近。但 Haiku 5.5 同属 Claude 系模型，作为 claude code subagent 使用时大概率会和主模型陷入一致的盲区。引入 Deepseek 作为 Claude 的补充，能增加智能多样性。

## 包含什么

| 组件 | 用途 |
|---|---|
| MCP 工具 `dsh_delegate` | 新建或继续一个 DSH session，发送任务；`wait:false` 时只入队并立即返回 |
| MCP 工具 `dsh_wait` | 等待运行中的 session 空闲，取回最新答案 |
| MCP 工具 `dsh_control` | `list` 列出已落盘 session；`status` 查看状态；`stop` 停止运行 |
| Subagent `dsh`（`dsh:dsh`） | 一层很薄的代理，把任务交给 DSH 并原样返回答案 |
| `/dsh:delegate` | 手动把任务交给 DSH |
| `/dsh:sessions` | 列出已落盘 session，可选择继续 |
| `/dsh:send` | 向运行中的 session 追加一条消息 |
| `/dsh:doctor` | 用一次只读调用检查连通性和认证 |

## 环境要求

- Claude Code 2.1+（插件 + MCP）
- DeepSeek Harness 0.2.1+ 桌面版已安装并登录，或者有 `DEEPSEEK_API_KEY`
- `node` 18+ 在 `PATH` 中（MCP server 零依赖）
- macOS 会自动找到 `/Applications/DeepSeek Harness.app/.../runtime/cli/bin/dsh`；其他平台把 `dsh` 放进 `PATH`，或设置 `DSH_BIN`

## 安装

### 从 GitHub 安装（推荐）

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

重启 Claude Code（或执行 `/reload-plugins`）后生效。

本地开发时可以把 `abersheeran/dsh-claude-plugin` 换成仓库目录的路径：

```sh
claude plugin marketplace add ./dsh-claude-plugin
```

### 只对当前会话加载

```sh
git clone https://github.com/abersheeran/dsh-claude-plugin.git
claude --plugin-dir ./dsh-claude-plugin/plugins/dsh
```

### 卸载

在 `/plugin` 界面里禁用或移除 `dsh@dsh-plugins`。

## 快速验证

```text
/dsh:doctor
```

成功时 Claude 会告诉你 DSH 返回了 `DSH_OK`。也可以直接说：

> 用 dsh subagent 回复 DSH_OK

## 多轮追问

第一次委派：

```text
用 dsh subagent 审查 src/auth.ts 的会话固定问题，只读。
```

结果末尾会有一个 footer：

```text
[dsh session: session-xxxxxxxx-...]
```

继续同一个对话：

```text
继续刚才那个 dsh session，让它给出修复后的代码。
```

如果 Claude 没有自动复用，也可以显式给 session id：

```text
用 dsh session session-xxxxxxxx-... 继续：把修复写成 patch。
```

同一个 session 会保留历史、模型选择和工作目录。`dsh_delegate` 的 `session_id` 参数就是入口。

## 中途插话

有两种方式。

### 1. 非破坏式：排队到下一回合

先把任务放到后台：

```text
让 dsh subagent 在后台写一份方案，先不要等它完成。
```

Claude 会调用 `dsh_delegate` 并带 `wait: false`，拿到 session id。

然后插话：

```text
告诉刚才那个 dsh session：优先考虑 SQLite，不要 PostgreSQL。
```

或者直接用命令：

```text
/dsh:send session-xxxxxxxx-... 优先考虑 SQLite，不要 PostgreSQL。
```

DSH 会把这条消息排在**当前回合结束之后**处理，不会丢弃当前已经完成的工作。想取回最终结果：

```text
用 dsh_wait 取回 session-xxxxxxxx-... 的结果。
```

如果 DSH 正在前台等待，Claude Code 里可以按 **Esc** 中断这次等待。插件只会取消等待，**不会停止 DSH 运行**；然后用 `/dsh:sessions` 找到正在运行的 session，或直接用：

```text
/dsh:send session-xxxxxxxx-... 改成优先考虑 SQLite。
```

> 注意：DSH SDK 的 `followup` 消息目标是 `next-turn`，所以插话是在回合边界生效，不是逐 token 打断当前回合。需要立刻中止当前回合时，用下面的中断方式。

### 2. 破坏式：中断当前回合

```text
中断 session-xxxxxxxx-...，改成只读分析，不要再改文件。
```

Claude 会调用 `dsh_delegate` 并带 `interrupt: true`：停止当前运行时、恢复同一个持久 session、发送新任务。当前回合未完成的工作会被丢弃，之前已提交的上下文仍在。

也可以分两步：

```text
/dsh:sessions
```

找到 session 后：

```text
停止 dsh session session-xxxxxxxx-...
```

然后重新委派。

## 恢复

DSH 的 session 会落盘在 `$DSH_HOME/sessions`，插件的元数据在 `$DSH_HOME/storages/session_projcache`。Claude Code 退出、MCP server 崩溃都不影响恢复。

列出可恢复的 session：

```text
/dsh:sessions
```

或让 Claude 调用 `dsh_control`：

```text
列出所有 dsh session。
```

输出包含 id、状态、权限模式、最后活动时间、标题和工作目录。恢复：

```text
用 dsh session session-xxxxxxxx-... 继续：总结一下你上次做到哪了。
```

插件会自动从元数据读取原始 `cwd` 和权限模式，启动一个新的 SDK 运行时并调用 `session/resume`。如果显式传了 `cwd`，它必须和原始目录一致；权限模式在 session 创建时固定，不能中途切换。

## 工具参考

### `dsh_delegate`

| 参数 | 必填 | 说明 |
|---|---|---|
| `task` | 是 | 完整任务说明；继续 session 时是下一条用户消息 |
| `session_id` | 否 | 继续已有对话；已落盘的 id 会自动恢复 |
| `cwd` | 否 | 新 session 的工作目录；恢复时必须与原始目录一致 |
| `mode` | 否 | `read-only` / `workspace-write` / `danger-full-access`；仅新 session 有效 |
| `wait` | 否 | 默认 `true`；`false` 只入队并立即返回，用于后台运行或插话 |
| `interrupt` | 否 | `true` 先中断当前回合，再发送新任务 |
| `timeout_ms` | 否 | 等待上限，默认 900000（15 分钟），最大 3300000 |

### `dsh_wait`

| 参数 | 必填 | 说明 |
|---|---|---|
| `session_id` | 是 | 要等待的 session |
| `timeout_ms` | 否 | 等待上限，默认 300000（5 分钟）；超时不会停止 DSH |

### `dsh_control`

| 参数 | 必填 | 说明 |
|---|---|---|
| `action` | 是 | `list` / `status` / `stop` |
| `session_id` | status/stop 必填 | 目标 session |
| `limit` | 否 | `list` 返回数量，默认 20 |

## 认证

插件按以下顺序选择 DSH 的模型路由：

1. 设置了 `DSH_SUBAGENT_PROVIDER`：直接使用它（可配 `DSH_SUBAGENT_MODEL`）。
2. 环境变量、`<cwd>/.env` 或 `$DSH_HOME/.env` 里有 `DEEPSEEK_API_KEY`：使用 `deepseek-official`（API Key）路由。
3. `$DSH_HOME/.credentials.yaml` 里有 `deepseek-account-platform/...` 登录凭据：复用 DSH 桌面版登录，路由为 `deepseek-account`，模型默认 `deepseek-flash`。
4. 都没有：使用 `deepseek-official`，首次请求以 `MISSING_CREDENTIAL` 失败，并返回修复建议。

最省事的方式是先登录 DSH 桌面版。插件不会修改 DSH 的 profile，只是在 `initialize` 时传入 provider/model；SDK profile 默认已启用 credentials / authorization / deepseek-account。

如果使用 API Key：

```sh
export DEEPSEEK_API_KEY='<your-key>'
claude
```

## 配置

所有配置都是环境变量。可以 `export`，也可以写进 `~/.claude/settings.json`：

```json
{
  "env": {
    "DSH_SUBAGENT_PERMISSION_MODE": "read-only",
    "DSH_SUBAGENT_WAIT_TIMEOUT_MS": "600000"
  }
}
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_BIN` | 自动查找 | `dsh` 启动器路径，或从 `PATH` 查找的命令名 |
| `DSH_HOME` | `~/.dsh` | DSH 的 profile、session 和凭据目录 |
| `DSH_SUBAGENT_PERMISSION_MODE` | `workspace-write` | 新 session 的默认权限边界 |
| `DSH_SUBAGENT_TIMEOUT_MS` | `900000` | `dsh_delegate` 默认等待时间 |
| `DSH_SUBAGENT_WAIT_TIMEOUT_MS` | `300000` | `dsh_wait` 默认等待时间 |
| `DSH_SUBAGENT_MAX_SESSIONS` | `8` | 同时保留的 SDK 运行时上限；超出时淘汰最老的 idle session（已落盘，可恢复） |
| `DSH_SUBAGENT_PROVIDER` | 自动 | 强制模型路由 |
| `DSH_SUBAGENT_MODEL` | `deepseek-flash` | 强制模型名 |
| `DSH_SUBAGENT_REASONING` | 未设置 | 传给 SDK `initialize` 的 `reasoningEffort` |
| `DSH_SUBAGENT_SAVED_AUTH` | `auto` | 设为 `off` 时不自动使用桌面版登录 |
| `DSH_SUBAGENT_DEBUG` | 未设置 | 设为 `1` 输出运行时诊断到 stderr |

## 权限与安全

- **`read-only`**：适合审查、分析、问答，不能改文件。
- **`workspace-write`（默认）**：可以在 `cwd` 下创建和修改文件；Shell 命令受 DSH 沙箱限制；越界写入或联网失败关闭（headless/SDK 没有交互审批器）。
- **`danger-full-access`**：取消沙箱和审批限制，允许任意路径写入和联网。只在信任任务内容时使用。

任务文本会发送到 DeepSeek API。不要把密钥、token 或其他敏感信息写进 `task`，除非你明确希望模型看到。

Claude Code 第一次调用 MCP 工具时会请求授权。插件不会打印或写入 `DEEPSEEK_API_KEY`；它只把环境变量原样传给 DSH 子进程。

## 故障排查

**`DeepSeek Harness CLI not found.`**

安装 DSH 桌面版，或设置：

```sh
export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
```

**`MISSING_CREDENTIAL` / `no API key`**

登录 DSH 桌面版，或 `export DEEPSEEK_API_KEY=...`。两者都有但想强制用 API Key 时，设置 `DSH_SUBAGENT_PROVIDER=deepseek-official`。

**`sandbox-exec: sandbox_apply: Operation not permitted`**

Claude Code 本身运行在另一个沙箱里（例如从 DSH 的 Shell 工具启动 Claude Code），嵌套的 macOS `sandbox-exec` 无法工作。请在普通终端里启动 Claude Code，或改用不需要 Shell 的只读任务。

**`EPERM ... .dsh/profiles/sdk` 或 `EPERM ... .claude/plugins/data`**

同样是嵌套沙箱导致的：Claude Code 无法写自己的插件数据目录，DSH 子进程也无法写 `$DSH_HOME`。在普通终端里运行 Claude Code；如果必须嵌套，至少把 `DSH_HOME` 指向可写目录。

**`Unknown DSH session`**

`dsh_control action:"list"` 里没有这个 id，或 `$DSH_HOME` 不对。恢复时 `cwd` 必须和创建时一致。

**`DSH session ... uses mode ...`**

权限模式在 session 创建时固定。要继续同一对话，使用原来的 mode；要换模式，开一个新 session。

**`/mcp` 里看不到 `dsh`**

确认 `node` 在 `PATH`，并手动启动：

```sh
node /绝对路径/dsh-claude-plugin/plugins/dsh/mcp/server.mjs
```

它应该在 stdin 上等待 JSON-RPC，不应立即退出。再用 `claude --debug-file /tmp/claude.log` 搜索 `Plugin MCP server error`。

**第一次运行很慢**

DSH 会在 `$DSH_HOME/profiles/sdk` 初始化 SDK profile；之后启动会快很多。

## 限制

- **插话在回合边界生效**：DSH SDK 的 followup 目标是 `next-turn`，不会逐 token 打断当前模型步骤；需要立即停止当前回合时用 `interrupt: true` 或 `dsh_control stop`。
- **中断是硬停止**：杀掉当前 SDK 运行时再恢复 session，当前未完成的回合会被丢弃。
- **一个 session 一个常驻进程**：同时保留的运行时上限默认 8 个；超出时会淘汰最老的 idle session（已落盘，可恢复）。
- **只返回已提交的助手消息**：不流式返回 token，也不返回工具调用日志。
- **MCP 输出上限**：Claude Code 对 MCP 结果的默认上限是 25,000 tokens；当前版本没有做大结果落盘/分页。长输出可能被截断。
- **权限模式固定**：恢复 session 时不能切换 `read-only` / `workspace-write` / `danger-full-access`。
- **macOS 有一等支持**；Linux / Windows 依赖 `dsh` 在 `PATH` 中，未做完整测试。

## 项目结构

```text
dsh-claude-plugin/
├── .claude-plugin/marketplace.json
├── plugins/dsh/
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json                       # 3 个 MCP 工具，1 小时调用上限
│   ├── mcp/server.mjs                  # 零依赖 MCP + DSH SDK 客户端
│   ├── agents/dsh.md                   # subagent 定义
│   └── commands/
│       ├── delegate.md                 # /dsh:delegate
│       ├── sessions.md                 # /dsh:sessions
│       ├── send.md                     # /dsh:send
│       └── doctor.md                   # /dsh:doctor
├── scripts/install.sh
└── README.md
```

`server.mjs` 自己实现了 MCP stdio 传输和 DSH SDK 的 JSON-RPC 客户端，所以插件没有 `node_modules`。

## 开发

```sh
# 语法检查
node --check plugins/dsh/mcp/server.mjs

# 只对当前会话加载
claude --plugin-dir "$PWD/plugins/dsh"

# 调试
DSH_SUBAGENT_DEBUG=1 claude --debug-file /tmp/claude.log
```

修改 `server.mjs` 后重启 Claude Code 或 `/reload-plugins`。

## License

MIT
