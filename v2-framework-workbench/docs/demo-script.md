# V2 Demo 脚本

## 演示目标

展示 V2 从 V1 的固定 pipeline 演进到 agno tool-using Agent：

- Agent 自主决定先查 trace 还是时间窗口日志。
- 日志和代码分别作为工具边界。
- 最终结论基于日志证据和代码证据。
- 同时说明 V2 仍然缺少强 workflow 控制、trace 和 eval。

## 启动

```bash
cd v2-framework-workbench
source .venv/bin/activate
python main.py
```

## 示例问题

```text
prod 环境 order-service 下单接口从 10:30 开始出现大量 500，trace_id 是 demo-trace-001，帮我排查。
```

## 期望工具调用路径

```text
analyze_problem
-> resolve_app(app_hint="order-service")
-> query_logs_by_trace_id(trace_id="demo-trace-001", env="prod")
-> ask_codebase(base_dir="inventory-service", question="InventoryService.reserve 为什么会出现 NullPointerException，结合异常栈 InventoryService.java:87 分析")
```

## 期望输出要点

```text
问题分析:
- prod 环境 order-service 下单接口 500。
- trace_id 为 demo-trace-001。

已收集证据:
- gateway 收到 /api/orders。
- order-service 调用 inventory-service。
- inventory-service 在 /internal/inventory/reserve 抛出 NullPointerException。
- 异常栈指向 InventoryService.reserve(InventoryService.java:87)。
- order-service 只是包装并传播 RemoteServiceException。

根因判断:
- 首次报错服务是 inventory-service。
- SKU-10086 查询库存记录为空，代码直接调用 inventory.getAvailable() 导致 NPE。

修复建议:
- repository 返回空时显式处理。
- 返回业务错误而不是空指针。
- 增加 skuId、trace_id、requestId 日志。
- 补充缺失库存记录的单元测试和集成测试。

后续验证:
- 用同样 skuId 回放请求。
- 查询 10:30 后 ERROR 数是否下降。
- 验证 order-service 不再出现 RemoteServiceException。
```

## 面试讲法

一句话：

> V2 是我把 V1 的硬编码故障排查 pipeline 改成 agno Agent 的版本，日志查询和代码问答都变成工具，Agent 可以根据 trace_id、时间窗口和异常栈自主选择下一步。

为什么不用 LangGraph：

> 这一版想验证的是开放式故障排查下工具顺序不固定时，Agent 框架能不能更快搭出可用 workbench。LangGraph 更适合路径明确的流程。V2 的代价是行为主要靠 prompt 约束，所以 V3 才转向 workflow-first harness。

引出 V3：

> V2 跑通后我发现生产排障不只是能调用工具，还需要 trace、eval、上下文裁剪和人工确认。否则 Agent 自己出问题时很难复盘，结果质量也无法回归验证。

## 504 慢查询示例

```text
order-service 下单接口从 10:30 开始大量 504，帮我排查。
```

期望工具调用路径：

```text
analyze_problem
-> resolve_app(app_hint="order-service")
-> query_logs_by_condition(app_id="order-service", query="timeout or 504", ...)
-> query_mysql_slow_log(db_names=["order_db"], query="Query_time > 3", ...)
```

讲解点：

> 500 场景更容易沿着异常栈和 trace 定位代码；504 场景经常没有明确异常栈，需要先查应用日志、网关日志、trace 和下游依赖耗时。只有线索指向 MySQL 时，才补充慢查询日志。这正是 V1 固定 if/else workflow 变僵硬、V2 引入 tool-based Agent 的原因。
