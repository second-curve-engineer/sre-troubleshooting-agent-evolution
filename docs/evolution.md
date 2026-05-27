# 演进说明

## V1：AI 辅助的硬编码故障排查 Workflow

V1 是在我还没有系统理解 Agent 概念时做出来的。当时的目标很直接：

> 用 Claude Code 辅助自动化一部分人工线上故障排查流程。

当时的项目形态是：

```text
Streamlit Web UI
-> 三种输入模式：trace_id / 错误码 / 异常栈
-> 硬编码 workflow 编排
-> 日志查询、异常栈分析、代码定位、根因分析、修复建议
-> 分 tab 展示诊断过程
-> 下载 JSON 诊断报告
```

当时的核心 workflow 是硬编码的：

```text
trace_id / 错误码 / 异常栈
-> 查询日志
-> 分析异常栈和调用链
-> 定位源码
-> 调用 Claude Code 做根因分析
-> 调用 Claude Code 生成修复建议
```

V1 带来的关键认知是：

> 把模块命名为 agent，不代表它真的是 Agent。V1 里大多数模块其实是工具或 workflow step。这个版本真正的价值，是验证了生产故障排查可以被拆解成 workflow，并且可以通过 Web 工具把日志、异常栈、代码定位、LLM 分析和结果报告串起来。

另一个重要认知来自 `code_locator_agent.py`：

> Claude Code 本身已经具备较强的代码定位能力。V1 自己实现 code locator 有重复造轮子的成分，但也让我意识到：Agent 系统里不是什么都要交给模型。确定性的上下文收集、代码定位、证据压缩应该先由工具完成，LLM 更适合做证据理解和总结。

这个认知推动了后续 V2、V3 的迭代。

V1 的完整不足可以概括为：

- 概念上，把很多工具和 workflow step 命名成了 agent。
- 架构上，Streamlit UI、workflow 编排、状态管理和结果展示耦合在一起。
- Workflow 上，流程硬编码，缺少步骤级状态和可配置路由。
- Tool 上，没有统一 schema、工具注册、工具白名单和权限边界。
- LLM 调用上，直接依赖 Claude Code CLI，缺少 timeout、retry、fallback、结构化输出和调用记录。
- Trace 和 eval 上，只有最终报告，没有可回放运行记录和回归评测。

这些不足不是要隐藏的缺点，而是 V2/V3 演进的动力。更完整的复盘见：

[V1 不足与 V2/V3 演进动力](./v1-limitations.md)

## V2：基于框架的 Workbench

V2 尝试使用 Agent 框架来做更丰富的工具集和前端工作台。

这一版带来的关键认知是：

> 框架可以帮助快速搭建 tool-using assistant，但生产故障排查场景仍然需要对 workflow、context、tool boundary 和 observability 有更强控制。

## V3：Workflow-first Lightweight Harness

V3 开始走向自研 lightweight harness：

- 显式问题分类。
- 上下文预解析。
- workflow 路由。
- step 级工具白名单。
- trace 持久化。
- eval 回归。

这一版带来的关键认知是：

> 对生产故障排查来说，workflow-first harness 往往比完全自由的 Agent 更可靠。
