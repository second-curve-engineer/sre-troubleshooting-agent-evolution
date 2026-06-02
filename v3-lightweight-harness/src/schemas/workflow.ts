// Workflow schema：定义 router 可输出的问题类型、workflow route 和置信度信息。
import { z } from "zod";
import { LlmCallTraceSchema, TokenUsageSchema } from "./llm.js";

export const ProblemTypeSchema = z.enum(["interface_error", "performance", "unknown"]);
export const WorkflowRouteSchema = z.enum([
  "trace-diagnosis",
  "condition-log",
  "performance",
  "clarification"
]);

export const WorkflowDecisionSchema = z.object({
  problemType: ProblemTypeSchema,
  route: WorkflowRouteSchema,
  reason: z.string(),
  traceId: z.string().optional(),
  appHint: z.string().optional(),
  timeHint: z.string().optional()
});

export const RouterResultSchema = z.object({
  decision: WorkflowDecisionSchema,
  source: z.enum(["heuristic", "llm", "fallback"]),
  confidence: z.number().min(0).max(1),
  usedLlm: z.boolean(),
  tokenUsage: TokenUsageSchema.optional(),
  llmCall: LlmCallTraceSchema.optional(),
  notes: z.array(z.string()).default([])
});

export type ProblemType = z.infer<typeof ProblemTypeSchema>;
export type WorkflowRoute = z.infer<typeof WorkflowRouteSchema>;
export type WorkflowDecision = z.infer<typeof WorkflowDecisionSchema>;
export type RouterResult = z.infer<typeof RouterResultSchema>;
