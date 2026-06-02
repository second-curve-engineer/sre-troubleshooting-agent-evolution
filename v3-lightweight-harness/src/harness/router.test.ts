// Router 单测：验证高置信规则不调用 LLM、低置信输入会进入 LLM/fallback。
import { describe, expect, it } from "vitest";
import { routeWorkflow } from "./router.js";

describe("routeWorkflow", () => {
  it("routes trace_id problems to trace diagnosis without LLM", async () => {
    const result = await routeWorkflow(
      "prod 环境 order-service 下单接口大量 500，trace_id 是 demo-trace-001"
    );

    const decision = result.decision;
    expect(decision.route).toBe("trace-diagnosis");
    expect(decision.problemType).toBe("interface_error");
    expect(decision.traceId).toBe("demo-trace-001");
    expect(result.usedLlm).toBe(false);
  });

  it("routes 504 problems to performance workflow without LLM", async () => {
    const result = await routeWorkflow("order-service 下单接口从 10:30 开始大量 504");

    const decision = result.decision;
    expect(decision.route).toBe("performance");
    expect(decision.problemType).toBe("performance");
    expect(result.usedLlm).toBe(false);
  });

  it("uses LLM router for low-confidence ambiguous input", async () => {
    const result = await routeWorkflow("订单接口有点卡住，帮我看看");

    expect(result.decision.route).toBe("performance");
    expect(result.usedLlm).toBe(true);
    expect(result.tokenUsage?.totalTokens).toBeGreaterThan(0);
    expect(result.llmCall?.role).toBe("router");
    expect(result.llmCall?.modelTier).toBe("small");
    expect(result.llmCall?.tokenBudget).toBe(1000);
  });

  it("falls back to clarification when LLM router is low confidence", async () => {
    const result = await routeWorkflow("线上接口好像有问题，帮我看看");

    expect(result.decision.route).toBe("clarification");
    expect(result.decision.problemType).toBe("unknown");
    expect(result.usedLlm).toBe(true);
  });
});
