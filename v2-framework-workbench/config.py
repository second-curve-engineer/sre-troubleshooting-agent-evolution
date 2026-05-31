from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from app_registry import AppRegistry, parse_app_mappings, parse_app_mappings_with_error


ROOT_DIR = Path(__file__).resolve().parent


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass(frozen=True)
class Config:
    openai_api_key: str
    openai_base_url: str
    openai_model: str
    agent_host: str
    agent_port: int
    agent_reload: bool
    agent_debug: bool
    log_query_mode: str
    enable_claude_code: bool
    codebases: dict[str, str]
    codebase_path: str
    app_codebase_mapping: str
    app_mappings: list[dict]
    app_registry: AppRegistry
    app_mappings_error: str = ""

    @classmethod
    def from_env(cls) -> "Config":
        load_dotenv(ROOT_DIR / ".env")
        codebase_path = os.getenv("CODEBASE_PATH", "")
        app_codebase_mapping = os.getenv("APP_CODEBASE_MAPPING", "")
        app_mappings, app_mappings_error = parse_app_mappings_with_error(os.getenv("APP_MAPPINGS", "[]"))
        codebases = {
            "order-service": os.getenv("CODEBASE_ORDER_SERVICE", "/path/to/order-service"),
            "inventory-service": os.getenv("CODEBASE_INVENTORY_SERVICE", "/path/to/inventory-service"),
            "payment-service": os.getenv("CODEBASE_PAYMENT_SERVICE", "/path/to/payment-service"),
        }
        app_registry = AppRegistry.from_config(
            codebase_path=codebase_path,
            app_codebase_mapping=app_codebase_mapping,
            app_mappings=app_mappings,
            fallback_codebases=codebases,
        )
        codebases = {**codebases, **app_registry.codebase_aliases()}
        return cls(
            openai_api_key=os.getenv("OPENAI_API_KEY", ""),
            openai_base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            openai_model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            agent_host=os.getenv("AGENT_HOST", "0.0.0.0"),
            agent_port=int(os.getenv("AGENT_PORT", "7777")),
            agent_reload=_bool_env("AGENT_RELOAD", True),
            agent_debug=_bool_env("AGENT_DEBUG", False),
            log_query_mode=os.getenv("LOG_QUERY_MODE", "mock"),
            enable_claude_code=_bool_env("ENABLE_CLAUDE_CODE", False),
            codebases=codebases,
            codebase_path=codebase_path,
            app_codebase_mapping=app_codebase_mapping,
            app_mappings=app_mappings,
            app_registry=app_registry,
            app_mappings_error=app_mappings_error,
        )

    def get_llm_model(self):
        from agno.models.openai import OpenAIChat

        kwargs = {"id": self.openai_model}
        if self.openai_api_key:
            kwargs["api_key"] = self.openai_api_key
        if self.openai_base_url:
            kwargs["base_url"] = self.openai_base_url
        return OpenAIChat(**kwargs)

    def validate(self) -> "ConfigValidation":
        warnings: list[str] = []
        errors: list[str] = []

        if not self.openai_api_key:
            warnings.append("OPENAI_API_KEY 未配置，当前只能使用 demo fallback，不会调用真实 Agent。")
        if not self.openai_base_url:
            errors.append("OPENAI_BASE_URL 不能为空。")
        if not self.openai_model:
            errors.append("OPENAI_MODEL 不能为空。")

        if self.agent_port < 1 or self.agent_port > 65535:
            errors.append("AGENT_PORT 必须在 1-65535 之间。")

        if self.app_mappings_error:
            warnings.append(f"APP_MAPPINGS JSON 解析失败，应用 appname/realname 映射会失效: {self.app_mappings_error}")
        if not self.app_registry.apps:
            warnings.append("未解析到任何应用映射，resolve_app 将只能依赖用户提供准确 appId 或代码库 key。")
        if self.app_codebase_mapping and not any(app.codebase_path for app in self.app_registry.apps):
            warnings.append("APP_CODEBASE_MAPPING 已配置但没有解析出代码库路径，请检查 Markdown 表格格式。")

        if self.enable_claude_code:
            if shutil.which("claude") is None:
                errors.append("ENABLE_CLAUDE_CODE=true，但未找到 claude CLI。")
            placeholder_paths = [
                path for path in self.codebases.values() if path.startswith("/path/to/")
            ]
            if placeholder_paths:
                errors.append("ENABLE_CLAUDE_CODE=true，但仍存在占位代码库路径，请配置真实 CODEBASE_PATH 或 CODEBASE_*。")

        return ConfigValidation(warnings=warnings, errors=errors)


@dataclass(frozen=True)
class ConfigValidation:
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def format(self) -> str:
        lines = []
        for warning in self.warnings:
            lines.append(f"[WARN] {warning}")
        for error in self.errors:
            lines.append(f"[ERROR] {error}")
        return "\n".join(lines)
