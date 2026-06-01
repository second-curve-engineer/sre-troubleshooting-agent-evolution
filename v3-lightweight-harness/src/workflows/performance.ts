// 性能排查 workflow：适用于 504/timeout/慢请求，并包含工具反馈驱动的自我纠偏。
import { ToolResult } from "../schemas/tool.js";
import { WorkflowDefinition, WorkflowContext } from "./types.js";

export async function runPerformanceDiagnosis(context: WorkflowContext): Promise<void> {
  const appId = context.state.app?.appId ?? "order-service";
  const simulateLogTimeout = context.state.userMessage.includes("模拟日志平台超时");
  const simulateSlowQueryFailure = context.state.userMessage.includes("模拟慢查询平台失败");
  const simulateSensitiveLog = context.state.userMessage.includes("模拟敏感日志");
  const simulatePromptInjectionLog = context.state.userMessage.includes("模拟日志注入");
  let query = "SELECT * WHERE http.status_code = '504'";
  let retryCount = 0;
  let logResult: ToolResult;

  do {
    logResult = await context.invokeTool(
      context.state,
      `step-performance-log-${retryCount + 1}`,
      "query_logs_by_condition",
      {
        appId,
        query,
        fromTime: "2026-05-28 10:30:00",
        toTime: "2026-05-28 10:35:00",
        env: "prod",
        limit: 5,
        ...(simulateLogTimeout && retryCount === 0 ? { __simulateDelayMs: 100 } : {}),
        ...(simulateSensitiveLog ? { __simulateSensitiveLog: true } : {}),
        ...(simulatePromptInjectionLog ? { __simulatePromptInjectionLog: true } : {})
      },
      ["query_logs_by_condition"]
    );

    context.evidence.add({
      source: "query_logs_by_condition",
      kind: "log",
      summary: `${appId} 性能日志查询第 ${retryCount + 1} 次: ${logResult.summary}${(logResult.outputSummary ?? {}).securityProbe ? `; ${(logResult.outputSummary ?? {}).securityProbe}` : ""}`,
      confidence: logResult.status === "ok" ? "high" : "medium",
      usedInFinalReport: true
    });

    // self-correction policy 决定是否根据工具反馈收窄查询条件。
    if (context.selfCorrectionPolicy.shouldRetry(logResult, retryCount)) {
      query = context.selfCorrectionPolicy.nextConditionQuery(query, logResult);
      retryCount += 1;
    } else {
      break;
    }
  } while (retryCount <= context.selfCorrectionPolicy.maxRetries);

  const shouldQuerySlowLog =
    (logResult.detectedKeywords ?? []).some((keyword) => ["sql", "timeout", "slow query"].includes(keyword.toLowerCase())) ||
    JSON.stringify(logResult.outputSummary).toLowerCase().includes("sql");

  if (!shouldQuerySlowLog) return;

  const slowResult = await context.invokeTool(
    context.state,
    "step-mysql-slow-log",
    "query_mysql_slow_log",
    {
      dbNames: ["order_db"],
      query: "Query_time > 3",
      fromTime: "2026-05-28 10:30:00",
      toTime: "2026-05-28 10:35:00",
      env: "prod",
      ...(simulateSlowQueryFailure ? { __simulateFailure: true } : {})
    },
    ["query_mysql_slow_log"]
  );

  context.evidence.add({
    source: "query_mysql_slow_log",
    kind: "slow_query",
    summary: `${slowResult.summary}; SQL=${String((slowResult.outputSummary ?? {}).sql ?? "unknown")}`,
    confidence: slowResult.status === "ok" ? "high" : "medium",
    usedInFinalReport: true
  });
}

export const performanceWorkflow: WorkflowDefinition = {
  route: "performance",
  description: "504/timeout 先查应用日志，必要时自我纠偏并转向慢查询证据。",
  steps: [
    {
      stepId: "step-resolve-app",
      description: "解析服务名和代码库信息。",
      allowedTools: ["resolve_app"]
    },
    {
      stepId: "step-performance-log-*",
      description: "按 504/timeout 条件查询性能相关日志，可根据工具反馈重试。",
      allowedTools: ["query_logs_by_condition"]
    },
    {
      stepId: "step-mysql-slow-log",
      description: "当日志出现 SQL/timeout 线索时查询慢 SQL。",
      allowedTools: ["query_mysql_slow_log"]
    }
  ],
  execute: runPerformanceDiagnosis
};
