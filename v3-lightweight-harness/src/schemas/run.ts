import { z } from "zod";
import { AppInfoSchema } from "./app.js";
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
  evidence: z.array(EvidenceItemSchema).default([]),
  toolTraces: z.array(ToolTraceSchema).default([]),
  finalReport: DiagnosisReportSchema.optional()
});

export type RunState = z.infer<typeof RunStateSchema>;
