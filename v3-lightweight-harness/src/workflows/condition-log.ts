// 条件日志 workflow：适用于有报错现象但缺少 trace_id 的接口故障。
// 支持从告警消息中提取接口名、错误码、时间窗口，动态构造查询条件。
import { WorkflowDefinition, WorkflowContext } from "./types.js";
import { resolveTimeRange } from "../harness/router.js";
import { runTraceDiagnosis } from "./trace-diagnosis.js";

/** 根据 decision 里提取到的信息动态构造日志查询条件 */
function buildLogQuery(decision: WorkflowContext["state"]["decision"]): string {
  const parts = ["log.level = 'ERROR'"];
  if (decision?.errorCodeHint) {
    // 业务错误码（ERR_xxx）用 error_code 字段；HTTP 状态码用 http.status_code
    if (/^\d{3}$/.test(decision.errorCodeHint)) {
      parts.push(`http.status_code = '${decision.errorCodeHint}'`);
    } else {
      parts.push(`error_code = '${decision.errorCodeHint}'`);
    }
  } else {
    parts.push("http.status_code = '500'");
  }
  if (decision?.interfaceHint) {
    parts.push(`http.path = '${decision.interfaceHint}'`);
  }
  return `SELECT * WHERE ${parts.join(" and ")}`;
}

export async function runConditionLogDiagnosis(context: WorkflowContext): Promise<void> {
  const appId = context.state.app?.appId ?? "order-service";
  const decision = context.state.decision;

  // 动态构造查询条件：从告警消息提取的接口名、错误码优先；降级为通用条件
  const query = buildLogQuery(decision);
  // 动态计算时间窗口：告警消息里有"最近 N 分钟"则用 N，否则默认最近 10 分钟
  const { fromTime, toTime } = resolveTimeRange(decision?.timeWindowMin);

  const logResult = await context.invokeTool(
    context.state,
    "step-condition-log",
    "query_logs_by_condition",
    { appId, query, fromTime, toTime, env: "prod" },
    ["query_logs_by_condition"]
  );

  const logSummary = await context.evidenceSummarizer.summarize({
    toolName: "query_logs_by_condition",
    appId,
    query,
    toolResult: logResult
  });
  context.evidence.add({
    source: "query_logs_by_condition",
    kind: "log",
    summary: `[${appId}] ${logSummary}`,
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
