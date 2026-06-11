// ReplayService：读取历史 Trace，用 RecordedToolAdapter 重跑当前 Harness。
import { HarnessRunner } from "./runner.js";
import { TraceStore } from "./trace-store.js";
import { RunTrace } from "../schemas/trace.js";
import { RecordedToolAdapter } from "../tools/recorded-adapter.js";

export type ReplayResult = Awaited<ReturnType<HarnessRunner["run"]>> & {
  sourceRunId: string;
};

export class ReplayService {
  constructor(private readonly traces = new TraceStore()) {}

  async replay(runId: string): Promise<ReplayResult> {
    const source = await this.traces.read(runId);
    return this.replayTrace(source);
  }

  async replayTrace(source: RunTrace): Promise<ReplayResult> {
    this.assertReplaySafe(source);
    const adapter = new RecordedToolAdapter(source);
    const runner = new HarnessRunner({
      approvalMode: "auto",
      toolExecutor: adapter
    });
    const result = await runner.run(
      source.run.userMessage,
      `replay-${source.run.runId}`,
      { replayOfRunId: source.run.runId }
    );
    return {
      ...result,
      sourceRunId: source.run.runId
    };
  }

  private assertReplaySafe(source: RunTrace): void {
    const executedSideEffects = source.run.toolTraces.filter(
      (trace) =>
        (trace.riskLevel === "high" || trace.riskLevel === "critical") &&
        trace.status === "ok"
    );
    if (executedSideEffects.length > 0) {
      throw new UnsafeRecordedReplayError(
        source.run.runId,
        executedSideEffects.map((trace) => `${trace.stepId}/${trace.toolName}`)
      );
    }
  }
}

export class UnsafeRecordedReplayError extends Error {
  constructor(readonly sourceRunId: string, readonly tools: string[]) {
    super(`recorded replay refuses executed high-risk tools: ${tools.join(", ")}`);
  }
}
