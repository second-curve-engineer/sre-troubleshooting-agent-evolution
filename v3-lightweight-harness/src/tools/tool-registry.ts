// Tool Registry：统一注册工具、风险等级和 step 级白名单校验入口。
import { ToolRiskLevel } from "../schemas/approval.js";
import { ToolResult } from "../schemas/tool.js";
import { resolveApp } from "./app-tools.js";
import { askCodebase } from "./code-tools.js";
import { queryLogsByCondition, queryLogsByTraceId } from "./log-tools.js";
import { queryMysqlSlowLog } from "./slow-query-tools.js";

export type ToolName =
  | "resolve_app"
  | "query_logs_by_trace_id"
  | "query_logs_by_condition"
  | "query_mysql_slow_log"
  | "ask_codebase"
  | "restart_service";

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;
export type ToolMetadata = {
  name: ToolName;
  riskLevel: ToolRiskLevel;
  description: string;
};

const handlers: Record<ToolName, ToolHandler> = {
  resolve_app: (input) => resolveApp({ query: String(input.query ?? "") }),
  query_logs_by_trace_id: (input) =>
    queryLogsByTraceId({
      traceId: String(input.traceId ?? ""),
      env: String(input.env ?? "prod")
    }),
  query_logs_by_condition: (input) =>
    queryLogsByCondition({
      appId: String(input.appId ?? ""),
      query: String(input.query ?? ""),
      fromTime: input.fromTime ? String(input.fromTime) : undefined,
      toTime: input.toTime ? String(input.toTime) : undefined,
      env: String(input.env ?? "prod"),
      limit: input.limit ? Number(input.limit) : undefined,
      __simulateSensitiveLog: Boolean(input.__simulateSensitiveLog),
      __simulatePromptInjectionLog: Boolean(input.__simulatePromptInjectionLog)
    }),
  query_mysql_slow_log: (input) =>
    queryMysqlSlowLog({
      dbNames: Array.isArray(input.dbNames) ? input.dbNames.map(String) : ["order_db"],
      query: input.query ? String(input.query) : undefined,
      fromTime: input.fromTime ? String(input.fromTime) : undefined,
      toTime: input.toTime ? String(input.toTime) : undefined,
      env: String(input.env ?? "prod")
    }),
  ask_codebase: (input) =>
    askCodebase({
      codebasePath: String(input.codebasePath ?? ""),
      question: String(input.question ?? "")
    }),
  restart_service: async (input) => ({
    status: "ok",
    summary: `模拟高风险动作：已生成 ${String(input.appId ?? "unknown")} 重启执行记录`,
    outputSummary: {
      appId: String(input.appId ?? "unknown"),
      action: "restart_service",
      dryRun: true
    }
  })
};

const metadata: Record<ToolName, ToolMetadata> = {
  resolve_app: {
    name: "resolve_app",
    riskLevel: "low",
    description: "Resolve service aliases to app metadata."
  },
  query_logs_by_trace_id: {
    name: "query_logs_by_trace_id",
    riskLevel: "low",
    description: "Read-only trace log lookup."
  },
  query_logs_by_condition: {
    name: "query_logs_by_condition",
    riskLevel: "low",
    description: "Read-only condition log lookup."
  },
  query_mysql_slow_log: {
    name: "query_mysql_slow_log",
    riskLevel: "medium",
    description: "Read-only slow query log lookup with potentially sensitive SQL fingerprints."
  },
  ask_codebase: {
    name: "ask_codebase",
    riskLevel: "low",
    description: "Read-only codebase question answering."
  },
  restart_service: {
    name: "restart_service",
    riskLevel: "high",
    description: "High-risk production action used to demonstrate HITL pending/resume."
  }
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ToolRegistry {
  getMetadata(toolName: ToolName): ToolMetadata {
    return metadata[toolName];
  }

  async invoke(args: {
    toolName: ToolName;
    input: Record<string, unknown>;
    allowedTools: ToolName[];
  }): Promise<ToolResult> {
    if (!args.allowedTools.includes(args.toolName)) {
      return {
        status: "error",
        summary: `工具 ${args.toolName} 不在当前 step 白名单中`,
        outputSummary: { allowedTools: args.allowedTools }
      };
    }
    if (typeof args.input.__simulateDelayMs === "number") {
      await sleep(args.input.__simulateDelayMs);
    }
    if (args.input.__simulateFailure) {
      return {
        status: "error",
        summary: `工具 ${args.toolName} 模拟失败`,
        outputSummary: {
          simulatedFailure: true
        }
      };
    }
    return handlers[args.toolName](args.input);
  }
}
