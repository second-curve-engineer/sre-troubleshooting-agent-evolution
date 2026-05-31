from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional
from uuid import uuid4

from agno.os import AgentOS
from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agents import build_troubleshooting_agent
from config import Config, ROOT_DIR
from tools.analyze_problem import _heuristic_problem_analysis
from tools.ask_codebase import MOCK_ANSWERS
from tools.query_logs_by_trace_id import query_logs_by_trace_id
from tools.query_mysql_slow_log import query_mysql_slow_log


config = Config.from_env()
validation = config.validate()
if validation.format():
    print(validation.format())
if not validation.ok:
    raise RuntimeError("V2 workbench configuration validation failed.")

agent = build_troubleshooting_agent(config)
agent_os = AgentOS(
    agents=[agent],
    description="V2 focused troubleshooting Agent workbench",
)
app = agent_os.get_app()
FRONTEND_DIR = ROOT_DIR / "frontend"


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    session_id: Optional[str] = None


class ChatResponse(BaseModel):
    session_id: str
    mode: str
    answer: str
    tool_trace: List[Dict[str, str]] = []
    evidence: List[str] = []


def _extract_run_content(run_output) -> str:
    content = getattr(run_output, "content", None)
    if content is None:
        return str(run_output)
    if isinstance(content, str):
        return content
    return str(content)


def _problem_type_line(problem: str) -> str:
    for line in problem.splitlines():
        if line.startswith("故障类型:"):
            return line
    return problem.splitlines()[0] if problem else "故障类型: 未知"


def _demo_diagnosis(message: str, session_id: str) -> ChatResponse:
    # demo fallback 直接用 heuristic 分类，不需要 LLM
    problem = _heuristic_problem_analysis(message, analysis_source="heuristic")
    resolved_app = config.app_registry.resolve("order-service")
    if _is_timeout_message(message):
        return _demo_timeout_diagnosis(message, session_id, problem, resolved_app)

    logs = query_logs_by_trace_id.entrypoint("demo-trace-001", "prod")
    code_answer = MOCK_ANSWERS["inventory-service"].strip()
    answer = """## 问题分析
这是一个 prod 环境下单接口 500 的故障。用户输入中提供了 order-service、故障时间窗口和 trace_id，因此优先按 trace_id 拉完整链路日志。

## 已收集证据
- gateway 收到 POST /api/orders 请求。
- order-service 调用 inventory-service 预占库存。
- inventory-service 在 /internal/inventory/reserve 抛出 java.lang.NullPointerException。
- 异常栈指向 InventoryService.reserve(InventoryService.java:87)。
- order-service 只是把下游异常包装成 RemoteServiceException。

## 根因判断
首次报错点在 inventory-service。SKU-10086 查询库存记录为空后，代码直接调用 inventory.getAvailable()，缺少空值分支，导致 NullPointerException。

## 修复建议
1. 在 InventoryService.reserve 中对 inventory == null 增加显式处理。
2. 返回可识别的业务错误，例如 INVENTORY_NOT_FOUND，而不是让空指针冒泡。
3. 日志补充 skuId、trace_id、requestId，方便后续按关键字段聚合。
4. 增加缺失库存记录场景的单元测试和接口回归测试。

## 后续验证
修复后用 SKU-10086 回放下单请求，并查询 10:30 后 inventory-service 的 NullPointerException 和 order-service 的 RemoteServiceException 是否下降。

说明：当前页面在未配置 OPENAI_API_KEY 时使用 demo fallback，日志和代码证据来自公开 mock 数据。""".strip()

    return ChatResponse(
        session_id=session_id,
        mode="demo-fallback",
        answer=answer,
        tool_trace=[
            {"name": "analyze_problem", "status": "completed"},
            {"name": "resolve_app", "status": "completed"},
            {"name": "query_logs_by_trace_id", "status": "completed"},
            {"name": "ask_codebase", "status": "completed"},
        ],
        evidence=[
            _problem_type_line(problem),
            f"应用解析: {resolved_app.appid if resolved_app else 'order-service'}",
            "trace_id: demo-trace-001",
            "首次 ERROR: inventory-service java.lang.NullPointerException",
            "代码定位: InventoryService.reserve(InventoryService.java:87)",
            code_answer.splitlines()[4],
        ],
    )


def _is_timeout_message(message: str) -> bool:
    lowered = message.lower()
    return any(keyword in lowered for keyword in ["504", "timeout", "gateway", "超时", "慢"])


def _demo_timeout_diagnosis(message: str, session_id: str, problem: str, resolved_app) -> ChatResponse:
    slow_logs = query_mysql_slow_log.entrypoint(
        ["order_db"],
        "Query_time > 3",
        "2026-05-28 10:30:00",
        "2026-05-28 10:35:00",
        "prod",
    )
    answer = """## 问题分析
这是一个 prod 环境接口 504/timeout 场景。504 通常不一定有明确异常栈，排查时不能只查 ERROR 日志，还要关注请求耗时、下游依赖和数据库慢查询。

## 已收集证据
- 用户输入指向 order-service 下单接口耗时或 504。
- 应用解析得到 order-service 对应的准确 appId 和代码库路径。
- 慢查询日志平台中，order_db 在故障窗口内出现多条慢 SQL。
- 最慢 SQL Query_time 达到 5.83s，Rows_examined 超过 180 万。
- SQL 访问 order_item 表，并按 created_at 排序，疑似缺少合适索引或过滤条件选择性差。

## 根因判断
当前证据更像数据库慢查询导致接口响应时间被拉长，最终在网关层表现为 504。这个场景下，应用日志只能看到超时现象，慢查询日志提供了更直接的性能证据。

## 修复建议
1. 检查 order_item 表在 user_id、created_at 上的联合索引。
2. 对该接口增加分页/时间窗口限制，避免扫描过多历史订单。
3. 在应用日志中补充 db_schema、table、rows_examined、query_time 等字段，便于后续自动关联。
4. 修复后回放同类请求，观察 504 数量和慢查询 Query_time 是否下降。

## 后续验证
继续对比 10:30 前后的网关 504 数、order-service P99 延迟和 order_db 慢查询数量，确认三者是否同向下降。

说明：当前页面在未配置 OPENAI_API_KEY 时使用 demo fallback，慢查询证据来自公开 mock 数据。""".strip()

    return ChatResponse(
        session_id=session_id,
        mode="demo-fallback",
        answer=answer,
        tool_trace=[
            {"name": "analyze_problem", "status": "completed"},
            {"name": "resolve_app", "status": "completed"},
            {"name": "query_logs_by_condition", "status": "completed"},
            {"name": "query_mysql_slow_log", "status": "completed"},
        ],
        evidence=[
            _problem_type_line(problem),
            f"应用解析: {resolved_app.appid if resolved_app else 'order-service'}",
            "504/timeout 场景需要补充慢查询日志证据",
            "慢 SQL: order_db.order_item Query_time=5.83s",
            "Rows_examined: 1842033",
        ],
    )


@app.get("/workbench", include_in_schema=False)
def workbench_page():
    index_file = FRONTEND_DIR / "index.html"
    if not index_file.exists():
        raise HTTPException(status_code=404, detail="Workbench frontend not found")
    return FileResponse(index_file)


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    session_id = request.session_id or f"web-{uuid4().hex}"
    if not config.openai_api_key:
        return _demo_diagnosis(request.message, session_id)

    try:
        run_output = await agent.arun(request.message, session_id=session_id)
    except Exception as exc:
        fallback = _demo_diagnosis(request.message, session_id)
        fallback.mode = "demo-fallback-after-agent-error"
        fallback.evidence.append(f"Agent 调用失败，已切换 demo fallback: {exc.__class__.__name__}")
        return fallback

    return ChatResponse(
        session_id=session_id,
        mode="agent",
        answer=_extract_run_content(run_output),
    )


if FRONTEND_DIR.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR), name="v2-workbench-assets")


if __name__ == "__main__":
    agent_os.serve(
        app="main:app",
        host=config.agent_host,
        port=config.agent_port,
        reload=config.agent_reload,
    )
