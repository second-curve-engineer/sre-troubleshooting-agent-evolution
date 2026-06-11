# V3：Workflow-first Lightweight Agent Harness

V3 是线上故障排查 Agent 的第三版实现。

V2 使用 agno 快速验证 tool-using Agent；V3 则把核心控制层拿回来，用 TypeScript 实现一个 workflow-first lightweight harness，重点解决生产故障排查 Agent 的几个核心问题：

- 问题分类和 workflow 路由。
- 上下文预解析。
- step 级工具白名单。
- tool trace 持久化。
- 工具反馈驱动的自我纠偏。
- eval 回归。

## 快速运行

```bash
npm install
npm run diagnose -- "prod 环境 order-service 下单接口从 10:30 开始大量 500，trace_id 是 demo-trace-001，帮我排查。"
npm run diagnose -- "order-service 下单接口从 10:30 开始大量 504，帮我排查。"
npm run eval
npm run eval:online
npm run replay -- <runId>
npm run server
```

每次运行都会在 `traces/` 下生成一份 `run-*.json`，记录 router decision、tool input/output summary、evidence 和 final report。

`npm run server` 会启动本地 Trace Viewer，默认地址：

```bash
http://127.0.0.1:4317
```

## Eval 运行口径

评测分为两个模式，结果不能混报：

- `npm run eval` / `npm run eval:offline`：强制使用 mock adapter，验证 route、tool order、
  failure handling、HITL、redaction、golden answer 和 token budget。该模式确定、可复现，
  适合本地回归、CI 和面试现场演示。
- `npm run eval:online`：强制使用 OpenAI-compatible API，同时运行真实 router/report/judge。
  该模式用于观察模型质量、稳定性和 prompt 回归，结果会受模型版本、网络和供应商状态影响。

对外描述时应分别报告离线回归通过率和在线评测结果，不能用离线通过率代表真实模型准确率。

## 当前已实现

- TypeScript 工程骨架。
- CLI 诊断入口。
- mock tools：应用解析、trace 日志、条件日志、慢查询日志、代码问答。
- workflow router：trace-diagnosis、condition-log、performance、clarification。
- workflow definitions：每条排障路径独立声明 step、allowedTools 和执行逻辑。
- hybrid router：高置信 heuristic 不调用 LLM，低置信模糊输入走 LLM router adapter。
- LLM adapter：router/report 共用一套 `LlmConfig`；默认使用 mock，设置 `LLM_MODE=openai` 后可调用 OpenAI-compatible API。
- ModelPolicy：在统一 LLM 配置之上，按 router/report 等 Agent 阶段记录模型档位、预算和 token 使用。
- step 级工具白名单。
- per-tool Zod input schema：白名单通过后、审批前校验必填字段、类型、环境枚举、
  时间窗口、limit、代码路径和高风险动作原因；非法输入写入 trace 且不进入审批。
- tool risk level + approval policy：低/中风险工具自动审批并进入 trace，高风险工具进入 HITL pending-resume。
- HITL pending-resume：高风险工具会暂停 run；`PendingRunStore` 原子写入完整 RunState，
  API Server 重启后可按 approvalId 恢复。审批通过后精准 resume，拒绝后不执行，完成后删除 pending 记录。
- tool timeout / failure handling：工具超时或失败会进入 trace 和 eval，不让 run 直接崩溃。
- redaction / prompt-injection boundary：进入 LLM/报告前脱敏，并把日志里的 prompt injection 标记为数据。
- trace JSON 持久化。
- Recorded Replay：按历史 trace 的 `stepId + toolName + toolInput` 返回固定 ToolResult，
  用相同外部证据重跑当前 Router / Workflow / Policy / Report；路径、参数或调用次数漂移会显式失败。
- API server + Trace Viewer：支持发起诊断、查看历史 trace、复盘 tool/LLM/evidence，并演示 HITL approve/reject。
- 504 场景下的初版 self-correction policy。
- eval runner：检查 route、tool order、tool status、redaction、prompt injection、evidence keywords、report fields、router token budget。

V3 带来的关键认知是：

> 对生产故障排查来说，可控性和可调试性不是锦上添花，而是 Agent 系统能否落地的前提。真正有用的 Agent 需要一个围绕模型的 harness。

## 关键术语

- heuristic：确定性规则。比如输入里明确出现 `trace_id`、`504`、`timeout` 时，router 可以直接按规则选择 workflow。
- 高置信：router 有足够明确的信号，可以直接做决策。例如有 trace_id 时走 `trace-diagnosis`。
- 低置信：输入信息不完整或语义比较模糊，规则层无法稳定判断，需要交给 LLM router adapter 或转为追问。
- hybrid router：规则和 LLM 结合的路由方式。确定性强的问题先用规则处理，模糊问题再调用 LLM，从而减少 token 消耗。
- ModelPolicy：按 Agent 执行阶段选择模型档位和预算。`LlmConfig` 管供应商连接，`ModelPolicy` 管 router/report/root-cause 等角色该用什么模型和 token budget。

## 可选：启用真实 LLM

默认使用 mock LLM adapter，便于本地运行和 eval。

如需让低置信路由和诊断报告生成调用 OpenAI-compatible API：

```bash
export LLM_MODE=openai
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.openai.com/v1
export LLM_MODEL=gpt-4.1-mini
export LLM_TIMEOUT_MS=15000
```

只有 heuristic router 低置信时才会调用 LLM，高置信的 `trace_id`、`504`、`500` 等场景仍然不消耗 router token。

LLM report 输出必须通过 `DiagnosisReportSchema` 校验。API 调用失败、缺少 key 或 schema 校验失败时，会 fallback 到 mock report，并把 `reportGeneration.source=fallback` 写入 trace。

兼容说明：旧的 `LLM_ROUTER_MODE` / `LLM_REPORT_MODE` / `LLM_ROUTER_MODEL` / `LLM_REPORT_MODEL` 仍会被读取，但新配置统一使用 `LLM_MODE`、`LLM_MODEL`、`LLM_TIMEOUT_MS`。

工具执行失败与查询纠偏是两套机制：`error` / `timeout` 在 Runner 中按相同输入进行技术重试，
由 `TOOL_MAX_ATTEMPTS` 和 `TOOL_RETRY_DELAY_MS` 控制；`empty` / `too_many_results` 不属于调用失败，
由 Workflow 的 `QueryRefinementPolicy` 调整查询条件后进入下一轮。

## 可选：配置 ModelPolicy

默认策略：

- router：`small` 档，token budget 1000。
- report：`standard` 档，token budget 4000。
- root_cause：`strong` 档，token budget 6000，当前预留给后续根因综合阶段。

可通过环境变量覆盖：

```bash
export LLM_SMALL_MODEL=gpt-4.1-mini
export LLM_STANDARD_MODEL=gpt-5.5
export LLM_STRONG_MODEL=gpt-5.5
export LLM_ROUTER_TOKEN_BUDGET=1000
export LLM_REPORT_TOKEN_BUDGET=4000
```

每次 LLM 调用会写入 `run.llmCalls[]`，包含 `role`、`modelTier`、`model`、`tokenBudget`、`tokenUsage` 和 fallback 信息。eval 会检查实际 token usage 是否超过 policy budget。

## API server / Trace Viewer

启动：

```bash
npm run server
```

主要接口：

- `POST /api/diagnose`：发起一次诊断。
- `GET /api/traces`：查看最近 trace 列表。
- `GET /api/traces/:runId`：读取单次 run trace。
- `POST /api/traces/:runId/replay`：使用历史工具结果重放当前 Harness。
- `POST /api/approvals/:approvalId/approve`：批准 pending 高风险工具。
- `POST /api/approvals/:approvalId/reject`：拒绝 pending 高风险工具。

Pending run 默认写入 `pending-runs/`，可通过环境变量覆盖：

```bash
export PENDING_RUN_DIR=pending-runs
```

当前文件型 Store 面向单机 demo。生产多实例应替换为数据库或共享 KV，并通过版本号/CAS、
事务或租约保证同一个 approval 只能被一个 worker 消费。

## Recorded Replay

```bash
npm run replay -- run-20260611163237-ca63b2aa
```

Replay 不复制旧报告，也不会重新调用日志平台、数据库或代码平台：

1. 读取历史 Trace 中的用户输入、工具输入、工具结果和 attemptCount。
2. 当前版本重新执行 Router、Workflow、Self-Correction、Evidence 和报告生成。
3. RecordedToolAdapter 按 `stepId + toolName + 规范化 input` 返回历史 ToolResult。
4. 当前路径多调用、少调用、参数变化或调用次数变化都会失败，暴露 Harness 行为回归。

历史中已经真实执行成功的 high/critical 工具禁止 replay。审批阶段被 pending/rejected 的工具
没有进入外部 handler，不作为 recorded invocation 消费。生产环境还应给 Trace 加 adapter、
schema、prompt 和 model 版本，支持跨版本兼容判断。

Trace Viewer 沿用 V2 的双栏控制台风格：左侧是诊断输入和报告，右侧展示 run summary、tool path、LLM calls、evidence 和历史 traces。

## 工具超时配置

工具调用默认超时时间为 3000ms：

```bash
export TOOL_TIMEOUT_MS=3000
```

工具超时会被记录为 `status=timeout`，并写入 trace；eval 中已有日志平台超时和慢查询平台失败的回归 case。
