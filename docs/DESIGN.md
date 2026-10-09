# Loom：一款融合四家 Harness 精华的开源 Agent Harness

> 设计文档 v1.0 ｜ 2026-10-08
>
> **口号：Small core, everything logged, everything composable.**
> （小核心，一切皆被记录，一切皆可组合）
>
> Loom，织机：append-only 日志是绷紧的经线，每一次工具调用是穿行的纬线，插件是彩线——织物可复制、可拆解、可续织。

---

## 目录

1. [调研背景与方法](#1-调研背景与方法)
2. [四家 Harness 深度剖析](#2-四家-harness-深度剖析)
3. [横向对比与实测数据](#3-横向对比与实测数据)
4. [精华清单与糟粕清单](#4-精华清单与糟粕清单)
5. [Loom 设计哲学](#5-loom-设计哲学)
6. [12 条核心机制](#6-12-条核心机制)
7. [架构与模块划分](#7-架构与模块划分)
8. [关键技术细节](#8-关键技术细节)
9. [系统提示词工程](#9-系统提示词工程)
10. [安全模型](#10-安全模型)
11. [路线图与验收标准](#11-路线图与验收标准)
12. [参考来源](#12-参考来源)

---

## 1. 调研背景与方法

"Model + Harness = Agent"。同样的模型，配不同的 Harness，通过率与成本可以相差数倍——Harness 工程已经成为与 Prompt 工程、上下文工程并列的独立学科。

本文调研了四个有代表性的 Harness：

| Harness | 厂商 | 形态 | 开源 |
|---|---|---|---|
| DeepSeek Harness（dsh） | DeepSeek | CLI / Web / 桌面 | MIT（TypeScript） |
| Claude Code | Anthropic | CLI / IDE / 桌面 / Web | 闭源 |
| Codex | OpenAI | CLI（Rust）+ 云端 VM | CLI 开源（Apache-2.0），云闭源 |
| ZCode | 智谱 | 桌面壳 + CLI 内核 | 闭源（本机实测探索） |

调研途径：官方文档与仓库（dsh 的 docs/ 与 AGENTS.md、openai/codex 的 crate 结构、Claude Code 文档与泄露系统提示词分析仓库）、第三方深度 teardown、Hacker News 两个热帖（747 分与 416 分）、独立基准 FrontierHarness Eval v1.0，以及对本机 ZCode 安装目录的逐层只读探索。

---

## 2. 四家 Harness 深度剖析

### 2.1 DeepSeek Harness（dsh）——"Everything is a Plugin"

**基本情况**：2026-08-13 以 developer preview 发布，MIT 协议，TypeScript/pnpm 单体仓库（54 个包），发布约三周即 21 万 star，现为 24.5 万 star。

**架构灵魂**：

1. **一切皆插件**：没有可打补丁的特权核心——模型适配器、工具注册表、会话日志、**连 agent loop 本身**都是插件。插件是导出 `apply(ctx, config)` 的模块，注册的是"可回滚效应"（reversible effects）："卸载即完全撤销副作用"（配套 arXiv 论文 *Cordis* 将其形式化为"时空可组合性"）。
2. **Append-only 会话日志是唯一事实源**："Model-visible means logged. Every model request must be reconstructable from the log."——日志为版本化代际文件（`session.vN.jsonl`，永不覆写），fork/resume/replay/遥测/持久化全部由它派生。模型看到的每个消息都是日志的投影（projection）。
3. **上下文工程做成工程体系**：
   - 工具结果**预剪枝**：压缩前先裁剪超大工具输出，减少需要压缩的历史量；
   - **缓存对齐**：摘要指令放在请求**末尾**而非开头，以保住前缀缓存；即使未用到的工具 schema 也保留在请求中，避免破坏 token 序列对齐导致缓存失效；
   - **Spill 溢出**：超大文本存到上下文之外，返回 locator + 检索指引；存储失败则保留原文；
   - **指令文件预算**：工作区指令文件共 65,536 字节，逐出顺序为"宽泛文件先整省略，最具体文件最后截断"；`CLAUDE.md` 是指向 `AGENTS.md` 的 symlink（one home per fact）。
4. **fail-closed 审批**："缺失、越权、抛异常或不合规的应答者都会变成 unavailable，而不是打开门禁。"
5. **无固定步数预算**：多轮深度由 goal 工具持久化目标驱动 auto-continuation，而非 16/32 步之类的硬预算。

**实测数据**（第三方 FrontierHarness Eval v1.0，9 个 harness、12 种配置、360 次试验，同模型 Kimi K3）：DSH Creator 63.3% 通过率、$3.28/任务、成本/成功 $0.119——**以约 1/6 于 Claude Code 的成本达到相近通过率**（Claude Code 63.3%、$18.34/任务；Codex 66.7% 最高、$3.47/任务）。

**局限**（来自 HN 讨论与第三方 teardown）：

- **无跨会话记忆**：只有 64KB 手写指令文件是跨会话载体——"Everything is a plugin at the boundary means everything is somebody else's problem"，插件化的极端形态导致"记忆"这种没有认领者的能力无人负责；
- **压缩不可逆**：compaction 对当前上下文不可逆，"recallable compaction"提案自 2026-07-06 起停留在 proposal 状态；
- 命名晦涩（HN 最高赞疑问："But like, what is it?"）、Cordis 术语被批 "word salad"；
- Electron/Node 体量（约 200MB 磁盘 / 4GB 内存）、telemetry 默认开启、不接受外部 PR。

### 2.2 Claude Code——"五大扩展机制 + 客户端强制权限"

**架构灵魂**：

1. **多 Surface 单引擎**：Terminal CLI、VS Code/JetBrains 扩展、桌面应用、Web/移动端共享同一引擎与记忆。
2. **五大扩展机制**：MCP、Subagents、Hooks、Skills、Plugins。Subagent 是带 YAML frontmatter 的 Markdown 文件（name/description/tools 白名单/model），在独立上下文窗口中运行，只回传摘要——保护主上下文。Skills 采用**渐进披露**：只有 name+description 常驻上下文，SKILL.md 正文触发时才加载，捆绑文件按需读取。
3. **客户端强制权限系统**（最值得学习的一条）：gitignore 风格的 allow/deny/ask 规则（如 `Bash(git push:*)`），官方文档明说"规则由 Claude Code 执行，而非模型——提示词指令无法改变允许的内容"。这不是模型自律，是 harness 他律。权限模式：default / acceptEdits / plan / bypassPermissions。
4. **Plan mode**：只允许只读工具（Read/Grep/Glob），产出结构化计划，用户批准后才进入执行——"先思考后行动"的制度化。
5. **纪律化工具设计**：Edit 工具强制"先 Read 后 Edit"，精确字符串匹配（old/new 对）+ replace_all；Read 带行号；Bash 带超时与沙箱选项。
6. **上下文管理**：自动 compaction + microcompaction（针对单个工具调用结果的细粒度压缩）+ `/compact` 手动压缩；CLAUDE.md 项目/用户/本地三层记忆（v2.1.277 起兼容 AGENTS.md 标准）。
7. **Hooks 覆盖生命周期**：PreToolUse（在权限提示**之前**运行，形成双重防御）、PostToolUse、SessionStart、Stop、SubagentStop、PreCompact 等。
8. **系统提示词工程**：泄露分析显示 Claude Code 由 500+ 字符片段组装，含 TodoWrite 任务管理纪律、停止条件（未完成不许停）、"先验证后宣称成功"的验收要求、简洁直接的沟通风格。

**局限**：闭源；模型绑定 Anthropic（对其他模型支持差）；长会话 token 消耗大（实测 $18/任务）；功能繁多带来配置复杂度；上下文膨胀依赖压缩，压缩有损。

### 2.3 OpenAI Codex / ChatGPT——"OS 沙箱 + 双轨制"

**架构灵魂**：

1. **Rust 模块化开源 CLI**：openai/codex 是 100+ crate 的 Cargo workspace——core 引擎、tui、protocol、沙箱（linux-sandbox/bwrap/mxc-sandbox/execpolicy/process-hardening）、MCP 客户端、多代理协作（agent-graph-store）、模型提供商抽象（支持 Ollama/LM Studio 本地模型）。
2. **OS 级沙箱**：macOS 用 Seatbelt、Linux 用 seccomp + namespace + Bubblewrap——安全由**系统层**强制，而非应用层确认。审批策略 suggest / auto-edit / full-auto 三档，full-auto 的安全性由沙箱兜底。
3. **AGENTS.md 开放标准**：60k+ 项目采用，被 Codex、Cursor、Zed、VS Code、Jules、Aider 等广泛支持——成为跨工具的项目指令事实标准。
4. **云端 ChatGPT Agent**：Ubuntu 容器 + 无头 VSCode + 浏览器工具 + 多任务并行——"云端 VM"路线的代表。

**局限**：CLI 开源但 2025 下半年起仓库文档被替换为存根、迁移到封闭门户；云端 Agent 完全黑盒；严格沙箱有时阻止合法操作（如需要网络的包安装）；TUI 体验弱于 Claude Code。

### 2.4 ZCode（本机实测）——"渐进披露 + 验收代理 + 双协议多 Provider"

对 `/Applications/ZCode.app` 与 `~/.zcode/` 的逐层探索发现：

1. **形态**：桌面 Electron 壳 + 12.5MB 单文件 CLI 内核（zcode.cjs），捆绑 bfs/ripgrep/ugrep 二进制保证跨机一致的搜索行为。
2. **三层渐进披露 skill**：① name+description（截断约 250 字符）常驻上下文；② SKILL.md 正文触发时加载（目标 <500 行）；③ references/scripts/assets 按需读取，体积不限。skill 文档明确指导 description 要写得 "pushy"（模型倾向漏触发）。
3. **插件 = 五件套容器**：skills + commands + hooks + agents + MCP servers 打包分发，marketplace.json 带 i18n 与 examplePrompts，版本化缓存 + hash 种子保证可回滚。
4. **Judge 验收代理**：document-skills 内置只读评审子代理（judge.md），工具白名单 [Read, Bash]、限 Bash 最多 2 次，输出严格 JSON verdict——**"一个 skill 一个验收代理"的交付验收闭环**，这是其他家没有的实践。
5. **工件外置**：大工具结果落盘为 `artifacts/call_<id>-tool-result-<uuid>.json`，返回引用而非全文——上下文经济学落实到存储层。
6. **双协议多 Provider 注册表**：Anthropic Messages 协议 + OpenAI 兼容协议并存，模型带 reasoning variants 与 priority，可混配任意厂商。
7. **可观测性**：`rollout/model-io-*.jsonl` 全量记录模型 I/O（含 system prompt 原文与 thinking 预算）。

**局限**：`config.json` **明文存 API key**；官方文档明说第三方插件 hook 与内置同权运行（无信任门）；单文件 bundle 不可审查内部实现。

---

## 3. 横向对比与实测数据

| 维度 | dsh | Claude Code | Codex | ZCode |
|---|---|---|---|---|
| 架构灵魂 | 一切皆插件 + append-only 日志 | 五大扩展 + 客户端权限 | Rust 模块化 + OS 沙箱 | 渐进披露 + judge + 双协议 |
| 安全模型 | fail-closed 审批 | 权限规则 + 交互确认 + plan mode | 系统级沙箱 + 审批三档 | 确认制（插件 hook 无信任门） |
| 上下文管理 | 预剪枝 / 缓存对齐压缩 / spill | compaction + microcompaction + 分层记忆 | AGENTS.md | artifacts 工件外置 + 全量 rollout |
| 扩展性 | 插件可替换一切（含 loop） | MCP/Subagent/Hook/Skill/Plugin | MCP + 有限 hooks/skills | 五件套插件 + marketplace |
| 可复现性 | ★★★★★ 日志可重建一切 | ★★（日志加密） | ★★★ | ★★★★（rollout 全量） |
| 模型自由度 | ★★★★★（本地 9B 可跑） | ★★（绑定 Claude） | ★★★★（Ollama/LM Studio） | ★★★★★（双协议） |
| 通过率* | 63.3% | 63.3% | **66.7%** | — |
| 成本/任务* | **$3.28** | $18.34 | $3.47 | —（GLM 系低价） |
| 跨会话记忆 | ✗（最大短板） | ✓ CLAUDE.md | ✓ AGENTS.md | ✓ |
| 压缩可逆性 | ✗（proposal 搁置） | ✗ | — | — |

\* FrontierHarness Eval v1.0（第三方，同模型 Kimi K3，360 次试验）。

**结论**：dsh 证明"上下文工程 + 可复现日志"比"堆功能"更能改善性价比（1/6 成本持平通过率）；Claude Code 证明"客户端强制权限 + 纪律化工具 + 渐进披露"是行为质量的基础；Codex 证明"OS 沙箱是自动化的安全底座"、开放标准（AGENTS.md/MCP）是大势；ZCode 展示了"验收代理 + 工件外置 + 双协议"这些被低估的实践。

---

## 4. 精华清单与糟粕清单

### 4.1 取其精华（→ Loom 机制映射）

| # | 精华 | 来源 | Loom 机制 |
|---|---|---|---|
| 1 | Append-only 日志："Model-visible means logged"，可 fork/resume/replay | dsh | M1 单一事实源 |
| 2 | 压缩的缓存对齐（摘要指令置末尾、schema 恒定对齐 token） | dsh | M6 上下文套件 |
| 3 | 工具结果预剪枝；指令文件 64KB 预算、宽文件先逐出 | dsh | M6 |
| 4 | Bash 超时转后台 job 而非杀死 | dsh | M7 工具纪律 |
| 5 | 客户端强制权限（模型提示词无法绕过）+ plan mode | Claude Code | M3 / M4 |
| 6 | Read-before-Edit 强制、精确字符串编辑 | Claude Code | M7 |
| 7 | 渐进披露 skills（仅 name+description 常驻） | Claude Code / ZCode | M3（M3 阶段实现） |
| 8 | TodoWrite 纪律 + 停止条件 + 先验证后宣称 | Claude Code | M8 / M9 |
| 9 | OS 沙箱使 full-auto 安全 | Codex | M5（M4 阶段实现） |
| 10 | AGENTS.md 开放标准 | Codex | M10 |
| 11 | 双协议多 Provider（Anthropic + OpenAI 兼容） | ZCode | Provider 层 |
| 12 | Judge 验收代理（只读、严格 JSON verdict） | ZCode | M9 |
| 13 | 大工具结果工件外置 + locator | ZCode | M6 |

### 4.2 去其糟粕（→ Loom 的修正）

| # | 糟粕 | 来源 | Loom 修正 |
|---|---|---|---|
| 1 | 极端插件化 → 记忆/权限/日志无人认领 | dsh | **小特权核心**：loop、日志、权限、上下文投影、记忆归核心所有，其余皆插件 |
| 2 | 压缩不可逆，信息永久丢失 | dsh | **可召回压缩**：压缩时全文 spill，`recall(locator)` 随时取回 |
| 3 | Telemetry 默认开启 | dsh | 严格 opt-in，默认零上报 |
| 4 | 闭源 + 模型锁定 | Claude Code | MIT 开源 + 双协议任意模型 |
| 5 | 云端黑盒 | Codex | 纯本地运行，日志全量可审计 |
| 6 | 明文存 API key | ZCode | 优先读环境变量；密钥文件 `600` 权限并支持 OS 钥匙串（路线图） |
| 7 | 第三方插件 hook 与内置同权、无信任门 | ZCode | 安装时信任门 + fail-closed |
| 8 | 54 包重 monorepo / Electron 200MB | dsh | 单 npm 包、零运行时依赖、Node ≥20 原生能力 |
| 9 | 命名晦涩难懂 | dsh | 直白命名 + 每个命令一句话能说清 |

---

## 5. Loom 设计哲学

三条，按优先级排序：

1. **可复现压倒一切**（来自 dsh 的验证）：会话日志是唯一事实源，模型看到的一切都是日志的纯函数投影。任何时刻 `loom replay` 都能重建发往模型的逐字节请求。调试、评测、审计、fork、resume 全部免费获得。
2. **他律压倒自律**（来自 Claude Code/Codex 的验证）：权限由 harness 客户端强制执行，read-before-edit 由工具机械校验，验收由独立 judge 代理把关——**永远不依赖模型的自我约束**。
3. **上下文经济学是第一约束**（dsh 与 ZCode 共同验证）：常驻上下文最小化（渐进披露）、大结果外置（spill + locator）、压缩可召回（无损）、请求布局缓存友好（schema 恒定、指令置后）。

明确的反目标：不做"一切皆插件"（核心能力要有主人）；不做 Electron；不做云端；不做默认遥测。

---

## 6. 12 条核心机制

| # | 机制 | 一句话 | 溯源 |
|---|---|---|---|
| M1 | 单一事实源 | 版本化 append-only JSONL，消息由 projector 派生，"Model-visible means logged" | dsh |
| M2 | 小特权核心 + 插件外壳 | 核心只管 loop/日志/权限/投影/记忆/provider，其余皆可插拔 | 修正 dsh |
| M3 | 客户端强制权限 | allow/ask/deny 规则由 harness 执行，模式 default/acceptEdits/plan/bypass | Claude Code |
| M4 | Plan mode | 只读工具集 + exit_plan 审批门 | Claude Code |
| M5 | OS 沙箱 | auto 模式下 bash 跑 Seatbelt/bwrap，默认禁网 | Codex（M4 阶段） |
| M6 | 上下文工程套件 | 预剪枝 + spill 外置 + **可召回压缩** + 缓存对齐 + 64KB 指令预算 | dsh + ZCode + 修正 |
| M7 | 纪律化工具 | read-before-edit 哈希校验、精确编辑、bash 超时转后台、捆绑 ripgrep | Claude Code + dsh |
| M8 | 任务与目标 | TodoWrite + goal 持久化续跑 + 反偷懒停止条件 | Claude Code + dsh |
| M9 | 子代理 + 验收闭环 | 子代理工具白名单；judge 只读代理按严格 JSON verdict 验收交付物 | Claude Code + ZCode |
| M10 | 记忆一等公民 | AGENTS.md（兼容 CLAUDE.md）+ 跨会话记忆——核心所有，不做插件 | 修正 dsh |
| M11 | 安全卫生 | 密钥不入明文配置、插件信任门、fail-closed 审批、遥测 opt-in | 修正 ZCode/dsh |
| M12 | 可复现评测 | `loom eval` 每任务隔离 workspace+session，跑分可回放 | dsh |

---

## 7. 架构与模块划分

```
loom/
├── src/
│   ├── core/        # agent loop：turn/step 生命周期（特权，M2 小核心）
│   ├── log/         # append-only 事件日志 + projector（日志→消息）
│   ├── context/     # spill 工件外置 / 预剪枝 / 可召回压缩 / token 估算
│   ├── perm/        # 权限引擎（规则+模式+plan 限制）
│   ├── hooks/       # 7 事件 hook runner
│   ├── memory/      # AGENTS.md 加载（64KB 预算、宽文件先逐出）
│   ├── providers/   # Anthropic Messages + OpenAI 兼容双协议、模型目录
│   ├── tools/       # read/edit/write/bash/grep/glob/todo/recall + read-state
│   ├── sysprompt.ts # 系统提示词（CC 风格纪律）
│   └── cli/         # REPL + -p 无头 + --resume + replay
├── test/            # 单测 + mock 适配器全链路冒烟
├── docs/DESIGN.md   # 本文档
└── AGENTS.md        # Loom 仓库自身的项目指令（吃自己的狗粮）
```

**核心概念**（沿用 dsh 的精确定义）：

- **Step（步）** = 一次模型请求 + 它发起的工具调用；
- **Turn（轮）** = 从一条用户输入开始、到模型不再调用工具为止的零或多步。

---

## 8. 关键技术细节

### 8.1 事件日志（M1）

会话存储于 `~/.loom/sessions/<sess_id>/log.jsonl`，每行一个事件，**只追加、永不覆写**；fork 复制文件、resume 追加。事件架构 `v` 版本号，`seq` 会话内单调递增：

```
session/start {sessionId, cwd, model, provider}
turn/start    {source: user|resume|goal}
user/message  {text}
context/message {kind: injected|compaction-summary, text}   ← 注入指令也进历史（dsh 原则）
assistant/message {text, toolCalls[], stopReason, usage}
tool/result   {callId, content|locator, isError}
compaction    {summary, locator, upToSeq}
turn/end      {reason}
```

### 8.2 Projector（日志 → 模型上下文）

`project(events)` 是**纯函数**：

- `user/message`、`context/message` → user 消息；
- `assistant/message` → assistant 消息（text + toolCalls）；
- 相邻 `tool/result` 合并为一条 user 消息（Anthropic tool_result 块 / OpenAI tool 消息，由适配器映射）；
- 遇到 `compaction` 事件 → 丢弃 `upToSeq` 之前派生的所有消息，以摘要消息 + recall 指引开头重建——**同一日志任何时刻投影结果逐字节一致**（M1 验收标准）。

### 8.3 Spill 与 recall（M6）

- 超过阈值的工具结果（默认 30KB）：全文写入 `sessions/<id>/artifacts/`，返回头部 + `[[输出超长已截断，全文外置；recall("artifact:<file>") 可取回]]`；
- `recall(locator)` 工具读回全文（上限 100KB 再剪枝）；
- 压缩时：被压缩的完整消息数组同样 spill 成工件，摘要消息携带 locator——**压缩对模型是可逆的**（修正 dsh 最大缺陷）。

### 8.4 可召回压缩（M6，缓存对齐）

触发：每步请求前估算 token（CJK 按 1 字/token，其余 4 字符/token），超过阈值即压缩。策略：**保留最近一条 user/message 起的当前任务段**，其之前全部压缩。压缩本身是一次独立的模型调用：lite 系统提示 + 待压缩历史 + **摘要指令置于请求末尾**（dsh 的缓存前缀技巧）。压缩事件追加进日志后，主对话以"摘要 + recall 指引"开头继续。请求布局恒定：工具 schema 永远全量携带（缓存对齐）。

### 8.5 权限引擎（M3/M4）

- 规则：`Bash(git push:*)` deny、`Edit(.env)` ask、`Read(src/**)` allow——支持 gitignore 风格路径；
- 判定顺序：**deny > ask > allow**（最严者胜）；无规则命中时回落到模式默认；
- 模式默认矩阵：default（只读放行、写/执行询问）、acceptEdits（写放行、执行询问）、plan（仅只读工具 + exit_plan）、bypassPermissions（全放行，仅建议在沙箱内）；
- **plan mode**：非只读工具直接拒绝并告知"规划模式"；模型完成调研后调用 `exit_plan`，用户批准后模式切换、计划作为 context/message 注入历史；
- 交互式环境弹确认；`-p` 无头模式下 ask **等价于 deny（fail-closed）**。

### 8.6 Provider 双协议（来自 ZCode）

统一内部消息格式，两个适配器：

- **Anthropic Messages**：原生 system/tools/tool_use/tool_result 块，SSE 流式，`cache_control: ephemeral` 提示可缓存前缀；
- **OpenAI 兼容**：chat/completions + function calling，SSE 流式；兼容 DeepSeek/智谱 GLM/通义/Ollama/LM Studio/vLLM 等一切 OpenAI 兼容端点；
- 模型目录内置常见模型 + `LOOM_MODEL / LOOM_BASE_URL / LOOM_API_KEY` 通用覆盖；密钥一律从环境变量读取。

---

## 9. 系统提示词工程

Claude Code 泄露提示词分析 + dsh AGENTS.md 指令哲学的融合，核心段落：

1. **沟通**：结论先行、简洁直接、不奉承、不用空洞结尾；
2. **任务纪律**：多步任务先 TodoWrite；**未完成不许停**（"Keep working until the task is fully done. Do not stop early to ask permission for steps that follow from the original request."）；
3. **验收**："Never claim success without evidence"——宣称完成前必须运行验证（测试/编译）并如实报告失败；
4. **编辑纪律**：先 Read 后 Edit、匹配周边风格、只写"代码自己表达不了"的注释；
5. **安全**：破坏性命令必须确认；拒绝与任务无关的状态改变。

规则遵循 dsh 的 "one home per fact"：提示词只放纪律，细节外链文档。

---

## 10. 安全模型

分层，每层独立兜底：

1. **工具层**：read-before-edit 哈希校验（防盲改）；Edit 唯一匹配（防误伤）；bash 命令注入风险由权限层兜底；
2. **权限层**：客户端强制、模型不可绕过；PreToolUse hook 在权限判定前可独立阻断（双重防御）；fail-closed；
3. **模式层**：plan mode 只读；bypass 仅建议沙箱内；
4. **沙箱层**（M4）：macOS Seatbelt / Linux bwrap，禁网 + workspace-write；
5. **生态层**：插件信任门——第三方插件的 hook/命令首次启用需显式批准，指纹变更需重批；
6. **数据层**：密钥只从环境变量/钥匙串读取，绝不写回配置文件；日志中的密钥字段脱敏。

---

## 11. 路线图与验收标准

| 阶段 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| M0 | 脚手架 + 本设计文档 | 文档完成 | ✅ v0.1.0 |
| M1 | 最小可复现内核：双协议 provider、事件日志、projector、agent loop、read/edit/write/bash/grep/glob/todo、系统提示词、REPL + `-p` + `--resume` + `replay` | 真实仓库多文件任务；`--resume` 续会话；日志重放投影逐字节一致 | ✅ v0.1.0 |
| M2 | 权限引擎（4 模式+规则+plan mode）、hook runner（7 事件）、预剪枝+spill+recall、缓存对齐可召回压缩 | 无信任门不执行；30+ 轮长会话存活压缩且 recall 可取回被压内容 | ✅ v0.1.0 |
| M3 | 子代理（general/explore 只读/judge 验收）、skills 渐进披露、跨会话记忆、MCP stdio client | 子代理独立日志+工具白名单；judge 严格 JSON verdict；MCP 真实子进程连通 | ✅ v0.2.0 |
| M4 | OS 沙箱（seatbelt/bwrap）、插件信任门（sha256 指纹）、slash commands、`loom eval` | 沙箱内写/外拒/网禁实机验证；插件未信任 fail-closed；eval 每任务隔离可回放 | ✅ v0.2.0 |

后续想法（M5+）：HTTP/SSE MCP 传输、子代理并行执行与双向通信、WebFetch/WebSearch 工具、插件市场与 npx 分发。

---

## 12. 参考来源

- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>（MIT；"Everything is a Plugin"）；docs/architecture.md、agent-lifecycle.md、tool-catalog.md；Cordis 论文 <https://arxiv.org/abs/2608.25512>；HN developer preview 帖 <https://news.ycombinator.com/item?id=49285244>、桌面版帖 <https://news.ycombinator.com/item?id=49929489>；Teardown <https://github.com/jimy-r/agent-workspace-architecture/blob/main/teardowns/2026-09-05-deepseek-harness.md>
- 独立基准：FrontierHarness Eval v1.0 <https://frontierharness.org/>（同模型 360 次试验）
- Claude Code：官方文档 <https://code.claude.com/docs>（permissions/memory/sub-agents/hooks/skills）；系统提示词分析 <https://github.com/Piebald-AI/claude-code-system-prompts>
- OpenAI Codex：<https://github.com/openai/codex>（Apache-2.0，Rust）；AGENTS.md 标准 <https://agents.md>；ChatGPT Agent <https://openai.com/index/introducing-chatgpt-agent/>；Reddit 情感分析 <https://aiengineering.report/p/claude-code-vs-codex-sentiment-analysis-reddit>
- ZCode：本机安装目录实测探索（/Applications/ZCode.app、~/.zcode/：skills 三层渐进披露、judge.md 验收代理、artifacts 工件外置、双协议 provider 注册表）
