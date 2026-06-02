// ModelPolicy：在统一 LlmConfig 之上，按 Agent 阶段选择模型档位、预算和超时。
import { LlmConfig } from "../config/env.js";
import { LlmRole, ModelTier } from "../schemas/llm.js";
import { WorkflowRoute } from "../schemas/workflow.js";

export type ResolvedModelPolicy = {
  role: LlmRole;
  modelTier: ModelTier;
  model: string;
  tokenBudget: number;
  timeoutMs: number;
  // 写入 trace 的策略解释，不会进入 LLM prompt；用于审计、调试和回归评测。
  reason: string;
};

export type ModelPolicyContext = {
  route?: WorkflowRoute;
  evidenceCount?: number;
};

const ROLE_DEFAULTS: Record<LlmRole, { tier: ModelTier; budget: number }> = {
  router: { tier: "small", budget: 1000 },
  evidence_summarizer: { tier: "small", budget: 2000 },
  root_cause: { tier: "strong", budget: 6000 },
  report: { tier: "standard", budget: 4000 },
  judge: { tier: "standard", budget: 3000 }
};

function envString(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function envNumber(name: string, fallback: number): number {
  const raw = envString(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envName(role: LlmRole, suffix: string): string {
  return `LLM_${role.toUpperCase()}_${suffix}`;
}

function resolveModelForTier(tier: ModelTier, config: LlmConfig): string {
  if (tier === "small") return envString("LLM_SMALL_MODEL") ?? config.model;
  if (tier === "standard") return envString("LLM_STANDARD_MODEL") ?? config.model;
  if (tier === "strong") return envString("LLM_STRONG_MODEL") ?? config.model;
  return config.model;
}

function resolveTier(role: LlmRole, fallback: ModelTier): ModelTier {
  const raw = envString(envName(role, "TIER"));
  if (raw === "rule" || raw === "small" || raw === "standard" || raw === "strong") return raw;
  return fallback;
}

// 这段解释是给 trace / llmCall.notes 用的，不是给模型看的 prompt。
function roleReason(role: LlmRole, tier: ModelTier, context: ModelPolicyContext): string {
  if (role === "router") return "低置信语义路由使用小模型或默认模型，确定性路由不调用 LLM";
  if (role === "report") {
    return `诊断报告生成使用 ${tier} 档模型，route=${context.route ?? "unknown"}，evidence=${context.evidenceCount ?? 0}`;
  }
  if (role === "root_cause") return "根因综合保留给强模型档位";
  if (role === "evidence_summarizer") return "证据压缩使用小模型档位控制上下文成本";
  return "评估类调用使用标准模型档位";
}

// 解析顺序：role 默认策略 -> role 专属环境变量覆盖 -> 档位模型映射 -> 预算和超时。
export function resolveModelPolicy(
  role: LlmRole,
  config: LlmConfig,
  context: ModelPolicyContext = {}
): ResolvedModelPolicy {
  const defaults = ROLE_DEFAULTS[role];
  const tier = resolveTier(role, defaults.tier);
  const model = envString(envName(role, "MODEL")) ?? resolveModelForTier(tier, config);
  const tokenBudget = envNumber(envName(role, "TOKEN_BUDGET"), defaults.budget);
  const timeoutMs = envNumber(envName(role, "TIMEOUT_MS"), config.timeoutMs);

  return {
    role,
    modelTier: tier,
    model,
    tokenBudget,
    timeoutMs,
    reason: roleReason(role, tier, context)
  };
}
