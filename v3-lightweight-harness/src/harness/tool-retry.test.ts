import { describe, expect, it } from "vitest";
import { HarnessRunner } from "./runner.js";

describe("tool technical retry", () => {
  it("retries timeout failures with the same logical tool call", async () => {
    const runner = new HarnessRunner({
      toolExecution: {
        timeoutMs: 20,
        maxAttempts: 2,
        retryDelayMs: 0
      }
    });

    const { state } = await runner.run(
      "order-service 下单接口从 10:30 开始大量 504，模拟日志平台超时，帮我排查。"
    );
    const logTrace = state.toolTraces.find(
      (trace) => trace.toolName === "query_logs_by_condition"
    );

    expect(logTrace?.status).toBe("timeout");
    expect(logTrace?.attemptCount).toBe(2);
    expect(state.evidence.some((item) => item.summary.includes("tool_failure"))).toBe(true);
  });
});
