// Evidence Summarizer：调用小模型对工具原始输出做语义提炼，替代字符串模板拼接。
// mock 模式降级为 ToolResult.summary，保证 eval 可在无 API Key 时正常运行。
import { loadLlmConfig, LlmConfig } from "../config/env.js";
import { ToolResult } from "../schemas/tool.js";
import { resolveModelPolicy } from "./model-policy.js";
import { OpenAiClient } from "./openai-client.js";

export type EvidenceSummarizerInput = {
  toolName: string;
  appId?: string;
  query?: string;
  toolResult: ToolResult;
};

export type EvidenceSummarizer = {
  summarize(input: EvidenceSummarizerInput): Promise<string>;
};

const SYSTEM_PROMPT = [
  "你是 SRE 故障排查 Agent 的证据摘要生成器。",
  "给你一次工具查询的原始结果，提炼出对根因分析最有价值的 1-3 句关键发现。",
  "要求：",
  "- 重点关注：错误类型、发生频率、涉及的服务或接口、异常模式、关键数值",
  "- 如有 SQL 慢查询，说明耗时和涉及的表",
  "- 如有异常栈，说明异常类型和发生位置",
  "- 如果数据为空或工具失败，简短说明原因和影响",
  "- 输出纯文本，不要 JSON 或 Markdown"
].join("\n");

function buildUserPrompt(input: EvidenceSummarizerInput): string {
  // mechanicalSummary = ToolResult.summary，工具层按模板生成的固定描述。
  // LLM 以此为基础做语义提炼，输出更有诊断价值的自然语言摘要。
  return JSON.stringify(
    {
      toolName: input.toolName,
      appId: input.appId,
      query: input.query,
      status: input.toolResult.status,
      mechanicalSummary: input.toolResult.summary,
      detectedKeywords: input.toolResult.detectedKeywords,
      outputSummary: input.toolResult.outputSummary,
      data: input.toolResult.data
    },
    null,
    2
  );
}

// 以下状态无需语义提炼，直接复用工具层的机械摘要。
const SKIP_STATUSES = new Set(["error", "timeout", "cancelled"]);

export class MockEvidenceSummarizer implements EvidenceSummarizer {
  async summarize(input: EvidenceSummarizerInput): Promise<string> {
    // mock 模式：直接返回工具层的机械 summary，不调 LLM。
    return input.toolResult.summary;
  }
}

export class OpenAiEvidenceSummarizer implements EvidenceSummarizer {
  private readonly client: OpenAiClient;

  constructor(private readonly config: LlmConfig = loadLlmConfig()) {
    this.client = new OpenAiClient(config.baseUrl, config.apiKey ?? "");
  }

  async summarize(input: EvidenceSummarizerInput): Promise<string> {
    // error/timeout/cancelled 没有有效数据，机械摘要已足够。
    if (SKIP_STATUSES.has(input.toolResult.status)) {
      return input.toolResult.summary;
    }
    if (!this.config.apiKey) {
      return input.toolResult.summary;
    }

    // evidence_summarizer 使用 small tier，控制成本；budget 2000 足够 1-3 句摘要。
    const policy = resolveModelPolicy("evidence_summarizer", this.config);

    try {
      const result = await this.client.complete({
        model: policy.model,
        timeoutMs: policy.timeoutMs,
        maxTokens: 300,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) }
        ]
      });
      return result.content.trim() || input.toolResult.summary;
    } catch {
      // LLM 调用失败，降级为机械摘要，不让单次摘要失败影响整体排查。
      return input.toolResult.summary;
    }
  }
}

export function createEvidenceSummarizer(): EvidenceSummarizer {
  const config = loadLlmConfig();
  if (config.mode === "openai") {
    return new OpenAiEvidenceSummarizer(config);
  }
  return new MockEvidenceSummarizer();
}
