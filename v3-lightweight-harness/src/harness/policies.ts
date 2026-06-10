// 查询纠偏策略：只处理查询结果过多/为空，不处理工具调用失败重试。
// error/timeout 的技术重试由 Runner 的 Tool 执行层统一负责。
import { ToolResult } from "../schemas/tool.js";

// 查询迭代的三种标准终止原因：
// - completed：工具返回满足条件，loop 正常结束（相当于模型宣布完成）
// - max_iterations：达到最大查询迭代次数，强制退出
// - tool_failure：工具经过技术重试后仍失败
export type QueryLoopTerminationReason = "completed" | "max_iterations" | "tool_failure";

export class QueryRefinementPolicy {
  readonly maxRefinements = 2;

  shouldRefineQuery(result: ToolResult, refinementsApplied: number): boolean {
    if (refinementsApplied >= this.maxRefinements) return false;
    return result.status === "too_many_results" || result.status === "empty";
  }

  terminationReason(result: ToolResult, refinementsApplied: number): QueryLoopTerminationReason {
    if (result.status === "error" || result.status === "timeout" || result.status === "cancelled") {
      return "tool_failure";
    }
    if (
      refinementsApplied >= this.maxRefinements &&
      (result.status === "too_many_results" || result.status === "empty")
    ) {
      return "max_iterations";
    }
    return "completed";
  }
}
