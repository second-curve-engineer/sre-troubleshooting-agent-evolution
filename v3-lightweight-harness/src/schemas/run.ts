// Run schema：定义一次 Agent 运行的共享 state，包括路由、审批、证据、工具轨迹和报告。
import { z } from "zod";
import { AppInfoSchema } from "./app.js";
import { HumanApprovalRequestSchema } from "./approval.js";
import { DiagnosisReportSchema } from "./diagnosis.js";
import { EvidenceItemSchema } from "./evidence.js";
import { ToolTraceSchema } from "./tool.js";
import { RouterResultSchema, WorkflowDecisionSchema } from "./workflow.js";

export const RunStateSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  userMessage: z.string(),
  decision: WorkflowDecisionSchema.optional(),
  router: RouterResultSchema.optional(),
  app: AppInfoSchema.optional(),
  approvals: z.array(HumanApprovalRequestSchema).default([]),
  evidence: z.array(EvidenceItemSchema).default([]),
  toolTraces: z.array(ToolTraceSchema).default([]),
  finalReport: DiagnosisReportSchema.optional()
});

export type RunState = z.infer<typeof RunStateSchema>;
