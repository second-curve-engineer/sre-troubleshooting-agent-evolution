// Harness 控制中心：串起 router、workflow、tool 调用、evidence、report 和 trace 持久化。
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { RunState } from "../schemas/run.js";
import { ToolResult, ToolTrace } from "../schemas/tool.js";
import { RunTrace } from "../schemas/trace.js";
import { redactUnknown } from "../security/redaction.js";
import { ToolName, ToolRegistry } from "../tools/tool-registry.js";
import { generateMockDiagnosis } from "../llm/mock-llm.js";
import { getWorkflow } from "../workflows/registry.js";
import { resolveAppForWorkflow } from "../workflows/shared.js";
import { loadToolExecutionConfig, ToolExecutionConfig } from "../config/env.js";
import { ApprovalPolicy } from "./approval-policy.js";
import { EvidenceStore } from "./evidence-store.js";
import { SelfCorrectionPolicy } from "./policies.js";
import { routeWorkflow } from "./router.js";
import { TraceStore } from "./trace-store.js";

export class HarnessRunner {
  private readonly tools = new ToolRegistry();
  private readonly traces = new TraceStore();
  private readonly policy = new SelfCorrectionPolicy();
  private readonly approvalPolicy = new ApprovalPolicy("auto");
  private readonly toolExecution: ToolExecutionConfig;

  constructor(options: { toolExecution?: Partial<ToolExecutionConfig> } = {}) {
    this.toolExecution = {
      ...loadToolExecutionConfig(),
      ...options.toolExecution
    };
  }

  async run(userMessage: string, sessionId = "cli"): Promise<{ state: RunState; tracePath: string }> {
    const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const state: RunState = {
      runId,
      sessionId,
      userMessage,
      approvals: [],
      evidence: [],
      toolTraces: []
    };
    const evidence = new EvidenceStore();

    // Runner 是控制中心：先由 router 选 workflow，再由 workflow 受控调用工具。
    state.router = await routeWorkflow(userMessage);
    state.decision = state.router.decision;
    evidence.add({
      source: "router",
      kind: "system",
      summary: `router=${state.router.source}, confidence=${state.router.confidence}, usedLlm=${state.router.usedLlm}, tokens=${state.router.tokenUsage?.totalTokens ?? 0}`,
      confidence: state.router.confidence >= 0.75 ? "high" : "medium",
      usedInFinalReport: false
    });

    const workflow = getWorkflow(state.decision.route);
    const workflowContext = {
      state,
      evidence,
      invokeTool: this.invokeTool.bind(this),
      selfCorrectionPolicy: this.policy
    };

    if (state.decision.route !== "clarification") {
      await resolveAppForWorkflow({
        state,
        evidence,
        invokeTool: workflowContext.invokeTool,
        userMessage
      });
    }

    await workflow.execute(workflowContext);
    state.evidence = evidence.list();
    state.finalReport = generateMockDiagnosis({ decision: state.decision, evidence: state.evidence });
    return this.persist(state);
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
    let timedOut = false;
    try {
      const metadata = this.tools.getMetadata(toolName);
      // 所有工具调用先过 approval policy，再进入 registry，保证风险控制和 trace 记录一致。
      const approval = this.approvalPolicy.evaluate({
        runId: state.runId,
        stepId,
        toolName,
        riskLevel: metadata.riskLevel,
        input
      });
      state.approvals.push(approval);

      if (!this.approvalPolicy.canExecute(approval)) {
        result = {
          status: "error",
          summary: `工具 ${toolName} 风险等级 ${metadata.riskLevel}，审批状态 ${approval.status}，未执行`,
          outputSummary: {
            riskLevel: metadata.riskLevel,
            approvalStatus: approval.status,
            approvalId: approval.approvalId
          }
        };
        const trace: ToolTrace = {
          runId: state.runId,
          stepId,
          toolName,
          riskLevel: metadata.riskLevel,
          approvalStatus: approval.status,
          toolInput: redactUnknown(input) as Record<string, unknown>,
          outputSummary: redactUnknown(result.outputSummary ?? {}) as Record<string, unknown>,
          status: result.status,
          timeoutMs: this.toolExecution.timeoutMs,
          timedOut: false,
          durationMs: Math.round(performance.now() - start),
          error: result.summary,
          usedForDecision: true
        };
        state.toolTraces.push(trace);
        return result;
      }

      result = await this.withTimeout(
        this.tools.invoke({ toolName, input, allowedTools }),
        this.toolExecution.timeoutMs,
        toolName
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      timedOut = caught instanceof ToolTimeoutError;
      result = {
        status: timedOut ? "timeout" : "error",
        summary: error,
        outputSummary: timedOut
          ? {
              timeoutMs: this.toolExecution.timeoutMs
            }
          : {}
      };
    }
    const trace: ToolTrace = {
      runId: state.runId,
      stepId,
      toolName,
      riskLevel: this.tools.getMetadata(toolName).riskLevel,
      approvalStatus: [...state.approvals]
        .reverse()
        .find((approval) => approval.stepId === stepId && approval.toolName === toolName)?.status,
      toolInput: redactUnknown(input) as Record<string, unknown>,
      outputSummary: redactUnknown(result.outputSummary ?? {}) as Record<string, unknown>,
      status: result.status,
      timeoutMs: this.toolExecution.timeoutMs,
      timedOut,
      durationMs: Math.round(performance.now() - start),
      error,
      usedForDecision: true
    };
    state.toolTraces.push(trace);
    return result;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: ToolName): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new ToolTimeoutError(`工具 ${toolName} 执行超过 ${timeoutMs}ms，已按 timeout 处理`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
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

class ToolTimeoutError extends Error {}
