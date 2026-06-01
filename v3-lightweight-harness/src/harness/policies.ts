// Workflow 策略集合：当前主要承载 504/timeout 场景的自我纠偏规则。
import { ToolResult } from "../schemas/tool.js";

export class SelfCorrectionPolicy {
  readonly maxRetries = 2;

  shouldRetry(result: ToolResult, retryCount: number): boolean {
    if (retryCount >= this.maxRetries) return false;
    return result.status === "too_many_results" || result.status === "empty";
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
