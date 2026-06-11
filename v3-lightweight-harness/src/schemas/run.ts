// Run schema：定义一次 Agent 运行的共享 state，包括路由、审批、证据、工具轨迹和报告。
import { z } from "zod";
import { AppInfoSchema } from "./app.js";
import { HumanApprovalRequestSchema } from "./approval.js";
import { DiagnosisReportSchema } from "./diagnosis.js";
import { EvidenceItemSchema } from "./evidence.js";
import { LlmCallTraceSchema, ModelTierSchema, TokenUsageSchema } from "./llm.js";
import { ToolTraceSchema } from "./tool.js";
import { RouterResultSchema, WorkflowDecisionSchema } from "./workflow.js";

export const RunStatusSchema = z.enum(["running", "waiting_approval", "completed", "failed"]);

export const ReplayMetadataSchema = z.object({
  sourceRunId: z.string(),
  mode: z.literal("recorded"),
  strictInputMatch: z.literal(true)
});

export const ReportGenerationTraceSchema = z.object({
  source: z.enum(["mock", "llm", "fallback"]),
  role: z.literal("report").default("report"),
  model: z.string().optional(),
  modelTier: ModelTierSchema.optional(),
  tokenBudget: z.number().optional(),
  timeoutMs: z.number().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  llmCall: LlmCallTraceSchema.optional(),
  error: z.string().optional(),
  notes: z.array(z.string()).default([])
});

export const RunStateSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  // OTel Agent Span 根节点 ID，toolTraces 和 llmCalls 的 parentSpanId 均指向此字段。
  agentSpanId: z.string(),
  status: RunStatusSchema.default("running"),
  userMessage: z.string(),
  replay: ReplayMetadataSchema.optional(),
  decision: WorkflowDecisionSchema.optional(),
  router: RouterResultSchema.optional(),
  app: AppInfoSchema.optional(),
  approvals: z.array(HumanApprovalRequestSchema).default([]),
  pendingApprovalId: z.string().optional(),
  resumeFromStepId: z.string().optional(),
  // 已完成步骤的原始结果缓存（stepId → ToolResult），HITL resume 时直接返回缓存结果。
  // 用 z.unknown() 存储，runner 取出时强转为 ToolResult，避免 input/output 类型分歧。
  // 这样 workflow 代码对"是否是 resume"完全透明，下游关键词判断、慢查询触发逻辑不受影响。
  completedSteps: z.record(z.string(), z.unknown()).default({}),
  // 运行失败时记录原因，配合 status="failed" 使用，保证失败 trace 也能落盘。
  failureReason: z.string().optional(),
  evidence: z.array(EvidenceItemSchema).default([]),
  toolTraces: z.array(ToolTraceSchema).default([]),
  llmCalls: z.array(LlmCallTraceSchema).default([]),
  // root_cause 阶段的结构化输出，序列化后注入 report prompt。
  // 仅在 evidence 充分（usedInFinalReport ≥ 2 条非 system 项）时填充。
  rootCauseAnalysis: z.string().optional(),
  reportGeneration: ReportGenerationTraceSchema.optional(),
  finalReport: DiagnosisReportSchema.optional()
});

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ReplayMetadata = z.infer<typeof ReplayMetadataSchema>;
export type ReportGenerationTrace = z.infer<typeof ReportGenerationTraceSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
