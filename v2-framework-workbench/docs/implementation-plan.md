# V2 聚焦版实现规划

## 定位

V2 是一个只做线上故障排查的 agno tool-using Agent。它承接 V1 的硬编码 pipeline，展示 Agent 框架带来的工具自主组合、多轮对话和 API 化运行方式，同时保留 workflow 可控性、trace、eval、上下文管理这些问题，用来引出 V3 的 lightweight harness。

## 明确边界

保留：

- 用户描述线上故障。
- 分析故障类型和缺失信息。
- 解析用户提到的系统简称、appname、realname 或 appId，得到准确 appId 和代码库路径。
- 按 trace_id 查询链路日志。
- 按服务、环境、时间窗口查询错误日志。
- 在 504、timeout、接口耗时高且疑似 MySQL 相关时查询 MySQL 慢查询日志。
- 从日志中提取异常、请求参数、调用链和证据。
- 基于异常和代码上下文询问代码库。
- 输出根因、证据、修复建议和后续验证动作。
- 支持多轮追问。

不做：

- 业务咨询。
- 发布巡检。
- 生产 DB 查询。
- 配置平台查询。
- 自动修复。
- 工单或 IM 推送。
- 复杂前端工作台。

## 目录结构

```text
v2-framework-workbench/
├── README.md
├── requirements.txt
├── .env.example
├── config.py
├── main.py
├── agents/
│   ├── __init__.py
│   └── troubleshooting_agent.py
├── tools/
│   ├── __init__.py
│   ├── analyze_problem.py
│   ├── ask_codebase.py
│   ├── query_logs_by_condition.py
│   ├── query_logs_by_trace_id.py
│   ├── query_mysql_slow_log.py
│   ├── resolve_app.py
│   └── string_to_timestamp.py
├── mock_data/
│   ├── logs_by_trace_id.json
│   └── logs_by_time_range.json
└── docs/
    ├── design.md
    ├── demo-script.md
    └── implementation-plan.md
```

## 里程碑

| 版本 | 目标 | 产物 |
| --- | --- | --- |
| M1 | 可启动骨架 | `main.py`、`config.py`、Agent 空壳 |
| M2 | 基础问题分析和应用解析 | `BaseTools`、`resolve_app` 可用 |
| M3 | 日志查询闭环 | `LogQueryTools` + mock logs + slow query logs |
| M4 | 代码问答闭环 | `CodeQueryTools` + mock/Claude Code 双模式 |
| M5 | 可展示项目 | README、demo script、完整排障案例 |

## 最终验收标准

1. 本地可以启动 AgentOS。
2. 用户输入一个线上故障描述，Agent 能自主选择工具。
3. 用户只提供系统简称或 app 昵称时，能先解析到准确 appId 和代码库路径。
4. 有 trace_id 时优先查链路日志。
5. 无 trace_id 时能按服务、时间、环境查日志。
6. 504/timeout 场景先查应用日志；只有线索指向 MySQL 时，才补充查询慢查询日志。
7. 能从日志中提取异常、调用链、请求上下文。
8. 能基于异常信息询问代码库。
9. 最终输出有根因、有证据、有修复建议。
10. README 能清楚讲明 V1 -> V2 -> V3 的演进逻辑。

## V3 预留点

- Trace：记录每个 tool call 的输入、输出、耗时、错误。
- Eval：用故障案例集回归测试根因准确率和定位准确率。
- Context：裁剪冗余日志，只保留异常栈、关键请求参数和定位文件。
- Human-in-the-loop：高风险生产动作前增加人工确认。
- DB 查询：作为 V3 human-in-the-loop 扩展点。只有日志明确指向 DB 数据校验失败、状态不一致、库存记录缺失等场景时，才允许进入只读 DB 查询；执行前需要人工审批、SQL 白名单和 trace 记录。
