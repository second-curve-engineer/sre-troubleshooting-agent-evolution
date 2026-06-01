// Harness 控制中心：串起 router、workflow、tool 调用、evidence、report 和 trace 持久化。
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ApprovalMode } from "./approval-policy.js";
import { ApprovalStatus } from "../schemas/approval.js";
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
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly toolExecution: ToolExecutionConfig;

  constructor(options: { approvalMode?: ApprovalMode; toolExecution?: Partial<ToolExecutionConfig> } = {}) {
    this.approvalPolicy = new ApprovalPolicy(options.approvalMode ?? "auto");
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
      status: "running",
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

    try {
      await workflow.execute(workflowContext);
      state.status = "completed";
    } catch (caught) {
      if (!(caught instanceof PendingApprovalError)) throw caught;
      state.status = "waiting_approval";
      state.pendingApprovalId = caught.approvalId;
      state.resumeFromStepId = caught.stepId;
      evidence.add({
        source: "approval_policy",
        kind: "system",
        summary: `高风险工具 ${caught.toolName} 等待人工审批，approvalId=${caught.approvalId}`,
        confidence: "medium",
        usedInFinalReport: true
      });
    }
    state.evidence = evidence.list();
    state.finalReport = generateMockDiagnosis({ decision: state.decision, evidence: state.evidence });
    return this.persist(state);
  }

  async resume(
    state: RunState,
    args: { approvalId: string; decision: Extract<ApprovalStatus, "approved" | "rejected"> }
  ): Promise<{ state: RunState; tracePath: string }> {
    const approval = state.approvals.find((item) => item.approvalId === args.approvalId);
    if (!approval) {
      throw new Error(`approval ${args.approvalId} not found`);
    }
    const now = new Date().toISOString();
    approval.status = args.decision;
    approval.decidedAt = now;
    state.pendingApprovalId = undefined;
    state.resumeFromStepId = undefined;

    if (args.decision === "rejected") {
      state.status = "completed";
      const evidence = new EvidenceStore(state.evidence);
      evidence.add({
        source: "approval_policy",
        kind: "system",
        summary: `人工审批拒绝 ${approval.toolName}，高风险工具未执行，approvalId=${approval.approvalId}`,
        confidence: "medium",
        usedInFinalReport: true
      });
      state.evidence = evidence.list();
      state.finalReport = generateMockDiagnosis({ decision: state.decision!, evidence: state.evidence });
      return this.persist(state);
    }

    state.status = "running";
    return this.continueRun(state);
  }

  private async continueRun(state: RunState): Promise<{ state: RunState; tracePath: string }> {
    if (!state.decision) {
      throw new Error("cannot resume run without workflow decision");
    }
    const evidence = new EvidenceStore(state.evidence);
    const workflow = getWorkflow(state.decision.route);
    await workflow.execute({
      state,
      evidence,
      invokeTool: this.invokeTool.bind(this),
      selfCorrectionPolicy: this.policy
    });
    state.status = "completed";
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
      const existingApproval = [...state.approvals]
        .reverse()
        .find((approval) => approval.stepId === stepId && approval.toolName === toolName);
      const approval = existingApproval ?? this.approvalPolicy.evaluate({
        runId: state.runId,
        stepId,
        toolName,
        riskLevel: metadata.riskLevel,
        input
      });
      if (!existingApproval) {
        state.approvals.push(approval);
      }

      // 所有工具调用先过 approval policy，再进入 registry，保证风险控制和 trace 记录一致。
      if (approval.status === "pending") {
        const trace: ToolTrace = {
          runId: state.runId,
          stepId,
          toolName,
          riskLevel: metadata.riskLevel,
          approvalStatus: approval.status,
          toolInput: redactUnknown(input) as Record<string, unknown>,
          outputSummary: {
            approvalId: approval.approvalId,
            riskLevel: metadata.riskLevel
          },
          status: "cancelled",
          timeoutMs: this.toolExecution.timeoutMs,
          timedOut: false,
          durationMs: Math.round(performance.now() - start),
          error: `工具 ${toolName} 等待人工审批`,
          usedForDecision: true
        };
        state.toolTraces.push(trace);
        throw new PendingApprovalError(approval.approvalId, stepId, toolName);
      }

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
      if (caught instanceof PendingApprovalError) {
        throw caught;
      }
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

class PendingApprovalError extends Error {
  constructor(
    readonly approvalId: string,
    readonly stepId: string,
    readonly toolName: ToolName
  ) {
    super(`approval pending: ${approvalId}`);
  }
}
