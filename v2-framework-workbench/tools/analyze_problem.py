from __future__ import annotations

import json

from agno.models.message import Message
from agno.tools import tool

from config import Config


CLASSIFIER_SCHEMA_PROMPT = """
你是线上故障排查助手的前置问题分类器。
你的任务是判断用户自然语言故障描述的故障类型。

只根据用户输入分类，不要编造日志、代码、平台结果或根因。

必须只输出一个 JSON object，字段和含义如下：
- incident_type: string。故障大类。只能取以下值之一：
  "接口报错", "性能问题", "未知，需要更多上下文"。

分类边界：
- 接口报错：HTTP 5xx、exception、NPE、服务直接抛错。例："下单接口大量 500"、"出现 NullPointerException"。
- 性能问题：接口级 504、timeout、接口耗时高、P99 飙高、SQL/MySQL 慢查询。例："下单接口 504"、"P99 突然飙高"、"SQL 慢查询告警"。
  注意：分类为 "性能问题" 不代表一定是 MySQL 问题，也不代表一定要查询 MySQL 慢日志。MySQL 慢查询只是性能问题中的一种可能线索；后续是否调用 query_mysql_slow_log，由主 Agent 根据用户描述和日志证据判断。
- 未知，需要更多上下文：不符合上面两类、信息不足，或需要更多业务/依赖/运行时上下文才能判断。

示例：
用户输入: "prod 环境 order-service 下单接口从 10:30 开始大量 504，帮我排查"
输出:
{
  "incident_type": "性能问题"
}
""".strip()


def _normalize_incident_type(value) -> str:
    allowed_incident_types = {
        "接口报错",
        "性能问题",
        "未知，需要更多上下文",
    }
    incident_type = str(value or "").strip()
    if incident_type not in allowed_incident_types:
        return "未知，需要更多上下文"
    return incident_type

def _heuristic_problem_analysis(description: str, analysis_source: str = "heuristic") -> str:
    lower_text = description.strip().lower()

    # 明确依赖/运行时/网关性能子类不作为 V2 正式分类，留到 V3 router。
    if any(word in lower_text for word in ["redis", "kafka", "mq", "rpc", "jvm", "gc", "线程池", "网关耗时", "下游", "依赖"]):
        incident_type = "未知，需要更多上下文"
    # 性能问题只表示 V2 可演示的接口级性能现象，不代表一定要查询 MySQL 慢日志。
    elif any(word in lower_text for word in ["timeout", "slow", "latency", "504", "耗时", "超时", "慢"]):
        incident_type = "性能问题"
    # 接口报错：5xx/exception/NPE
    elif any(word in lower_text for word in ["500", "exception", "error", "报错", "异常", "失败", "npe", "nullpointer"]):
        incident_type = "接口报错"
    else:
        incident_type = "未知，需要更多上下文"

    return "\n".join(
        [
            f"分析来源: {analysis_source}",
            f"故障类型: {incident_type}",
        ]
    )

def _format_llm_problem_analysis(payload: dict) -> str:
    incident_type = _normalize_incident_type(payload.get("incident_type"))
    return "\n".join(
        [
            "分析来源: llm",
            f"故障类型: {incident_type}",
        ]
    )

def _extract_model_response_content(response) -> str:
    content = getattr(response, "content", None)
    if content is None:
        return str(response)
    if isinstance(content, str):
        return content
    return str(content)


def _llm_problem_analysis(description: str, config: "Config") -> str | None:
    """使用 LLM 做分类，config 由调用方注入，避免重复 load .env。"""
    if not config.openai_api_key:
        return None

    model = config.get_llm_model()
    response = model.response(
        messages=[
            Message(role="system", content=CLASSIFIER_SCHEMA_PROMPT),
            Message(role="user", content=description),
        ],
        response_format={"type": "json_object"},
    )
    content = _extract_model_response_content(response) or "{}"
    return _format_llm_problem_analysis(json.loads(content))


def build_analyze_problem_tool(config: "Config"):
    """工厂函数：把 config 注入 analyze_problem，避免工具内部重复 load .env。

    用法：
        analyze_problem = build_analyze_problem_tool(config)
        agent = Agent(tools=[analyze_problem, ...])
    """
    @tool
    def analyze_problem(description: str) -> str:
        """Classify a production incident description.

        Args:
            description: User-provided incident description.

        Returns:
            A short text summary with the incident type.
        """
        try:
            llm_result = _llm_problem_analysis(description, config)
            if llm_result:
                return llm_result
        except Exception as exc:
            return _heuristic_problem_analysis(
                description,
                analysis_source=f"heuristic(llm_failed:{exc.__class__.__name__})",
            )
        return _heuristic_problem_analysis(description)

    return analyze_problem
