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
```

每次运行都会在 `traces/` 下生成一份 `run-*.json`，记录 router decision、tool input/output summary、evidence 和 final report。

## 当前已实现

- TypeScript 工程骨架。
- CLI 诊断入口。
- mock tools：应用解析、trace 日志、条件日志、慢查询日志、代码问答。
- workflow router：trace-diagnosis、condition-log、performance、clarification。
- workflow definitions：每条排障路径独立声明 step、allowedTools 和执行逻辑。
- hybrid router：高置信 heuristic 不调用 LLM，低置信模糊输入走 LLM router adapter。
- router adapter：默认使用 mock router；设置 `LLM_ROUTER_MODE=openai` 后，低置信路由可调用 OpenAI-compatible API。
- step 级工具白名单。
- tool risk level + approval policy：低/中风险工具自动审批并进入 trace，高风险工具预留人工审批。
- trace JSON 持久化。
- 504 场景下的初版 self-correction policy。
- eval runner：检查 route、tool order、evidence keywords、report fields、router token budget。

V3 带来的关键认知是：

> 对生产故障排查来说，可控性和可调试性不是锦上添花，而是 Agent 系统能否落地的前提。真正有用的 Agent 需要一个围绕模型的 harness。

## 关键术语

- heuristic：确定性规则。比如输入里明确出现 `trace_id`、`504`、`timeout` 时，router 可以直接按规则选择 workflow。
- 高置信：router 有足够明确的信号，可以直接做决策。例如有 trace_id 时走 `trace-diagnosis`。
- 低置信：输入信息不完整或语义比较模糊，规则层无法稳定判断，需要交给 LLM router adapter 或转为追问。
- hybrid router：规则和 LLM 结合的路由方式。确定性强的问题先用规则处理，模糊问题再调用 LLM，从而减少 token 消耗。

## 可选：启用真实 LLM Router

默认使用 mock router，便于本地运行和 eval。

如需让低置信路由调用 OpenAI-compatible API：

```bash
export LLM_ROUTER_MODE=openai
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.openai.com/v1
export LLM_ROUTER_MODEL=gpt-4.1-mini
```

只有 heuristic router 低置信时才会调用 LLM，高置信的 `trace_id`、`504`、`500` 等场景仍然不消耗 router token。
