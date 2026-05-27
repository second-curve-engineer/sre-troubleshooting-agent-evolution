# SRE 线上故障排查 Agent 演进项目

这个仓库记录一个线上故障排查助手从「AI 辅助 workflow」逐步演进到「Agent Harness」的过程。

项目最初来自一个很实际的需求：线上问题排查通常需要工程师在日志、trace_id、异常栈、本地代码库、配置和经验之间来回切换。这个项目的目标，是把这条重复的故障排查路径先做成 AI 辅助 workflow，再逐步演进成更可控、可追踪、可评测的 Agent Harness。

## 三版演进

```text
v1-ai-assisted-workflow/
  硬编码线上故障排查 workflow。
  其中很多命名为 agent 的模块，严格来说是 workflow step、确定性工具，
  或者由 LLM 驱动的分析步骤。

v2-framework-workbench/
  基于 Agent 框架的 workbench。
  这个公开仓库里先保留占位目录，后续用于展示第二版：
  基于开源 Agent 框架、更丰富工具集和前端工作台的尝试。

v3-lightweight-harness/
  Workflow-first lightweight harness。
  这个公开仓库里先保留占位目录，后续用于展示第三版：
  重点解决可控性、trace、eval 和工具边界。
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

如果要本地运行，请参考 `config.example.json` 创建自己的 `config.json`。

## 复盘文档

- [演进说明](./docs/evolution.md)
- [V1 设计复盘：工具、Claude Code 与提示词](./docs/v1-design-notes.md)
- [V1 不足与 V2/V3 演进动力](./docs/v1-limitations.md)
