import { ToolName } from "../tools/tool-registry.js";
import { WorkflowRoute } from "../schemas/workflow.js";

export type EvalCase = {
  id: string;
  input: string;
  expectedRoute: WorkflowRoute;
  expectedTools: ToolName[];
  expectedEvidenceKeywords: string[];
  expectedConfidence?: "high" | "medium" | "low";
  expectedUsedLlm?: boolean;
  maxRouterTokens?: number;
  expectedApprovals?: Array<{
    toolName: ToolName;
    riskLevel: "low" | "medium" | "high" | "critical";
    status: "pending" | "approved" | "rejected" | "auto_approved";
  }>;
};

export const evalCases: EvalCase[] = [
  {
    id: "trace_500_npe",
    input: "prod 环境 order-service 下单接口从 10:30 开始大量 500，trace_id 是 demo-trace-001，帮我排查。",
    expectedRoute: "trace-diagnosis",
    expectedTools: ["resolve_app", "query_logs_by_trace_id", "ask_codebase"],
    expectedEvidenceKeywords: ["NullPointerException", "inventory-service", "InventoryService.java"],
    expectedConfidence: "high",
    expectedUsedLlm: false,
    maxRouterTokens: 0,
    expectedApprovals: [
      { toolName: "resolve_app", riskLevel: "low", status: "auto_approved" },
      { toolName: "query_logs_by_trace_id", riskLevel: "low", status: "auto_approved" },
      { toolName: "ask_codebase", riskLevel: "low", status: "auto_approved" }
    ]
  },
  {
    id: "condition_500_no_trace",
    input: "order-service 下单接口 10:30 开始大量 500，没有 trace_id，错误码 ERR_10086。",
    expectedRoute: "condition-log",
    expectedTools: ["resolve_app", "query_logs_by_condition", "query_logs_by_trace_id", "ask_codebase"],
    expectedEvidenceKeywords: ["trace", "NullPointerException", "InventoryService.java"],
    expectedConfidence: "high",
    expectedUsedLlm: false,
    maxRouterTokens: 0
  },
  {
    id: "timeout_504_mysql",
    input: "order-service 下单接口从 10:30 开始大量 504，帮我排查。",
    expectedRoute: "performance",
    expectedTools: ["resolve_app", "query_logs_by_condition", "query_logs_by_condition", "query_mysql_slow_log"],
    expectedEvidenceKeywords: ["结果过宽", "Query_time", "order_item"],
    expectedConfidence: "medium",
    expectedUsedLlm: false,
    maxRouterTokens: 0,
    expectedApprovals: [
      { toolName: "query_mysql_slow_log", riskLevel: "medium", status: "auto_approved" }
    ]
  },
  {
    id: "insufficient_context",
    input: "线上接口好像有问题，帮我看看。",
    expectedRoute: "clarification",
    expectedTools: [],
    expectedEvidenceKeywords: ["低置信路由", "证据不足"],
    expectedConfidence: "low",
    expectedUsedLlm: true
  },
  {
    id: "ambiguous_slow_order",
    input: "订单接口有点卡住，帮我看看。",
    expectedRoute: "performance",
    expectedTools: ["resolve_app", "query_logs_by_condition", "query_logs_by_condition", "query_mysql_slow_log"],
    expectedEvidenceKeywords: ["router=llm", "Query_time"],
    expectedConfidence: "medium",
    expectedUsedLlm: true
  }
];
