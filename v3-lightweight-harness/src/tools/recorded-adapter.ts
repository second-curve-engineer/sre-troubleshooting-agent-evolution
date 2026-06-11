// RecordedToolAdapter：从历史 Trace 返回固定工具结果，重放时绝不调用真实或 mock handler。
import { isDeepStrictEqual } from "node:util";
import { RunTrace } from "../schemas/trace.js";
import { ToolResult, ToolResultSchema, ToolTrace } from "../schemas/tool.js";
import {
  ToolExecutor,
  ToolInvocationArgs,
  ToolMetadata,
  ToolName,
  ToolRegistry
} from "./tool-registry.js";

type RecordedInvocation = {
  stepId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
  result: ToolResult;
  remainingAttempts: number;
};

function reconstructResult(source: RunTrace, trace: ToolTrace): ToolResult {
  const completed = source.run.completedSteps[trace.stepId];
  const parsed = ToolResultSchema.safeParse(completed);
  if (parsed.success) {
    return parsed.data;
  }

  return ToolResultSchema.parse({
    status: trace.status,
    summary: trace.error ?? `recorded ${trace.toolName} result: ${trace.status}`,
    outputSummary: trace.outputSummary,
    retryable: trace.status === "error" || trace.status === "timeout"
  });
}

export class RecordedToolAdapter implements ToolExecutor {
  private readonly delegate = new ToolRegistry();
  private readonly invocations: RecordedInvocation[];

  constructor(readonly source: RunTrace) {
    this.invocations = source.run.toolTraces
      // pending/rejected approval traces did not reach the external tool handler.
      .filter(
        (trace) =>
          !(
            trace.status === "cancelled" &&
            (trace.approvalStatus === "pending" || trace.approvalStatus === "rejected")
          )
      )
      .map((trace) => ({
        stepId: trace.stepId,
        toolName: trace.toolName as ToolName,
        input: trace.toolInput,
        result: reconstructResult(source, trace),
        remainingAttempts: trace.attemptCount
      }));
  }

  getMetadata(toolName: ToolName): ToolMetadata {
    return this.delegate.getMetadata(toolName);
  }

  validateInvocation(args: Omit<ToolInvocationArgs, "stepId">) {
    return this.delegate.validateInvocation(args);
  }

  async invoke(args: ToolInvocationArgs): Promise<ToolResult> {
    const recorded = this.invocations.find(
      (item) =>
        item.stepId === args.stepId &&
        item.toolName === args.toolName &&
        item.remainingAttempts > 0
    );
    if (!recorded) {
      throw new RecordedInvocationNotFoundError(args.stepId, args.toolName);
    }
    if (!isDeepStrictEqual(recorded.input, args.input)) {
      throw new RecordedInputMismatchError({
        stepId: args.stepId,
        toolName: args.toolName,
        expected: recorded.input,
        actual: args.input
      });
    }

    recorded.remainingAttempts -= 1;
    return structuredClone(recorded.result);
  }

  assertFullyConsumed(): void {
    const remaining = this.invocations.filter((item) => item.remainingAttempts > 0);
    if (remaining.length > 0) {
      throw new RecordedInvocationsRemainingError(
        remaining.map((item) => ({
          stepId: item.stepId,
          toolName: item.toolName,
          remainingAttempts: item.remainingAttempts
        }))
      );
    }
  }
}

export class RecordedAdapterError extends Error {}

export class RecordedInvocationNotFoundError extends RecordedAdapterError {
  constructor(readonly stepId: string, readonly toolName: ToolName) {
    super(`recorded invocation not found or exhausted: ${stepId}/${toolName}`);
  }
}

export class RecordedInputMismatchError extends RecordedAdapterError {
  constructor(
    readonly details: {
      stepId: string;
      toolName: ToolName;
      expected: Record<string, unknown>;
      actual: Record<string, unknown>;
    }
  ) {
    super(`recorded input mismatch: ${details.stepId}/${details.toolName}`);
  }
}

export class RecordedInvocationsRemainingError extends RecordedAdapterError {
  constructor(
    readonly remaining: Array<{
      stepId: string;
      toolName: ToolName;
      remainingAttempts: number;
    }>
  ) {
    super(`recorded invocations were not consumed: ${JSON.stringify(remaining)}`);
  }
}
