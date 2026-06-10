// Agent Loop 查询收窄决策的 system prompt 和 user message 构造。
import { ToolResult } from "../schemas/tool.js";

export function buildLoopQuerySystemPrompt(): string {
  return [
    "你是 SRE 故障诊断专家，负责在 Agent Loop 中根据工具返回结果决定下一轮查询策略。",
    "",
    "你会收到：previousQuery（已执行的查询）、status（too_many_results / empty）、",
    "detectedKeywords（工具检测到的关键词）、suggestedNextQueries（工具建议的下一步查询）。",
    "",
    "规则：",
    "- too_many_results → 增加过滤条件收窄结果，如 AND log.level='ERROR' 或追加关键词匹配",
    "- empty → 放宽条件或换角度查询，参考 detectedKeywords 联想相关症状",
    "- 若 suggestedNextQueries 不为空，优先采用第一条",
    "- 保持查询语法风格与 previousQuery 一致",
    "",
    "输出格式（严格 JSON）：",
    "{\"nextQuery\": \"<新查询字符串>\", \"reasoning\": \"<一句话说明调整理由>\"}"
  ].join("\n");
}

export function buildLoopQueryUserMessage(args: {
  previousQuery: string;
  toolResult: ToolResult;
  iterationIndex: number;
}): string {
  return JSON.stringify({
    previousQuery: args.previousQuery,
    status: args.toolResult.status,
    detectedKeywords: args.toolResult.detectedKeywords ?? [],
    suggestedNextQueries: args.toolResult.suggestedNextQueries ?? [],
    summary: args.toolResult.summary,
    iterationIndex: args.iterationIndex
  });
}
