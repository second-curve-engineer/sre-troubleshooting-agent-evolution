from __future__ import annotations

from agno.agent import Agent
from agno.db.sqlite import SqliteDb

from config import Config, ROOT_DIR
from tools import (
    build_analyze_problem_tool,
    build_ask_codebase_tool,
    build_resolve_app_tool,
    query_logs_by_condition,
    query_logs_by_trace_id,
    query_mysql_slow_log,
    string_to_timestamp,
)


def build_instructions() -> str:
    return """
# 角色
你是一个专业的线上故障排查助手，只处理线上故障排查问题。

# 目标
基于用户描述、日志、trace、异常栈和代码证据，输出可执行的根因判断和修复建议。

# 排查 Workflow
1. 先调用 analyze_problem 判断故障类型。
2. 如果用户提到服务、系统简称、appname、realname 或 appId，调用 resolve_app 解析准确 appId 和代码库路径；如果只有 trace_id，可以先查 trace。
3. 如果关键信息不足以开始排查，先追问用户补充服务、trace_id、时间窗口或错误现象；如果需要把明确时间转成 timestamp，可调用 string_to_timestamp。
4. 日志入口选择：
   - 有 trace_id：调用 query_logs_by_trace_id 获取完整链路日志。
   - 没有 trace_id，但有服务、时间窗口、接口路径、错误码、异常类型或日志关键词：调用 query_logs_by_condition 过滤日志。
   - query_logs_by_condition 查到 trace_id 后，再调用 query_logs_by_trace_id 补全链路。
5. 接口报错主线：基于日志定位首次报错服务、异常信息和异常栈；拿到异常栈或明确方法后，调用 ask_codebase 定位代码根因。
6. 性能问题主线：先调用 query_logs_by_condition 查询应用日志和耗时线索；只有线索指向 SQL timeout、连接池耗尽、数据库慢、慢查询告警或 MySQL 读写路径时，才调用 query_mysql_slow_log。
7. 最终结论必须基于已收集证据，不要编造日志、代码或内部平台结果。

# 输出格式
## 问题分析
## 已收集证据
## 根因判断
## 修复建议
## 后续验证

# 边界
- 只处理接口报错、性能问题和需要补充上下文的线上故障排查。
- 不执行生产变更、修复动作或高风险数据查询，只给排查结论和建议。
- 工具的参数、过滤语法和返回字段以工具自身说明为准。
""".strip()


def build_troubleshooting_agent(config: Config | None = None) -> Agent:
    config = config or Config.from_env()
    db_file = ROOT_DIR / "tmp" / "agent.db"
    db_file.parent.mkdir(parents=True, exist_ok=True)

    analyze_problem = build_analyze_problem_tool(config)  # config 注入，避免工具内部重复 load .env
    ask_codebase = build_ask_codebase_tool(
        codebases=config.codebases,
        enable_claude_code=config.enable_claude_code,
    )
    resolve_app = build_resolve_app_tool(config.app_registry)

    return Agent(
        id="troubleshooting_agent",
        name="故障排查专家",
        description="只做线上故障排查的 agno tool-using Agent。",
        model=config.get_llm_model(),
        db=SqliteDb(db_file=str(db_file)),
        tools=[
            analyze_problem,
            ask_codebase,
            resolve_app,
            query_logs_by_condition,
            query_logs_by_trace_id,
            query_mysql_slow_log,
            string_to_timestamp,
        ],
        instructions=build_instructions(),
        add_history_to_context=True,
        num_history_runs=5,
        add_datetime_to_context=True,
        markdown=True,
        debug_mode=config.agent_debug,
    )
