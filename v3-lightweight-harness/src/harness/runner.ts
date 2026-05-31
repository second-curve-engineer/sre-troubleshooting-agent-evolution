import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AppInfo } from "../schemas/app.js";
import { RunState } from "../schemas/run.js";
import { ToolResult, ToolTrace } from "../schemas/tool.js";
import { RunTrace } from "../schemas/trace.js";
import { ToolName, ToolRegistry } from "../tools/tool-registry.js";
import { generateMockDiagnosis } from "../llm/mock-llm.js";
import { EvidenceStore } from "./evidence-store.js";
import { SelfCorrectionPolicy } from "./policies.js";
import { routeWorkflow } from "./router.js";
import { TraceStore } from "./trace-store.js";

export class HarnessRunner {
  private readonly tools = new ToolRegistry();
  private readonly traces = new TraceStore();
  private readonly policy = new SelfCorrectionPolicy();

  async run(userMessage: string, sessionId = "cli"): Promise<{ state: RunState; tracePath: string }> {
    const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const state: RunState = {
      runId,
      sessionId,
      userMessage,
      evidence: [],
      toolTraces: []
    };
    const evidence = new EvidenceStore();

    state.router = await routeWorkflow(userMessage);
    state.decision = state.router.decision;
    evidence.add({
      source: "router",
      kind: "system",
      summary: `router=${state.router.source}, confidence=${state.router.confidence}, usedLlm=${state.router.usedLlm}, tokens=${state.router.tokenUsage?.totalTokens ?? 0}`,
      confidence: state.router.confidence >= 0.75 ? "high" : "medium",
      usedInFinalReport: false
    });

    if (state.decision.route === "clarification") {
      evidence.add({
        source: "router",
        kind: "system",
        summary: state.decision.reason,
      confidence: state.router.confidence >= 0.75 ? "high" : "medium",
        usedInFinalReport: true
      });
      state.evidence = evidence.list();
      state.finalReport = generateMockDiagnosis({ decision: state.decision, evidence: state.evidence });
      return this.persist(state);
    }

    const appResult = await this.invokeTool(state, "step-resolve-app", "resolve_app", {
      query: state.decision.appHint ?? userMessage
    }, ["resolve_app"]);
    if (appResult.status === "ok") {
      state.app = appResult.data as AppInfo;
      evidence.add({
        source: "resolve_app",
        kind: "app",
        summary: `应用解析为 ${state.app.appId}，代码库 ${state.app.codebasePath}`,
        confidence: "high",
        usedInFinalReport: true
      });
    }

    if (state.decision.route === "trace-diagnosis") {
      await this.runTraceDiagnosis(state, evidence);
    } else if (state.decision.route === "condition-log") {
      await this.runConditionLogDiagnosis(state, evidence);
    } else if (state.decision.route === "performance") {
      await this.runPerformanceDiagnosis(state, evidence);
    }

    state.evidence = evidence.list();
    state.finalReport = generateMockDiagnosis({ decision: state.decision, evidence: state.evidence });
    return this.persist(state);
  }

  private async runTraceDiagnosis(state: RunState, evidence: EvidenceStore): Promise<void> {
    const traceId = state.decision?.traceId ?? "demo-trace-001";
    const traceResult = await this.invokeTool(state, "step-trace", "query_logs_by_trace_id", {
      traceId,
      env: "prod"
    }, ["query_logs_by_trace_id"]);
    evidence.add({
      source: "query_logs_by_trace_id",
      kind: "trace",
      summary: `trace ${traceId}: ${traceResult.summary}; 首次异常=${String((traceResult.outputSummary ?? {}).firstException ?? "unknown")}`,
      confidence: traceResult.status === "ok" ? "high" : "low",
      rawRef: traceId,
      usedInFinalReport: true
    });
    await this.askCodeIfPossible(state, evidence);
  }

  private async runConditionLogDiagnosis(state: RunState, evidence: EvidenceStore): Promise<void> {
    const appId = state.app?.appId ?? "order-service";
    const logResult = await this.invokeTool(state, "step-condition-log", "query_logs_by_condition", {
      appId,
      query: "SELECT * WHERE log.level = 'ERROR' and http.status_code = '500'",
      fromTime: "2026-05-28 10:30:00",
      toTime: "2026-05-28 10:35:00",
      env: "prod"
    }, ["query_logs_by_condition"]);
    evidence.add({
      source: "query_logs_by_condition",
      kind: "log",
      summary: `${appId} 条件日志查询: ${logResult.summary}`,
      confidence: logResult.status === "ok" ? "high" : "medium",
      usedInFinalReport: true
    });
    const traceIds = ((logResult.outputSummary ?? {}).traceIds as string[] | undefined) ?? [];
    if (traceIds.length > 0) {
      state.decision = { ...state.decision!, traceId: traceIds[0] };
      await this.runTraceDiagnosis(state, evidence);
    }
  }

  private async runPerformanceDiagnosis(state: RunState, evidence: EvidenceStore): Promise<void> {
    const appId = state.app?.appId ?? "order-service";
    let query = "SELECT * WHERE http.status_code = '504'";
    let retryCount = 0;
    let logResult: ToolResult;

    do {
      logResult = await this.invokeTool(state, `step-performance-log-${retryCount + 1}`, "query_logs_by_condition", {
        appId,
        query,
        fromTime: "2026-05-28 10:30:00",
        toTime: "2026-05-28 10:35:00",
        env: "prod",
        limit: 5
      }, ["query_logs_by_condition"]);

      evidence.add({
        source: "query_logs_by_condition",
        kind: "log",
        summary: `${appId} 性能日志查询第 ${retryCount + 1} 次: ${logResult.summary}`,
        confidence: logResult.status === "ok" ? "high" : "medium",
        usedInFinalReport: true
      });

      if (this.policy.shouldRetry(logResult, retryCount)) {
        query = this.policy.nextConditionQuery(query, logResult);
        retryCount += 1;
      } else {
        break;
      }
    } while (retryCount <= this.policy.maxRetries);

    const shouldQuerySlowLog =
      (logResult.detectedKeywords ?? []).some((keyword) => ["sql", "timeout", "slow query"].includes(keyword.toLowerCase())) ||
      JSON.stringify(logResult.outputSummary).toLowerCase().includes("sql");

    if (shouldQuerySlowLog) {
      const slowResult = await this.invokeTool(state, "step-mysql-slow-log", "query_mysql_slow_log", {
        dbNames: ["order_db"],
        query: "Query_time > 3",
        fromTime: "2026-05-28 10:30:00",
        toTime: "2026-05-28 10:35:00",
        env: "prod"
      }, ["query_mysql_slow_log"]);
      evidence.add({
        source: "query_mysql_slow_log",
        kind: "slow_query",
        summary: `${slowResult.summary}; SQL=${String((slowResult.outputSummary ?? {}).sql ?? "unknown")}`,
        confidence: slowResult.status === "ok" ? "high" : "medium",
        usedInFinalReport: true
      });
    }
  }

  private async askCodeIfPossible(state: RunState, evidence: EvidenceStore): Promise<void> {
    if (!state.app?.codebasePath) return;
    const codeResult = await this.invokeTool(state, "step-code", "ask_codebase", {
      codebasePath: "inventory-service",
      question: "根据 trace 异常栈定位代码根因"
    }, ["ask_codebase"]);
    evidence.add({
      source: "ask_codebase",
      kind: "code",
      summary: `${codeResult.summary}; 文件=${String((codeResult.outputSummary ?? {}).file ?? "unknown")}:${String((codeResult.outputSummary ?? {}).line ?? "")}`,
      confidence: codeResult.status === "ok" ? "high" : "medium",
      usedInFinalReport: true
    });
  }

  private async invokeTool(
    state: RunState,
    stepId: string,
    toolName: ToolName,
    input: Record<string, unknown>,
    allowedTools: ToolName[]
  ): Promise<ToolResult> {
    const start = performance.now();
    let result: ToolResult;
    let error: string | null = null;
    try {
      result = await this.tools.invoke({ toolName, input, allowedTools });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      result = {
        status: "error",
        summary: error,
        outputSummary: {}
      };
    }
    const trace: ToolTrace = {
      runId: state.runId,
      stepId,
      toolName,
      toolInput: input,
      outputSummary: result.outputSummary ?? {},
      status: result.status,
      durationMs: Math.round(performance.now() - start),
      error,
      usedForDecision: true
    };
    state.toolTraces.push(trace);
    return result;
  }

  private async persist(state: RunState): Promise<{ state: RunState; tracePath: string }> {
    const trace: RunTrace = {
      version: "v3-lightweight-harness",
      createdAt: new Date().toISOString(),
      run: state
    };
    const tracePath = await this.traces.save(trace);
    return { state, tracePath };
  }
}
