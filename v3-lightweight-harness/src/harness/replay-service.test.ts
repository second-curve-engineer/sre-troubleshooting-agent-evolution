import { describe, expect, it } from "vitest";
import { HarnessRunner } from "./runner.js";
import { ReplayService, UnsafeRecordedReplayError } from "./replay-service.js";
import { RunTrace } from "../schemas/trace.js";
import {
  RecordedInputMismatchError,
  RecordedInvocationNotFoundError,
  RecordedToolAdapter
} from "../tools/recorded-adapter.js";

const performanceInput = "order-service 下单接口从 10:30 开始大量 504，帮我排查。";

function asTrace(state: Awaited<ReturnType<HarnessRunner["run"]>>["state"]): RunTrace {
  return {
    version: "v3-lightweight-harness",
    createdAt: new Date().toISOString(),
    run: state
  };
}

describe("recorded replay", () => {
  it("reruns the current harness from recorded tool results", async () => {
    const sourceResult = await new HarnessRunner().run(performanceInput, "replay-source");
    const replayed = await new ReplayService().replayTrace(asTrace(sourceResult.state));

    expect(replayed.sourceRunId).toBe(sourceResult.state.runId);
    expect(replayed.state.runId).not.toBe(sourceResult.state.runId);
    expect(replayed.state.replay).toEqual({
      sourceRunId: sourceResult.state.runId,
      mode: "recorded",
      strictInputMatch: true
    });
    expect(replayed.state.toolTraces.map((trace) => [trace.stepId, trace.toolName, trace.status]))
      .toEqual(
        sourceResult.state.toolTraces.map((trace) => [
          trace.stepId,
          trace.toolName,
          trace.status
        ])
      );
    expect(replayed.state.finalReport).toEqual(sourceResult.state.finalReport);
  });

  it("fails when current tool input differs from the recorded input", async () => {
    const sourceResult = await new HarnessRunner().run(performanceInput, "replay-mismatch");
    const source = asTrace(sourceResult.state);
    const recordedLog = source.run.toolTraces.find(
      (trace) => trace.stepId === "step-performance-log-1"
    )!;
    recordedLog.toolInput = {
      ...recordedLog.toolInput,
      query: "different recorded query"
    };

    await expect(new ReplayService().replayTrace(source)).rejects.toBeInstanceOf(
      RecordedInputMismatchError
    );
  });

  it("rejects calls after the recorded attempts are exhausted", async () => {
    const sourceResult = await new HarnessRunner().run(
      "prod 环境 order-service 大量 500，trace_id 是 demo-trace-001",
      "replay-exhausted"
    );
    const source = asTrace(sourceResult.state);
    const adapter = new RecordedToolAdapter(source);
    const trace = source.run.toolTraces[0];
    const args = {
      stepId: trace.stepId,
      toolName: trace.toolName as "resolve_app",
      input: trace.toolInput,
      allowedTools: [trace.toolName as "resolve_app"]
    };

    await adapter.invoke(args);
    await expect(adapter.invoke(args)).rejects.toBeInstanceOf(
      RecordedInvocationNotFoundError
    );
  });

  it("refuses traces where a high-risk side effect was executed", async () => {
    const runner = new HarnessRunner({ approvalMode: "strict" });
    const pending = await runner.run(
      "order-service 下单接口从 10:30 开始大量 504，模拟高风险重启，帮我排查。",
      "replay-unsafe"
    );
    const approved = await runner.resume(pending.state, {
      approvalId: pending.state.pendingApprovalId!,
      decision: "approved"
    });

    await expect(new ReplayService().replayTrace(asTrace(approved.state))).rejects.toBeInstanceOf(
      UnsafeRecordedReplayError
    );
  });
});
