// Trace 诊断 workflow：适用于已知 trace_id 的 500/异常链路排查。
import { WorkflowDefinition, WorkflowContext } from "./types.js";
import { askCodeIfPossible } from "./shared.js";

export async function runTraceDiagnosis(context: WorkflowContext): Promise<void> {
  const traceId = context.state.decision?.traceId ?? "demo-trace-001";
  const traceResult = await context.invokeTool(
    context.state,
    "step-trace",
    "query_logs_by_trace_id",
    {
      traceId,
      env: "prod"
    },
    ["query_logs_by_trace_id"]
  );

  const traceSummary = await context.evidenceSummarizer.summarize({
    toolName: "query_logs_by_trace_id",
    toolResult: traceResult
  });
  context.evidence.add({
    source: "query_logs_by_trace_id",
    kind: "trace",
    summary: `[trace ${traceId}] ${traceSummary}`,
    confidence: traceResult.status === "ok" ? "high" : "low",
    rawRef: traceId,
    usedInFinalReport: true
  });

  await askCodeIfPossible(context);
}

export const traceDiagnosisWorkflow: WorkflowDefinition = {
  route: "trace-diagnosis",
  description: "已知 trace_id 时，先查链路日志，再按异常栈定位代码。",
  steps: [
    {
      stepId: "step-resolve-app",
      description: "解析服务名和代码库信息。",
      allowedTools: ["resolve_app"]
    },
    {
      stepId: "step-trace",
      description: "按 trace_id 查询完整链路日志。",
      allowedTools: ["query_logs_by_trace_id"]
    },
    {
      stepId: "step-code",
      description: "根据异常栈询问代码库。",
      allowedTools: ["ask_codebase"]
    }
  ],
  execute: runTraceDiagnosis
};
