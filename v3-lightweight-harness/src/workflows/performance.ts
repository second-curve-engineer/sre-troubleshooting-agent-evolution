// 性能排查 workflow：适用于 504/timeout/慢请求，并包含工具反馈驱动的自我纠偏。
import { ToolResult } from "../schemas/tool.js";
import { QueryLoopTerminationReason } from "../harness/policies.js";
import { WorkflowDefinition, WorkflowContext } from "./types.js";

export async function runPerformanceDiagnosis(context: WorkflowContext): Promise<void> {
  const appId = context.state.app?.appId ?? "order-service";
  const simulateLogTimeout = context.state.userMessage.includes("模拟日志平台超时");
  const simulateSlowQueryFailure = context.state.userMessage.includes("模拟慢查询平台失败");
  const simulateSensitiveLog = context.state.userMessage.includes("模拟敏感日志");
  const simulatePromptInjectionLog = context.state.userMessage.includes("模拟日志注入");
  const simulateHighRiskRestart = context.state.userMessage.includes("模拟高风险重启");
  const simulateAlwaysTooMany = context.state.userMessage.includes("模拟查询持续过宽");
  let query = "SELECT * WHERE http.status_code = '504'";
  let refinementCount = 0;
  let logResult: ToolResult;
  let terminationReason: QueryLoopTerminationReason = "completed";

  // 查询迭代：每轮执行工具 → 观察结果 → 必要时调整查询条件。
  // error/timeout 的同参数技术重试已在 Runner.invokeTool 内完成。
  do {
    logResult = await context.invokeTool(
      context.state,
      `step-performance-log-${refinementCount + 1}`,
      "query_logs_by_condition",
      {
        appId,
        query,
        fromTime: "2026-05-28 10:30:00",
        toTime: "2026-05-28 10:35:00",
        env: "prod",
        limit: 5,
        // 4000ms > TOOL_TIMEOUT_MS(3000ms)，技术重试耗尽后查询迭代以 tool_failure 退出。
        ...(simulateLogTimeout && refinementCount === 0 ? { __simulateDelayMs: 4000 } : {}),
        ...(simulateSensitiveLog ? { __simulateSensitiveLog: true } : {}),
        ...(simulatePromptInjectionLog ? { __simulatePromptInjectionLog: true } : {}),
        // 每轮都返回 too_many_results，耗尽 maxRefinements 后以 max_iterations 退出。
        ...(simulateAlwaysTooMany ? { __simulateAlwaysTooMany: true } : {})
      },
      ["query_logs_by_condition"]
    );

    // 调用小模型对原始日志做语义提炼，替代 "命中 N 条" 这种机械摘要。
    // 失败时自动降级为 logResult.summary，不影响主排查流程。
    const logSummary = await context.evidenceSummarizer.summarize({
      toolName: "query_logs_by_condition",
      appId,
      query,
      toolResult: logResult
    });
    const securityProbeText = (logResult.outputSummary ?? {}).securityProbe
      ? `; ${String((logResult.outputSummary ?? {}).securityProbe)}`
      : "";
    context.evidence.add({
      source: "query_logs_by_condition",
      kind: "log",
      summary: `[${appId} 第${refinementCount + 1}轮] ${logSummary}${securityProbeText}`,
      confidence: logResult.status === "ok" ? "high" : "medium",
      usedInFinalReport: true
    });

    if (context.queryRefinementPolicy.shouldRefineQuery(logResult, refinementCount)) {
      // 未满足条件且未超限：由 LLM 观察工具结果后决定下一轮查询条件。
      // openai 模式调用小模型动态决策；mock 模式降级为规则驱动，行为与改造前一致。
      const refinement = await context.loopQueryRefiner.refine({
        appId,
        previousQuery: query,
        toolResult: logResult,
        iterationIndex: refinementCount
      });
      query = refinement.nextQuery;
      context.evidence.add({
        source: "loop_query_refiner",
        kind: "system",
        summary: `[第${refinementCount + 1}轮查询收窄] ${refinement.reasoning}，新查询: "${refinement.nextQuery}"`,
        confidence: "medium",
        usedInFinalReport: false
      });
      refinementCount += 1;
    } else {
      // Loop 退出：由 policy 判断具体原因。
      terminationReason = context.queryRefinementPolicy.terminationReason(logResult, refinementCount);
      break;
    }
  } while (refinementCount <= context.queryRefinementPolicy.maxRefinements);

  context.evidence.add({
    source: "self_correction_policy",
    kind: "system",
    summary: `日志查询迭代终止：reason=${terminationReason}，共执行 ${refinementCount + 1} 轮，最终查询="${query}"`,
    confidence: terminationReason === "completed" ? "high" : "medium",
    usedInFinalReport: true
  });

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

  const slowSummary = await context.evidenceSummarizer.summarize({
    toolName: "query_mysql_slow_log",
    appId,
    toolResult: slowResult
  });
  // SQL 语句是根因分析的关键证据；LLM 语义摘要会提及，mock 模式下手动追加保证 eval 稳定性。
  const slowSql = String((slowResult.outputSummary ?? {}).sql ?? "");
  context.evidence.add({
    source: "query_mysql_slow_log",
    kind: "slow_query",
    summary: slowSql ? `${slowSummary}; SQL=${slowSql}` : slowSummary,
    confidence: slowResult.status === "ok" ? "high" : "medium",
    usedInFinalReport: true
  });

  if (!simulateHighRiskRestart) return;

  const restartResult = await context.invokeTool(
    context.state,
    "step-restart-service",
    "restart_service",
    {
      appId,
      reason: "模拟高风险重启，用于验证 HITL pending-resume 控制流"
    },
    ["restart_service"]
  );

  context.evidence.add({
    source: "restart_service",
    kind: "system",
    summary: restartResult.summary,
    confidence: restartResult.status === "ok" ? "medium" : "low",
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
    },
    {
      stepId: "step-restart-service",
      description: "高风险生产动作，必须经过 HITL 审批后才能执行。",
      allowedTools: ["restart_service"]
    }
  ],
  execute: runPerformanceDiagnosis
};
