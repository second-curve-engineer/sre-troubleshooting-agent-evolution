from __future__ import annotations

from agno.tools import tool

from tools._log_helpers import TIME_LOG_FILE, compact_log_response, ensure_env_filter, load_json


@tool
def query_logs_by_condition(
    app_id: str,
    query: str,
    from_time: str,
    to_time: str,
    env: str = "prod",
) -> str:
    """Query logs for a service using flexible SQL-like filter conditions.

    Use this when there is no trace_id yet, but the user provides a service and
    some filtering context. The condition can be error level, api path, error
    code, exception type, log keyword, status code, or any combination of them
    within a time window.

    Common log fields:
    - host.deploy_env: runtime environment, e.g. prod or staging.
    - log.level:       log level — ERROR, WARN, INFO.
    - log.trace_id:    distributed tracing id (use query_logs_by_trace_id for full chain).
    - http.path:       request path, e.g. /api/orders/create.
    - http.status_code: HTTP response status code.
    - log.msg:         log message body (use ~ for substring match).
    - exception.type:  exception class name.
    - exception.message: exception message.
    - exception.stack: stack trace.

    Query syntax examples:
    - SELECT * WHERE log.level = 'ERROR'
    - SELECT * WHERE exception.type = 'java.lang.NullPointerException'
    - SELECT * WHERE log.level = 'ERROR' and http.path ~ '/api/orders'
    - SELECT * WHERE log.level = 'ERROR' and http.path ~ '/api/orders' and log.msg ~ 'ERR_10086'
    - SELECT * WHERE log.level = 'ERROR' and http.status_code = '500'

    Error-code alert scenario (monitoring alert → diagnosis):
    When a monitoring alert fires with a known service, api_path, error_code, and time window:
      1. Call this tool with a combined filter, e.g.:
         query = "SELECT * WHERE log.level = 'ERROR' and http.path ~ '/api/orders' and log.msg ~ 'ERR_10086'"
      2. Extract log.trace_id values from the returned logs.
      3. Call query_logs_by_trace_id with the most recent trace_id to get full chain logs.
    This two-step approach converts monitoring alert context into a complete chain diagnosis.

    Args:
        app_id:    Service id, e.g. order-service. Use resolve_app first if only a nickname is known.
        query:     SQL-like filter expression. Env filter is appended automatically if missing.
        from_time: Query start time string, e.g. "2024-01-15 10:30:00" or "10:30".
        to_time:   Query end time string, e.g. "2024-01-15 11:00:00" or "11:00".
        env:       Runtime environment, default prod.

    Returns:
        Compact JSON string with query_info, trace_ids found, and matched error log entries.
    """
    # TODO(v3): record tool input/output/duration for trace replay.
    rewritten_query = ensure_env_filter(query, env)
    data = load_json(TIME_LOG_FILE)
    payload = data.get(
        app_id,
        {
            "status": "success",
            "query_info": {
                "app_id": app_id,
                "env": env,
                "query": rewritten_query,
                "from_time": from_time,
                "to_time": to_time,
            },
            "result": {"data": {"logs": []}},
        },
    )
    payload["query_info"] = {
        **payload.get("query_info", {}),
        "app_id": app_id,
        "env": env,
        "query": rewritten_query,
        "from_time": from_time,
        "to_time": to_time,
        "mock_note": "公开版使用 mock 日志，真实环境中这里会调用内部日志平台 HTTP API。",
    }
    return compact_log_response(payload)
