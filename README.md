# SRE 线上故障排查 Agent 演进项目

[![V3 CI](https://github.com/second-curve-engineer/sre-troubleshooting-agent-evolution/actions/workflows/v3-ci.yml/badge.svg)](https://github.com/second-curve-engineer/sre-troubleshooting-agent-evolution/actions/workflows/v3-ci.yml)
[![Showcase](https://img.shields.io/badge/live-showcase-2563eb)](https://second-curve-engineer.github.io/sre-troubleshooting-agent-evolution/#home)

这个仓库记录一个线上故障排查助手从「AI 辅助 workflow」逐步演进到「Agent Harness」的过程。

项目最初来自一个很实际的需求：线上问题排查通常需要工程师在日志、trace_id、异常栈、本地代码库、配置和经验之间来回切换。这个项目的目标，是把这条重复的故障排查路径先做成 AI 辅助 workflow，再逐步演进成更可控、可追踪、可评测的 Agent Harness。

## 三版演进

```text
v1-ai-assisted-workflow/
  硬编码线上故障排查 workflow。
  其中很多命名为 agent 的模块，严格来说是 workflow step、确定性工具，
  或者由 LLM 驱动的分析步骤。

v2-framework-workbench/
  基于 agno 的 tool-using Agent workbench。
  包含自然语言故障入口、日志/慢查询/代码库工具、会话历史、
  demo fallback、API 和轻量前端工作台。

v3-lightweight-harness/
  Workflow-first lightweight harness。
  使用 TypeScript 实现 Router、Workflow、ToolRegistry、Evidence、
  Trace、Eval、HITL 和安全边界，是当前主线版本。
```

## 为什么保留 V1 的原始命名

V1 会保留 `trace_log_query_agent.py`、`code_locator_agent.py` 这类原始文件名。

严格来说，这些模块并不是 autonomous agent。更准确的角色应该是：

| 原始模块名 | 更准确的定位 |
| --- | --- |
| `trace_log_query_agent.py` | 日志查询工具 / 检索步骤 |
| `stack_trace_analyze_agent.py` | 异常栈分析器 |
| `code_locator_agent.py` | 代码定位工具 |
| `root_cause_analysis_agent.py` | LLM 驱动的根因分析步骤 |
| `solution_suggest_agent.py` | LLM 驱动的修复建议步骤 |
| `app.py` | 硬编码 workflow 编排器 |

我刻意保留这些命名，是为了展示真实的学习路径：项目一开始是“把 AI 辅助脚本叫作 agent”，后来逐步分清 tool、workflow、runtime、trace、eval 和 harness 的边界。

## 脱敏说明

这个公开版本已经做过脱敏：

- 真实服务名替换为 demo 服务名。
- 真实包名替换为 `com.example.*`。
- 内部日志平台地址和 token 已移除。
- 本地源码路径替换为占位路径。
- 不包含公司真实生产数据。

V3 默认使用 mock adapter，不需要公司内部系统或模型 API。连接真实模型时，
请参考 [`v3-lightweight-harness/.env.example`](./v3-lightweight-harness/.env.example)
配置本地 `.env`。

## 当前主线

项目当前主线是 [`v3-lightweight-harness/`](./v3-lightweight-harness/)。

V3 默认使用 mock adapter，便于在不依赖公司内部系统和外部模型 API 的情况下，
稳定演示路由、工具调用、失败处理、HITL、Trace 和离线回归。真实模型质量评测
使用单独命令运行，不与确定性离线回归混报。

```bash
cd v3-lightweight-harness
npm ci
npm run verify
npm run server
```

`npm run verify` 会依次执行 TypeScript 类型检查、20 个单元测试和 12 个确定性
离线 Eval 用例。GitHub Actions 使用同一个命令，避免本地与 CI 口径不一致。

## 可验证能力

| 能力 | 代码证据 |
| --- | --- |
| 路由与编排 | Hybrid Router + 4 条显式 Workflow |
| 工具安全 | step 级白名单 + per-tool Zod input schema + risk policy |
| 可恢复执行 | 文件持久化 PendingRunStore + 跨进程 HITL resume |
| 可复现诊断 | Recorded Adapter + strict Replay，不回退调用实时工具 |
| 可观测与评测 | Evidence Store + Trace Store + 20 个单测 + 12 个离线 Eval |

线上展示：[Troubleshooting Agent Showcase](https://second-curve-engineer.github.io/sre-troubleshooting-agent-evolution/#home)

## 阅读顺序

1. [`v3-lightweight-harness/README.md`](./v3-lightweight-harness/README.md)：当前主线、架构和运行方式。
2. [`v1-ai-assisted-workflow/README.md`](./v1-ai-assisted-workflow/README.md)：V1 的硬编码 workflow。
3. [`v2-framework-workbench/README.md`](./v2-framework-workbench/README.md)：V2 的框架方案及其边界。
