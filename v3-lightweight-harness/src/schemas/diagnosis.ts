// Diagnosis schema：定义最终诊断报告的结构化输出格式。
import { z } from "zod";

export const DiagnosisReportSchema = z.object({
  problemAnalysis: z.string(),
  collectedEvidence: z.array(z.string()),
  rootCause: z.string(),
  fixSuggestions: z.array(z.string()),
  verificationSteps: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  missingContext: z.array(z.string()).default([])
});

export type DiagnosisReport = z.infer<typeof DiagnosisReportSchema>;
