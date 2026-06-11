import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRunner } from "./runner.js";
import {
  PendingRunNotFoundError,
  PendingRunStore
} from "./pending-run-store.js";

const highRiskInput =
  "order-service 下单接口从 10:30 开始大量 504，模拟高风险重启，帮我排查。";

describe("PendingRunStore cross-process resume", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    );
  });

  async function createStore(): Promise<PendingRunStore> {
    const directory = await mkdtemp(join(tmpdir(), "pending-run-store-"));
    temporaryDirectories.push(directory);
    return new PendingRunStore(directory);
  }

  it("resumes with a new runner and does not repeat completed steps", async () => {
    const store = await createStore();
    const firstProcess = new HarnessRunner({
      approvalMode: "strict",
      pendingRunStore: store
    });
    const pending = await firstProcess.run(highRiskInput, "cross-process-approve");
    const approvalId = pending.state.pendingApprovalId!;
    const tracesBeforeResume = pending.state.toolTraces.map((trace) => ({
      stepId: trace.stepId,
      toolName: trace.toolName,
      status: trace.status
    }));

    expect(pending.state.status).toBe("waiting_approval");
    expect((await store.read(approvalId))?.state.runId).toBe(pending.state.runId);

    // 新 Runner 实例模拟服务重启后的新进程，不复用 firstProcess 的内存状态。
    const secondProcess = new HarnessRunner({
      approvalMode: "strict",
      pendingRunStore: store
    });
    const resumed = await secondProcess.resumePending(approvalId, "approved");

    expect(resumed.state.status).toBe("completed");
    expect(resumed.state.runId).toBe(pending.state.runId);
    expect(await store.read(approvalId)).toBeNull();
    expect(
      resumed.state.toolTraces.filter(
        (trace) => trace.toolName === "restart_service" && trace.status === "ok"
      )
    ).toHaveLength(1);

    for (const prior of tracesBeforeResume.filter((trace) => trace.toolName !== "restart_service")) {
      expect(
        resumed.state.toolTraces.filter(
          (trace) =>
            trace.stepId === prior.stepId &&
            trace.toolName === prior.toolName &&
            trace.status === prior.status
        )
      ).toHaveLength(1);
    }

    await expect(secondProcess.resumePending(approvalId, "approved")).rejects.toBeInstanceOf(
      PendingRunNotFoundError
    );
  });

  it("persists rejection and removes the pending record", async () => {
    const store = await createStore();
    const firstProcess = new HarnessRunner({
      approvalMode: "strict",
      pendingRunStore: store
    });
    const pending = await firstProcess.run(highRiskInput, "cross-process-reject");
    const approvalId = pending.state.pendingApprovalId!;

    const secondProcess = new HarnessRunner({
      approvalMode: "strict",
      pendingRunStore: store
    });
    const rejected = await secondProcess.resumePending(approvalId, "rejected");

    expect(rejected.state.status).toBe("completed");
    expect(rejected.state.finalReport?.confidence).toBe("low");
    expect(
      rejected.state.approvals.some(
        (approval) => approval.approvalId === approvalId && approval.status === "rejected"
      )
    ).toBe(true);
    expect(await store.read(approvalId)).toBeNull();
  });
});
