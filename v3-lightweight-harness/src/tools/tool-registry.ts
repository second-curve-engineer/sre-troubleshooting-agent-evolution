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
  | "ask_codebase";

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

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
      limit: input.limit ? Number(input.limit) : undefined
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
    })
};

export class ToolRegistry {
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
    return handlers[args.toolName](args.input);
  }
}
