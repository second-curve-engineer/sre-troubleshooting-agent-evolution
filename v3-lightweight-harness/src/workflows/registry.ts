// Workflow Registry：把 router 输出的 route 映射到具体 workflow 定义。
import { WorkflowRoute } from "../schemas/workflow.js";
import { clarificationWorkflow } from "./clarification.js";
import { conditionLogWorkflow } from "./condition-log.js";
import { performanceWorkflow } from "./performance.js";
import { traceDiagnosisWorkflow } from "./trace-diagnosis.js";
import { WorkflowDefinition } from "./types.js";

const workflows: Record<WorkflowRoute, WorkflowDefinition> = {
  "trace-diagnosis": traceDiagnosisWorkflow,
  "condition-log": conditionLogWorkflow,
  performance: performanceWorkflow,
  clarification: clarificationWorkflow
};

export function getWorkflow(route: WorkflowRoute): WorkflowDefinition {
  return workflows[route];
}

export function listWorkflows(): WorkflowDefinition[] {
  return Object.values(workflows);
}
