# V2 系统架构与执行流程

## 1. V2 的定位

V2 是一个基于 Agno 的线上故障排查 Agent Workbench。

它相比 V1 的核心变化是：

- V1 是固定 pipeline，用户需要在固定入口输入 trace_id、异常栈等信息。
- V2 改成对话式入口，用户可以直接描述线上故障。
- V2 把故障分类、应用解析、日志查询、慢查询日志、代码问答封装成工具，由 Agent 根据 instructions 选择调用。

当前 V2 的边界是：

- `analyze_problem` 只做故障类型分类。
- workflow 优先级统一放在 `build_instructions()` 中。
- 日志和代码查询默认使用 mock 数据，便于公开仓库演示。
- 生产 DB 查询、human-in-the-loop、trace、eval、显式 router 留到 V3。

## 2. 总体架构

```text
Browser Workbench
  |
  | POST /api/chat
  v
FastAPI / AgentOS app
  |
  | 有 OPENAI_API_KEY
  v
Agno Agent
  |
  +-- analyze_problem
  +-- resolve_app
  +-- string_to_timestamp
  +-- query_logs_by_trace_id
  +-- query_logs_by_condition
  +-- query_mysql_slow_log
  +-- ask_codebase
  |
  v
Markdown diagnosis answer

无 OPENAI_API_KEY 时：
Browser Workbench -> /api/chat -> demo fallback -> mock answer
```

## 3. 目录与模块职责

```text
v2-framework-workbench/
├── main.py                         # HTTP 入口、AgentOS app、demo fallback
├── config.py                       # .env 读取、配置校验、Agno model 创建
├── app_registry.py                 # appId / appname / 系统名 / 代码库路径映射
├── agents/
│   └── troubleshooting_agent.py    # 构建 Agno Agent、注册工具、定义 instructions
├── tools/
│   ├── analyze_problem.py          # 故障类型分类工具
│   ├── resolve_app.py              # 应用映射解析工具工厂
│   ├── string_to_timestamp.py      # 时间字符串转 timestamp
│   ├── query_logs_by_trace_id.py   # 按 trace_id 查链路日志
│   ├── query_logs_by_condition.py  # 按灵活条件过滤日志
│   ├── query_mysql_slow_log.py     # 查 MySQL 慢查询日志
│   ├── ask_codebase.py             # 代码库问答工具工厂
│   └── _log_helpers.py             # 日志工具共享 helper
├── frontend/                       # 对话式工作台页面
└── mock_data/                      # 公开 demo 的 mock 日志数据
```

## 4. 核心类与函数

### 4.1 `Config`

文件：`config.py`

职责：

- 从 `v2-framework-workbench/.env` 读取配置。
- 读取 OpenAI-compatible API 配置。
- 读取 Agent host、port、debug、reload 配置。
- 读取代码库路径配置。
- 读取应用映射配置。
- 构建 `AppRegistry`。
- 创建 Agno 的 `OpenAIChat` model wrapper。
- 执行启动前配置校验。

关键方法：

- `Config.from_env()`：加载 `.env`，生成完整配置对象。
- `Config.get_llm_model()`：创建 Agno model wrapper，不在业务工具里裸调 OpenAI SDK。
- `Config.validate()`：校验必要配置，返回 warning 和 error。

### 4.2 `ConfigValidation`

文件：`config.py`

职责：

- 承载配置校验结果。
- `warnings` 表示可以启动但能力受限。
- `errors` 表示不能启动。

典型规则：

- 没有 `OPENAI_API_KEY`：warning，允许 demo fallback。
- `OPENAI_BASE_URL` 或 `OPENAI_MODEL` 为空：error。
- `AGENT_PORT` 非法：error。
- `ENABLE_CLAUDE_CODE=true` 但没有 `claude` CLI：error。

### 4.3 `AppInfo`

文件：`app_registry.py`

职责：

- 表示一个内部应用或子系统。
- 保存 `appid`、系统名、`appname`、`realname`、代码库路径和别名。

为什么重要：

线上排查时，用户经常只说系统简称或 app 昵称，但日志平台需要准确 appId，代码库查询需要准确路径。`AppInfo` 是这些信息的统一载体。

### 4.4 `AppRegistry`

文件：`app_registry.py`

职责：

- 把 `.env` 中的 `CODEBASE_PATH`、`APP_CODEBASE_MAPPING`、`APP_MAPPINGS` 合并成应用索引。
- 支持按 appId、系统名、appname、realname、代码库目录名解析应用。
- 给 `resolve_app` 工具提供应用映射索引。
- 给代码库工具提供 alias 到代码库路径的映射。

关键方法：

- `AppRegistry.from_config()`：从配置构建应用注册表。
- `resolve(query)`：把用户提到的系统或服务解析成 `AppInfo`。
- `to_prompt_table()`：保留为调试/文档辅助方法，当前主 Agent prompt 不再直接注入应用映射表。
- `codebase_aliases()`：生成代码库 alias 映射。

### 4.5 `build_troubleshooting_agent`

文件：`agents/troubleshooting_agent.py`

职责：

- 创建 Agno `Agent`。
- 注入 LLM model。
- 创建 SQLite session db。
- 注册所有工具。
- 注入 `build_instructions()` 生成的全局 workflow 规则。
- 打开最近 5 轮历史上下文。

它是 V2 的 Agent 装配中心。

### 4.6 `build_instructions`

文件：`agents/troubleshooting_agent.py`

职责：

- 定义主 Agent 的角色和目标。
- 定义 V2 的推荐排查 workflow。
- 定义工具调用优先级。
- 定义最终回答格式。
- 定义必要的执行边界。

当前 V2 中，workflow 主要靠这里约束。`build_instructions()` 只保留高层排查策略；具体工具参数、过滤语法、日志字段和应用映射细节交给各工具自身说明，V3 规划保存在文档中，不放进 Agent prompt。

### 4.7 `ChatRequest` / `ChatResponse`

文件：`main.py`

职责：

- `ChatRequest` 表示前端请求体，包括用户消息和可选 session_id。
- `ChatResponse` 表示返回给前端的数据，包括诊断答案、模式、工具路径和证据摘要。

`ChatResponse.mode` 可能是：

- `agent`：真实 Agent 调用。
- `demo-fallback`：未配置 key 时的本地 mock 演示。
- `demo-fallback-after-agent-error`：Agent 调用失败后回退 demo。

## 5. 工具职责

### 5.1 `analyze_problem`

文件：`tools/analyze_problem.py`

职责：

- 只做故障类型分类。
- 优先通过 Agno model wrapper 调用 LLM。
- 未配置 `OPENAI_API_KEY` 或 LLM 调用失败时，回退关键词规则。

输出示例：

```text
分析来源: llm
故障类型: 性能问题
```

分类范围：

- 接口报错
- 性能问题
- 未知，需要更多上下文

V2 不把功能异常、数据一致性问题、依赖故障作为正式分类。这些场景需要业务配置、生产数据、依赖指标或 human-in-the-loop，放到 V3 扩展。

### 5.2 `resolve_app`

文件：`tools/resolve_app.py`

职责：

- 把用户提到的系统简称、appname、realname、appId 解析成准确应用信息。
- 返回 appId、系统名、appname、realname、代码库路径。

它通过 `build_resolve_app_tool(app_registry)` 动态创建工具，因为它依赖启动时读取到的应用映射配置。

### 5.3 `string_to_timestamp`

文件：`tools/string_to_timestamp.py`

职责：

- 把人类可读时间转成 Unix timestamp。
- 默认使用 Asia/Shanghai 时区。

### 5.4 `query_logs_by_trace_id`

文件：`tools/query_logs_by_trace_id.py`

职责：

- 按 trace_id 查询跨服务链路日志。
- 公开版从 `mock_data/logs_by_trace_id.json` 读取数据。
- 返回压缩后的 JSON，包含 involved apps、trace ids、错误日志和 sample logs。

### 5.5 `query_logs_by_condition`

文件：`tools/query_logs_by_condition.py`

职责：

- 按 appId、时间窗口、环境和灵活过滤条件查询日志。
- 过滤条件可以是错误码、接口路径、异常类型、日志关键词、HTTP 状态码等任意组合。
- 如果查询条件没有环境过滤，会自动补 `host.deploy_env`。
- 公开版从 `mock_data/logs_by_time_range.json` 读取数据。

### 5.6 `query_mysql_slow_log`

文件：`tools/query_mysql_slow_log.py`

职责：

- 查询 MySQL 慢查询日志平台。
- 用于 504、timeout、耗时高且疑似 MySQL 相关的问题。
- 如果只是泛化性能问题，应先查应用日志、网关日志、trace 或下游耗时线索，不直接默认查 MySQL。
- 它不是业务 DB 查询，只是慢日志查询。

V3 才会考虑真正的业务 DB 查询，并且需要 human-in-the-loop、SQL 白名单和 trace。

### 5.7 `ask_codebase`

文件：`tools/ask_codebase.py`

职责：

- 对指定代码库提出带上下文的问题。
- 默认返回公开 mock 答案。
- 如果 `ENABLE_CLAUDE_CODE=true`，会调用本地 `claude -p`。
- 同一代码目录第二次调用时会加 `-c`，复用 Claude Code 上下文。

它通过 `build_ask_codebase_tool(codebases, enable_claude_code)` 动态创建工具，因为它依赖启动时读取到的代码库配置。

## 6. 一次请求的执行流程

### 6.1 前端入口

文件：`frontend/app.js`

流程：

1. 用户在页面输入故障描述。
2. 前端 POST `/api/chat`。
3. 请求体包含 `message` 和 `session_id`。
4. 前端收到返回后渲染：
   - 对话内容。
   - 工具路径。
   - 证据摘要。
   - 当前模式。

### 6.2 后端入口

文件：`main.py`

流程：

1. 启动时执行 `Config.from_env()`。
2. 执行 `config.validate()`。
3. 创建 `agent = build_troubleshooting_agent(config)`。
4. 用 `AgentOS` 包装 Agent。
5. 暴露 `/workbench` 和 `/api/chat`。

### 6.3 `/api/chat` 正常 Agent 模式

触发条件：

- 配置了 `OPENAI_API_KEY`。

执行流程：

```text
POST /api/chat
  -> 生成或复用 session_id
  -> agent.arun(message, session_id=session_id)
  -> Agno Agent 根据 instructions 决定工具调用
  -> 返回 RunOutput
  -> _extract_run_content 提取 answer
  -> ChatResponse(mode="agent")
```

Agent 内部推荐流程：

```text
用户输入
  -> analyze_problem 判断故障类型
  -> resolve_app 解析应用映射
  -> 有 trace_id: query_logs_by_trace_id
  -> 无 trace_id 但有服务和过滤条件: query_logs_by_condition
  -> 504 / timeout / 耗时高: 先查应用日志；线索指向 MySQL 时再 query_mysql_slow_log
  -> 需要代码理解: ask_codebase
  -> 输出问题分析、证据、根因、修复建议、后续验证
```

### 6.4 `/api/chat` Demo Fallback 模式

触发条件：

- 未配置 `OPENAI_API_KEY`。
- 或真实 Agent 调用失败。

执行流程：

```text
POST /api/chat
  -> _demo_diagnosis(message, session_id)
  -> analyze_problem.entrypoint(message)
  -> 根据关键词判断是否 timeout 场景
  -> 返回固定 mock 诊断答案
```

Demo fallback 的意义：

- 公开仓库不需要真实 API key 也能演示。
- 不访问内部日志平台和代码库。
- 保留工具路径和证据摘要，方便展示 V2 交互效果。

## 7. 两条典型排查链路

### 7.1 500 + trace_id

输入示例：

```text
prod 环境 order-service 下单接口从 10:30 开始大量 500，trace_id 是 demo-trace-001，帮我排查。
```

预期链路：

```text
analyze_problem
  -> 故障类型: 接口报错
resolve_app
  -> 解析 order-service
query_logs_by_trace_id
  -> 拉完整链路日志
ask_codebase
  -> 根据异常栈问 inventory-service 代码
输出根因和修复建议
```

### 7.2 504 / timeout / 慢查询

输入示例：

```text
order-service 下单接口从 10:30 开始大量 504，帮我排查。
```

预期链路：

```text
analyze_problem
  -> 故障类型: 性能问题
resolve_app
  -> 解析 order-service
query_logs_by_condition
  -> 查应用日志和耗时线索
query_mysql_slow_log
  -> 在线索指向 MySQL 时查慢查询日志
输出根因和修复建议
```

## 8. V2 的关键设计取舍

### 8.1 为什么 `analyze_problem` 只做分类

之前 `analyze_problem` 曾经提取服务名、trace_id、时间窗口、缺失信息和下一步建议，但这样会和 `build_instructions()` 里的全局 workflow 规则重叠。

当前收敛后的边界是：

- `analyze_problem`：只判断故障类型。
- `build_instructions()`：统一决定工具优先级和上下文提取方式。
- `resolve_app`：专门处理应用映射。
- 日志工具：专门处理 trace_id 或时间窗口查询。

这样 V2 只有一个 workflow 决策源，逻辑更容易解释。

### 8.2 为什么慢查询日志属于 V2

`query_mysql_slow_log` 查询的是慢查询日志平台，不是业务数据库。

504、timeout、接口耗时高场景下，只查应用 ERROR 日志通常不够，但也不能默认都查 MySQL。V2 的慢查询工具只覆盖 MySQL 相关性能线索，例如 SQL timeout、连接池耗尽、数据库慢、慢查询告警，或接口明显依赖 MySQL 读写。

真正的业务 DB 查询会读生产数据，属于高风险动作，放到 V3 human-in-the-loop。

### 8.3 为什么保留 demo fallback

公开仓库不能依赖内部日志平台、内部代码库和真实 API key。

demo fallback 保证：

- 页面可以直接演示。
- 工具路径和证据摘要可见。
- 不暴露内部系统名和生产数据。

## 9. 当前不足与 V3 方向

V2 的不足：

- workflow 主要靠 instructions 约束，不是显式 router。
- V2 为了保持版本边界，只保留接口报错和性能问题两条可演示路径；功能异常、数据一致性问题、依赖故障暂不作为 V2 正式分类。
- 性能问题只能识别到大类，当前只实现 MySQL 慢查询这一条典型路径；Redis、下游 RPC、JVM、线程池、网关耗时等性能子路径还不能统一排查。
- 工具调用没有完整 trace。
- 输出格式仍然主要靠 prompt，不是严格 schema。
- 长对话只保留最近 5 轮，没有精细上下文管理。
- 没有 eval。
- 没有 human-in-the-loop。

V3 方向：

- 引入显式 router / workflow-first harness。
- 记录每一步工具输入、输出、耗时和错误。
- 引入 eval case，评估诊断质量。
- 对生产 DB 查询等高风险动作加入 human-in-the-loop。
- 对最终报告做结构化 schema 校验。

## 9.1 V2 分类边界规划

V2 作为一个独立版本，需要避免两种极端：

- 如果分类过多，但工具能力跟不上，会显得设计过度。
- 如果只保留一个 500 demo，又会显得只是把 V1 换成了 Agent 框架。

因此当前规划是：

```text
V2 正式分类:
- 接口报错
- 性能问题
- 未知，需要更多上下文

V3 再扩展:
- 功能异常
- 数据一致性问题
- 依赖故障
- Redis / RPC / JVM / 线程池 / 网关等性能子类
- human-in-the-loop DB 查询
```

V2 的两条代表路径：

```text
接口报错
  -> trace/log/code
  -> 形成完整根因闭环

性能问题
  -> 条件日志
  -> MySQL 相关时查慢查询
  -> 作为动态工具选择的扩展样例
```

这让 V2 的价值集中在两个点：

- 自然语言入口替代 V1 的固定表单。
- Agent 能根据上下文组合日志、trace、慢查询和代码工具。

## 10. 性能问题的通用诊断方案备忘

V2 当前能把 504、timeout、接口耗时高识别为“性能问题”，但这只是现象分类。真正的性能诊断不能默认都查 MySQL，因为性能瓶颈可能来自：

- MySQL 慢查询或连接池耗尽。
- Redis 慢查询、热点 key、连接池耗尽。
- 下游 HTTP / RPC 超时。
- MQ 堆积。
- JVM GC、CPU 飙高、内存压力。
- 业务线程池打满。
- 网关超时或入口层限流。

后续更通用的方案不是做一个“万能性能工具”，而是做成：

```text
统一性能诊断框架
  -> 性能子类型 router
  -> 多类专用证据工具
  -> 统一证据模型
```

### 10.1 统一性能诊断框架

性能问题可以按三步拆解：

```text
先确认慢在哪里
再确认是谁慢
最后确认为什么慢
```

第一步先收集通用信号：

- 接口耗时。
- 网关耗时。
- 应用日志耗时。
- trace span 耗时。
- 下游依赖耗时。
- 错误码。
- 线程池指标。
- JVM 指标。
- DB / Redis / RPC 指标。

### 10.2 性能子类型 Router

在 V3/V4 中，可以把“性能问题”继续拆成更细子类型：

```text
DB_SLOW
REDIS_SLOW
RPC_DOWNSTREAM_SLOW
JVM_GC
THREAD_POOL_SATURATION
GATEWAY_TIMEOUT
APP_INTERNAL_SLOW
UNKNOWN_PERFORMANCE
```

Router 的职责不是直接给结论，而是根据日志、trace 和指标证据选择下一类工具。

### 10.3 专用工具扩展

每个子类型接自己的证据工具：

```text
DB_SLOW
  -> query_mysql_slow_log

REDIS_SLOW
  -> query_redis_slow_log
  -> query_redis_metrics

RPC_DOWNSTREAM_SLOW
  -> query_trace_dependency_latency
  -> query_downstream_error_logs

JVM_GC
  -> query_jvm_metrics
  -> query_gc_logs

THREAD_POOL_SATURATION
  -> query_thread_pool_metrics
  -> query_app_logs_by_keyword

GATEWAY_TIMEOUT
  -> query_gateway_logs
  -> query_trace_by_request_id
```

### 10.4 统一证据模型

不同工具返回的原始结果不同，但可以压缩成统一证据模型：

```json
{
  "bottleneck_type": "RPC_DOWNSTREAM_SLOW",
  "service": "order-service",
  "time_window": "10:30-10:45",
  "evidence": [
    "trace 中 payment-service span P99 从 120ms 升到 3.2s",
    "order-service 等待 payment-service 超时",
    "gateway 504 与下游超时同时间段上涨"
  ],
  "confidence": 0.84,
  "next_checks": [
    "查询 payment-service 同时间段错误日志",
    "查看 payment-service 线程池和 JVM 指标"
  ]
}
```

这样上层 Agent 不需要关心底层工具差异，只看：

- 瓶颈类型。
- 影响服务。
- 时间窗口。
- 证据。
- 置信度。
- 下一步检查项。

### 10.5 版本演进建议

```text
V2: 只覆盖 MySQL 慢查询这一条性能路径
V3: 引入性能问题 router，区分 DB / Redis / RPC / JVM / 线程池 / 网关
V4: 统一性能诊断模型，做跨工具证据聚合和瓶颈归因
```

一句话总结：

> 通用点不在某个工具本身，而在诊断框架：先统一识别性能问题，再用 router 判断性能子类型，最后用专用工具采集证据，并压缩成统一证据模型。

## 11. V3 Tool Trace / Replay 备忘

V2 的工具已经能被 Agent 调用并返回结果，但还没有系统记录“工具调用过程”。V3 需要补一层 tool trace，把每次工具调用的输入、输出摘要、耗时和错误保存下来，方便复盘、调试、评测和回放。

以 `query_logs_by_condition` 为例，V2 现在只做：

```text
Agent 决定调用工具
-> 工具读取 mock 日志或真实日志平台
-> 返回 compact JSON
```

但没有记录：

- 什么时候调用。
- 为什么调用。
- 传了哪些参数。
- 查了哪个 app_id。
- query 条件是什么。
- 耗时多久。
- 返回多少条日志。
- 有没有错误。
- 这个结果后来有没有被 Agent 用来判断根因。

V3 可以记录成：

```json
{
  "run_id": "run-20260529-001",
  "session_id": "web-xxx",
  "step_id": "step-003",
  "tool_name": "query_logs_by_condition",
  "input": {
    "app_id": "order-service",
    "query": "SELECT * WHERE log.level = 'ERROR'",
    "from_time": "2026-05-29 10:30:00",
    "to_time": "2026-05-29 10:35:00",
    "env": "prod"
  },
  "output_summary": {
    "status": "success",
    "log_count": 12,
    "trace_ids": ["demo-trace-001"],
    "apps": ["order-service", "inventory-service"]
  },
  "duration_ms": 43,
  "error": null
}
```

### 11.1 解决的问题

**调试 Agent 自身判断**

如果诊断结果不对，可以复盘：

```text
第 1 步 analyze_problem 分类成性能问题
第 2 步 resolve_app 解析到 order-service
第 3 步 query_logs_by_condition 没查到日志
第 4 步 Agent 没有追问，直接给了结论
```

这样可以定位是分类错、工具参数错、工具结果为空，还是总结阶段幻觉。

**支持 eval**

以后做故障案例集时，不只看最终答案，还能评估过程：

- 是否调用了正确工具。
- 是否先查 trace。
- 是否用了准确 appId。
- 日志为空时是否追问。
- 是否没有越权查 DB。

**支持上下文压缩**

原始日志可能很长，不能全塞回 LLM。V3 可以：

```text
完整 output 存 trace
LLM 上下文只放 output_summary
```

**支持前端展示排查过程**

右侧工具路径可以从 demo 列表升级成真实步骤：

```text
1. analyze_problem 28ms
2. resolve_app 3ms
3. query_logs_by_condition 43ms, 命中 12 条日志
4. query_logs_by_trace_id 51ms, 涉及 3 个服务
5. ask_codebase 4.2s
```

**支持 replay**

如果某次诊断结果有问题，可以用保存下来的 trace 重放：

```text
复用当时的 tool input/output
不重新查真实生产系统
只重新跑 Agent 总结逻辑或 router 逻辑
```

这对调 prompt、调 router 和做回归测试很有用。

### 11.2 实现方向

V3 可以加统一 wrapper，而不是让每个工具自己写记录逻辑：

```python
def traced_tool(tool_name, fn):
    def wrapper(*args, **kwargs):
        start = time.time()
        error = None
        output = None
        try:
            output = fn(*args, **kwargs)
            return output
        except Exception as exc:
            error = str(exc)
            raise
        finally:
            save_tool_trace(
                tool_name=tool_name,
                input=kwargs,
                output_summary=summarize(output),
                duration_ms=int((time.time() - start) * 1000),
                error=error,
            )
    return wrapper
```

更适合 V3 的做法是在工具注册层或 workflow step 层统一加 trace，而不是散落到单个工具里。

一句话总结：

```text
V2: 工具能调用，能返回结果
V3: 每次工具调用都要可观测、可回放、可评测
```
