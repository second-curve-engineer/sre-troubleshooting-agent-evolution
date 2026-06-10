// Workflow 类型定义：描述每条排障路径如何声明 step、绑定工具并操作 RunState。
import { EvidenceStore } from "../harness/evidence-store.js";
import { QueryRefinementPolicy } from "../harness/policies.js";
import { EvidenceSummarizer } from "../llm/evidence-summarizer.js";
import { LoopQueryRefiner } from "../llm/loop-decision-adapter.js";
import { RunState } from "../schemas/run.js";
import { ToolResult } from "../schemas/tool.js";
import { WorkflowRoute } from "../schemas/workflow.js";
import { ToolName } from "../tools/tool-registry.js";

export type WorkflowStepDefinition = {
  stepId: string;
  description: string;
  allowedTools: ToolName[];
};

export type ToolInvoker = (
  state: RunState,
  stepId: string,
  toolName: ToolName,
  input: Record<string, unknown>,
  allowedTools: ToolName[]
) => Promise<ToolResult>;

export type WorkflowContext = {
  state: RunState;
  evidence: EvidenceStore;
  invokeTool: ToolInvoker;
  queryRefinementPolicy: QueryRefinementPolicy;
  // 语义摘要生成器：工具拿到原始数据后，由小模型提炼 1-3 句关键发现写入 evidence。
  // mock 模式降级为工具层机械 summary，保证 eval 零 API 调用也能通过。
  evidenceSummarizer: EvidenceSummarizer;
  // Agent Loop 查询收窄决策器：LLM 观察工具输出后动态决定下一轮查询条件。
  // openai 模式调用小模型；mock 模式降级为规则驱动，行为与改造前一致。
  loopQueryRefiner: LoopQueryRefiner;
};

export type WorkflowDefinition = {
  route: WorkflowRoute;
  description: string;
  steps: WorkflowStepDefinition[];
  execute(context: WorkflowContext): Promise<void>;
};
