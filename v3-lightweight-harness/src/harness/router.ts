// Hybrid Router：先用确定性规则判断 workflow，低置信时再调用 LLM router adapter。
import { RouterResult, WorkflowDecision } from "../schemas/workflow.js";
import { createLlmRouterAdapter, LlmRouterAdapter } from "../llm/router-adapter.js";

function extractTraceId(message: string): string | undefined {
  return message.match(/[a-zA-Z]+-trace-\d+|trace[_ -]?id\s*(?:是|=|:)?\s*([a-zA-Z0-9_-]+)/i)?.[1]
    ?? message.match(/demo-trace-\d+/i)?.[0];
}

function extractAppHint(message: string): string | undefined {
  const match = message.match(/([a-zA-Z][a-zA-Z0-9_-]*-service)/);
  if (match) return match[1];
  if (message.includes("订单") || message.includes("下单")) return "order-service";
  return undefined;
}

// 提取接口路径，如 "POST /order/create" 或 "/order/create"
function extractInterfaceHint(message: string): string | undefined {
  const match = message.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s，,。]+)/)
    ?? message.match(/(\/[a-zA-Z][a-zA-Z0-9/_-]{2,})/);
  return match?.[1];
}

// 提取错误码，优先业务错误码（ERR_xxx / BIZ_xxx），其次 HTTP 状态码
function extractErrorCodeHint(message: string): string | undefined {
  return message.match(/[A-Z]{2,}_\d+/)?.[0]      // ERR_10086、BIZ_4001
    ?? message.match(/\b(4\d{2}|5\d{2})\b/)?.[1]; // 400-599
}

// 提取时间窗口，如"最近 5 分钟" / "过去 10min"
function extractTimeWindowMin(message: string): number | undefined {
  const match = message.match(/(?:最近|过去|近)\s*(\d+)\s*(?:分钟|min)/i);
  return match ? Number(match[1]) : undefined;
}

// 根据时间窗口计算起止时间字符串（ISO 格式）
export function resolveTimeRange(timeWindowMin?: number): { fromTime: string; toTime: string } {
  const toTime = new Date();
  const fromTime = new Date(toTime.getTime() - (timeWindowMin ?? 10) * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
  return { fromTime: fmt(fromTime), toTime: fmt(toTime) };
}

function heuristicDecision(userMessage: string): RouterResult {
  const lowered = userMessage.toLowerCase();
  const traceId = extractTraceId(userMessage);
  const appHint = extractAppHint(userMessage);
  const interfaceHint = extractInterfaceHint(userMessage);
  const errorCodeHint = extractErrorCodeHint(userMessage);
  const timeWindowMin = extractTimeWindowMin(userMessage);
  const hasPerformanceSignal =
    lowered.includes("504") ||
    lowered.includes("timeout") ||
    lowered.includes("超时") ||
    lowered.includes("慢") ||
    lowered.includes("latency");
  const hasErrorSignal =
    lowered.includes("500") ||
    lowered.includes("exception") ||
    lowered.includes("错误") ||
    lowered.includes("报错");

  // 第一层只做确定性信号判断：缺少服务/trace 时不要急着查工具，先追问或交给 LLM router。
  if (!appHint && !traceId) {
    return {
      decision: {
        problemType: "unknown",
        route: "clarification",
        reason: "缺少服务名、trace_id 或明确故障现象"
      },
      source: "heuristic",
      confidence: 0.55,
      usedLlm: false,
      notes: ["missing app and trace"]
    };
  }

  // trace_id 是最强路由信号：即使同时出现 504/timeout，也优先按完整链路定位故障。
  if (traceId) {
    return {
      decision: {
        problemType: "interface_error",
        route: "trace-diagnosis",
        reason: "输入包含 trace_id，可直接走链路诊断",
        appHint,
        traceId
      },
      source: "heuristic",
      confidence: 0.98,
      usedLlm: false,
      notes: ["trace_id is deterministic route signal"]
    };
  }

  // 没有 trace_id 时，504、timeout、慢查询信号直接走性能排查，不消耗 router token。
  if (hasPerformanceSignal) {
    return {
      decision: {
        problemType: "performance",
        route: "performance",
        reason: "输入包含 504/timeout/慢 等性能问题信号",
        appHint,
        traceId
      },
      source: "heuristic",
      confidence: 0.95,
      usedLlm: false,
      notes: ["high-confidence performance signal"]
    };
  }

  // 有明确报错和服务名，但没有 trace_id，先从条件日志反查 trace。
  if (hasErrorSignal && appHint) {
    return {
      decision: {
        problemType: "interface_error",
        route: "condition-log",
        reason: "输入有接口报错信号但没有 trace_id，先按条件日志查询",
        appHint,
        interfaceHint,
        errorCodeHint,
        timeWindowMin
      },
      source: "heuristic",
      confidence: 0.86,
      usedLlm: false,
      notes: ["high-confidence error signal"]
    };
  }

  return {
    decision: {
      problemType: "unknown",
      route: "clarification",
      reason: "故障类型或关键上下文不足",
      appHint,
      traceId
    },
    source: "heuristic",
    confidence: 0.4,
    usedLlm: false,
    notes: ["low-confidence heuristic result"]
  };
}

export async function routeWorkflow(
  userMessage: string,
  options: {
    llmRouter?: LlmRouterAdapter;
    confidenceThreshold?: number;
  } = {}
): Promise<RouterResult> {
  const threshold = options.confidenceThreshold ?? 0.75;
  const heuristic = heuristicDecision(userMessage);

  // 高置信规则命中时直接返回，避免把确定性判断交给 LLM。
  if (heuristic.confidence >= threshold) {
    return heuristic;
  }

  // 只有规则层低置信时才调用 LLM adapter；具体是 mock 还是真实 API 由配置决定。
  const llmRouter = options.llmRouter ?? createLlmRouterAdapter();
  const llmResult = await llmRouter.route(userMessage);

  if (llmResult.confidence >= threshold) {
    return llmResult;
  }

  // LLM 结果仍然低置信时，不继续执行工具，转成 clarification，避免错误路径放大。
  return {
    decision: {
      ...llmResult.decision,
      route: "clarification",
      problemType: "unknown",
      reason: `低置信路由，转为追问: ${llmResult.decision.reason}`
    },
    source: "fallback",
    confidence: llmResult.confidence,
    usedLlm: llmResult.usedLlm,
    tokenUsage: llmResult.tokenUsage,
    llmCall: llmResult.llmCall,
    notes: [...(llmResult.notes ?? []), "fallback_to_clarification"]
  };
}
