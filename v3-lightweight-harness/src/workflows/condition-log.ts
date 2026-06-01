// 条件日志 workflow：适用于有报错现象但缺少 trace_id 的接口故障。
import { WorkflowDefinition, WorkflowContext } from "./types.js";
import { runTraceDiagnosis } from "./trace-diagnosis.js";

export async function runConditionLogDiagnosis(context: WorkflowContext): Promise<void> {
  const appId = context.state.app?.appId ?? "order-service";
  const logResult = await context.invokeTool(
    context.state,
    "step-condition-log",
    "query_logs_by_condition",
    {
      appId,
      query: "SELECT * WHERE log.level = 'ERROR' and http.status_code = '500'",
      fromTime: "2026-05-28 10:30:00",
      toTime: "2026-05-28 10:35:00",
      env: "prod"
    },
    ["query_logs_by_condition"]
  );

  context.evidence.add({
    source: "query_logs_by_condition",
    kind: "log",
    summary: `${appId} 条件日志查询: ${logResult.summary}`,
    confidence: logResult.status === "ok" ? "high" : "medium",
    usedInFinalReport: true
  });

  const traceIds = ((logResult.outputSummary ?? {}).traceIds as string[] | undefined) ?? [];
  if (traceIds.length > 0) {
    context.state.decision = { ...context.state.decision!, traceId: traceIds[0] };
    await runTraceDiagnosis(context);
  }
}

export const conditionLogWorkflow: WorkflowDefinition = {
  route: "condition-log",
  description: "没有 trace_id 时，先按条件查日志，命中 trace 后复用 trace 诊断。",
  steps: [
    {
      stepId: "step-resolve-app",
      description: "解析服务名和代码库信息。",
      allowedTools: ["resolve_app"]
    },
    {
      stepId: "step-condition-log",
      description: "按错误码和时间窗口反查日志。",
      allowedTools: ["query_logs_by_condition"]
    },
    {
      stepId: "step-trace",
      description: "反查到 trace_id 后查询完整链路。",
      allowedTools: ["query_logs_by_trace_id"]
    },
    {
      stepId: "step-code",
      description: "根据异常栈询问代码库。",
      allowedTools: ["ask_codebase"]
    }
  ],
  execute: runConditionLogDiagnosis
};
