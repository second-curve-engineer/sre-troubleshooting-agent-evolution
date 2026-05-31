from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from agno.tools import tool


@tool
def string_to_timestamp(time_str: str) -> str:
    """Convert a human-readable time string to a Unix timestamp in Asia/Shanghai.

    Supported examples:
    - 2026-05-28 10:30:00
    - 2026-05-28T10:30:00+08:00

    Args:
        time_str: Time string.

    Returns:
        Unix timestamp as a string, or an error message if parsing fails.
    """
    raw = time_str.strip()
    formats = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"]
    for fmt in formats:
        try:
            dt = datetime.strptime(raw, fmt).replace(tzinfo=ZoneInfo("Asia/Shanghai"))
            return str(int(dt.timestamp()))
        except ValueError:
            pass

    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=ZoneInfo("Asia/Shanghai"))
        return str(int(dt.timestamp()))
    except ValueError:
        return f"无法解析时间: {time_str}"
