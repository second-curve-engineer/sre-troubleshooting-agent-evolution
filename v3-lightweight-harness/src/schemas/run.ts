// Run schema：定义一次 Agent 运行的共享 state，包括路由、审批、证据、工具轨迹和报告。
import { z } from "zod";
import { AppInfoSchema } from "./app.js";
import { HumanApprovalRequestSchema } from "./approval.js";
import { DiagnosisReportSchema } from "./diagnosis.js";
import { EvidenceItemSchema } from "./evidence.js";
import { ToolTraceSchema } from "./tool.js";
import { RouterResultSchema, WorkflowDecisionSchema } from "./workflow.js";

export const RunStatusSchema = z.enum(["running", "waiting_approval", "completed", "failed"]);

export const ReportGenerationTraceSchema = z.object({
  source: z.enum(["mock", "llm", "fallback"]),
  model: z.string().optional(),
  tokenUsage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number()
    })
    .optional(),
  error: z.string().optional(),
  notes: z.array(z.string()).default([])
});

export const RunStateSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  status: RunStatusSchema.default("running"),
  userMessage: z.string(),
  decision: WorkflowDecisionSchema.optional(),
  router: RouterResultSchema.optional(),
  app: AppInfoSchema.optional(),
  approvals: z.array(HumanApprovalRequestSchema).default([]),
  pendingApprovalId: z.string().optional(),
  resumeFromStepId: z.string().optional(),
  evidence: z.array(EvidenceItemSchema).default([]),
  toolTraces: z.array(ToolTraceSchema).default([]),
  reportGeneration: ReportGenerationTraceSchema.optional(),
  finalReport: DiagnosisReportSchema.optional()
});

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ReportGenerationTrace = z.infer<typeof ReportGenerationTraceSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
