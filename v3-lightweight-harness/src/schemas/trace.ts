// Trace schema：定义持久化 run trace 的整体结构，便于复盘和离线评测。
import { z } from "zod";
import { RunStateSchema } from "./run.js";

export const RunTraceSchema = z.object({
  version: z.literal("v3-lightweight-harness"),
  createdAt: z.string(),
  run: RunStateSchema
});

export type RunTrace = z.infer<typeof RunTraceSchema>;
