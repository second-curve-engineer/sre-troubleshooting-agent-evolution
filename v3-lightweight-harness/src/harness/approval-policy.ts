// 工具审批策略：根据 risk level 决定工具是否自动执行，作为 HITL 的后端雏形。
import { randomUUID } from "node:crypto";
import { HumanApprovalRequest, ToolRiskLevel } from "../schemas/approval.js";
import { ToolName } from "../tools/tool-registry.js";

export type ApprovalMode = "auto" | "strict";

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 160) {
      summary[key] = `${value.slice(0, 157)}...`;
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

export class ApprovalPolicy {
  constructor(private readonly mode: ApprovalMode = "auto") {}

  // 当前是 HITL 后端雏形：所有工具先生成审批记录，再决定是否允许执行。
  evaluate(args: {
    runId: string;
    stepId: string;
    toolName: ToolName;
    riskLevel: ToolRiskLevel;
    input: Record<string, unknown>;
  }): HumanApprovalRequest {
    const now = new Date().toISOString();
    const request: HumanApprovalRequest = {
      approvalId: `approval-${randomUUID().slice(0, 8)}`,
      runId: args.runId,
      stepId: args.stepId,
      toolName: args.toolName,
      riskLevel: args.riskLevel,
      reason: this.reasonFor(args.riskLevel),
      toolInputSummary: summarizeInput(args.input),
      status: "pending",
      createdAt: now
    };

    if (args.riskLevel === "low") {
      return { ...request, status: "auto_approved", decidedAt: now };
    }

    if (args.riskLevel === "medium" && this.mode === "auto") {
      return { ...request, status: "auto_approved", decidedAt: now };
    }

    // 高风险工具在没有真实审批 UI 前不自动执行，避免把风险动作伪装成 demo 成功。
    return {
      ...request,
      status: this.mode === "strict" ? "pending" : "rejected",
      decidedAt: this.mode === "strict" ? undefined : now
    };
  }

  canExecute(request: HumanApprovalRequest): boolean {
    return request.status === "approved" || request.status === "auto_approved";
  }

  private reasonFor(riskLevel: ToolRiskLevel): string {
    if (riskLevel === "low") return "低风险只读工具，允许自动执行";
    if (riskLevel === "medium") return "中风险只读工具，当前 demo 模式自动执行并记录审批";
    if (riskLevel === "high") return "高风险工具，需要人工审批";
    return "关键风险工具，必须人工审批";
  }
}
