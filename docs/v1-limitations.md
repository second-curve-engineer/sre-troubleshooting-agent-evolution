# V1 不足与 V2/V3 演进动力

## 总体判断

V1 是一个成功的真实场景原型，但不是成熟的 Agent 系统。

它证明了线上故障排查可以拆成一条相对稳定的 workflow：日志查询、异常栈分析、代码定位、根因分析、修复建议和结果报告。但它也暴露出很多工程化问题：Agent 概念不清、workflow 写死、工具边界不清、状态不可追踪、LLM 调用不可治理、没有 eval 回归。

这些不足不是需要回避的问题，反而是 V2 和 V3 演进的核心动力。

## 1. 概念层：把 workflow step 命名成了 agent

V1 里很多文件命名为 `*_agent.py`，但严格来说，它们大多不是 autonomous agent：

| 文件 | V1 命名 | 更准确的定位 |
| --- | --- | --- |
| `trace_log_query_agent.py` | 日志查询 Agent | 日志查询工具 / 检索步骤 |
| `stack_trace_analyze_agent.py` | 异常栈分析 Agent | 规则分析器 / 异常栈解析工具 |
| `code_locator_agent.py` | 代码定位 Agent | 代码定位工具 / code grounding tool |
| `root_cause_analysis_agent.py` | 根因分析 Agent | LLM 驱动的分析步骤 |
| `solution_suggest_agent.py` | 修复建议 Agent | LLM 驱动的建议生成步骤 |
| `app.py` | 应用入口 | Streamlit UI + 硬编码 workflow 编排器 |

这说明 V1 的真实形态是：

> AI 辅助的线上故障排查 workflow，而不是成熟 Agent Harness。

### 演进动力

- V2：尝试用开源 Agent 框架重新理解 tool、agent、memory、playground/workbench 的边界。
- V3：明确区分 tool、workflow step、LLM step、runtime state、trace、eval 和 harness。

## 2. 架构层：Streamlit UI 承担了太多职责

V1 的 `app.py` 同时承担了：

- Streamlit 页面渲染。
- 三种诊断入口切换。
- workflow 编排。
- 中间状态管理。
- 错误处理。
- 结果展示。
- 报告下载。

这样做适合快速原型验证，但会导致几个问题：

- UI 和业务逻辑耦合，难以复用。
- workflow 修改需要改 UI 文件。
- 无法方便地写单元测试和集成测试。
- 很难把能力暴露成 API，供其他系统调用。
- 后续要接入更多工具、更多诊断路径时，`app.py` 会持续膨胀。

### 演进动力

- V2：引入 workbench 形态，把工具、Agent 和前端体验拆开。
- V3：进一步拆成 `IssueClassifier`、`ContextResolver`、`WorkflowRouter`、`PromptBuilder`、`ToolManager`、`TraceManager`、`EvalService` 等更清晰的组件。

## 3. Workflow 层：流程硬编码，缺少可配置编排

V1 的核心流程写死在代码里，例如：

- `run_full_diagnosis()`
- `run_error_code_diagnosis()`
- `run_stack_diagnosis()`
- `run_remaining_steps()`

这带来的问题是：

- 新增一种故障类型，需要改编排代码。
- 不同场景无法灵活选择不同步骤。
- 没有 step-level 状态模型。
- 中断恢复只是临时任务保存，不是真正的 resumable run。
- 每一步的输入输出没有统一 schema。
- 无法清楚回答“这次诊断到底执行了哪些步骤、每一步用了什么输入、产出了什么结果”。

### 演进动力

- V2：借助框架探索更灵活的 tool-using workflow。
- V3：采用 workflow-first 设计，让不同问题类型通过 router 进入不同诊断路径，并把每一步的状态、输入、输出和错误都记录下来。

## 4. Tool 层：没有统一工具抽象和工具边界

V1 中每个模块各自定义输入输出，主要靠 Python dict 串联。它们能工作，但缺少统一约束：

- 没有统一 tool schema。
- 没有工具注册中心。
- 没有工具白名单。
- 没有 step-level allowed tools。
- 没有标准错误返回结构。
- 没有权限边界。
- 没有工具调用 trace。

这会导致一个问题：

> 工具越多，系统越难控制；工具越强，风险越高。

尤其在线上故障排查场景里，工具可能访问日志、数据库、配置、代码库、监控系统。如果没有边界控制，很难把它做成可解释、可审计、可上线的系统。

### 演进动力

- V2：尝试把日志查询、代码查询、数据库诊断等能力做成更明确的 tools。
- V3：引入 `ToolManager` 和步骤级工具白名单，让每个 workflow step 只能调用自己被允许的工具。

## 5. Context 层：有上下文提取意识，但没有形成系统

V1 已经有一个正确方向：不是把所有日志和代码直接扔给模型，而是先提取有效上下文。

例如：

- 从日志中提取接口路径、请求参数、异常、服务调用链。
- 从异常栈中挑选业务相关栈帧。
- 从本地代码库中定位文件、行号和附近代码片段。

但 V1 的上下文处理还比较分散：

- 规则散落在多个模块里。
- 日志字段和具体业务系统强耦合。
- 代码定位依赖本地目录结构和包名规则。
- 缺少 token budget。
- 缺少上下文裁剪策略。
- 缺少证据引用结构。
- 缺少置信度和候选排序。

### 演进动力

- V2：通过更丰富的工具集增强上下文收集能力。
- V3：把上下文解析、裁剪、压缩和 prompt 构造独立出来，形成 `ContextResolver` 和 `PromptBuilder`。

## 6. LLM 调用层：直接调用 Claude Code CLI，缺少治理能力

V1 真正调用 LLM 的地方主要是：

- `root_cause_analysis_agent.py`
- `solution_suggest_agent.py`

调用方式是直接通过 `subprocess` 执行 `claude` 命令。这在当时很实用，因为公司提供的 AI 工具就是 Claude Code，但从工程化角度看有明显不足：

- 没有统一 LLM client。
- 没有 timeout。
- 没有 retry。
- 没有 fallback。
- 没有模型参数管理。
- 没有 token、cost、latency 记录。
- 没有结构化输出约束。
- 没有输出质量检查。
- 没有要求模型区分事实、推测和置信度。
- 没有要求引用日志、异常栈和源码证据。

### 演进动力

- V2：通过 Agent 框架理解模型、工具和执行环境之间的关系。
- V3：把 LLM 调用收敛到受控的 prompt builder、model adapter 和 trace 记录中。

## 7. Prompt 层：提示词朴素，缺少面向生产排查的结构化要求

V1 的提示词方向是对的：把日志、异常栈和源码作为证据交给模型，而不是空问模型。

但提示词还很初级：

- 没有要求输出固定 JSON 或 Markdown 结构。
- 没有要求列出证据来源。
- 没有要求说明置信度。
- 没有要求“不确定时不要强行下结论”。
- 没有把修复建议拆成临时止血、长期修复、验证步骤和风险。
- 没有把 SRE 视角、研发视角、业务影响放进统一框架。

### 演进动力

- V2：探索通过 framework 的 agent instruction 和 tool result 组织上下文。
- V3：为不同 workflow step 设计更明确的 step prompt，并配合 eval 观察提示词调整是否真的变好。

## 8. Trace 与 Eval 层：有报告，但没有可观测 Agent 运行记录

V1 能生成诊断结果报告，但这和 Agent 系统需要的 trace 不是一回事。

V1 缺少：

- 每一步开始和结束时间。
- 每一步输入输出快照。
- 每一次工具调用记录。
- 每一次 LLM 调用记录。
- prompt 版本记录。
- 错误、重试和 fallback 记录。
- 可回放的诊断过程。
- eval case。
- 回归指标。

这会导致后续优化缺少依据：不知道哪个步骤耗时、哪个工具失败率高、哪个 prompt 版本更好、哪个模型输出经常幻觉。

### 演进动力

- V3：把 trace 和 eval 作为一等公民，设计 `TraceManager` 和 `EvalService`，让系统可以被观察、复盘和回归测试。

## 9. 生产化层：安全、权限、脱敏和人审都还不完整

V1 是内部原型，因此很多生产化问题没有系统解决：

- 配置文件里容易混入真实环境信息。
- 日志、请求参数、异常栈可能包含敏感数据。
- 没有统一脱敏策略。
- 没有权限控制。
- 没有工具调用审批。
- 没有人审节点。
- 没有多环境隔离。
- 没有线上可观测指标。

这些问题在 demo 阶段可以暂时接受，但如果要进入真实生产环境，就必须解决。

### 演进动力

- V2：开始把能力做成 workbench，便于人参与、查看和操作。
- V3：通过 harness 控制工具边界、记录 trace，并为 human-in-the-loop 留出位置。

## 10. 代码工程层：能跑通，但缺少长期维护能力

V1 的代码更像一次快速验证：

- 模块之间通过 dict 隐式传递数据。
- 缺少类型定义。
- 缺少单元测试。
- 缺少 mock backend。
- 缺少 CI。
- 规则和业务场景耦合较深。
- 错误处理不统一。
- 一些源码解析逻辑依赖字符串匹配，对复杂语法不稳。

这些问题不影响 V1 证明价值，但会限制它继续扩展。

### 演进动力

- V2：借助框架快速扩展工具能力。
- V3：回到更可控的自研轻量架构，补齐状态、trace、工具边界、eval 和测试。

## 总结

V1 的定位应该保持准确：它是一个 AI 辅助的线上故障排查 workflow，而不是成熟 Agent Harness。

它的价值在于验证了真实场景：

- 线上故障排查可以被拆解成稳定步骤。
- 日志、异常栈和代码定位可以先由确定性工具完成。
- LLM 更适合在已有证据基础上做根因归纳和修复建议。
- Web UI 和报告能力能把一次性脚本变成工程师可使用的内部工具。

它的不足也构成了后续演进方向：

- V2 通过框架化 workbench 探索工具扩展和交互体验。
- V3 通过 lightweight harness 强化 workflow、tool boundary、trace、eval 和可控性。
