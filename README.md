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

> 诚实说明：Loom 是年轻的 MVP（子代理/judge、skills、MCP、沙箱在 M3/M4 路线图中）；上表中关于 dsh / Claude Code / Codex 的事实与第三方评测数据（如 dsh 以约 1/6 于 Claude Code 的成本达到相近通过率）来自公开资料，出处全部列在 [docs/DESIGN.md](docs/DESIGN.md) 第 12 节。

## 核心特性（源自四家精华）

| 特性 | 继承自 | 说明 |
|---|---|---|
| **Append-only 会话日志 = 唯一事实源** | DeepSeek Harness | "Model-visible means logged"：模型看到的一切都是日志的纯函数投影，可 fork / resume / replay，`loom replay --verify` 验证确定性 |
| **客户端强制权限** | Claude Code | allow/ask/deny 规则由 harness 执行，模型提示词无法绕过；四模式：default / acceptEdits / plan / bypassPermissions |
| **Plan mode** | Claude Code | 只读工具集 + `exit_plan` 审批门，用户批准后自动切换执行模式 |
| **可召回压缩** | 修正 dsh 最大缺陷 | 压缩时全文 spill 成工件，`recall(locator)` 随时取回——压缩永不丢信息 |
| **工具结果预剪枝 + spill** | dsh + ZCode | 超过 30KB 的工具输出自动外置，返回截断头 + locator |
| **机械强制 read-before-edit** | Claude Code | 未读文件无法编辑；读后被外部改动也会被 mtime 校验拦下 |
| **Bash 超时不杀进程** | dsh | 超时命令转后台 job，`bash_output` 轮询——长构建/服务不被腰斩 |
| **双协议多 Provider** | ZCode | Anthropic Messages + OpenAI 兼容（DeepSeek / 智谱 GLM / Kimi / Ollama / vLLM / one-api 全兼容），密钥只从环境变量读取 |
| **7 事件 Hooks** | Claude Code / ZCode | SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop |
| **AGENTS.md（64KB 预算）** | Codex + dsh | 宽文件先逐出、最具体文件最后截断；兼容 CLAUDE.md |

## 快速开始

```bash
git clone git@github.com:zgsddzwj/Loom.git && cd Loom
npm install            # 安装 dev 依赖（零运行时依赖）
npm run build          # 编译到 dist/
npm test               # 39 个测试（含全链路冒烟）

# 配置任意一家模型的 key（只从环境变量读取，绝不落盘）
export DEEPSEEK_API_KEY=sk-...        # 或 ZHIPU_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / MOONSHOT_API_KEY
# 或通用 OpenAI 兼容端点：
# export LOOM_MODEL=qwen3:14b LOOM_BASE_URL=http://localhost:11434/v1 LOOM_API_KEY=ollama

node dist/cli.js                      # 交互式 REPL
node dist/cli.js --plan               # 规划模式启动
node dist/cli.js -p "修复失败的测试"    # 无头单发（权限 fail-closed）
node dist/cli.js --resume latest      # 续上次会话
node dist/cli.js replay latest --verify --json   # 重建逐字节模型上下文
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
├── memory/     AGENTS.md 加载（64KB 预算、宽文件先逐出）
├── providers/  anthropic.ts + openai.ts 双协议 + catalog.ts 模型目录
├── tools/      read/edit/write/bash/grep/glob/todo/recall + read-state 强制
├── sysprompt.ts  纪律优先系统提示词
└── cli.ts      REPL + -p + --resume + replay
```

SDK 用法：`import { EventLog, project, runTurn, ... } from "loom-harness"`（见 `src/index.ts` 导出面）。

## 路线图

- **M3**：子代理（Explore 只读 profile）、judge 验收代理、skills 渐进披露、跨会话记忆、MCP client
- **M4**：插件打包 + 信任门、OS 沙箱（seatbelt/bwrap）、`loom eval` 可复现评测

详见 [docs/DESIGN.md](docs/DESIGN.md) 第 11 节。

## License

MIT
