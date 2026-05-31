from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
TRACE_LOG_FILE = ROOT_DIR / "mock_data" / "logs_by_trace_id.json"
TIME_LOG_FILE = ROOT_DIR / "mock_data" / "logs_by_time_range.json"
MYSQL_SLOW_LOG_FILE = ROOT_DIR / "mock_data" / "mysql_slow_logs.json"


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def ensure_env_filter(query: str, env: str) -> str:
    if "host.deploy_env" in query:
        return query
    if "where" in query.lower():
        return f"{query} AND host.deploy_env = '{env}'"
    return f"{query} WHERE host.deploy_env = '{env}'"


def compact_log_response(payload: dict[str, Any]) -> str:
    logs = payload.get("result", {}).get("data", {}).get("logs", [])
    summary = {
        "status": payload.get("status"),
        "query_info": payload.get("query_info", {}),
        "log_count": len(logs),
        "apps": sorted({item.get("app_id", "unknown") for item in logs}),
        "trace_ids": sorted({item.get("log.trace_id", "unknown") for item in logs if item.get("log.trace_id")}),
        "errors": [
            {
                "timestamp": item.get("timestamp"),
                "app_id": item.get("app_id"),
                "level": item.get("log.level"),
                "path": item.get("http.path"),
                "exception_type": item.get("exception.type"),
                "exception_message": item.get("exception.message"),
                "stack": item.get("exception.stack"),
                "message": item.get("message"),
            }
            for item in logs
            if item.get("log.level") == "ERROR" or item.get("exception.type")
        ],
        "sample_logs": logs[:5],
    }
    return json.dumps(summary, ensure_ascii=False, indent=2)


def compact_slow_log_response(payload: dict[str, Any]) -> str:
    logs = payload.get("result", {}).get("data", {}).get("logs", [])
    summary = {
        "status": payload.get("status"),
        "query_info": payload.get("query_info", {}),
        "log_count": len(logs),
        "schemas": sorted({item.get("schema", "unknown") for item in logs}),
        "max_query_time": max([item.get("query_time", 0) for item in logs], default=0),
        "slow_queries": [
            {
                "timestamp": item.get("timestamp"),
                "schema": item.get("schema"),
                "host": item.get("host"),
                "query_time": item.get("query_time"),
                "lock_time": item.get("lock_time"),
                "rows_examined": item.get("rows_examined"),
                "rows_sent": item.get("rows_sent"),
                "sql": item.get("sql"),
                "message": item.get("message"),
            }
            for item in logs[:10]
        ],
    }
    return json.dumps(summary, ensure_ascii=False, indent=2)
