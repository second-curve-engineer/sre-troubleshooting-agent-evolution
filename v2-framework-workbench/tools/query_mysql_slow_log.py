from __future__ import annotations

import json

from agno.tools import tool

from tools._log_helpers import MYSQL_SLOW_LOG_FILE, compact_slow_log_response, load_json


@tool
def query_mysql_slow_log(
    db_names: list[str],
    query: str,
    from_time: str,
    to_time: str,
    env: str = "prod",
) -> str:
    """Query MySQL slow query logs from the dedicated slow-log platform.

    Use this for timeout or 504 scenarios when application logs suggest slow
    downstream dependency, SQL timeout, connection pool exhaustion, or long
    request latency. This is not a business DB query; it queries slow-query logs
    from a dedicated log app such as ops.akso.akso-slow-log.

    Query examples:
    - Query_time > 3
    - log.msg~'order_item'
    - rows_examined > 100000

    Args:
        db_names: Database/schema names to filter, for example ["order_db"].
        query: Slow-log filter condition.
        from_time: Start time string.
        to_time: End time string.
        env: Runtime environment.

    Returns:
        Compact JSON string with matched schemas, max query time, and slow SQL samples.
    """
    # TODO(v3): record slow-log query as trace evidence and correlate it with app latency.
    if not db_names:
        return json.dumps(
            {
                "status": "error",
                "error": "db_names 不能为空。需要先从应用日志或代码逻辑中确认数据库名。",
            },
            ensure_ascii=False,
            indent=2,
        )

    data = load_json(MYSQL_SLOW_LOG_FILE)
    db_names_str = "', '".join(db_names)
    final_query = f"schema in ('{db_names_str}') AND ({query})" if query.strip() else f"schema in ('{db_names_str}')"
    logs = []
    for db_name in db_names:
        logs.extend(data.get(db_name, {}).get("result", {}).get("data", {}).get("logs", []))

    payload = {
        "status": "success",
        "query_info": {
            "app_id": "ops.akso.akso-slow-log",
            "env": env,
            "db_names": db_names,
            "query": final_query,
            "from_time": from_time,
            "to_time": to_time,
            "mock_note": "公开版使用 mock 慢查询日志，真实环境中这里会查询专门的 MySQL 慢日志平台。",
        },
        "result": {"data": {"logs": logs}},
    }
    return compact_slow_log_response(payload)
