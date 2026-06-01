import { loadLlmRouterConfig, LlmRouterConfig } from "../config/env.js";
import { RouterResult, WorkflowDecisionSchema } from "../schemas/workflow.js";
import { z } from "zod";

export type LlmRouterAdapter = {
  route(userMessage: string): Promise<RouterResult>;
};

function estimateTokens(text: string): number {
  // mock 模式没有真实 usage，这里用粗略估算保留 token 成本观念。
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

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

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
  constructor(private readonly config: LlmRouterConfig = loadLlmRouterConfig()) {}

  async route(userMessage: string): Promise<RouterResult> {
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
        notes: ["missing_openai_api_key"]
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      // 使用 OpenAI-compatible Chat Completions，便于未来切换兼容网关或其他模型供应商。
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "你是线上故障排查 Agent 的 router。",
                "只输出 JSON，不要输出 Markdown。",
                "JSON 字段必须包含 problemType, route, reason, confidence。",
                "problemType 只能是 interface_error, performance, unknown。",
                "route 只能是 trace-diagnosis, condition-log, performance, clarification。",
                "如果信息不足，route=clarification。",
                "如果能提取 appHint 或 traceId，可以附加这些字段。"
              ].join("\n")
            },
            {
              role: "user",
              content: userMessage
            }
          ]
        })
      });

      const data = (await response.json()) as ChatCompletionResponse & { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(data.error?.message ?? `LLM router HTTP ${response.status}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM router returned empty content");
      }

      const payload = parseRouterPayload(stripJsonFence(content));
      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;

      return {
        decision: payload.decision,
        source: "llm",
        confidence: payload.confidence,
        usedLlm: true,
        tokenUsage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens: data.usage?.total_tokens ?? promptTokens + completionTokens
        },
        notes: [`openai-compatible router model=${this.config.model}`]
      };
    } catch (error) {
      // Router 失败不能让整次诊断崩掉，降级为 clarification，保留错误原因到 trace。
      return {
        decision: {
          problemType: "unknown",
          route: "clarification",
          reason: `LLM router 调用失败: ${error instanceof Error ? error.message : String(error)}`
        },
        source: "fallback",
        confidence: 0,
        usedLlm: true,
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0
        },
        notes: ["llm_router_error"]
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createLlmRouterAdapter(): LlmRouterAdapter {
  const config = loadLlmRouterConfig();
  // 默认 mock 保证本地 eval 可复现；显式配置 openai 时才产生真实 API 调用和 token 成本。
  if (config.mode === "openai") {
    return new OpenAiRouterAdapter(config);
  }
  return new MockLlmRouterAdapter();
}
