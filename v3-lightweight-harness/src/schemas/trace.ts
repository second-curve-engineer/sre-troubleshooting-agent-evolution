import { z } from "zod";
import { RunStateSchema } from "./run.js";

export const RunTraceSchema = z.object({
  version: z.literal("v3-lightweight-harness"),
  createdAt: z.string(),
  run: RunStateSchema
});

export type RunTrace = z.infer<typeof RunTraceSchema>;
