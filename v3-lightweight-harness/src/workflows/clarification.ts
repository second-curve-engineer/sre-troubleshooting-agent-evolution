// 追问 workflow：适用于上下文不足或低置信路由，避免在证据不足时乱调工具。
import { WorkflowDefinition } from "./types.js";

export const clarificationWorkflow: WorkflowDefinition = {
  route: "clarification",
  description: "信息不足时不调用工具，只把追问原因写入 evidence。",
  steps: [],
  async execute(context) {
    context.evidence.add({
      source: "router",
      kind: "system",
      summary: context.state.decision?.reason ?? "需要补充更多上下文",
      confidence: (context.state.router?.confidence ?? 0) >= 0.75 ? "high" : "medium",
      usedInFinalReport: true
    });
  }
};
