// Tool schema：定义工具执行结果和 tool trace，支撑可观测性与 eval。
import { z } from "zod";
import { ToolRiskLevelSchema } from "./approval.js";

export const ToolStatusSchema = z.enum(["ok", "empty", "too_many_results", "error", "timeout", "cancelled"]);

export const ToolResultSchema = z.object({
  status: ToolStatusSchema,
  summary: z.string(),
  data: z.unknown().optional(),
  outputSummary: z.record(z.unknown()).default({}),
  suggestedNextQueries: z.array(z.string()).default([]),
  detectedKeywords: z.array(z.string()).default([])
});

export const ToolTraceSchema = z.object({
  runId: z.string(),
  stepId: z.string(),
  toolName: z.string(),
  riskLevel: ToolRiskLevelSchema.optional(),
  approvalStatus: z.string().optional(),
  toolInput: z.record(z.unknown()),
  outputSummary: z.record(z.unknown()),
  status: z.string(),
  timeoutMs: z.number().optional(),
  timedOut: z.boolean().default(false),
  durationMs: z.number(),
  error: z.string().nullable(),
  usedForDecision: z.boolean().default(false)
});

export type ToolResult = z.input<typeof ToolResultSchema>;
export type ToolTrace = z.infer<typeof ToolTraceSchema>;
