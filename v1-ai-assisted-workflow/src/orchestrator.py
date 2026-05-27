from agents import trace_log_query_agent, stack_trace_analyze_agent, code_locator_agent, root_cause_analysis_agent, solution_suggest_agent

# 已废弃，agent 调度在 app.py 中实现
def run_diagnosis(trace_id: str):
    step1 = trace_log_query_agent.run({"trace_id": trace_id})
    step2 = stack_trace_analyze_agent.run(step1)
    step3 = code_locator_agent.run(step2)
    step4 = root_cause_analysis_agent.run({"logs": step1["logs"], "stack": step2["stack"], "code": step3["code"]})
    step5 = solution_suggest_agent.run({"root_cause": step4["root_cause"], **step3})

    return {
        "trace_id": trace_id,
        "logs": step1["logs"],
        "stack": step2["stack"],
        "code": step3["code"],
        "root_cause": step4["root_cause"],
        "suggestion": step5["suggestion"]
    }