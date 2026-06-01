// Approval schema：定义工具风险等级和人工审批请求的数据结构。
import { z } from "zod";

export const ToolRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "auto_approved"]);

export const HumanApprovalRequestSchema = z.object({
  approvalId: z.string(),
  runId: z.string(),
  stepId: z.string(),
  toolName: z.string(),
  riskLevel: ToolRiskLevelSchema,
  reason: z.string(),
  toolInputSummary: z.record(z.unknown()),
  status: ApprovalStatusSchema,
  createdAt: z.string(),
  decidedAt: z.string().optional()
});

export type ToolRiskLevel = z.infer<typeof ToolRiskLevelSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type HumanApprovalRequest = z.infer<typeof HumanApprovalRequestSchema>;
