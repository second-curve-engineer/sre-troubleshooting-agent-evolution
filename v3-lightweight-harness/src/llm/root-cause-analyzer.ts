// Root Cause Analyzer：两阶段诊断管道的第一阶段——深度根因推导。
//
// 设计意图：
//   - root_cause（strong tier）负责"侦探"工作：跨多条证据推导因果链
//   - report（standard tier）只负责"格式化"：把推导结论整理成 DiagnosisReport JSON
//   - 简单场景（证据 < 2 条）跳过本阶段，report 按原逻辑独立运行
//
// 两阶段的核心价值：
//   strong 模型做推理，standard 模型做格式化，各司其职，
//   相比全程用 strong 模型，节省 30-50% 的推理 token。
import { loadLlmConfig, LlmConfig } from "../config/env.js";
import { EvidenceItem } from "../schemas/evidence.js";
import { LlmCallTrace } from "../schemas/llm.js";
import { WorkflowDecision } from "../schemas/workflow.js";
import { resolveModelPolicy } from "./model-policy.js";
import { OpenAiClient } from "./openai-client.js";
import { randomUUID } from "node:crypto";

// ---------- 输入 / 输出类型 ----------

export type RootCauseAnalyzerInput = {
  userMessage: string;
  decision: WorkflowDecision;
  evidence: EvidenceItem[];
};

export type RootCauseAnalysis = {
  /** 因果链描述，如"连接池耗尽 → DB 查询超时 → 接口 504" */
  causalChain: string;
  /** 支撑根因结论的关键证据（从输入证据中提取） */
  keyEvidence: string[];
  /** 其他候选假设（已排除或置信度较低） */
  alternativeHypotheses: string[];
  /** 尚缺什么证据，report 阶段可在 missingContext 里体现 */
  dataGaps: string[];
  /** LLM 对本次推导的自信度 */
  confidence: "high" | "medium" | "low";
};

export type RootCauseAnalyzerResult = {
  analysis: RootCauseAnalysis;
  /** LLM 调用 trace，供 runner 汇总到 state.llmCalls[] */
  llmCall: LlmCallTrace;
};

export interface RootCauseAnalyzer {
  /**
   * 判断当前证据是否充分到值得调用 strong 模型做深度分析。
   * runner 在调用 analyze() 前先问这个，不满足则跳过。
   */
  shouldAnalyze(evidence: EvidenceItem[]): boolean;
  analyze(input: RootCauseAnalyzerInput): Promise<RootCauseAnalyzerResult>;
}

// ---------- 常量 ----------

/** 至少需要这么多"有效"证据条目（usedInFinalReport=true 且 kind 不是 system） */
const MIN_EVIDENCE_COUNT = 2;

const SYSTEM_PROMPT = [
  "你是资深 SRE 根因分析专家。",
  "给你一次线上故障的所有排查证据，你的任务是推导出最可能的根本原因。",
  "",
  "分析要求：",
  "- 从最底层的直接原因往上追溯，找到触发故障的根本原因（而不只是表象）",
  "- 明确指出哪条证据最关键，以及证据之间的因果关系",
  "- 如果存在多个竞争假设，说明为什么选择当前结论",
  "- 如果证据不足以得出高置信结论，如实说明缺口",
  "",
  '严格按 JSON 格式输出（不要 Markdown 代码块）：',
  '{"causalChain":"...","keyEvidence":["..."],"alternativeHypotheses":["..."],"dataGaps":["..."],"confidence":"high"|"medium"|"low"}'
].join("\n");

function buildUserPrompt(input: RootCauseAnalyzerInput): string {
  return JSON.stringify(
    {
      userMessage: input.userMessage,
      route: input.decision.route,
      appId: input.decision.appHint,
      evidence: input.evidence
        .filter((e) => e.usedInFinalReport)
        .map((e) => ({
          source: e.source,
          kind: e.kind,
          summary: e.summary,
          confidence: e.confidence
        }))
    },
    null,
    2
  );
}

type RawAnalysis = {
  causalChain?: unknown;
  keyEvidence?: unknown;
  alternativeHypotheses?: unknown;
  dataGaps?: unknown;
  confidence?: unknown;
};

function parseAnalysis(content: string): RootCauseAnalysis | null {
  try {
    const cleaned = content.replace(/```json\n?|\n?```/g, "").trim();
    const raw = JSON.parse(cleaned) as RawAnalysis;

    const causalChain = typeof raw.causalChain === "string" ? raw.causalChain : "";
    const keyEvidence = Array.isArray(raw.keyEvidence) ? raw.keyEvidence.map(String) : [];
    const alternativeHypotheses = Array.isArray(raw.alternativeHypotheses)
      ? raw.alternativeHypotheses.map(String)
      : [];
    const dataGaps = Array.isArray(raw.dataGaps) ? raw.dataGaps.map(String) : [];
    const confidence =
      raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low"
        ? raw.confidence
        : "low";

    if (!causalChain) return null;
    return { causalChain, keyEvidence, alternativeHypotheses, dataGaps, confidence };
  } catch {
    return null;
  }
}

function fallbackAnalysis(reason: string): RootCauseAnalysis {
  return {
    causalChain: `[root_cause 分析失败: ${reason}]`,
    keyEvidence: [],
    alternativeHypotheses: [],
    dataGaps: ["root_cause LLM 调用失败，根因推导未完成"],
    confidence: "low"
  };
}

function makeLlmCallTrace(
  args: {
    source: "mock" | "llm" | "fallback";
    model: string;
    modelTier: import("../schemas/llm.js").ModelTier;
    tokenBudget: number;
    timeoutMs: number;
    tokenUsage?: import("../schemas/llm.js").TokenUsage;
    error?: string;
    notes: string[];
    agentSpanId?: string;
  }
): LlmCallTrace {
  return {
    role: "root_cause",
    source: args.source,
    model: args.model,
    modelTier: args.modelTier,
    tokenBudget: args.tokenBudget,
    timeoutMs: args.timeoutMs,
    tokenUsage: args.tokenUsage,
    error: args.error,
    notes: args.notes,
    spanId: randomUUID(),
    parentSpanId: args.agentSpanId,
    spanKind: "LLM"
  };
}

// ---------- Mock 实现 ----------

export class MockRootCauseAnalyzer implements RootCauseAnalyzer {
  constructor(private readonly config: LlmConfig = loadLlmConfig()) {}

  shouldAnalyze(evidence: EvidenceItem[]): boolean {
    return countUsableEvidence(evidence) >= MIN_EVIDENCE_COUNT;
  }

  async analyze(input: RootCauseAnalyzerInput): Promise<RootCauseAnalyzerResult> {
    const policy = resolveModelPolicy("root_cause", this.config, {
      route: input.decision.route,
      evidenceCount: input.evidence.length
    });

    // mock 模式：从证据里提取关键信息组成合理的伪分析，不调 LLM
    const usable = input.evidence.filter((e) => e.usedInFinalReport);
    const causalChain =
      usable.length > 0
        ? `[mock] ${usable.map((e) => e.summary).join(" → ")}`
        : "[mock] 证据不足，无法推导因果链";

    const analysis: RootCauseAnalysis = {
      causalChain,
      keyEvidence: usable.slice(0, 3).map((e) => e.summary),
      alternativeHypotheses: [],
      dataGaps: [],
      confidence: usable.length >= 2 ? "medium" : "low"
    };

    return {
      analysis,
      llmCall: makeLlmCallTrace({
        source: "mock",
        model: policy.model,
        modelTier: policy.modelTier,
        tokenBudget: policy.tokenBudget,
        timeoutMs: policy.timeoutMs,
        notes: ["mock root_cause analyzer", policy.reason]
      })
    };
  }
}

// ---------- OpenAI 实现 ----------

export class OpenAiRootCauseAnalyzer implements RootCauseAnalyzer {
  private readonly client: OpenAiClient;

  constructor(private readonly config: LlmConfig = loadLlmConfig()) {
    this.client = new OpenAiClient(config.baseUrl, config.apiKey ?? "");
  }

  shouldAnalyze(evidence: EvidenceItem[]): boolean {
    return countUsableEvidence(evidence) >= MIN_EVIDENCE_COUNT;
  }

  async analyze(input: RootCauseAnalyzerInput): Promise<RootCauseAnalyzerResult> {
    const policy = resolveModelPolicy("root_cause", this.config, {
      route: input.decision.route,
      evidenceCount: input.evidence.length
    });

    if (!this.config.apiKey) {
      return {
        analysis: fallbackAnalysis("缺少 API Key"),
        llmCall: makeLlmCallTrace({
          source: "fallback",
          model: policy.model,
          modelTier: policy.modelTier,
          tokenBudget: policy.tokenBudget,
          timeoutMs: policy.timeoutMs,
          error: "missing_api_key",
          notes: ["missing_api_key", policy.reason]
        })
      };
    }

    try {
      const { content, tokenUsage } = await this.client.complete({
        model: policy.model,
        timeoutMs: policy.timeoutMs,
        responseFormat: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) }
        ]
      });

      const parsed = parseAnalysis(content);
      if (!parsed) {
        return {
          analysis: fallbackAnalysis(`JSON 解析失败: ${content.slice(0, 80)}`),
          llmCall: makeLlmCallTrace({
            source: "fallback",
            model: policy.model,
            modelTier: policy.modelTier,
            tokenBudget: policy.tokenBudget,
            timeoutMs: policy.timeoutMs,
            tokenUsage,
            error: "parse_error",
            notes: ["root_cause_parse_error", policy.reason]
          })
        };
      }

      return {
        analysis: parsed,
        llmCall: makeLlmCallTrace({
          source: "llm",
          model: policy.model,
          modelTier: policy.modelTier,
          tokenBudget: policy.tokenBudget,
          timeoutMs: policy.timeoutMs,
          tokenUsage,
          notes: [`route=${input.decision.route}`, `evidence=${input.evidence.length}`, policy.reason]
        })
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        analysis: fallbackAnalysis(msg),
        llmCall: makeLlmCallTrace({
          source: "fallback",
          model: policy.model,
          modelTier: policy.modelTier,
          tokenBudget: policy.tokenBudget,
          timeoutMs: policy.timeoutMs,
          error: msg,
          notes: ["root_cause_llm_error", policy.reason]
        })
      };
    }
  }
}

// ---------- 工厂函数 ----------

export function createRootCauseAnalyzer(): RootCauseAnalyzer {
  const config = loadLlmConfig();
  if (config.mode === "openai") {
    return new OpenAiRootCauseAnalyzer(config);
  }
  return new MockRootCauseAnalyzer();
}

// ---------- 工具函数 ----------

function countUsableEvidence(evidence: EvidenceItem[]): number {
  return evidence.filter((e) => e.usedInFinalReport && e.kind !== "system").length;
}

/** 把 RootCauseAnalysis 序列化为可注入 report prompt 的文本块 */
export function formatRootCauseForReport(analysis: RootCauseAnalysis): string {
  const lines = [
    "=== 根因分析（由 root_cause 阶段生成，供 report 参考）===",
    `因果链：${analysis.causalChain}`,
    `置信度：${analysis.confidence}`
  ];
  if (analysis.keyEvidence.length > 0) {
    lines.push(`关键证据：${analysis.keyEvidence.join("；")}`);
  }
  if (analysis.alternativeHypotheses.length > 0) {
    lines.push(`候选假设（已评估）：${analysis.alternativeHypotheses.join("；")}`);
  }
  if (analysis.dataGaps.length > 0) {
    lines.push(`证据缺口：${analysis.dataGaps.join("；")}`);
  }
  lines.push("===");
  return lines.join("\n");
}
