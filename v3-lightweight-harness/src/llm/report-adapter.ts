// Report Adapter：默认 mock，配置开启后调用真实 OpenAI-compatible API 生成结构化诊断报告。
import { loadLlmConfig, LlmConfig } from "../config/env.js";
import { DiagnosisReport, DiagnosisReportSchema } from "../schemas/diagnosis.js";
import { EvidenceItem } from "../schemas/evidence.js";
import { ReportGenerationTrace } from "../schemas/run.js";
import { WorkflowDecision } from "../schemas/workflow.js";
import { sanitizeForLlm } from "../security/llm-safety.js";
import { resolveModelPolicy, ResolvedModelPolicy } from "./model-policy.js";
import { generateMockDiagnosis } from "./mock-llm.js";
import { buildReportSystemPrompt, buildReportUserPrompt } from "./report-prompt.js";
import { OpenAiClient } from "./openai-client.js";

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

function stripJsonFence(content: string): string {
  return content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function mockResult(
  input: DiagnosisGeneratorInput,
  policy: ResolvedModelPolicy,
  trace?: Partial<ReportGenerationTrace>
): DiagnosisGeneratorResult {
  // reportGeneration 保留报告生成视角；llmCall 用于 RunState.llmCalls[] 统一汇总成本和模型策略。
  const source = trace?.source ?? "mock";
  const model = trace?.model ?? policy.model;
  const notes = trace?.notes ?? ["mock diagnosis generator", policy.reason];
  return {
    report: generateMockDiagnosis({
      decision: input.decision,
      evidence: input.evidence
    }),
    trace: {
      source,
      role: "report",
      model,
      modelTier: policy.modelTier,
      tokenBudget: policy.tokenBudget,
      timeoutMs: policy.timeoutMs,
      tokenUsage: trace?.tokenUsage,
      error: trace?.error,
      notes,
      llmCall: {
        role: "report",
        source,
        model,
        modelTier: policy.modelTier,
        tokenBudget: policy.tokenBudget,
        timeoutMs: policy.timeoutMs,
        tokenUsage: trace?.tokenUsage,
        error: trace?.error,
        notes
      }
    }
  };
}

export class MockDiagnosisGenerator implements DiagnosisGenerator {
  constructor(private readonly config: LlmConfig = loadLlmConfig()) {}

  async generate(input: DiagnosisGeneratorInput): Promise<DiagnosisGeneratorResult> {
    // mock report 也走 ModelPolicy，保证本地 eval 能验证生产时同一套预算字段。
    const policy = resolveModelPolicy("report", this.config, {
      route: input.decision.route,
      evidenceCount: input.evidence.length
    });
    return mockResult(input, policy);
  }
}

export class OpenAiDiagnosisGenerator implements DiagnosisGenerator {
  private readonly client: OpenAiClient;

  constructor(private readonly config: LlmConfig = loadLlmConfig()) {
    this.client = new OpenAiClient(config.baseUrl, config.apiKey ?? "");
  }

  async generate(input: DiagnosisGeneratorInput): Promise<DiagnosisGeneratorResult> {
    // Report 的模型档位、预算和超时由 ModelPolicy 决定，不在 adapter 中写死。
    const policy = resolveModelPolicy("report", this.config, {
      route: input.decision.route,
      evidenceCount: input.evidence.length
    });

    if (!this.config.apiKey) {
      return mockResult(input, policy, {
        source: "fallback",
        model: policy.model,
        error: "LLM report 配置为 openai，但缺少 OPENAI_API_KEY",
        notes: ["missing_openai_api_key", "fallback_to_mock_report", policy.reason]
      });
    }

    const safeUserPrompt = sanitizeForLlm(
      buildReportUserPrompt({
        userMessage: input.userMessage,
        decision: input.decision,
        evidence: input.evidence
      })
    );

    try {
      const { content, tokenUsage } = await this.client.complete({
        model: policy.model,
        timeoutMs: policy.timeoutMs,
        responseFormat: { type: "json_object" },
        messages: [
          { role: "system", content: buildReportSystemPrompt() },
          { role: "user", content: safeUserPrompt.text }
        ]
      });

      const report = DiagnosisReportSchema.parse(JSON.parse(stripJsonFence(content)));
      return {
        report,
        trace: {
          source: "llm",
          role: "report",
          model: policy.model,
          modelTier: policy.modelTier,
          tokenBudget: policy.tokenBudget,
          timeoutMs: policy.timeoutMs,
          tokenUsage,
          llmCall: {
            role: "report",
            source: "llm",
            model: policy.model,
            modelTier: policy.modelTier,
            tokenBudget: policy.tokenBudget,
            timeoutMs: policy.timeoutMs,
            tokenUsage,
            notes: [policy.reason]
          },
          notes: [
            `openai-compatible report model=${policy.model}`,
            `model_policy=${policy.modelTier}:${policy.model}`,
            policy.reason,
            ...safeUserPrompt.redactedTypes.map((type) => `redacted:${type}`),
            ...safeUserPrompt.promptInjectionFindings.map((finding) => `prompt_injection:${finding.pattern}`)
          ]
        }
      };
    } catch (error) {
      return mockResult(input, policy, {
        source: "fallback",
        model: policy.model,
        error: error instanceof Error ? error.message : String(error),
        notes: ["llm_report_error", "fallback_to_mock_report", policy.reason]
      });
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
