// Per-tool input schemas：在审批和执行前约束参数，避免依赖 handler 内的宽松类型转换。
import { isAbsolute } from "node:path";
import { z } from "zod";

const NonEmptyTextSchema = z.string().trim().min(1).max(4000);
const IdentifierSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/);
const EnvironmentSchema = z.enum(["prod", "staging", "test", "dev"]).default("prod");
const TimeSchema = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/,
    "must be an ISO-like timestamp"
  );

const SimulationControlShape = {
  __simulateDelayMs: z.number().int().min(0).max(10_000).optional(),
  __simulateFailure: z.boolean().optional()
};

function hasParentTraversal(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").includes("..");
}

const RelativeCodebasePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((path) => !isAbsolute(path), "must be relative to the project root")
  .refine((path) => !hasParentTraversal(path), "must not contain parent-directory traversal");

function validateTimeWindow(
  value: { fromTime?: string; toTime?: string },
  context: z.RefinementCtx
): void {
  if (value.fromTime && value.toTime && Date.parse(value.fromTime) > Date.parse(value.toTime)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["toTime"],
      message: "must be greater than or equal to fromTime"
    });
  }
}

export const ResolveAppInputSchema = z
  .object({
    query: NonEmptyTextSchema.max(500),
    ...SimulationControlShape
  })
  .strict();

export const QueryLogsByTraceIdInputSchema = z
  .object({
    traceId: IdentifierSchema,
    env: EnvironmentSchema,
    ...SimulationControlShape
  })
  .strict();

export const QueryLogsByConditionInputSchema = z
  .object({
    appId: IdentifierSchema,
    query: NonEmptyTextSchema,
    fromTime: TimeSchema.optional(),
    toTime: TimeSchema.optional(),
    env: EnvironmentSchema,
    limit: z.number().int().min(1).max(100).default(20),
    __simulateSensitiveLog: z.boolean().optional(),
    __simulatePromptInjectionLog: z.boolean().optional(),
    __simulateAlwaysTooMany: z.boolean().optional(),
    ...SimulationControlShape
  })
  .strict()
  .superRefine(validateTimeWindow);

export const QueryMysqlSlowLogInputSchema = z
  .object({
    dbNames: z.array(IdentifierSchema).min(1).max(10),
    query: NonEmptyTextSchema.optional(),
    fromTime: TimeSchema.optional(),
    toTime: TimeSchema.optional(),
    env: EnvironmentSchema,
    ...SimulationControlShape
  })
  .strict()
  .superRefine(validateTimeWindow);

export const AskCodebaseInputSchema = z
  .object({
    appId: IdentifierSchema,
    codebasePath: RelativeCodebasePathSchema.optional(),
    question: NonEmptyTextSchema.max(1000),
    stackTrace: NonEmptyTextSchema.max(50_000).optional(),
    ...SimulationControlShape
  })
  .strict();

export const RestartServiceInputSchema = z
  .object({
    appId: IdentifierSchema,
    reason: z.string().trim().min(10).max(500),
    ...SimulationControlShape
  })
  .strict();

export const ToolInputSchemas = {
  resolve_app: ResolveAppInputSchema,
  query_logs_by_trace_id: QueryLogsByTraceIdInputSchema,
  query_logs_by_condition: QueryLogsByConditionInputSchema,
  query_mysql_slow_log: QueryMysqlSlowLogInputSchema,
  ask_codebase: AskCodebaseInputSchema,
  restart_service: RestartServiceInputSchema
} as const;

export type ToolInputValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export function formatToolInputIssues(error: z.ZodError): ToolInputValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    code: issue.code,
    message: issue.message
  }));
}
