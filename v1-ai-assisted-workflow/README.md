# V1：AI 辅助的硬编码故障排查 Workflow

V1 是线上故障排查助手的第一版。

它来自一个实际运维需求：当线上问题只给出 `trace_id`、接口错误码，或者一段异常栈时，自动完成第一轮故障排查，包括查询日志、提取有效上下文、定位源码，并调用 Claude Code 总结根因和修复建议。

## 重要历史说明

这一版里很多文件命名为 `*_agent.py`，但从今天的理解看，这个命名并不准确。

V1 开发时，我还没有系统理解 Agent、tool calling、function tools、Agent runtime、harness 这些概念。当时公司提供的 AI 工具是 Claude Code，所以第一版是在硬编码线上故障排查 workflow 里直接调用 Claude Code CLI。

更准确的角色划分如下：

| 文件 | 实际角色 |
| --- | --- |
| `trace_log_query_agent.py` | 日志查询工具 / 检索步骤 |
| `stack_trace_analyze_agent.py` | 异常栈分析器 |
| `code_locator_agent.py` | 代码定位工具 |
| `root_cause_analysis_agent.py` | LLM 驱动的根因分析步骤 |
| `solution_suggest_agent.py` | LLM 驱动的修复建议步骤 |
| `app.py` | Streamlit UI + 硬编码 workflow 编排器 |

这里刻意保留原始命名，是为了展示真实学习路径：V1 起点是 AI 辅助 workflow，还不是成熟的 Agent Harness。

## Workflow

```text
Trace ID 模式：
trace_id
-> 查询日志
-> 提取异常 / 请求参数 / 服务调用链
-> 分析异常栈
-> 定位源码
-> 通过 Claude Code CLI 做根因分析
-> 通过 Claude Code CLI 生成修复建议

错误码模式：
接口路径 + 错误码
-> 查询错误日志
-> 提取 trace_id
-> 复用 Trace ID 模式

异常栈模式：
异常栈
-> 定位源码
-> 根因分析
-> 修复建议
```

## 项目架构

V1 的整体架构是一个 Streamlit Web 工具 + 一组按步骤拆分的 Python 模块。

```text
Streamlit Web UI (app.py)
├── 输入入口
│   ├── Trace ID 诊断
│   ├── 接口路径 + 错误码诊断
│   └── 异常栈诊断
├── Workflow 编排
│   ├── run_full_diagnosis()
│   ├── run_error_code_diagnosis()
│   ├── run_stack_diagnosis()
│   └── run_remaining_steps()
├── 工具 / 分析模块
│   ├── trace_log_query_agent.py
│   ├── stack_trace_analyze_agent.py
│   ├── code_locator_agent.py
│   ├── root_cause_analysis_agent.py
│   └── solution_suggest_agent.py
├── 任务状态
│   └── temp_tasks/，用于记录诊断中断状态
└── 结果展示
    ├── 日志查询结果
    ├── 异常分析
    ├── 代码定位
    ├── 根因分析
    ├── 修复建议
    └── JSON 报告下载
```

### Streamlit Web 界面做了什么

V1 使用 Streamlit 做了一个内部可操作的 Web 界面，不只是命令行脚本。

界面提供：

- 三种诊断模式切换：Trace ID、异常栈、错误码。
- 诊断过程状态提示，避免用户刷新页面中断任务。
- 每一步结果分 tab 展示：总览、日志查询、异常分析、代码定位、根因分析、解决方案、详细信息。
- 日志预览、异常详情、请求参数、服务调用链、错误代码片段展示。
- 诊断结果 JSON 下载，方便保存和转发。
- 简单任务状态持久化，检测未完成诊断任务。

这个界面的价值是：它把 AI 辅助分析变成一个工程师可以直接使用的内部工具，而不是只在终端里跑一次脚本。

## 设计复盘：工具、Claude Code 与提示词

V1 里很多模块叫 `*_agent.py`，但严格来说它们大多不是 autonomous agent，而是工具或 workflow step。

其中 `code_locator_agent.py` 是一个典型例子。从今天看，Claude Code 本身已经具备较强的代码库理解和定位能力，所以这个模块有一部分重复造轮子的成分。但它仍然体现了一个重要工程思路：

> 先用确定性程序把异常栈 grounding 到具体项目、文件、行号和代码片段，再把压缩后的上下文交给 Claude Code 做根因分析。

V1 中真正调用 Claude Code CLI 的地方主要是：

- `root_cause_analysis_agent.py`
- `solution_suggest_agent.py`

当时的提示词也比较朴素，主要是把日志、异常栈、源码、文件和行号交给 Claude Code，让它总结根因和修复建议。

更详细的复盘见：

[V1 设计复盘：工具、Claude Code 与提示词](../docs/v1-design-notes.md)

## V1 证明了什么

V1 证明了生产故障排查可以拆成一组可重复步骤：

- 收集日志。
- 从噪声很大的日志字段里提取有效信号。
- 从异常栈里选择最有价值的业务栈帧。
- 把分析 grounded 到真实源码。
- 使用 LLM 做根因分析和修复建议。
- 用 Web UI 把诊断过程和结果组织成工程师可读、可下载的报告。

## 已知不足

V1 的不足主要集中在几个方面：

- 概念上，很多 `*_agent.py` 更准确是工具或 workflow step，而不是 autonomous agent。
- 架构上，Streamlit `app.py` 同时承担 UI、workflow 编排、状态管理和结果展示。
- Workflow 上，流程写死在代码里，新增诊断场景需要改编排逻辑。
- Tool 上，没有统一 schema、工具注册、工具白名单和权限边界。
- LLM 调用上，直接调用 Claude Code CLI，缺少 timeout、retry、fallback、结构化输出和成本记录。
- Prompt 上，提示词比较朴素，没有要求证据引用、置信度、事实/推测区分和验证步骤。
- Trace 和 eval 上，只有结果报告，还没有可回放的步骤级 trace 和回归评测。

这些不足推动了 V2 和 V3 的迭代。

更完整的分析见：

[V1 不足与 V2/V3 演进动力](../docs/v1-limitations.md)

## 本地运行

```bash
pip install -r requirements.txt
cd src
cp ../config.example.json config.json
streamlit run app.py
```

如果希望日志查询链路完整跑通，需要准备自己的 mock log backend。
