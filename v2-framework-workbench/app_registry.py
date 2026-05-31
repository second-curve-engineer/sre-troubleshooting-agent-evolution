from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class AppInfo:
    appid: str
    system_name: str = ""
    appname: str = ""
    realname: str = ""
    codebase_path: str = ""
    aliases: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "appid": self.appid,
            "system_name": self.system_name,
            "appname": self.appname,
            "realname": self.realname,
            "codebase_path": self.codebase_path,
            "aliases": list(self.aliases),
        }


class AppRegistry:
    def __init__(self, apps: list[AppInfo]):
        self.apps = apps
        self._index: dict[str, AppInfo] = {}
        for app in apps:
            for alias in self._aliases_for(app):
                self._index.setdefault(_normalize(alias), app)

    @classmethod
    def from_config(
        cls,
        *,
        codebase_path: str = "",
        app_codebase_mapping: str = "",
        app_mappings: list[dict[str, Any]] | None = None,
        fallback_codebases: dict[str, str] | None = None,
    ) -> "AppRegistry":
        records: dict[str, dict[str, Any]] = {}
        for item in _parse_app_codebase_mapping(app_codebase_mapping, codebase_path):
            records.setdefault(item["appid"], {}).update(item)

        for item in app_mappings or []:
            appid = item.get("appid") or item.get("appId")
            if not appid:
                continue
            records.setdefault(appid, {}).update(
                {
                    "appid": appid,
                    "appname": item.get("appname", ""),
                    "realname": item.get("realname", ""),
                }
            )

        for key, path in (fallback_codebases or {}).items():
            records.setdefault(
                key,
                {
                    "appid": key,
                    "system_name": key,
                    "appname": key,
                    "realname": key,
                    "codebase_path": path,
                },
            )

        apps = []
        for record in records.values():
            aliases = _dedupe(
                [
                    record.get("appid", ""),
                    record.get("system_name", ""),
                    record.get("appname", ""),
                    record.get("realname", ""),
                    Path(record.get("codebase_path", "")).name,
                ]
            )
            apps.append(
                AppInfo(
                    appid=record.get("appid", ""),
                    system_name=record.get("system_name", ""),
                    appname=record.get("appname", ""),
                    realname=record.get("realname", ""),
                    codebase_path=record.get("codebase_path", ""),
                    aliases=tuple(aliases),
                )
            )

        return cls(sorted(apps, key=lambda app: app.appid))

    def resolve(self, query: str) -> AppInfo | None:
        normalized = _normalize(query)
        if not normalized:
            return None
        if normalized in self._index:
            return self._index[normalized]

        candidates = []
        for key, app in self._index.items():
            if normalized in key or key in normalized:
                candidates.append(app)
        if not candidates:
            return None
        return sorted(set(candidates), key=lambda app: len(app.appid))[0]

    def to_prompt_table(self, max_rows: int = 20) -> str:
        if not self.apps:
            return "未配置应用映射。"
        rows = ["| appId | 系统/昵称 | appname | realname | 代码库 |", "| --- | --- | --- | --- | --- |"]
        for app in self.apps[:max_rows]:
            rows.append(
                f"| {app.appid} | {app.system_name or '-'} | {app.appname or '-'} | {app.realname or '-'} | {app.codebase_path or '-'} |"
            )
        if len(self.apps) > max_rows:
            rows.append(f"| ... | 其余 {len(self.apps) - max_rows} 个应用省略 | ... | ... | ... |")
        return "\n".join(rows)

    def codebase_aliases(self) -> dict[str, str]:
        mapping: dict[str, str] = {}
        for app in self.apps:
            if not app.codebase_path:
                continue
            for alias in self._aliases_for(app):
                mapping.setdefault(alias, app.codebase_path)
        return mapping

    def _aliases_for(self, app: AppInfo) -> list[str]:
        return _dedupe([app.appid, app.system_name, app.appname, app.realname, *app.aliases])


def parse_app_mappings(raw: str) -> list[dict[str, Any]]:
    parsed, _ = parse_app_mappings_with_error(raw)
    return parsed


def parse_app_mappings_with_error(raw: str) -> tuple[list[dict[str, Any]], str]:
    if not raw.strip():
        return [], ""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        return [], str(exc)
    if not isinstance(parsed, list):
        return [], "APP_MAPPINGS must be a JSON array"
    return parsed, ""


def _parse_app_codebase_mapping(raw: str, codebase_path: str) -> list[dict[str, str]]:
    rows = []
    expanded = raw.replace("${CODEBASE_PATH}", codebase_path).replace("$CODEBASE_PATH", codebase_path)
    for line in expanded.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or "---" in stripped or "appId" in stripped:
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) < 3:
            continue
        appid, system_name, codebase = cells[:3]
        if not appid or not codebase:
            continue
        rows.append(
            {
                "appid": appid,
                "system_name": system_name,
                "codebase_path": os.path.expandvars(codebase),
            }
        )
    return rows


def _normalize(value: str) -> str:
    return value.strip().lower().replace(" ", "").replace("_", "-")


def _dedupe(values: list[str]) -> list[str]:
    result = []
    seen = set()
    for value in values:
        cleaned = value.strip()
        if not cleaned:
            continue
        key = _normalize(cleaned)
        if key in seen:
            continue
        seen.add(key)
        result.append(cleaned)
    return result
