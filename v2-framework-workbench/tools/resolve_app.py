from __future__ import annotations

import json

from agno.tools import tool

from app_registry import AppRegistry


def build_resolve_app_tool(app_registry: AppRegistry):
    @tool
    def resolve_app(app_hint: str) -> str:
        """Resolve a user-provided system nickname, appname, realname, or appId.

        Use this before querying logs or code when the user only mentions a
        system name such as "广告创建", a repo name such as "ad-platform", or a
        nickname rather than the precise internal appId.

        Args:
            app_hint: User-provided app/system hint.

        Returns:
            JSON string with appid, appname, realname, system_name and codebase_path.
        """
        app = app_registry.resolve(app_hint)
        if app is None:
            return json.dumps(
                {
                    "status": "not_found",
                    "query": app_hint,
                    "message": "未找到应用映射。请让用户补充准确 appId、appname 或系统名称。",
                },
                ensure_ascii=False,
                indent=2,
            )
        return json.dumps({"status": "success", **app.to_dict()}, ensure_ascii=False, indent=2)

    return resolve_app
