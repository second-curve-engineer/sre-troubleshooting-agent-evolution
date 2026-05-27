# V1 设计复盘：工具、Claude Code 与提示词

## 1. `*_agent.py` 命名是否准确

V1 里很多模块命名为 `*_agent.py`，但从现在的 Agent 工程视角看，这个命名并不准确。

更准确的定位是：

| 文件 | 更准确的角色 |
| --- | --- |
| `trace_log_query_agent.py` | 日志查询工具 / 检索步骤 |
| `stack_trace_analyze_agent.py` | 异常栈分析器 / 规则分析工具 |
| `code_locator_agent.py` | 代码定位工具 / code grounding tool |
| `root_cause_analysis_agent.py` | LLM 驱动的根因分析步骤 |
| `solution_suggest_agent.py` | LLM 驱动的修复建议步骤 |
| `app.py` | Streamlit UI + 硬编码 workflow 编排器 |

V1 更准确的名字应该是：

> AI 辅助的硬编码线上故障排查 workflow。

它不是 autonomous agent system，也不是标准 LLM API tool calling 系统。

## 2. 为什么当时会这样做

V1 开发时，我还没有系统理解 Agent、tool calling、function tools、Agent runtime、harness 这些概念。

当时公司提供了 Claude Code，所以最直接的想法是：

> 把线上人工故障排查流程自动化，能用程序做的先用程序做，最后把日志、异常栈和代码片段交给 Claude Code 做分析。

所以 V1 的重点不是“做一个标准 Agent”，而是先验证一个真实场景：

> AI 是否能帮助工程师完成线上故障排查的第一轮信息收集、代码定位、根因分析和修复建议。

## 3. `code_locator_agent.py` 和 Claude Code 能力的关系

从今天看，Claude Code 本身已经具备较强的代码库理解和定位能力。如果把完整仓库交给 Claude Code，它有可能自己根据异常栈找到对应代码。

因此，V1 里的 `code_locator_agent.py` 确实有一部分“重复造轮子”的成分。

但它仍然有工程价值，因为它不是为了证明“比 Claude Code 更聪明”，而是做了一个确定性的 code grounding step：

- 根据异常栈判断属于哪个项目。
- 用包名前缀匹配本地代码库。
- 自动发现模块。
- 解析 Java / Kotlin / Python / C# 异常栈里的文件和行号。
- 递归搜索源码文件。
- 提取错误行附近代码、扩展上下文、方法边界、package、imports、类信息。
- 把结构化结果交给后续 LLM 分析。

这背后的设计原则是：

> 能用确定性程序收集和压缩上下文的地方，先用工具做好；LLM 更适合做证据理解、根因归纳和修复建议。

这个认知后来影响了 V3：不要把所有事情都交给模型，而是用 harness 控制 workflow、tool boundary、context 和 trace。

## 4. V1 的提示词设计

V1 只有两个地方真正调用 Claude Code CLI：

- `root_cause_analysis_agent.py`
- `solution_suggest_agent.py`

### 根因分析提示词

```text
你是一名资深后端工程师。请根据以下信息分析代码报错原因：

【日志】
{logs}

【异常栈】
{stack}

【源码】
{code}

请指出可能的错误原因。
```

这个提示词很朴素，但它有一个正确方向：不是空问模型，而是把日志、异常栈和源码作为证据交给模型。

### 修复建议提示词

```text
问题文件：{file} 第 {line} 行
问题描述：{root_cause}
代码如下：
{code}

请提出修改建议并展示建议后的代码。
```

这个提示词同样很简单，主要目标是把根因分析结果转成可执行的修改建议。

## 5. V1 提示词的不足

V1 的 prompt engineering 还很初级：

- 没有要求模型区分事实、推测和置信度。
- 没有要求引用日志、异常栈、源码中的证据。
- 没有结构化输出。
- 没有要求在证据不足时拒绝下结论。
- 没有把修复建议分成临时止血、长期修复和验证步骤。
- 没有 eval 来验证提示词调整是否变好。

这些不足后来推动了 V2 / V3：

- V2 尝试借助 Agent 框架扩展工具能力。
- V3 更关注 workflow-first、步骤级 prompt、工具白名单、trace 和 eval。

## 6. 复盘结论

V1 的核心价值不是证明“所有模块都是真正的 Agent”，而是证明了一个真实业务判断：

> 线上故障排查不是纯聊天场景，它可以被拆解成日志检索、异常栈解析、代码定位、LLM 归因和修复建议这几类可组合步骤。

这版代码也暴露了一个重要工程边界：

> Agent 系统里，不是什么都应该交给模型。确定性的上下文收集、代码定位和证据压缩更适合由工具完成；LLM 更适合在已有证据基础上做理解、归纳和建议生成。

这个结论后来推动了后续版本的设计：从 V1 的硬编码 workflow，到 V2 的框架化 workbench，再到 V3 更强调 workflow、tool boundary、trace 和 eval 的 lightweight harness。
