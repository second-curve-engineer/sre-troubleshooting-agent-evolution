// HITL 单测：验证高风险工具会暂停 run，并能在审批后 resume 或拒绝。
import { describe, expect, it } from "vitest";
import { HarnessRunner } from "./runner.js";

const highRiskInput = "order-service 下单接口从 10:30 开始大量 504，模拟高风险重启，帮我排查。";

describe("HITL pending-resume", () => {
  it("pauses on high-risk tools and resumes after approval", async () => {
    const runner = new HarnessRunner({ approvalMode: "strict" });
    const pending = await runner.run(highRiskInput, "hitl-approve");

    expect(pending.state.status).toBe("waiting_approval");
    expect(pending.state.pendingApprovalId).toBeTruthy();
    expect(pending.state.approvals.some((approval) => approval.status === "pending")).toBe(true);
    expect(
      pending.state.toolTraces.some(
        (trace) => trace.toolName === "restart_service" && trace.approvalStatus === "pending"
      )
    ).toBe(true);

    const resumed = await runner.resume(pending.state, {
      approvalId: pending.state.pendingApprovalId!,
      decision: "approved"
    });

    expect(resumed.state.status).toBe("completed");
    expect(
      resumed.state.toolTraces.some(
        (trace) => trace.toolName === "restart_service" && trace.status === "ok"
      )
    ).toBe(true);
  });

  it("does not execute high-risk tools after rejection", async () => {
    const runner = new HarnessRunner({ approvalMode: "strict" });
    const pending = await runner.run(highRiskInput, "hitl-reject");
    const rejected = await runner.resume(pending.state, {
      approvalId: pending.state.pendingApprovalId!,
      decision: "rejected"
    });

    expect(rejected.state.status).toBe("completed");
    expect(
      rejected.state.approvals.some(
        (approval) => approval.toolName === "restart_service" && approval.status === "rejected"
      )
    ).toBe(true);
    expect(
      rejected.state.toolTraces.some(
        (trace) => trace.toolName === "restart_service" && trace.status === "ok"
      )
    ).toBe(false);
    expect(rejected.state.finalReport?.confidence).toBe("low");
  });
});
