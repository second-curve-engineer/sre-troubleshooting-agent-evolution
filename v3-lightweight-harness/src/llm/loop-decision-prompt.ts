// Agent Loop 查询收窄决策的 system prompt 和 user message 构造。
import { ToolResult } from "../schemas/tool.js";

export function buildLoopQuerySystemPrompt(): string {
  return [
    "你是 SRE 故障诊断专家，负责在 Agent Loop 中根据工具返回结果决定下一轮查询策略。",
    "",
    "你会收到：previousQuery（已执行的查询）、status（too_many_results / empty）、",
    "detectedKeywords（工具检测到的关键词）、suggestedNextQueries（工具建议的下一步查询）、",
    "timeDistribution（可选，日志的时间分布，含峰值分钟和建议时间窗口）。",
    "",
    "规则：",
    "- too_many_results → 优先采用 suggestedNextQueries[0]（若有）；",
    "  否则增加过滤条件收窄结果，如 AND log.level='ERROR' 或追加 detectedKeywords 关键词匹配；",
    "  若 timeDistribution 存在，可将 fromTime/toTime 收窄到 suggestedFromTime/suggestedToTime",
    "- empty → 放宽条件或换角度查询，参考 detectedKeywords 联想相关症状",
    "- 保持查询语法风格与 previousQuery 一致",
    "",
    "输出格式（严格 JSON，fromTime/toTime 仅在需要收窄时间窗口时输出）：",
    "{\"nextQuery\": \"<新查询字符串>\", \"fromTime\": \"<可选>\", \"toTime\": \"<可选>\", \"reasoning\": \"<一句话说明调整理由>\"}"
  ].join("\n");
}

export function buildLoopQueryUserMessage(args: {
  previousQuery: string;
  toolResult: ToolResult;
  iterationIndex: number;
}): string {
  const timeDistribution = (args.toolResult.outputSummary as Record<string, unknown>)?.timeDistribution;
  return JSON.stringify({
    previousQuery: args.previousQuery,
    status: args.toolResult.status,
    detectedKeywords: args.toolResult.detectedKeywords ?? [],
    suggestedNextQueries: args.toolResult.suggestedNextQueries ?? [],
    summary: args.toolResult.summary,
    timeDistribution: timeDistribution ?? null,
    iterationIndex: args.iterationIndex
  });
}
