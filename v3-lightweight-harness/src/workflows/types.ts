// Workflow 类型定义：描述每条排障路径如何声明 step、绑定工具并操作 RunState。
import { EvidenceStore } from "../harness/evidence-store.js";
import { SelfCorrectionPolicy } from "../harness/policies.js";
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
  selfCorrectionPolicy: SelfCorrectionPolicy;
};

export type WorkflowDefinition = {
  route: WorkflowRoute;
  description: string;
  steps: WorkflowStepDefinition[];
  execute(context: WorkflowContext): Promise<void>;
};
