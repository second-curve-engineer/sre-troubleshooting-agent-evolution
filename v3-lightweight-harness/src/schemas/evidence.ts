// Evidence schema：定义诊断过程中沉淀的证据项，连接 tool output 和 final report。
import { z } from "zod";

export const EvidenceItemSchema = z.object({
  id: z.string(),
  source: z.string(),
  kind: z.enum(["app", "log", "trace", "slow_query", "code", "system"]),
  summary: z.string(),
  rawRef: z.string().optional(),
  safetyFlags: z.array(z.string()).default([]),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  usedInFinalReport: z.boolean().default(true)
});

export type EvidenceInput = z.input<typeof EvidenceItemSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
