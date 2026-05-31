import { z } from "zod";

export const EvidenceItemSchema = z.object({
  id: z.string(),
  source: z.string(),
  kind: z.enum(["app", "log", "trace", "slow_query", "code", "system"]),
  summary: z.string(),
  rawRef: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  usedInFinalReport: z.boolean().default(true)
});

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
