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
import { createDiagnosisGenerator, DiagnosisGenerator } from "../llm/report-adapter.js";
import { createEvidenceSummarizer, EvidenceSummarizer } from "../llm/evidence-summarizer.js";
import {
  createRootCauseAnalyzer,
  formatRootCauseForReport,
  RootCauseAnalyzer
} from "../llm/root-cause-analyzer.js";
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
  private readonly diagnosisGenerator: DiagnosisGenerator;
  private readonly evidenceSummarizer: EvidenceSummarizer;
  private readonly rootCauseAnalyzer: RootCauseAnalyzer;

  constructor(options: {
    approvalMode?: ApprovalMode;
    toolExecution?: Partial<ToolExecutionConfig>;
    diagnosisGenerator?: DiagnosisGenerator;
  } = {}) {
    this.approvalPolicy = new ApprovalPolicy(options.approvalMode ?? "auto");
    this.toolExecution = {
      ...loadToolExecutionConfig(),
      ...options.toolExecution
    };
    this.diagnosisGenerator = options.diagnosisGenerator ?? createDiagnosisGenerator();
    this.evidenceSummarizer = createEvidenceSummarizer();
    this.rootCauseAnalyzer = createRootCauseAnalyzer();
  }

  async run(userMessage: string, sessionId = "cli"): Promise<{ state: RunState; tracePath: string }> {
    const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    // agentSpanId 是本次 run 的根 Agent Span，所有 toolTraces 和 llmCalls 的 parentSpanId 均指向它。
    const agentSpanId = randomUUID();
    const state: RunState = {
      runId,
      sessionId,
      agentSpanId,
      status: "running",
      userMessage,
      approvals: [],
      completedSteps: {},
      evidence: [],
      toolTraces: [],
      llmCalls: []
    };
    const evidence = new EvidenceStore();

    // Runner 是控制中心：先由 router 选 workflow，再由 workflow 受控调用工具。
    state.router = await routeWorkflow(userMessage);
    state.decision = state.router.decision;
    // llmCalls[] 是跨阶段的 LLM 成本视图；router/report 各自 trace 仍保留在原字段里。
    // 由 runner 统一补齐 spanId/parentSpanId，adapter 层不感知 agentSpanId。
    if (state.router.llmCall) {
      state.llmCalls.push({
        ...state.router.llmCall,
        spanId: randomUUID(),
        parentSpanId: state.agentSpanId,
        spanKind: "LLM"
      });
    }
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
      selfCorrectionPolicy: this.policy,
      evidenceSummarizer: this.evidenceSummarizer
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
      if (caught instanceof PendingApprovalError) {
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
      } else {
        // 未预期异常：设 failed 状态并立即落盘，保证 trace 不丢失，便于事后排查。
        state.status = "failed";
        state.failureReason = caught instanceof Error ? caught.message : String(caught);
        state.evidence = evidence.list();
        await this.persist(state);
        throw caught;
      }
    }
    state.evidence = evidence.list();
    await this.generateDiagnosis(state);
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
      await this.generateDiagnosis(state);
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
    // invokeTool 会检查 completedStepIds，已完成的步骤直接跳过，避免 resume 时重复执行。
    await workflow.execute({
      state,
      evidence,
      invokeTool: this.invokeTool.bind(this),
      selfCorrectionPolicy: this.policy,
      evidenceSummarizer: this.evidenceSummarizer
    });
    state.status = "completed";
    state.evidence = evidence.list();
    await this.generateDiagnosis(state);
    return this.persist(state);
  }

  private async generateDiagnosis(state: RunState): Promise<void> {
    if (!state.decision) {
      throw new Error("cannot generate diagnosis without workflow decision");
    }

    // ── 阶段一：root_cause（strong tier）——仅在证据充分时运行 ──
    // 由 analyzer.shouldAnalyze() 决定是否值得调用 strong 模型：
    //   - 条件：usedInFinalReport=true 且 kind≠system 的证据 ≥ 2 条
    //   - 简单场景（clarification、工具全失败）直接跳到 report 阶段
    let rootCauseAnalysis: string | undefined;
    if (this.rootCauseAnalyzer.shouldAnalyze(state.evidence)) {
      const rcResult = await this.rootCauseAnalyzer.analyze({
        userMessage: state.userMessage,
        decision: state.decision,
        evidence: state.evidence
      });
      rootCauseAnalysis = formatRootCauseForReport(rcResult.analysis);
      state.rootCauseAnalysis = rootCauseAnalysis;
      // 汇总 root_cause LLM 调用，供 eval llm_policy_budget 检查
      state.llmCalls.push({
        ...rcResult.llmCall,
        spanId: rcResult.llmCall.spanId ?? randomUUID(),
        parentSpanId: state.agentSpanId
      });
    }

    // ── 阶段二：report（standard tier）——基于证据 + 可选根因分析生成结构化报告 ──
    // 有 rootCauseAnalysis 时，report LLM 只需格式化，不需要重新推理，
    // 实际认知负荷更低，standard tier 足够完成任务。
    const result = await this.diagnosisGenerator.generate({
      userMessage: state.userMessage,
      decision: state.decision,
      evidence: state.evidence,
      rootCauseAnalysis
    });
    state.finalReport = result.report;
    state.reportGeneration = result.trace;
    // 汇总 report LLM 调用，便于 eval 按统一口径检查 token budget。
    if (result.trace.llmCall) {
      state.llmCalls.push({
        ...result.trace.llmCall,
        spanId: randomUUID(),
        parentSpanId: state.agentSpanId
      });
    }
  }

  private async invokeTool(
    state: RunState,
    stepId: string,
    toolName: ToolName,
    input: Record<string, unknown>,
    allowedTools: ToolName[]
  ): Promise<ToolResult> {
    // Resume 幂等保护：已完成的步骤直接返回上一轮的原始结果，不重新执行。
    // 返回原始结果（而非 cancelled 占位）保证下游的关键词判断、慢查询触发等逻辑与首次运行完全一致。
    if (state.completedSteps[stepId]) {
      return state.completedSteps[stepId] as ToolResult;
    }

    const startTime = new Date().toISOString();
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
          spanId: randomUUID(),
          parentSpanId: state.agentSpanId,
          startTime,
          spanKind: "TOOL",
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
          status: "cancelled",
          summary: `工具 ${toolName} 风险等级 ${metadata.riskLevel}，审批状态 ${approval.status}，未执行`,
          outputSummary: {
            riskLevel: metadata.riskLevel,
            approvalStatus: approval.status,
            approvalId: approval.approvalId
          }
        };
        const trace: ToolTrace = {
          spanId: randomUUID(),
          parentSpanId: state.agentSpanId,
          startTime,
          spanKind: "TOOL",
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
      spanId: randomUUID(),
      parentSpanId: state.agentSpanId,
      startTime,
      spanKind: "TOOL",
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
    // 工具成功执行后缓存原始结果，供 resume 时直接返回，保证幂等。
    // timeout/error 不缓存：这些步骤下次 resume 时应重试。
    if (result.status === "ok" || result.status === "empty" || result.status === "too_many_results") {
      state.completedSteps[stepId] = result;
    }
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
