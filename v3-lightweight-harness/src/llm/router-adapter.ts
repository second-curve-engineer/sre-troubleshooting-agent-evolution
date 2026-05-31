import { RouterResult } from "../schemas/workflow.js";

export type LlmRouterAdapter = {
  route(userMessage: string): Promise<RouterResult>;
};

function estimateTokens(text: string): number {
  // Coarse deterministic estimate for mock cost accounting.
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockLlmRouterAdapter implements LlmRouterAdapter {
  async route(userMessage: string): Promise<RouterResult> {
    const inputTokens = estimateTokens(userMessage);
    const lowered = userMessage.toLowerCase();
    const appHint = userMessage.includes("订单") || userMessage.includes("下单") ? "order-service" : undefined;

    if (lowered.includes("卡住") || lowered.includes("慢") || lowered.includes("超时")) {
      return {
        decision: {
          problemType: "performance",
          route: "performance",
          reason: "LLM router 判断用户在描述性能或超时类问题",
          appHint
        },
        source: "llm",
        confidence: 0.82,
        usedLlm: true,
        tokenUsage: {
          inputTokens,
          outputTokens: 32,
          totalTokens: inputTokens + 32
        },
        notes: ["mock llm router"]
      };
    }

    return {
      decision: {
        problemType: "unknown",
        route: "clarification",
        reason: "LLM router 未能高置信判断故障类型",
        appHint
      },
      source: "llm",
      confidence: 0.45,
      usedLlm: true,
      tokenUsage: {
        inputTokens,
        outputTokens: 28,
        totalTokens: inputTokens + 28
      },
      notes: ["mock llm router"]
    };
  }
}
