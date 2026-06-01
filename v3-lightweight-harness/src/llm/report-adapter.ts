// Report Adapter：默认 mock，配置开启后调用真实 OpenAI-compatible API 生成结构化诊断报告。
import { loadLlmConfig, LlmConfig } from "../config/env.js";
import { DiagnosisReport, DiagnosisReportSchema } from "../schemas/diagnosis.js";
import { EvidenceItem } from "../schemas/evidence.js";
import { ReportGenerationTrace } from "../schemas/run.js";
import { WorkflowDecision } from "../schemas/workflow.js";
import { sanitizeForLlm } from "../security/llm-safety.js";
import { generateMockDiagnosis } from "./mock-llm.js";
import { buildReportSystemPrompt, buildReportUserPrompt } from "./report-prompt.js";

export type DiagnosisGeneratorInput = {
  userMessage: string;
  decision: WorkflowDecision;
  evidence: EvidenceItem[];
};

export type DiagnosisGeneratorResult = {
  report: DiagnosisReport;
  trace: ReportGenerationTrace;
};

export type DiagnosisGenerator = {
  generate(input: DiagnosisGeneratorInput): Promise<DiagnosisGeneratorResult>;
};

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

function stripJsonFence(content: string): string {
  return content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function mockResult(input: DiagnosisGeneratorInput, trace?: Partial<ReportGenerationTrace>): DiagnosisGeneratorResult {
  return {
    report: generateMockDiagnosis({
      decision: input.decision,
      evidence: input.evidence
    }),
    trace: {
      source: trace?.source ?? "mock",
      model: trace?.model,
      tokenUsage: trace?.tokenUsage,
      error: trace?.error,
      notes: trace?.notes ?? ["mock diagnosis generator"]
    }
  };
}

export class MockDiagnosisGenerator implements DiagnosisGenerator {
  async generate(input: DiagnosisGeneratorInput): Promise<DiagnosisGeneratorResult> {
    return mockResult(input);
  }
}

export class OpenAiDiagnosisGenerator implements DiagnosisGenerator {
  constructor(private readonly config: LlmConfig = loadLlmConfig()) {}

  async generate(input: DiagnosisGeneratorInput): Promise<DiagnosisGeneratorResult> {
    if (!this.config.apiKey) {
      return mockResult(input, {
        source: "fallback",
        model: this.config.model,
        error: "LLM report 配置为 openai，但缺少 OPENAI_API_KEY",
        notes: ["missing_openai_api_key", "fallback_to_mock_report"]
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const safeUserPrompt = sanitizeForLlm(
      buildReportUserPrompt({
        userMessage: input.userMessage,
        decision: input.decision,
        evidence: input.evidence
      })
    );

    try {
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
              content: buildReportSystemPrompt()
            },
            {
              role: "user",
              content: safeUserPrompt.text
            }
          ]
        })
      });

      const data = (await response.json()) as ChatCompletionResponse & { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(data.error?.message ?? `LLM report HTTP ${response.status}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM report returned empty content");
      }

      const report = DiagnosisReportSchema.parse(JSON.parse(stripJsonFence(content)));
      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;

      return {
        report,
        trace: {
          source: "llm",
          model: this.config.model,
          tokenUsage: {
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            totalTokens: data.usage?.total_tokens ?? promptTokens + completionTokens
          },
          notes: [
            `openai-compatible report model=${this.config.model}`,
            ...safeUserPrompt.redactedTypes.map((type) => `redacted:${type}`),
            ...safeUserPrompt.promptInjectionFindings.map((finding) => `prompt_injection:${finding.pattern}`)
          ]
        }
      };
    } catch (error) {
      return mockResult(input, {
        source: "fallback",
        model: this.config.model,
        error: error instanceof Error ? error.message : String(error),
        notes: ["llm_report_error", "fallback_to_mock_report"]
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createDiagnosisGenerator(): DiagnosisGenerator {
  const config = loadLlmConfig();
  if (config.mode === "openai") {
    return new OpenAiDiagnosisGenerator(config);
  }
  return new MockDiagnosisGenerator();
}
