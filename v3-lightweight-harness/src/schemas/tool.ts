// Tool schema：定义工具执行结果和 tool trace，支撑可观测性与 eval。
import { z } from "zod";
import { ToolRiskLevelSchema } from "./approval.js";
import { LlmCallTraceSchema } from "./llm.js";

export const ToolStatusSchema = z.enum(["ok", "empty", "too_many_results", "error", "timeout", "cancelled"]);
// OpenInference span kind — 保持与 Phoenix/Arize 可观测性平台的语义兼容。
export const ToolSpanKindSchema = z.literal("TOOL");

export const ToolResultSchema = z.object({
  // 执行状态：ok=有数据，empty=查无结果，too_many_results=结果过多需缩小范围，
  // error/timeout/cancelled=执行失败。
  status: ToolStatusSchema,
  // 机械摘要（mechanicalSummary）：工具层按固定模板生成的一句话描述，
  // 如"查到 5 条 MySQL 慢查询，最大 Query_time=3.2s"。
  // 不依赖 LLM，eval / fallback / mock 模式下直接作为 evidence summary 使用。
  summary: z.string(),
  // 原始数据（可选），工具返回的完整结构，evidence-summarizer 用来做语义提炼的素材。
  data: z.unknown().optional(),
  // 结构化输出摘要：工具层提取的关键数值/字段，供 trace 落盘和 LLM prompt 构造使用。
  // 与 summary（自然语言）的区别：outputSummary 保留结构，程序可读；summary 是给人看的文本。
  // 例：{ logCount: 5, maxQueryTime: 3.2, dbNames: ["order_db"] }
  outputSummary: z.record(z.unknown()).default({}),
  // 工具输出中建议的后续查询方向，workflow 可据此决定是否追加调用其他工具。
  suggestedNextQueries: z.array(z.string()).default([]),
  // 工具输出中命中的领域关键词（如 "OOM"、"slow_query"、"timeout"），
  // workflow 用来触发特定分支逻辑（如自动追查慢查询）。
  detectedKeywords: z.array(z.string()).default([]),
  // 复合工具内部发生的 LLM 调用，由 Runner 汇总到 run.llmCalls[]。
  llmCall: LlmCallTraceSchema.optional(),
  // error 状态是否适合用相同参数做技术重试；timeout 默认由 Runner 视为可重试。
  retryable: z.boolean().optional()
});

export const ToolTraceSchema = z.object({
  // -- OpenTelemetry / OpenInference 兼容字段 --
  // spanId 全局唯一，parentSpanId 指向触发本次工具调用的 Agent Span（agentSpanId）。
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  // startTime ISO 8601，与 LlmCallTrace 对齐后可按时间线重建完整执行顺序。
  startTime: z.string(),
  // OpenInference span kind：Tool Span 固定为 "TOOL"，便于接入 Phoenix 等平台。
  spanKind: ToolSpanKindSchema.optional(),
  // -- SRE 语义扩展字段（作为 OTel attributes）--
  runId: z.string(),
  stepId: z.string(),
  toolName: z.string(),
  riskLevel: ToolRiskLevelSchema.optional(),
  approvalStatus: z.string().optional(),
  toolInput: z.record(z.unknown()),
  outputSummary: z.record(z.unknown()),
  status: z.string(),
  timeoutMs: z.number().optional(),
  attemptCount: z.number().int().positive().default(1),
  timedOut: z.boolean().default(false),
  durationMs: z.number(),
  error: z.string().nullable(),
  usedForDecision: z.boolean().default(false)
});

export type ToolResult = z.input<typeof ToolResultSchema>;
export type ToolSpanKind = z.infer<typeof ToolSpanKindSchema>;
export type ToolTrace = z.infer<typeof ToolTraceSchema>;
