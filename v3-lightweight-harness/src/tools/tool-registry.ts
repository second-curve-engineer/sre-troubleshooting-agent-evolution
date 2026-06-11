// Tool Registry：统一注册工具、风险等级和 step 级白名单校验入口。
import { ToolRiskLevel } from "../schemas/approval.js";
import { ToolResult } from "../schemas/tool.js";
import { formatToolInputIssues, ToolInputSchemas } from "../schemas/tool-input.js";
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

export type ToolInvocationArgs = {
  stepId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
  allowedTools: ToolName[];
};

export interface ToolExecutor {
  getMetadata(toolName: ToolName): ToolMetadata;
  validateInvocation(args: Omit<ToolInvocationArgs, "stepId">):
    | { success: true; input: Record<string, unknown> }
    | { success: false; result: ToolResult };
  invoke(args: ToolInvocationArgs): Promise<ToolResult>;
  assertFullyConsumed?(): void;
}

const handlers: Record<ToolName, ToolHandler> = {
  resolve_app: (input) => resolveApp(ToolInputSchemas.resolve_app.parse(input)),
  query_logs_by_trace_id: (input) =>
    queryLogsByTraceId(ToolInputSchemas.query_logs_by_trace_id.parse(input)),
  query_logs_by_condition: (input) =>
    queryLogsByCondition(ToolInputSchemas.query_logs_by_condition.parse(input)),
  query_mysql_slow_log: (input) =>
    queryMysqlSlowLog(ToolInputSchemas.query_mysql_slow_log.parse(input)),
  ask_codebase: (input) => askCodebase(ToolInputSchemas.ask_codebase.parse(input)),
  restart_service: async (input) => {
    const parsed = ToolInputSchemas.restart_service.parse(input);
    return {
      status: "ok",
      summary: `模拟高风险动作：已生成 ${parsed.appId} 重启执行记录`,
      outputSummary: {
        appId: parsed.appId,
        action: "restart_service",
        dryRun: true
      }
    };
  }
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

export class ToolRegistry implements ToolExecutor {
  getMetadata(toolName: ToolName): ToolMetadata {
    return metadata[toolName];
  }

  validateInvocation(args: {
    toolName: ToolName;
    input: Record<string, unknown>;
    allowedTools: ToolName[];
  }):
    | { success: true; input: Record<string, unknown> }
    | { success: false; result: ToolResult } {
    if (!args.allowedTools.includes(args.toolName)) {
      return {
        success: false,
        result: {
          status: "error",
          summary: `工具 ${args.toolName} 不在当前 step 白名单中`,
          outputSummary: {
            validationType: "tool_not_allowed",
            allowedTools: args.allowedTools
          },
          retryable: false
        }
      };
    }

    const parsed = ToolInputSchemas[args.toolName].safeParse(args.input);
    if (!parsed.success) {
      return {
        success: false,
        result: {
          status: "error",
          summary: `工具 ${args.toolName} 输入校验失败`,
          outputSummary: {
            validationType: "invalid_tool_input",
            validationIssues: formatToolInputIssues(parsed.error)
          },
          retryable: false
        }
      };
    }

    return {
      success: true,
      input: parsed.data as Record<string, unknown>
    };
  }

  async invoke(args: {
    stepId: string;
    toolName: ToolName;
    input: Record<string, unknown>;
    allowedTools: ToolName[];
  }): Promise<ToolResult> {
    const validation = this.validateInvocation(args);
    if (!validation.success) {
      return validation.result;
    }
    if (typeof validation.input.__simulateDelayMs === "number") {
      await sleep(validation.input.__simulateDelayMs);
    }
    if (validation.input.__simulateFailure) {
      return {
        status: "error",
        summary: `工具 ${args.toolName} 模拟失败`,
        outputSummary: {
          simulatedFailure: true
        },
        retryable: true
      };
    }
    return handlers[args.toolName](validation.input);
  }
}
