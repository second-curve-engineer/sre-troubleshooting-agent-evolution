# SRE Troubleshooting Agent Evolution - Project Summary for AI Review

本文档用于给其他 AI 或工程 reviewer 快速理解项目背景、V1/V2/V3 演进过程、当前 V3 能力、代码架构、运行流程和待实现事项。

## 1. 项目定位

这个项目是一个“线上故障排查 Agent”演进项目，核心目标不是做一个通用聊天机器人，而是把 SRE / 后端工程师常见的第一轮故障排查流程工程化：

```text
用户描述故障
-> 判断问题类型
-> 查日志 / trace / 慢查询 / 代码线索
-> 沉淀证据
-> 输出根因判断、修复建议和验证步骤
-> 保留可复盘 trace 和 eval case
```

项目从 V1 到 V3 的主线是：

```text
V1: AI-assisted fixed workflow
-> V2: framework-based tool-using workbench
-> V3: workflow-first lightweight agent harness
```

演进重点从“能跑通一次 AI 辅助排障”逐步转向“可控、可观测、可评测、可扩展的 Agent Harness”。

## 2. V1 -> V2 -> V3 演进过程

### 2.1 V1: AI 辅助的硬编码 Workflow

目录：

```text
v1-ai-assisted-workflow/
```

V1 的目标是验证线上故障排查能否被拆成固定步骤，并使用 Claude Code 辅助完成根因分析和修复建议。

典型流程：

```text
trace_id / 错误码 / 异常栈
-> 查询日志
-> 提取异常 / 请求参数 / 服务调用链
-> 分析异常栈
-> 定位源码
-> 调用 Claude Code CLI 做根因分析
-> 调用 Claude Code CLI 生成修复建议
-> Streamlit UI 展示结果
```

关键实现：

- `src/app.py`
  - Streamlit Web UI。
  - 提供 trace_id、错误码、异常栈三种诊断入口。
  - 负责 workflow 编排、状态展示和报告下载。
- `src/orchestrator.py`
  - 管理固定流程。
- `src/agents/trace_log_query_agent.py`
  - 实际角色是日志查询工具 / 检索步骤。
- `src/agents/stack_trace_analyze_agent.py`
  - 异常栈分析。
- `src/agents/code_locator_agent.py`
  - 根据异常栈定位代码文件、行号和上下文。
- `src/agents/root_cause_analysis_agent.py`
  - 调用 Claude Code CLI 做根因分析。
- `src/agents/solution_suggest_agent.py`
  - 调用 Claude Code CLI 生成修复建议。

V1 证明了：

- 线上故障排查可以被拆成可重复 workflow。
- 日志、异常栈、源码和 LLM 分析可以组合成工程师可读的诊断报告。
- Web UI 比纯脚本更适合展示多步骤诊断过程。

V1 的问题：

- 很多文件命名为 `*_agent.py`，但严格来说是 tool 或 workflow step，不是 autonomous agent。
- `app.py` 同时负责 UI、编排、状态和展示，职责耦合。
- workflow 写死，扩展新故障类型需要改主流程。
- 没有统一 tool schema、tool registry、allowed tools、risk policy。
- LLM 调用依赖 Claude Code CLI，缺少结构化输出、timeout、fallback、成本记录。
- 没有 step-level trace、eval、replay。

V1 到 V2 的动机：

> 从固定 workflow 走向 tool-using Agent，让模型能够根据上下文选择工具，而不是每次都按固定路径执行。

### 2.2 V2: 基于 agno 的 Tool-Using Agent Workbench

目录：

```text
v2-framework-workbench/
```

V2 的目标是使用 Agent 框架快速验证 tool-using Agent 形态。它把 V1 的固定排障步骤拆成工具，由 Agent 根据自然语言故障描述选择工具调用顺序。

能力范围：

- 自然语言输入线上故障描述。
- 解析服务名、时间窗口、trace_id、错误码等上下文。
- 按 trace_id 查询链路日志。
- 按条件查询日志。
- 对 504 / timeout / 慢请求场景查询 MySQL 慢查询日志。
- 向代码库提问。
- 输出根因、证据、修复建议、验证步骤。
- 提供轻量前端 workbench。

关键实现：

- `main.py`
  - 启动 agno / AgentOS 服务和前端静态页面。
- `agents/troubleshooting_agent.py`
  - 定义故障排查 Agent。
  - 构造 instructions 和工具列表。
- `tools/analyze_problem.py`
  - 使用 LLM 或 fallback 规则做问题分类。
- `tools/resolve_app.py`
  - 将用户输入中的系统名、appname、realname 映射为标准 appId 和代码库路径。
- `tools/query_logs_by_trace_id.py`
  - 查询 trace_id 关联日志。
- `tools/query_logs_by_condition.py`
  - 按错误码、HTTP 状态、日志关键词、时间窗口等条件查询日志。
- `tools/query_mysql_slow_log.py`
  - 查询慢 SQL 日志。
- `tools/ask_codebase.py`
  - 默认返回 mock 代码问答；可配置 Claude Code CLI。
- `frontend/`
  - 原生 HTML/CSS/JS 双栏工作台。
  - 左侧对话，右侧工具路径和证据摘要。

V2 证明了：

- 自然语言入口比 V1 的固定表单更符合真实排障使用方式。
- Agent 框架可以快速把工具暴露给 LLM。
- 工具列表 + instructions 可以验证 tool-using 方向。
- 前端 workbench 能展示工具路径和证据摘要，提高可解释性。

V2 的问题：

- 控制权主要在框架和 prompt 中，关键路径不够显式。
- 工具选择依赖 Agent 行为，难以严格限制每个 step 可用工具。
- 低风险 / 高风险工具没有独立 runtime gate。
- trace 仍不够结构化，不足以支撑 replay 和严格 eval。
- 自我纠偏、timeout、fallback、redaction、prompt injection 防护没有形成统一 harness。
- 框架适合快速验证，但不一定适合展示生产级 Agent 的控制层设计。

V2 到 V3 的动机：

> 把核心控制层拿回来，让 router、workflow、tool whitelist、trace、eval、HITL、安全边界由代码显式控制，LLM 作为可替换能力接入，而不是系统控制中心。

### 2.3 V3: Workflow-First Lightweight Agent Harness

目录：

```text
v3-lightweight-harness/
```

V3 使用 TypeScript 实现轻量 Agent Harness。它不是完全自主的 open-ended Agent，而是面向线上故障排查的 controlled agent runtime。

核心思想：

```text
LLM 可以参与语义理解和总结；
关键路径由 harness 控制：
router、workflow、allowedTools、tool registry、risk policy、trace、eval。
```

V3 解决的问题：

- workflow route 从 prompt 约束变成代码决策。
- 每个 workflow step 显式声明 allowed tools。
- 工具调用统一经过 ToolRegistry、ApprovalPolicy、timeout 包装和 trace 记录。
- LLM router / report adapter 可替换，默认 mock，配置后可走 OpenAI-compatible API。
- 所有关键结果进入 RunState 和 JSON trace。
- eval runner 对 route、tool order、evidence、token budget、安全边界做回归检查。

## 3. V3 当前已实现功能

### 3.1 基础运行入口

文件：

```text
src/cli.ts
src/server.ts
frontend/
```

支持：

- CLI 诊断：

```bash
npm run diagnose -- "order-service 下单接口从 10:30 开始大量 504，帮我排查。"
```

- eval：

```bash
npm run eval
```

- HITL demo：

```bash
npm run hitl-demo
```

- API server + Trace Viewer：

```bash
npm run server
```

默认访问：

```text
http://127.0.0.1:4317
```

### 3.2 Hybrid Router

文件：

```text
src/harness/router.ts
src/llm/router-adapter.ts
src/llm/router-prompt.ts
src/schemas/workflow.ts
```

实现：

- 先用 heuristic 判断确定性信号：
  - `trace_id` -> `trace-diagnosis`
  - `504` / `timeout` / `慢` -> `performance`
  - `500` / `exception` + appHint -> `condition-log`
  - 信息不足 -> 低置信
- 高置信 heuristic 不调用 LLM。
- 低置信输入调用 LLM router adapter。
- LLM 输出必须经过 zod schema 校验。
- LLM 低置信时 fallback 到 `clarification`。

价值：

- 确定性路径不浪费 token。
- 模糊自然语言仍可使用 LLM。
- route decision 可被 trace/eval 复盘。

### 3.3 Workflow Definitions

文件：

```text
src/workflows/types.ts
src/workflows/registry.ts
src/workflows/trace-diagnosis.ts
src/workflows/condition-log.ts
src/workflows/performance.ts
src/workflows/clarification.ts
src/workflows/shared.ts
```

当前 workflow：

- `trace-diagnosis`
  - 已有 trace_id 时查链路日志，再问代码库。
- `condition-log`
  - 没有 trace_id 但有错误信号时，先按条件查日志，再反查 trace。
- `performance`
  - 处理 504 / timeout / 慢请求。
  - 支持第一次查询过宽后按 timeout 关键词自我纠偏。
  - 结合 MySQL 慢查询日志。
- `clarification`
  - 信息不足时不调用工具，生成低置信报告和追问信息。

每个 workflow 显式声明：

```text
route
description
steps[]
allowedTools
execute(context)
```

### 3.4 Tool Registry 和 Mock Tools

文件：

```text
src/tools/tool-registry.ts
src/tools/app-tools.ts
src/tools/log-tools.ts
src/tools/slow-query-tools.ts
src/tools/code-tools.ts
src/tools/data.ts
mock-data/
```

当前工具：

- `resolve_app`
- `query_logs_by_trace_id`
- `query_logs_by_condition`
- `query_mysql_slow_log`
- `ask_codebase`
- `restart_service`，仅用于验证 HITL 高风险控制流。

实现特点：

- 工具统一注册在 ToolRegistry。
- 工具 metadata 包含 risk level。
- workflow step 传入 allowedTools。
- ToolRegistry 拒绝不在白名单内的工具调用。
- mock data 保证公开仓库可运行。

### 3.5 Evidence Store

文件：

```text
src/harness/evidence-store.ts
src/schemas/evidence.ts
```

作用：

- 把 router、tool、approval、slow query 等结果转成结构化 evidence。
- evidence 有 source、kind、summary、confidence、usedInFinalReport、safetyFlags。
- 报告生成只基于 evidence，不直接把所有 raw tool output 塞给 LLM。

### 3.6 Trace Store

文件：

```text
src/harness/trace-store.ts
src/schemas/trace.ts
src/schemas/run.ts
```

实现：

- 每次 run 保存为 `traces/run-*.json`。
- trace 包含：
  - runId / sessionId / status
  - userMessage
  - router decision
  - approvals
  - evidence
  - toolTraces
  - llmCalls
  - reportGeneration
  - finalReport
- TraceStore 支持：
  - `save(trace)`
  - `list(limit)`
  - `read(runId)`

价值：

- 支持离线复盘。
- 支持 eval。
- 支持 Trace Viewer 展示。

### 3.7 Tool Timeout / Failure Handling

文件：

```text
src/harness/runner.ts
src/evals/cases.ts
src/evals/metrics.ts
```

实现：

- `TOOL_TIMEOUT_MS` 配置工具超时。
- `invokeTool()` 统一包装 tool call。
- 工具状态支持：
  - `ok`
  - `empty`
  - `too_many_results`
  - `error`
  - `timeout`
  - `cancelled`
- 工具失败不会让 run 直接崩溃，而是进入 tool trace 和 final report。
- eval 包含日志平台超时、慢查询平台失败 case。

### 3.8 Self-Correction Policy

文件：

```text
src/harness/policies.ts
src/workflows/performance.ts
```

当前主要服务于 504 / timeout 场景：

```text
第一次按 504 查询日志
-> 返回 too_many_results / truncated
-> policy 判断需要收窄查询
-> 第二次加入 timeout 关键词重新查询
-> 命中 SQL timeout 线索
-> 查询 MySQL 慢日志
```

特点：

- 当前自我纠偏不是让 LLM 自由重试。
- 它由工具结构化状态和 policy 控制。
- 可复现、可限制、可 eval。

### 3.9 Redaction / Prompt Injection Boundary

文件：

```text
src/security/redaction.ts
src/security/prompt-injection.ts
src/security/llm-safety.ts
```

实现：

- 敏感信息进入 LLM / report 前脱敏。
- tool trace 的 input / outputSummary 保存前做脱敏。
- evidence 进入报告前做安全处理。
- 日志里的 prompt injection 文本作为数据处理，而不是执行指令。
- eval 包含敏感日志和日志注入 case。

### 3.10 LLM Router / Report Adapter

文件：

```text
src/config/env.ts
src/llm/router-adapter.ts
src/llm/report-adapter.ts
src/llm/router-prompt.ts
src/llm/report-prompt.ts
src/llm/mock-llm.ts
```

实现：

- `LlmConfig` 统一管理：
  - mode
  - apiKey
  - baseUrl
  - model
  - timeoutMs
- 默认 mock，保证本地 eval 稳定。
- 设置 `LLM_MODE=openai` 后，低置信 router 和 report generator 可调用 OpenAI-compatible Chat Completions API。
- LLM 输出必须经过 schema 校验。
- 缺少 key、API 失败、schema 校验失败时 fallback。

### 3.11 ModelPolicy

文件：

```text
src/llm/model-policy.ts
src/schemas/llm.ts
```

当前是 role-based policy，不是动态模型路由。

默认策略：

```text
router -> small, budget 1000
evidence_summarizer -> small, budget 2000
root_cause -> strong, budget 6000
report -> standard, budget 4000
judge -> standard, budget 3000
```

作用：

- 根据 LLM role 解析模型档位、模型名、token budget、timeout。
- 写入 `run.llmCalls[]`。
- eval 检查 LLM 调用是否超过 budget。

注意：

- 当前不会根据剩余预算 / deadline 动态切模型。
- 当前预算主要用于 trace 和 eval 回归检查。

### 3.12 HITL Pending-Resume

文件：

```text
src/harness/approval-policy.ts
src/harness/runner.ts
src/schemas/approval.ts
src/harness/hitl.test.ts
```

实现：

- 每个 tool 有 risk level：
  - low
  - medium
  - high
  - critical
- low / medium 当前自动审批并记录。
- high / critical 在 strict mode 下进入 pending。
- Runner 遇到 pending approval：
  - 暂停 run。
  - 状态变为 `waiting_approval`。
  - 保存 pendingApprovalId。
  - 生成低置信报告。
- `resume()` 支持 approve / reject。
- server 提供 approve / reject API。
- Trace Viewer 可演示 HITL。

当前限制：

- pending run store 还是内存版。
- approve 后仍是 workflow replay MVP，可能重复部分 tool trace。
- 后续应支持从具体 step resume。

### 3.13 Eval Runner

文件：

```text
src/evals/cases.ts
src/evals/metrics.ts
src/evals/runner.ts
```

当前 eval 检查：

- route 是否正确。
- tool order 是否符合预期。
- evidence keywords 是否命中。
- final report 字段是否完整。
- confidence 是否符合预期。
- router 是否调用 LLM。
- router token budget。
- LLM policy budget。
- tool status。
- approval status。

当前 eval case 覆盖：

- 500 + trace_id。
- 500 无 trace_id。
- 504 / timeout / MySQL 慢查询。
- 信息不足 clarification。
- 模糊慢请求触发 LLM router。
- 日志平台 timeout。
- 慢查询平台 failure。
- 敏感日志脱敏。
- prompt injection boundary。

### 3.14 API Server + Trace Viewer

文件：

```text
src/server.ts
frontend/index.html
frontend/styles.css
frontend/app.js
```

接口：

```text
POST /api/diagnose
GET  /api/traces
GET  /api/traces/:runId
POST /api/approvals/:approvalId/approve
POST /api/approvals/:approvalId/reject
```

前端：

- 沿用 V2 双栏控制台风格。
- 左侧：故障输入、报告展示、HITL 操作。
- 右侧：
  - Run Summary
  - Tool Path
  - LLM Calls
  - Evidence
  - Recent Traces

价值：

- 不只是 CLI demo。
- 可以可视化复盘 Agent 执行链路。
- 展示 router、tool、LLM、approval、evidence 的完整关系。

## 4. V3 代码架构

目录结构：

```text
v3-lightweight-harness/
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── mock-data/
├── src/
│   ├── cli.ts
│   ├── server.ts
│   ├── config/
│   ├── evals/
│   ├── harness/
│   ├── llm/
│   ├── schemas/
│   ├── security/
│   ├── tools/
│   └── workflows/
├── traces/
├── package.json
└── tsconfig.json
```

核心模块职责：

| 模块 | 职责 |
| --- | --- |
| `src/cli.ts` | CLI 入口，支持 diagnose / eval / hitl-demo |
| `src/server.ts` | API server 和静态 Trace Viewer |
| `src/harness/runner.ts` | Harness 控制中心，串起 router、workflow、tool、evidence、trace、report |
| `src/harness/router.ts` | Hybrid router，先 heuristic，低置信再 LLM |
| `src/workflows/` | 各 route 的 workflow 定义和执行逻辑 |
| `src/tools/` | mock tools 和 ToolRegistry |
| `src/harness/approval-policy.ts` | 工具风险审批策略 |
| `src/harness/evidence-store.ts` | 证据收集与安全处理 |
| `src/harness/trace-store.ts` | trace 保存、读取、列表 |
| `src/harness/policies.ts` | self-correction policy |
| `src/llm/` | mock/real LLM adapter、prompt、ModelPolicy |
| `src/security/` | redaction 和 prompt injection boundary |
| `src/evals/` | eval cases、metrics、runner |
| `src/schemas/` | zod schemas，定义 app、tool、workflow、run、trace、llm 等结构 |

## 5. V3 端到端功能流程

### 5.1 CLI / API 入口

```text
用户输入
-> CLI 或 POST /api/diagnose
-> HarnessRunner.run(userMessage, sessionId)
```

### 5.2 Runner 初始化 RunState

```text
runId
sessionId
status=running
userMessage
approvals=[]
evidence=[]
toolTraces=[]
llmCalls=[]
```

### 5.3 Router 决策

```text
routeWorkflow(userMessage)
-> heuristicDecision()
-> confidence >= threshold: 直接返回
-> confidence < threshold: 调用 LlmRouterAdapter
-> LLM 仍低置信: fallback clarification
```

结果写入：

```text
state.router
state.decision
router evidence
state.llmCalls[]，仅当 router 调用了 LLM
```

### 5.4 获取 Workflow

```text
getWorkflow(state.decision.route)
```

如果不是 `clarification`，先执行：

```text
resolveAppForWorkflow()
```

### 5.5 执行 Workflow

workflow 通过 context 调用工具：

```text
workflow.execute({
  state,
  evidence,
  invokeTool,
  selfCorrectionPolicy
})
```

每次工具调用：

```text
invokeTool()
-> 读取 tool metadata
-> ApprovalPolicy.evaluate()
-> 若 pending: 写 cancelled trace，抛 PendingApprovalError
-> 若可执行: ToolRegistry.invoke()
-> timeout 包装
-> 写 ToolTrace
-> workflow 根据结果写 Evidence
```

### 5.6 HITL 分支

如果高风险工具 pending：

```text
catch PendingApprovalError
-> state.status = waiting_approval
-> state.pendingApprovalId = approvalId
-> 写 approval evidence
-> 生成当前低置信/中置信报告
-> 保存 trace
```

approve / reject：

```text
POST /api/approvals/:approvalId/approve
-> runner.resume()
-> approval.status = approved
-> continueRun()
-> persist trace
```

### 5.7 生成报告

```text
DiagnosisGenerator.generate({
  userMessage,
  decision,
  evidence
})
```

当前默认：

```text
MockDiagnosisGenerator
```

可配置：

```text
OpenAiDiagnosisGenerator
```

输出：

```text
state.finalReport
state.reportGeneration
state.llmCalls[]
```

### 5.8 保存 Trace

```text
TraceStore.save({
  version,
  createdAt,
  run: state
})
```

保存路径：

```text
traces/run-*.json
```

## 6. 当前待实现 / 待增强能力

### 6.1 Real adapters

当前日志、trace、慢查询、代码问答主要是 mock adapter。

后续可以补：

- RealLogAdapter。
- RealTraceAdapter。
- RealSlowQueryAdapter。
- RecordedAdapter，用 trace 文件模拟真实平台输出。

考虑到公开环境无法访问公司内部接口，更合理的下一步是实现 adapter interface 和 recorded adapter，而不是伪装真实内部平台。

### 6.2 PendingRunStore

当前 HITL pending run 保存在 server 内存里。

后续需要：

- 文件或 sqlite 持久化 pending run。
- server 重启后可恢复 pending approval。
- approve/reject 可跨进程恢复。

### 6.3 精准 resume

当前 approve 后是 workflow replay MVP，可能重复部分 tool trace。

后续需要：

- 保存 workflow cursor。
- 从 `resumeFromStepId` 继续执行。
- 避免已完成工具重复执行。
- trace 中记录 explicit resumed event。

### 6.4 Per-tool input schema

当前已有 zod schemas，但 tool input schema 仍可加强。

后续需要：

- 为每个 tool 定义输入 schema。
- 限制 env allowlist。
- 限制 limit 最大值。
- 限制时间窗口跨度。
- 对高风险参数触发 approval。

### 6.5 SessionStore / Context Compaction

当前有 `sessionId`，但没有完整 SessionStore。

后续需要：

- 保存 session 下多个 run summary。
- 保存 selected app、time window、accumulated evidence、pending approvals。
- 多轮对话只把压缩后的 context 送 LLM。

### 6.6 Replay / Recorded Adapter

后续需要：

- 从 trace replay 一次 run。
- recorded adapter 读取历史 tool output。
- 将失败 trace 转成 eval case。
- replay 时锁定版本信息。

### 6.7 OpenTelemetry Export

当前是 JSON trace。

后续可增加：

- run root span。
- router span。
- workflow span。
- tool call spans。
- LLM call spans。
- 接 Jaeger / Tempo / Datadog / Grafana。

### 6.8 Production Eval Dashboard

当前 eval 是 CLI + rule scorer。

后续可以补：

- Web eval dashboard。
- eval run history。
- pass rate、latency、token cost 统计。
- LLM-as-judge 只评估报告语义质量。

### 6.9 Prompt / Model / Tool Versioning

后续需要 trace 记录：

- agentVersion。
- routerVersion。
- workflowVersion。
- toolRegistryVersion。
- promptVersion。
- modelVersion。

### 6.10 Evidence Ranker / Summarizer

当前 evidence 直接进入 report。

后续可以补：

- evidence scoring。
- selected evidence。
- raw output / evidence summary / report context 分层。
- evidence summarizer。

### 6.11 LLM Step Planner

当前 V3 是 workflow-first controlled agent。

后续可增加 LLM Step Planner，但应放在 policy guard 后面：

```text
User Input
-> Router
-> Candidate Workflow
-> LLM Planner
   输出 selectedTool / toolInput / reason / expectedEvidence / confidence
-> Policy Guard
   校验 allowedTools / schema / risk / token budget / evidence
-> ToolRegistry
-> EvidenceStore
-> Report
```

关键原则：

> LLM 可以获得更多 planning 权重，但执行权仍然由 ToolRegistry、allowedTools、schema、risk policy、approval 和 eval 控制。

## 7. 当前项目可运行命令

V3：

```bash
cd v3-lightweight-harness
npm install
npm run typecheck
npm test
npm run eval
npm run diagnose -- "order-service 下单接口从 10:30 开始大量 504，帮我排查。"
npm run server
```

Trace Viewer：

```text
http://127.0.0.1:4317
```

## 8. 当前验证状态

最近一次验证结果：

```text
npm run typecheck 通过
npm test         7/7 passed
npm run eval     9/9 passed
```

浏览器验证：

- Trace Viewer 页面可打开。
- 普通诊断可完成。
- trace 列表可读取。
- LLM calls / tool path / evidence 可展示。
- strict HITL 下高风险工具可进入 waiting_approval。
- approve API 可 resume run。

已知验证观察：

- approve 后仍存在 workflow replay 导致部分 tool trace 重复，这是 pending-resume MVP 的已知限制。

## 9. 给 Reviewer 的重点问题

建议重点 review：

1. V3 的 controlled agent 设计是否合理。
2. Router / Workflow / ToolRegistry 的边界是否清晰。
3. Tool whitelist 和 risk policy 是否足以限制高风险工具。
4. Trace schema 是否足以支撑 replay、eval 和线上 observability。
5. Eval case 是否覆盖了核心故障路径和失败路径。
6. Redaction / prompt injection boundary 是否放在合适位置。
7. ModelPolicy 当前作为 role-based policy 是否足够清晰。
8. API server / Trace Viewer 是否有效展示了 Agent 执行链路。
9. 后续应该优先做 PendingRunStore、per-tool input schema、Replay，还是 real adapters。
10. 如果要引入 LLM Step Planner，policy guard 需要补哪些约束。

## 10. 一句话总结

这个项目的核心价值不在于“调用了一次 LLM”，而在于把线上故障排查 Agent 拆成了可控的工程系统：

```text
router
-> workflow
-> step allowed tools
-> tool registry
-> risk approval
-> evidence store
-> LLM adapter
-> trace
-> eval
-> trace viewer
```

V1 验证了 AI 辅助排障的流程价值；V2 验证了 tool-using Agent 的可行性；V3 则把重点放在生产级 Agent Harness 的控制、可观测、安全和评测能力上。
