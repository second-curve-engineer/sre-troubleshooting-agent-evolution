from __future__ import annotations

from agno.tools import tool

from tools._log_helpers import TRACE_LOG_FILE, compact_log_response, load_json


@tool
def query_logs_by_trace_id(trace_id: str, env: str = "prod") -> str:
    """Query full cross-service logs for a distributed trace id.

    This tool first discovers apps involved in the trace, then returns compact
    cross-service logs in chronological order. The public version uses mock data
    but keeps the same return schema as an internal log platform call.

    Args:
        trace_id: Distributed trace id, for example demo-trace-001.
        env: Runtime environment.

    Returns:
        Compact JSON string with involved apps, error logs, and sample logs.
    """
    # TODO(v3): record tool input/output/duration for trace replay.
    data = load_json(TRACE_LOG_FILE)
    payload = data.get(
        trace_id,
        {
            "status": "success",
            "query_info": {"trace_id": trace_id, "env": env},
            "result": {"data": {"apps": [], "logs": []}},
        },
    )
    payload["query_info"] = {
        **payload.get("query_info", {}),
        "trace_id": trace_id,
        "env": env,
        "mock_note": "公开版使用 mock 日志，真实环境中这里会先查 trace 涉及服务，再拉完整链路日志。",
    }
    return compact_log_response(payload)
