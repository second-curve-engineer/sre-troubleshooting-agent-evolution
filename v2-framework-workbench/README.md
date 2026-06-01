# V2：基于 agno 的故障排查 Agent Workbench

V2 的目标是把 V1 的硬编码故障排查 pipeline，重构成一个聚焦线上故障排查的 tool-using Agent。

这个公开版本只保留故障排查主线：分析问题、查日志、查 trace、问代码库、输出根因和修复建议。业务问题、发布巡检、生产 DB 查询等能力不放进 V2，避免项目叙事发散。

## 背景

V1 证明了线上故障排查流程可以被自动化：

```text
trace_id / 错误码 / 异常栈
-> 查询日志
-> 分析异常栈和调用链
-> 定位源码
-> 调用 Claude Code 做根因分析
-> 生成修复建议
```

但 V1 的流程是写死的，每次排查都按固定顺序执行，也没有真正的多轮对话和 LLM API tool calling。

V2 尝试用 agno 框架把日志查询、代码问答、基础问题分析封装成工具，让 Agent 根据上下文自主选择工具调用顺序。

## 能力范围

保留：

- 分析线上故障描述。
- 按 trace_id 查询跨服务链路日志。
- 按服务、时间窗口和环境查询错误日志。
- 在 504、timeout、接口耗时高且疑似 MySQL 相关时查询 MySQL 慢查询日志。
- 从日志中提取异常、请求参数、调用链和首次报错服务。
- 基于异常栈向代码库提出具体问题。
- 输出根因、证据、修复建议和后续验证。
- 支持多轮追问和最近 5 轮历史上下文。

不做：

- 业务咨询。
- 发布巡检。
- 生产 DB 查询。
- 配置平台查询。
- 自动修复。
- 工单或 IM 推送。

## 目录结构

```text
v2-framework-workbench/
├── README.md
├── requirements.txt
├── .env.example
├── config.py
├── main.py
├── agents/
│   └── troubleshooting_agent.py
├── tools/
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
    ├── implementation-plan.md
    └── system-architecture.md
```

## 架构文档

当前 V2 的系统架构、核心类职责、工具职责和请求执行流程整理在：

- `docs/system-architecture.md`

## 快速启动

```bash
cd v2-framework-workbench
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```

默认服务端口是 `7777`。启动后可以访问：

- V2 对话工作台: `http://localhost:7777/workbench`
- Swagger UI: `http://localhost:7777/docs`
- Health check: `http://localhost:7777/health`
- Agent list: `http://localhost:7777/agents`

agno 2.6.x 的 AgentOS 路由可在 `/docs` 查看。当前 Agent id 是 `troubleshooting_agent`。

### .env.example 的作用

`.env.example` 是配置模板，不会被程序直接读取。程序实际读取的是项目根目录下的 `.env`：

```text
v2-framework-workbench/.env
```

本地运行前需要复制一份：

```bash
cp .env.example .env
```

然后按需要修改 `.env`。这样做有两个目的：

- 让仓库里保留完整配置项说明。
- 避免把真实 API key、代码库路径、内部 app 映射提交到 Git。

如果没有 `.env`，项目仍然可以启动，但会使用代码里的默认值；没有 `OPENAI_API_KEY` 时会进入 demo fallback 模式。

## 对话式 Workbench

V2 新增了一个轻量页面：

```text
http://localhost:7777/workbench
```

用户不再需要像 V1 一样先选择固定入口，再分别填写 trace_id、错误码或异常栈。现在可以直接用自然语言描述线上故障，例如：

```text
prod 环境 order-service 下单接口从 10:30 开始出现大量 500，trace_id 是 demo-trace-001，帮我排查。
```

页面会展示：

- 对话式诊断过程。
- 工具调用路径。
- 日志、异常栈、代码定位等证据摘要。
- V2 相比 V1 的易用性变化。

如果没有配置 `OPENAI_API_KEY`，页面会自动使用 demo fallback，基于 `mock_data/` 返回一条完整的故障诊断链路，便于本地演示。

## Demo 输入

```text
prod 环境 order-service 下单接口从 10:30 开始出现大量 500，trace_id 是 demo-trace-001，帮我排查。
```

期望调用路径：

```text
analyze_problem
-> query_logs_by_trace_id
-> ask_codebase(base_dir="inventory-service", question="...")
-> 输出根因和修复建议
```

## 关键设计

### 问题分类

`analyze_problem` 会优先使用 LLM 对自然语言故障描述做故障类型分类。这里不裸调 OpenAI SDK，而是复用 `Config.get_llm_model()` 创建的 Agno model wrapper，保证 V2 的模型调用统一走框架封装。未配置 `OPENAI_API_KEY` 或 LLM 调用失败时，会自动回退到规则分类，保证 demo fallback 可运行。

`analyze_problem` 不提取服务名、trace_id、时间窗口和下一步工具调用建议。V2 的工具调用优先级和上下文提取统一放在 `build_instructions()` 中，避免分类工具和主 Agent workflow 规则出现两个决策源。

### LLM 接入

公开版只支持 OpenAI-compatible API：

```env
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=
```

公司内真实版本可以扩展到 Bedrock、Vertex 或其他 provider，但这个仓库不把 provider 适配作为展示重点。

### 配置校验

V2 启动时会执行轻量配置校验：

- 没有配置 `OPENAI_API_KEY`：打印 warning，允许启动，页面使用 demo fallback。
- `OPENAI_BASE_URL` / `OPENAI_MODEL` 为空：启动失败。
- `AGENT_PORT` 不合法：启动失败。
- `APP_MAPPINGS` JSON 格式错误：打印 warning，应用 appname/realname 映射会失效。
- 没有解析到应用映射：打印 warning，`resolve_app` 能力会受限。
- `ENABLE_CLAUDE_CODE=true` 但没有 `claude` CLI 或仍使用占位代码库路径：启动失败。

这个校验属于 V2 的基础工程质量，不放到 V3。V3 关注的是 Agent 可靠性方向，例如 workflow control、trace、eval、context management、human-in-the-loop 和结构化输出。

### 日志查询

`tools/query_logs_by_trace_id.py`、`tools/query_logs_by_condition.py` 和 `tools/query_mysql_slow_log.py` 保留真实日志平台调用的接口形状，但默认使用 `mock_data/` 下的数据。

其中 `query_logs_by_condition` 的特点是灵活过滤：可以按错误码、接口路径、异常类型、日志关键词、HTTP 状态码等任意条件组合查询，适合没有 trace_id 但有告警上下文或时间窗口的场景。

这样做是为了让公开项目可运行，同时避免暴露公司内部日志平台、token 和生产数据。

### 代码问答

`tools/ask_codebase.py` 默认使用 mock 答案。如果设置：

```env
ENABLE_CLAUDE_CODE=true
```

则会调用本地 `claude -p`。同一运行进程内，同一代码目录第二次调用会自动加 `-c` 复用 Claude Code 上下文。

### 应用映射

V2 支持从 `.env` 读取应用目录配置：

- `CODEBASE_PATH`
- `APP_CODEBASE_MAPPING`
- `APP_MAPPINGS`

这类配置用于解决内部系统常见的问题：用户可能只说系统简称、app 昵称或 appname，但日志平台需要准确 appId，代码库查询需要准确代码库路径。

Agent 会先调用 `resolve_app` 把用户输入解析成：

```text
appid / system_name / appname / realname / codebase_path
```

然后再把准确 `appid` 传给日志查询工具，把 `appname` 或 `codebase_path` 传给代码库问答工具。

### 504 / 慢查询场景

V2 也包含一个慢查询日志工具：`query_mysql_slow_log`。

它用于 504、timeout、接口耗时高且疑似 MySQL 相关的故障。此时应用日志可能只有超时现象，没有明确异常栈；如果用户描述或日志中出现 SQL timeout、连接池耗尽、数据库慢、慢查询告警，或接口明显依赖 MySQL 读写，Agent 才需要动态选择慢查询日志作为补充证据。

注意：这个工具查询的是专门的 MySQL 慢日志平台，不是直接查询业务数据库数据。因此它属于日志证据工具；真正的生产 DB 数据查询仍然留到 V3，通过 human-in-the-loop、SQL 白名单和 trace 控制。

## V1 vs V2

| 维度 | V1 | V2 |
| --- | --- | --- |
| 执行方式 | 写死 pipeline | Agent 自主选择工具 |
| LLM 接入 | Claude Code CLI | OpenAI-compatible API |
| 代码定位 | 正则和文件搜索 | ask_codebase 问代码库 |
| 对话能力 | 每次全新 | SQLite 会话历史 |
| UI/接口 | Streamlit | AgentOS/FastAPI |
| 扩展方式 | 改 pipeline 代码 | 新增工具并注册 |

## V2 的不足

V2 有意保留以下问题，用来引出 V3：

- Workflow 主要靠 prompt 约束，复杂故障下工具顺序可能不稳定。
- 问题分类刻意收敛，只保留接口报错、性能问题、未知三类；功能异常、数据一致性问题、依赖故障不放进 V2。
- 性能问题只覆盖 MySQL 慢查询这一条典型路径，Redis、RPC、JVM、线程池、网关耗时等子路径留到后续版本。
- 工具调用缺少完整 trace，排查 Agent 自身问题不够方便。
- 没有 eval，结果质量主要靠人工观察。
- 长对话只保留最近 5 轮，没有精细上下文裁剪。
- 高风险生产动作没有 human-in-the-loop。

V3 会转向 workflow-first lightweight harness，重点解决可控性、trace、eval、上下文管理和人工确认。

一个典型 V3 扩展点是只读 DB 查询：当日志明确指向数据校验失败、订单状态不一致或库存记录缺失时，再进入 DB 查询步骤。生产 DB 查询需要 human-in-the-loop、SQL 白名单和完整 trace，因此不放进 V2。

### 分类边界

V2 正式分类只保留：

```text
接口报错
性能问题
未知，需要更多上下文
```

接口报错走完整的 `trace/log/code` 主链路；性能问题只保留 MySQL 慢查询作为扩展样例。功能异常、数据一致性问题、依赖故障放到 V3，用显式 router、更多专用工具和 human-in-the-loop 承接。
