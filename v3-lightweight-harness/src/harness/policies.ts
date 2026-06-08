// Workflow 策略集合：当前主要承载 504/timeout 场景的自我纠偏规则。
import { ToolResult } from "../schemas/tool.js";

// Agent Loop 的三种标准终止原因：
// - completed：工具返回满足条件，loop 正常结束（相当于模型宣布完成）
// - max_iterations：达到最大重试次数，强制退出
// - tool_error：工具调用出错或超时，立即终止
export type LoopTerminationReason = "completed" | "max_iterations" | "tool_error";

export class SelfCorrectionPolicy {
  readonly maxRetries = 2;

  shouldRetry(result: ToolResult, retryCount: number): boolean {
    if (retryCount >= this.maxRetries) return false;
    return result.status === "too_many_results" || result.status === "empty";
  }

  terminationReason(result: ToolResult, retryCount: number): LoopTerminationReason {
    if (result.status === "error" || result.status === "timeout" || result.status === "cancelled") {
      return "tool_error";
    }
    if (retryCount >= this.maxRetries && (result.status === "too_many_results" || result.status === "empty")) {
      return "max_iterations";
    }
    return "completed";
  }

  nextConditionQuery(previousQuery: string, result: ToolResult): string {
    const suggestedNextQueries = result.suggestedNextQueries ?? [];
    if (suggestedNextQueries.length > 0) {
      return suggestedNextQueries[0];
    }
    const keywords = (result.detectedKeywords ?? []).map((keyword) => keyword.toLowerCase());
    if (keywords.some((keyword) => keyword.includes("sql"))) {
      return `${previousQuery} and log.msg ~ 'SQL'`;
    }
    if (keywords.some((keyword) => keyword.includes("timeout"))) {
      return `${previousQuery} and log.msg ~ 'timeout'`;
    }
    return `${previousQuery} and log.level = 'ERROR'`;
  }
}
