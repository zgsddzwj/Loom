# Loom

> **Small core, everything logged, everything composable.**
>
> 织机（Loom）：append-only 日志是经线，工具调用是纬线，插件是彩线——织物可复制、可拆解、可续织。

Loom 是一个开源（MIT）、模型无关的 AI 编程 Agent Harness。它是对 DeepSeek Harness、Claude Code、OpenAI Codex、ZCode 四家 Harness 调研后"取其精华、去其糟粕"的设计实现——完整调研报告与设计文档见 **[docs/DESIGN.md](docs/DESIGN.md)**。

## 为什么 Loom 比其他 Harness 好

每家 Harness 都有自己最强的那一块，但也都带着自己的包袱。Loom 把四家的精华拼在一台织机上，并系统性地修掉它们的已知缺陷：

| 维度 | dsh | Claude Code | Codex | ZCode | **Loom** |
|---|---|---|---|---|---|
| 开源 | ✅ MIT | ❌ 闭源 | ✅ CLI 开源，云闭源 | ❌ 闭源 | ✅ **MIT 全开源** |
| 模型自由 | ✅ | ❌ 绑定 Claude | 部分（本地模型） | ✅ | ✅ **双协议，任意厂商/本地模型** |
| 可复现性 | ✅ 日志可重建 | ❌ 日志加密 | 部分 | ✅ | ✅ **纯函数投影，`replay --verify` 自证确定性** |
| 压缩 | ❌ 不可逆（提案搁置中） | ❌ 有损 | — | — | ✅ **可召回压缩：全文 spill + `recall` 取回，零信息丢失** |
| 权限模型 | fail-closed 审批 | ✅ 客户端强制 | 沙箱+审批 | ⚠️ 插件 hook 无信任门 | ✅ **客户端强制 + 4 模式 + fail-closed** |
| 密钥安全 | ⚠️ telemetry 默认开 | — | — | ❌ 明文存 key | ✅ **只读环境变量，绝不落盘** |
| 依赖体量 | ⚠️ Electron/Node ~200MB | — | Rust 单二进制 | ⚠️ 12.5MB bundle | ✅ **零运行时依赖，Node ≥20 原生能力** |
| 记忆/指令 | ⚠️ 记忆无主（一切皆插件的代价） | ✅ 分层记忆 | ✅ AGENTS.md 标准 | ✅ | ✅ **AGENTS.md 一等公民（64KB 预算，宽文件先逐出）** |

几个具体的"人无我有 / 人有我优"：

1. **压缩永不丢信息**（修正 dsh 最大缺陷）：压缩时完整历史 spill 成工件、摘要附上 locator，模型随时 `recall` 逐字取回——dsh 的 recallable-compaction 至今停在 proposal 阶段，Loom 把它做成了默认行为，并有测试钉死。
2. **可复现性可自证**（继承 dsh 并推进一步）：投影是日志的纯函数，`loom replay --verify` 每次运行都重新投影两遍并逐字节比对，CI 里的 projector 测试也强制确定性——Claude Code 的日志是加密的，你只能选择相信。
3. **纪律是机械的，不是靠模型自觉**（继承 Claude Code）：未读文件无法编辑（read-state 校验 mtime+size）、编辑必须唯一匹配、无头模式 ask 一律 deny（fail-closed）、plan mode 只读 + 用户审批门——全部由 harness 强制，提示词注入绕不过去。
4. **模型无关 + 密钥卫生**（继承 ZCode 双协议，修掉它的明文 key）：一套代码同时讲 Anthropic Messages 和 OpenAI 兼容两种协议；密钥只从环境变量读取，任何配置文件里都不会出现。
5. **轻到可以读完**：零运行时依赖、单包模块化（刻意不做 dsh 那种 54 包 monorepo），核心循环 + 权限 + 压缩一共几千行 TypeScript，一个下午能通读——这对想改造 harness 的人是本质区别。

> 诚实说明：Loom 很年轻（v0.2.0 刚补齐子代理/沙箱/插件/评测版图），尚无自己的公开基准跑分；上表中关于 dsh / Claude Code / Codex 的事实与第三方评测数据（如 dsh 以约 1/6 于 Claude Code 的成本达到相近通过率）来自公开资料，出处全部列在 [docs/DESIGN.md](docs/DESIGN.md) 第 12 节。

## 核心特性（源自四家精华）

| 特性 | 继承自 | 说明 |
|---|---|---|
| **Append-only 会话日志 = 唯一事实源** | DeepSeek Harness | "Model-visible means logged"：模型看到的一切都是日志的纯函数投影，可 fork / resume / replay，`loom replay --verify` 验证确定性 |
| **客户端强制权限** | Claude Code | allow/ask/deny 规则由 harness 执行，模型提示词无法绕过；四模式：default / acceptEdits / plan / bypassPermissions |
| **Plan mode** | Claude Code | 只读工具集 + `exit_plan` 审批门，用户批准后自动切换执行模式 |
| **子代理三 profile + judge 验收闭环** | Claude Code + ZCode | `task` 工具委派 general / explore（只读）/ judge 三个子代理：独立上下文窗口、工具白名单、独立子会话日志；judge 按严格 JSON verdict 验收交付物 |
| **可召回压缩** | 修正 dsh 最大缺陷 | 压缩时全文 spill 成工件，`recall(locator)` 随时取回——压缩永不丢信息 |
| **工具结果预剪枝 + spill** | dsh + ZCode | 超过 30KB 的工具输出自动外置，返回截断头 + locator |
| **渐进披露 Skills** | Claude Code + ZCode | 仅 name+description 常驻系统提示词（目录），`skill` 工具按需加载正文；项目级同名 shadow 用户级 |
| **跨会话记忆（一等公民）** | 修正 dsh "记忆无主" | `memory` 工具 + `~/.loom/memory.md`（预算封顶、用户可直接编辑）——核心所有，不做插件 |
| **机械强制 read-before-edit** | Claude Code | 未读文件无法编辑；读后被外部改动也会被 mtime 校验拦下 |
| **Bash 超时不杀进程** | dsh | 超时命令转后台 job，`bash_output` 轮询——长构建/服务不被腰斩 |
| **MCP stdio client** | 通用标准 | `mcp__<server>__<tool>` 命名桥接进注册表，结果同样剪枝/鉴权/入日志 |
| **双协议多 Provider** | ZCode | Anthropic Messages + OpenAI 兼容（DeepSeek / 智谱 GLM / Kimi / Ollama / vLLM / one-api 全兼容），密钥只从环境变量读取 |
| **7 事件 Hooks** | Claude Code / ZCode | SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop |
| **OS 级沙箱** | Codex | macOS Seatbelt / Linux bwrap：内可写、外拒写、网络禁；bypass 模式自动启用，封装失败 fail-closed 拒跑 |
| **插件 + sha256 信任门** | 修正 ZCode "hook 无信任门" | 插件打包 skills/commands/hooks，首次须 `loom plugin trust`；文件变动即指纹失效（fail-closed 停用） |
| **AGENTS.md（64KB 预算）** | Codex + dsh | 宽文件先逐出、最具体文件最后截断；兼容 CLAUDE.md |
| **`loom eval` 可复现评测** | dsh | 每任务隔离 workspace + 独立会话日志，verify.sh 判定，results.jsonl 落盘（样例见 `benchmarks/samples/`） |

## 安装（给使用者）

**方式一：一条命令装全局**（需要 Node ≥ 20，npm 会自动拉源码并编译）：

```bash
npm install -g github:zgsddzwj/Loom
loom --help
```

**方式二：clone 源码运行**（适合想读代码、做改造的人）：

```bash
git clone https://github.com/zgsddzwj/Loom.git && cd Loom
npm install          # prepare 钩子自动编译到 dist/
node dist/cli.js     # 或 npm link 之后直接敲 loom
```

**接上任意一个模型**（key 只从环境变量读取，绝不落盘；建议写进 `~/.zshrc`）：

```bash
export DEEPSEEK_API_KEY=sk-...                          # DeepSeek
# export ZHIPU_API_KEY=...                               # 智谱开放平台
# export ANTHROPIC_API_KEY=sk-ant-...                    # Claude（原生协议）
# 火山方舟等 Anthropic 协议网关（注意 anthropic: 前缀）：
# export LOOM_MODEL="anthropic:glm-5.3-flash" LOOM_BASE_URL="https://ark.cn-beijing.volces.com/api/coding" LOOM_API_KEY=ark-...
# 本地 Ollama / 任意 OpenAI 兼容端点：
# export LOOM_API_KEY=ollama LOOM_BASE_URL=http://localhost:11434/v1 LOOM_MODEL=qwen3:14b

loom                    # 开始
```

## 快速开始（开发者）

```bash
git clone git@github.com:zgsddzwj/Loom.git && cd Loom
npm install            # 安装 dev 依赖（零运行时依赖）
npm run build          # 编译到 dist/
npm test               # 68 个测试（含全链路冒烟、真实 MCP 子进程、macOS 沙箱实机断言）

# 配置任意一家模型的 key（只从环境变量读取，绝不落盘）
export DEEPSEEK_API_KEY=sk-...        # 或 ZHIPU_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / MOONSHOT_API_KEY
# 或通用 OpenAI 兼容端点：
# export LOOM_MODEL=qwen3:14b LOOM_BASE_URL=http://localhost:11434/v1 LOOM_API_KEY=ollama

node dist/cli.js                      # 交互式 REPL
node dist/cli.js --plan               # 规划模式启动
node dist/cli.js -p "修复失败的测试"    # 无头单发（权限 fail-closed）
node dist/cli.js --resume latest      # 续上次会话
node dist/cli.js replay latest --verify --json   # 重建逐字节模型上下文

# 生态（v0.2.0）
node dist/cli.js plugin list          # 查看插件与信任状态
node dist/cli.js plugin trust my-plugin    # 信任一个插件（sha256 指纹门）
node dist/cli.js eval benchmarks/samples   # 可复现评测（需模型 key）
```

`.loom/config.json`（项目级，优先）与 `~/.loom/config.json`（用户级）：

```json
{
  "model": "deepseek-chat",
  "mode": "default",
  "permissions": {
    "deny":  ["Bash(git push:*)"],
    "ask":   ["Edit(.env)"],
    "allow": ["Bash(npm test:*)"]
  },
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "command": "./scripts/guard.sh" }]
  },
  "context": { "compactThresholdTokens": 50000, "pruneBytes": 30000 }
}
```

## REPL 命令

`/help` `/quit` `/mode <m>` `/plan`（切换规划模式）`/compact`（手动压缩）`/todos` `/session`

## 架构一览

```
src/
├── core/       loop.ts     turn/step 生命周期（一步=一次模型请求+工具调用）
├── log/        eventlog.ts append-only JSONL；projector.ts 纯函数投影
├── context/    artifacts / pruner / manager（可召回压缩）/ tokens 估算
├── perm/       客户端强制权限引擎（规则 + 四模式 + fail-closed）
├── hooks/      7 事件 runner（退出码 2 = 阻断）
├── memory/     AGENTS.md 预算加载 + 跨会话记忆 store + memory 工具
├── providers/  anthropic.ts + openai.ts 双协议 + catalog.ts 模型目录
├── tools/      read/edit/write/bash/grep/glob/todo/recall/task/skill + read-state 强制
├── subagents/  general / explore / judge 三 profile + 子会话 spawner
├── skills/     渐进披露 loader + skill 工具
├── mcp/        stdio JSON-RPC client + 注册表桥接
├── sandbox/    seatbelt（双语法探测+realpath 规范化）/ bwrap
├── plugins/    manifest 加载 + sha256 信任门
├── commands/   slash 命令模板（$ARGUMENTS）
├── eval/       可复现评测 runner
├── sysprompt.ts  纪律优先系统提示词 + composeSystemPrompt
└── cli.ts      REPL + -p + --resume + replay + plugin/eval 子命令
```

SDK 用法：`import { EventLog, project, runTurn, ... } from "loom-harness"`（见 `src/index.ts` 导出面）。

## 扩展点速览

- **Skill**：`~/.loom/skills/<name>/SKILL.md`（frontmatter: name/description；正文触发时加载）
- **Slash 命令**：`~/.loom/commands/foo.md` 或 `.loom/commands/foo.md`（frontmatter: description；正文 `$ARGUMENTS` 占位）→ REPL 里 `/foo 参数`
- **插件**：`~/.loom/plugins/<name>/`（plugin.json + skills/ + commands/ + hooks.json），先 `loom plugin trust <name>`
- **MCP**：`.loom/config.json` → `{"mcp":{"servers":{"name":{"command":"...","args":[...]}}}}`
- **记忆**：`memory` 工具自动维护 `~/.loom/memory.md`，也可直接编辑

## 路线图

M0–M4 全部落地（v0.2.0）。后续想法：HTTP/SSE MCP 传输、子代理并行执行与双向通信、WebFetch/WebSearch 工具、插件市场与 `npx` 分发。详见 [docs/DESIGN.md](docs/DESIGN.md) 第 11 节。

## License

MIT
