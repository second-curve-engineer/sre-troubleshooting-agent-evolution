// LLM schema：记录每次模型调用的角色、模型档位、预算和 token 使用。
import { z } from "zod";

export const LlmRoleSchema = z.enum(["router", "evidence_summarizer", "root_cause", "report", "judge"]);
export const ModelTierSchema = z.enum(["rule", "small", "standard", "strong"]);
export const LlmCallSourceSchema = z.enum(["mock", "llm", "fallback", "skipped"]);

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number()
});

// 单次 LLM 调用的 trace。它记录“为什么这个阶段用这个模型、花了多少预算、是否降级”。
export const LlmCallTraceSchema = z.object({
  // 本次 LLM 调用所属的 Agent 阶段，例如 router、report、root_cause。
  role: LlmRoleSchema,
  // 调用来源：mock、本次真实 LLM 调用、fallback，或后续预留的 skipped。
  source: LlmCallSourceSchema,
  // 最终实际使用的模型名，由 LlmConfig + ModelPolicy 解析得到。
  model: z.string(),
  // 模型档位，不直接绑定供应商模型名，便于后续切换模型供应商或具体型号。
  modelTier: ModelTierSchema,
  // 当前阶段的 token 预算；eval 会用它检查真实 tokenUsage 是否超预算。
  tokenBudget: z.number(),
  // 当前阶段的超时时间；真实 LLM adapter 会用它控制 AbortController。
  timeoutMs: z.number(),
  // 真实 API 返回或 mock 估算的 token 使用量。
  tokenUsage: TokenUsageSchema.optional(),
  // LLM 调用失败或 fallback 时记录错误原因。
  error: z.string().optional(),
  // 记录策略选择原因、脱敏信息、prompt injection 命中等调试线索。
  notes: z.array(z.string()).default([])
});

export type LlmRole = z.infer<typeof LlmRoleSchema>;
export type ModelTier = z.infer<typeof ModelTierSchema>;
export type LlmCallSource = z.infer<typeof LlmCallSourceSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type LlmCallTrace = z.infer<typeof LlmCallTraceSchema>;
