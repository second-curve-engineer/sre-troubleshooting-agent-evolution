// LLM Router Adapter：为低置信路由提供 mock/真实 API 两种可替换实现。
import { loadLlmConfig, LlmConfig } from "../config/env.js";
import { RouterResult, WorkflowDecisionSchema } from "../schemas/workflow.js";
import { sanitizeForLlm } from "../security/llm-safety.js";
import { resolveModelPolicy } from "./model-policy.js";
import { buildRouterSystemPrompt } from "./router-prompt.js";
import { OpenAiClient } from "./openai-client.js";
import { z } from "zod";

export type LlmRouterAdapter = {
  route(userMessage: string): Promise<RouterResult>;
};

function estimateTokens(text: string): number {
  // mock 模式没有真实 usage，这里用粗略估算保留 token 成本观念。
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockLlmRouterAdapter implements LlmRouterAdapter {
  constructor(private readonly config: LlmConfig = loadLlmConfig()) {}

  async route(userMessage: string): Promise<RouterResult> {
    // 即使是 mock router，也解析 ModelPolicy，确保 trace/eval 能看到同一套成本策略。
    const policy = resolveModelPolicy("router", this.config);
    const inputTokens = estimateTokens(userMessage);
    const lowered = userMessage.toLowerCase();
    const appHint = userMessage.includes("订单") || userMessage.includes("下单") ? "order-service" : undefined;
    const tokenUsage = {
      inputTokens,
      outputTokens: 32,
      totalTokens: inputTokens + 32
    };

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
        tokenUsage,
        llmCall: {
          role: policy.role,
          source: "mock",
          model: policy.model,
          modelTier: policy.modelTier,
          tokenBudget: policy.tokenBudget,
          timeoutMs: policy.timeoutMs,
          tokenUsage,
          notes: ["mock llm router", policy.reason]
        },
        notes: ["mock llm router", `model_policy=${policy.modelTier}:${policy.model}`]
      };
    }

    const fallbackTokenUsage = {
      inputTokens,
      outputTokens: 28,
      totalTokens: inputTokens + 28
    };
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
      tokenUsage: fallbackTokenUsage,
      llmCall: {
        role: policy.role,
        source: "mock",
        model: policy.model,
        modelTier: policy.modelTier,
        tokenBudget: policy.tokenBudget,
        timeoutMs: policy.timeoutMs,
        tokenUsage: fallbackTokenUsage,
        notes: ["mock llm router", policy.reason]
      },
      notes: ["mock llm router", `model_policy=${policy.modelTier}:${policy.model}`]
    };
  }
}

const RouterPayloadSchema = WorkflowDecisionSchema.extend({
  confidence: z.number().min(0).max(1).default(0.5)
});

// LLM 只负责给出候选路由；最终仍要经过 schema 校验，不能直接信任模型输出。
function parseRouterPayload(raw: string): {
  decision: RouterResult["decision"];
  confidence: number;
} {
  const parsed = RouterPayloadSchema.parse(JSON.parse(raw));
  const { confidence, ...decision } = parsed;
  return {
    decision,
    confidence
  };
}

function stripJsonFence(content: string): string {
  return content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

export class OpenAiRouterAdapter implements LlmRouterAdapter {
  private readonly client: OpenAiClient;

  constructor(private readonly config: LlmConfig = loadLlmConfig()) {
    this.client = new OpenAiClient(config.baseUrl, config.apiKey ?? "");
  }

  async route(userMessage: string): Promise<RouterResult> {
    // Router 的模型选择由 ModelPolicy 决定；adapter 只负责执行和记录结果。
    const policy = resolveModelPolicy("router", this.config);
    if (!this.config.apiKey) {
      return {
        decision: {
          problemType: "unknown",
          route: "clarification",
          reason: "LLM router 配置为 openai，但缺少 OPENAI_API_KEY"
        },
        source: "fallback",
        confidence: 0,
        usedLlm: false,
        llmCall: {
          role: policy.role,
          source: "fallback",
          model: policy.model,
          modelTier: policy.modelTier,
          tokenBudget: policy.tokenBudget,
          timeoutMs: policy.timeoutMs,
          error: "missing_openai_api_key",
          notes: [policy.reason]
        },
        notes: ["missing_openai_api_key", `model_policy=${policy.modelTier}:${policy.model}`]
      };
    }

    const safeUserMessage = sanitizeForLlm(userMessage);

    try {
      // 使用 OpenAI-compatible Chat Completions，便于未来切换兼容网关或其他模型供应商。
      const { content, tokenUsage } = await this.client.complete({
        model: policy.model,
        timeoutMs: policy.timeoutMs,
        responseFormat: { type: "json_object" },
        messages: [
          { role: "system", content: buildRouterSystemPrompt() },
          { role: "user", content: safeUserMessage.text }
        ]
      });

      const payload = parseRouterPayload(stripJsonFence(content));
      return {
        decision: payload.decision,
        source: "llm",
        confidence: payload.confidence,
        usedLlm: true,
        tokenUsage,
        llmCall: {
          role: policy.role,
          source: "llm",
          model: policy.model,
          modelTier: policy.modelTier,
          tokenBudget: policy.tokenBudget,
          timeoutMs: policy.timeoutMs,
          tokenUsage,
          notes: [policy.reason]
        },
        notes: [
          `openai-compatible router model=${policy.model}`,
          `model_policy=${policy.modelTier}:${policy.model}`,
          ...safeUserMessage.redactedTypes.map((type) => `redacted:${type}`),
          ...safeUserMessage.promptInjectionFindings.map((finding) => `prompt_injection:${finding.pattern}`)
        ]
      };
    } catch (error) {
      // Router 失败不能让整次诊断崩掉，降级为 clarification，保留错误原因到 trace。
      const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      return {
        decision: {
          problemType: "unknown",
          route: "clarification",
          reason: `LLM router 调用失败: ${error instanceof Error ? error.message : String(error)}`
        },
        source: "fallback",
        confidence: 0,
        usedLlm: true,
        tokenUsage: zeroUsage,
        llmCall: {
          role: policy.role,
          source: "fallback",
          model: policy.model,
          modelTier: policy.modelTier,
          tokenBudget: policy.tokenBudget,
          timeoutMs: policy.timeoutMs,
          tokenUsage: zeroUsage,
          error: error instanceof Error ? error.message : String(error),
          notes: [policy.reason]
        },
        notes: ["llm_router_error", `model_policy=${policy.modelTier}:${policy.model}`]
      };
    }
  }
}

export function createLlmRouterAdapter(): LlmRouterAdapter {
  const config = loadLlmConfig();
  // 默认 mock 保证本地 eval 可复现；显式配置 openai 时才产生真实 API 调用和 token 成本。
  if (config.mode === "openai") {
    return new OpenAiRouterAdapter(config);
  }
  return new MockLlmRouterAdapter();
}
