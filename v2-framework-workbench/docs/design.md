# V2 设计说明

## 核心命题

V2 验证的是：在线上故障排查场景中，Agent 框架能否比 V1 的硬编码 pipeline 更灵活地组合工具。

它不是生产级最终形态。V2 的价值在于快速搭起 tool-using assistant，并暴露出下一阶段要解决的工程问题。

## 架构

```text
User
  |
  v
Agno AgentOS / FastAPI
  |
  v
Troubleshooting Agent
  |
  +-- analyze_problem
  +-- resolve_app
  +-- string_to_timestamp
  +-- query_logs_by_trace_id
  +-- query_logs_by_condition
  +-- query_mysql_slow_log
  +-- ask_codebase
```

## 工具职责

| 工具 | 职责 |
| --- | --- |
| `analyze_problem` | 优先使用 LLM 判断故障类型；无模型配置时回退规则分类 |
| `resolve_app` | 把系统简称、appname、realname 或 appId 解析成准确 appId 和代码库路径 |
| `string_to_timestamp` | 把时间字符串转成 Unix timestamp |
| `query_logs_by_trace_id` | 按 trace_id 返回跨服务链路日志 |
| `query_logs_by_condition` | 按服务、环境、时间窗口和灵活过滤条件查询日志；条件可以是错误码、接口路径、异常类型、日志关键词、HTTP 状态码等 |
| `query_mysql_slow_log` | 在 504、timeout、耗时高且疑似 MySQL 相关时查询 MySQL 慢查询日志 |
| `ask_codebase` | 对指定代码库提出带上下文的代码问题 |

## LLM 分类与 Prompt 约束

V2 的故障类型识别交给 `analyze_problem` 完成。它会优先通过 Agno model wrapper 调用 OpenAI-compatible API，让 LLM 输出故障类型；如果未配置 `OPENAI_API_KEY` 或调用失败，则回退到轻量规则分类，保证 demo 可运行。

`analyze_problem` 不提取服务名、trace_id、时间窗口，也不决定下一步工具调用。V2 的 workflow 优先级和上下文提取统一保留在主 Agent instructions 中，避免分类工具和全局规则冲突。

工具路径仍通过 instructions 约束 Agent：

- 先分析问题。
- 用户只给系统简称或 app 昵称时，先解析应用映射。
- 有 trace_id 优先查 trace。
- 没有 trace_id 时查时间窗口日志。
- 504/timeout/耗时高场景下，先查应用日志和耗时线索；只有出现 SQL timeout、连接池耗尽、数据库慢、慢查询告警，或接口明显依赖 MySQL 读写时，才补充查询 MySQL 慢查询日志。
- 从日志中提取异常和调用链。
- 代码查询必须带明确问题。
- 最终结论必须基于证据。

这个方式足够适合 V2 演示：LLM 负责理解自然语言，Agent 根据 prompt 约束选择工具。但它还不是生产级可控方案。V3 会把关键路径显式化，引入 router、状态、trace、eval 和 human-in-the-loop。

## Mock 策略

公开仓库不能访问内部日志平台，也不能包含真实生产数据，所以 V2 默认使用 mock。

Mock 不是为了假装真实系统，而是为了保留真实工具边界：

- 输入参数和真实日志查询接近。
- 返回 schema 和真实日志平台接近。
- Agent 能基于日志证据继续调用代码工具。

## 应用映射

内部系统往往由多个上下游子系统构成。用户为了方便，可能只说“库存系统”或某个 app 昵称，但日志平台和代码库工具需要准确标识：

- 日志查询需要准确 `appid`。
- 代码库问答需要准确 `appname` 或 `codebase_path`。

V2 通过 `.env` 中的 `APP_CODEBASE_MAPPING` 和 `APP_MAPPINGS` 构建 `AppRegistry`，并注册 `resolve_app` 工具。Agent 在查日志或代码前，先把用户口中的简称解析成准确应用信息。

## 504 与慢查询场景

504、timeout 和接口耗时高不一定会直接产生清晰异常栈。真实排查中，除了应用日志，还需要看网关日志、trace、下游依赖耗时。只有线索指向 MySQL 时，才进一步看数据库慢查询日志。

V2 新增 `query_mysql_slow_log`，它查询的是专门的慢查询日志平台，而不是业务数据库本身。因此它仍然属于日志证据工具，不触碰 V3 中需要 human-in-the-loop 的生产 DB 数据查询。

这个场景能体现 V2 相比 V1 的动态决策价值：

```text
接口 500 + 异常栈
-> 查 trace
-> 定位异常服务
-> 问代码库

接口 504 / timeout
-> 查应用日志和时间窗口
-> 查慢查询日志
-> 结合延迟和 SQL 证据判断瓶颈
```

## V3 预留

代码中保留 `TODO(v3)`：

- tool trace
- eval case
- context trimming
- structured output schema and report validation
- human approval
- read-only DB query with human approval

这些不在 V2 实现，避免削弱 V2 “框架化 Agent 试验版”的定位。

## 结构化输出扩展点

V2 通过 prompt 要求 Agent 按固定 Markdown 小节输出：

```text
## 问题分析
## 已收集证据
## 根因判断
## 修复建议
## 后续验证
```

这对 demo 和人工阅读足够，但不是强约束。模型可能在多轮追问、工具失败或上下文较长时改变标题、漏掉字段或输出额外内容。

V3 可以增加结构化输出 schema，例如：

```text
problem_analysis
evidence[]
root_cause
fix_suggestions[]
verification_steps[]
confidence_score
```

最终报告先通过 schema 校验，再渲染成 Markdown 或页面卡片。这样更适合后续报告落库、下载、eval 回归和自动化检查。

## DB 查询扩展点

V2 不实现 DB 查询工具。DB 查询更适合放到 V3，因为它属于高风险生产动作，需要显式 workflow 和 human-in-the-loop。

V3 中可以增加一个只读 DB 查询 step：

```text
日志证据显示数据校验失败 / 状态不一致 / 库存记录缺失
-> 生成只读 SQL
-> 人工审批
-> 执行白名单 SQL
-> 记录 trace
-> 汇总 DB 证据
```

这条路径不应该只靠 prompt 决定，而应该由 workflow-first harness 控制：

- 只有日志证据满足数据类故障条件时才允许进入 DB 查询。
- 只能执行 `SELECT`。
- 只能查询白名单表和字段。
- 查询前需要人工确认。
- SQL、参数、结果摘要和审批人都要进入 trace。
