// Trace 诊断 workflow：适用于已知 trace_id 的 500/异常链路排查。
import { WorkflowDefinition, WorkflowContext } from "./types.js";
import { askCodeIfPossible } from "./shared.js";

type ErrorEvidence = {
  stackTrace?: string;
  errorAppId?: string;
};

/**
 * 从日志工具返回的 data 中提取第一个有异常栈的 exception.stack 和 app_id。
 * queryLogsByTraceId 返回结构：{ logs: LogItem[], errors: LogItem[] }
 */
function extractErrorEvidence(data: unknown): ErrorEvidence {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;

  // 优先从 errors 数组（已过滤出 ERROR 级别日志）中查找
  const candidates = Array.isArray(d.errors) ? d.errors : Array.isArray(d.logs) ? d.logs : [];
  for (const log of candidates) {
    if (log && typeof log === "object") {
      const entry = log as Record<string, unknown>;
      const stack = entry["exception.stack"];
      if (typeof stack === "string" && stack.trim().length > 0) {
        return {
          stackTrace: stack.trim(),
          errorAppId: typeof entry.app_id === "string" ? entry.app_id : undefined
        };
      }
    }
  }
  return {};
}

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

  // 从日志结果中提取异常栈和首个报错 app，传给 askCodeIfPossible 走真实文件分析路径
  // errorAppId 可能与 context.state.app（用户描述的入口服务）不同，
  // 例如用户说 order-service 下单失败，但首个异常实际在 inventory-service。
  const { stackTrace, errorAppId } = extractErrorEvidence(traceResult.data);
  await askCodeIfPossible(context, stackTrace, errorAppId);
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
