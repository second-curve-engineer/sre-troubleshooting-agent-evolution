// Agent Loop 查询收窄决策：mock / OpenAI 两种实现，接口与 evidence-summarizer 对齐。
// mock 降级为规则驱动（关键词匹配），openai 模式由 LLM 根据工具结果动态决策。
import { loadLlmConfig, LlmConfig } from "../config/env.js";
import { LlmCallTrace } from "../schemas/llm.js";
import { ToolResult } from "../schemas/tool.js";
import { resolveModelPolicy } from "./model-policy.js";
import { buildLoopQuerySystemPrompt, buildLoopQueryUserMessage } from "./loop-decision-prompt.js";
import { OpenAiClient } from "./openai-client.js";

export type LoopQueryRefinerInput = {
  appId: string;
  previousQuery: string;
  toolResult: ToolResult;
  iterationIndex: number;
};

export type LoopQueryRefinerOutput = {
  nextQuery: string;
  fromTime?: string;
  toTime?: string;
  reasoning: string;
  llmCall: Omit<LlmCallTrace, "spanId" | "parentSpanId" | "startTime" | "spanKind">;
};

export interface LoopQueryRefiner {
  refine(input: LoopQueryRefinerInput): Promise<LoopQueryRefinerOutput>;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function stripJsonFence(content: string): string {
  return content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

// Mock 实现：规则驱动的查询收窄，作为真实 LLM refiner 的可复现降级路径。
// 保留规则逻辑作为 fallback，确保无 API Key 时行为与改造前完全一致。
export class MockLoopQueryRefiner implements LoopQueryRefiner {
  constructor(private readonly config: LlmConfig = loadLlmConfig()) {}

  async refine(input: LoopQueryRefinerInput): Promise<LoopQueryRefinerOutput> {
    const policy = resolveModelPolicy("loop_query_refiner", this.config);
    const { previousQuery, toolResult } = input;
    const suggested = toolResult.suggestedNextQueries ?? [];
    const keywords = (toolResult.detectedKeywords ?? []).map((k) => k.toLowerCase());
    const timeDistribution = (toolResult.outputSummary as Record<string, unknown>)?.timeDistribution as
      | { suggestedFromTime: string; suggestedToTime: string; peakMinute: string }
      | undefined;

    let nextQuery: string;
    let fromTime: string | undefined;
    let toTime: string | undefined;
    let reasoning: string;

    if (suggested.length > 0) {
      nextQuery = suggested[0];
      reasoning = "采用工具建议的 suggestedNextQueries[0]";
    } else if (keywords.some((k) => k.includes("sql"))) {
      nextQuery = `${previousQuery} and log.msg ~ 'SQL'`;
      reasoning = "检测到 SQL 关键词，收窄到 SQL 相关日志";
    } else if (keywords.some((k) => k.includes("timeout"))) {
      nextQuery = `${previousQuery} and log.msg ~ 'timeout'`;
      reasoning = "检测到 timeout 关键词，收窄到超时相关日志";
    } else if (timeDistribution) {
      nextQuery = previousQuery;
      fromTime = timeDistribution.suggestedFromTime;
      toTime = timeDistribution.suggestedToTime;
      reasoning = `按时间分布收窄到峰值窗口 ${timeDistribution.peakMinute} 附近`;
    } else {
      nextQuery = `${previousQuery} and log.level = 'ERROR'`;
      reasoning = "结果不满足条件，收窄到 ERROR 级别日志";
    }

    const inputTokens = estimateTokens(JSON.stringify(input));
    const tokenUsage = { inputTokens, outputTokens: 20, totalTokens: inputTokens + 20 };

    return {
      nextQuery,
      fromTime,
      toTime,
      reasoning,
      llmCall: {
        role: "loop_query_refiner",
        source: "mock",
        model: policy.model,
        modelTier: policy.modelTier,
        tokenBudget: policy.tokenBudget,
        timeoutMs: policy.timeoutMs,
        tokenUsage,
        notes: ["mock loop query refiner", policy.reason]
      }
    };
  }
}

// OpenAI 实现：LLM 观察工具输出后动态决策下一步查询，失败时自动降级为 mock 规则。
export class OpenAiLoopQueryRefiner implements LoopQueryRefiner {
  private readonly client: OpenAiClient;
  private readonly mock: MockLoopQueryRefiner;

  constructor(private readonly config: LlmConfig = loadLlmConfig()) {
    this.client = new OpenAiClient(config.baseUrl, config.apiKey ?? "");
    this.mock = new MockLoopQueryRefiner(config);
  }

  async refine(input: LoopQueryRefinerInput): Promise<LoopQueryRefinerOutput> {
    const policy = resolveModelPolicy("loop_query_refiner", this.config);

    if (!this.config.apiKey) {
      return this.mock.refine(input);
    }

    try {
      const { content, tokenUsage } = await this.client.complete({
        model: policy.model,
        timeoutMs: policy.timeoutMs,
        responseFormat: { type: "json_object" },
        messages: [
          { role: "system", content: buildLoopQuerySystemPrompt() },
          {
            role: "user",
            content: buildLoopQueryUserMessage({
              previousQuery: input.previousQuery,
              toolResult: input.toolResult,
              iterationIndex: input.iterationIndex
            })
          }
        ]
      });

      const parsed = JSON.parse(stripJsonFence(content)) as {
        nextQuery?: string;
        fromTime?: string;
        toTime?: string;
        reasoning?: string;
      };
      const nextQuery = parsed.nextQuery?.trim() || input.previousQuery;
      const reasoning = parsed.reasoning?.trim() || "LLM 决策";

      return {
        nextQuery,
        fromTime: parsed.fromTime?.trim() || undefined,
        toTime: parsed.toTime?.trim() || undefined,
        reasoning,
        llmCall: {
          role: "loop_query_refiner",
          source: "llm",
          model: policy.model,
          modelTier: policy.modelTier,
          tokenBudget: policy.tokenBudget,
          timeoutMs: policy.timeoutMs,
          tokenUsage,
          notes: [policy.reason]
        }
      };
    } catch (error) {
      // LLM 调用失败，降级为 mock 规则，确保 loop 不因 refiner 失败而中断。
      const fallback = await this.mock.refine(input);
      return {
        ...fallback,
        llmCall: {
          ...fallback.llmCall,
          source: "fallback",
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }
}

export function createLoopQueryRefiner(): LoopQueryRefiner {
  const config = loadLlmConfig();
  if (config.mode === "openai") {
    return new OpenAiLoopQueryRefiner(config);
  }
  return new MockLoopQueryRefiner();
}
