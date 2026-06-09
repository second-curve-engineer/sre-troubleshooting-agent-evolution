// Judge Evaluator：LLM-as-judge，离线评估诊断报告质量。
// 仅在 eval pipeline 中调用，不出现在生产推理路径。
// mock 模式返回固定高分，保证 eval 在无 API Key 时可运行。
import { loadLlmConfig, LlmConfig } from "../config/env.js";
import { DiagnosisReport } from "../schemas/diagnosis.js";
import { resolveModelPolicy } from "./model-policy.js";
import { OpenAiClient } from "./openai-client.js";

// ---------- 输入 / 输出类型 ----------

export type JudgeEvaluatorInput = {
  /** 用户原始问题 */
  userMessage: string;
  /** Agent 生成的最终诊断报告 */
  finalReport: DiagnosisReport;
  /** 本次排查收集到的全部证据摘要 */
  evidence: Array<{ source: string; summary: string }>;
};

export type JudgeEvaluatorOutput = {
  /** 0.0 – 1.0，证据支撑度评分 */
  score: number;
  /** judge 的推理过程（1-3 句） */
  reasoning: string;
  /** score >= PASS_THRESHOLD 则视为通过 */
  passed: boolean;
};

export interface JudgeEvaluator {
  evaluate(input: JudgeEvaluatorInput): Promise<JudgeEvaluatorOutput>;
}

// ---------- 常量 ----------

const PASS_THRESHOLD = 0.6;

const SYSTEM_PROMPT = [
  "你是 SRE 故障诊断报告的质量评审员。",
  "给你一份 AI Agent 生成的诊断报告和本次排查收集到的原始证据，",
  "评估报告的根因结论（rootCause）是否有充分的证据支撑，以及修复建议（fixSuggestions）是否合理。",
  "",
  "评分标准（0.0 – 1.0）：",
  "1.0 — 根因直接引用了具体证据（服务名、异常类型、SQL 等），逻辑链完整，建议可操作",
  "0.8 — 根因有合理依据，但部分细节未精确引用证据",
  "0.6 — 根因基本正确，依据较模糊，或建议过于笼统",
  "0.4 — 根因部分正确，或结论超出证据范围",
  "0.2 — 根因与证据关联很弱，推断依据不足",
  "0.0 — 根因完全没有证据支撑，或明显错误",
  "",
  "严格按 JSON 格式输出，不要 Markdown 代码块：",
  '{"score": 0.8, "reasoning": "..."}'
].join("\n");

function buildUserPrompt(input: JudgeEvaluatorInput): string {
  return JSON.stringify(
    {
      userMessage: input.userMessage,
      evidence: input.evidence,
      finalReport: {
        problemAnalysis: input.finalReport.problemAnalysis,
        rootCause: input.finalReport.rootCause,
        fixSuggestions: input.finalReport.fixSuggestions,
        confidence: input.finalReport.confidence
      }
    },
    null,
    2
  );
}

type JudgeRaw = { score?: unknown; reasoning?: unknown };

function parseJudgeResponse(content: string): { score: number; reasoning: string } | null {
  try {
    // 去掉可能的 markdown code fence
    const cleaned = content.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as JudgeRaw;
    const score = typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : String(parsed.reasoning ?? "");
    if (Number.isFinite(score) && score >= 0 && score <= 1) {
      return { score, reasoning };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- Mock 实现 ----------

export class MockJudgeEvaluator implements JudgeEvaluator {
  async evaluate(_input: JudgeEvaluatorInput): Promise<JudgeEvaluatorOutput> {
    // mock 模式：不调 LLM，直接返回 "通过" 占位，保证 eval 在无 API Key 时能正常跑完
    return {
      score: 1.0,
      reasoning: "[mock] judge skipped in mock mode",
      passed: true
    };
  }
}

// ---------- OpenAI 实现 ----------

export class OpenAiJudgeEvaluator implements JudgeEvaluator {
  private readonly client: OpenAiClient;

  constructor(private readonly config: LlmConfig = loadLlmConfig()) {
    this.client = new OpenAiClient(config.baseUrl, config.apiKey ?? "");
  }

  async evaluate(input: JudgeEvaluatorInput): Promise<JudgeEvaluatorOutput> {
    if (!this.config.apiKey) {
      return { score: 1.0, reasoning: "[no-api-key] judge skipped", passed: true };
    }

    // judge 使用 standard tier，budget 3000，足够评估一份中等长度诊断报告
    const policy = resolveModelPolicy("judge", this.config, {
      evidenceCount: input.evidence.length
    });

    try {
      const result = await this.client.complete({
        model: policy.model,
        timeoutMs: policy.timeoutMs,
        maxTokens: 400,
        responseFormat: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) }
        ]
      });

      const parsed = parseJudgeResponse(result.content);
      if (!parsed) {
        return {
          score: 0.5,
          reasoning: `[parse-error] raw: ${result.content.slice(0, 100)}`,
          passed: false
        };
      }

      return {
        score: parsed.score,
        reasoning: parsed.reasoning,
        passed: parsed.score >= PASS_THRESHOLD
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        score: 0.0,
        reasoning: `[judge-error] ${msg}`,
        passed: false
      };
    }
  }
}

// ---------- 工厂函数 ----------

export function createJudgeEvaluator(): JudgeEvaluator {
  const config = loadLlmConfig();
  if (config.mode === "openai") {
    return new OpenAiJudgeEvaluator(config);
  }
  return new MockJudgeEvaluator();
}
