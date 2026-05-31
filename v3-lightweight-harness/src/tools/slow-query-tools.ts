import { ToolResult } from "../schemas/tool.js";
import { readMockJson } from "./data.js";

type SlowPayload = {
  result?: { data?: { logs?: Array<Record<string, unknown>> } };
};

export async function queryMysqlSlowLog(input: {
  dbNames: string[];
  query?: string;
  fromTime?: string;
  toTime?: string;
  env?: string;
}): Promise<ToolResult> {
  const data = await readMockJson<Record<string, SlowPayload>>("mysql-slow-logs.json");
  const logs = input.dbNames.flatMap((dbName) => data[dbName]?.result?.data?.logs ?? []);

  if (logs.length === 0) {
    return {
      status: "empty",
      summary: `未查到慢查询日志: ${input.dbNames.join(", ")}`,
      outputSummary: { dbNames: input.dbNames, logCount: 0 }
    };
  }

  const maxQueryTime = Math.max(...logs.map((log) => Number(log.query_time ?? 0)));
  const worst = logs.find((log) => Number(log.query_time ?? 0) === maxQueryTime);
  return {
    status: "ok",
    summary: `查到 ${logs.length} 条 MySQL 慢查询，最大 Query_time=${maxQueryTime}s`,
    data: { logs },
    outputSummary: {
      dbNames: input.dbNames,
      logCount: logs.length,
      maxQueryTime,
      rowsExamined: worst?.rows_examined,
      sql: worst?.sql
    },
    detectedKeywords: ["SQL", "slow query"]
  };
}
