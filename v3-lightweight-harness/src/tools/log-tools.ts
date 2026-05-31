import { ToolResult } from "../schemas/tool.js";
import { readMockJson } from "./data.js";

type LogItem = Record<string, unknown>;
type LogPayload = {
  status?: string;
  result?: { data?: { logs?: LogItem[]; apps?: string[] } };
};

const KEYWORDS = [
  "timeout",
  "Connection timed out",
  "SQL",
  "NullPointerException",
  "RemoteServiceException",
  "slow query"
];

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOf(log: LogItem): string {
  return Object.values(log).map(String).join(" ");
}

function detectKeywords(logs: LogItem[]): string[] {
  const corpus = logs.map(textOf).join("\n").toLowerCase();
  return KEYWORDS.filter((keyword) => corpus.includes(keyword.toLowerCase()));
}

function summarizeLog(log: LogItem): Record<string, unknown> {
  return {
    timestamp: log.timestamp,
    appId: log.app_id,
    level: log["log.level"],
    traceId: log["log.trace_id"],
    path: log["http.path"],
    exceptionType: log["exception.type"],
    exceptionMessage: log["exception.message"],
    message: log.message
  };
}

function applyQuery(logs: LogItem[], query: string): LogItem[] {
  const lowered = query.toLowerCase();
  const has504 = lowered.includes("504");
  const has500 = lowered.includes("500");
  const wantsTimeout = lowered.includes("timeout");
  const wantsSql = lowered.includes("sql");
  const wantsError = lowered.includes("error");

  return logs.filter((log) => {
    const text = textOf(log).toLowerCase();
    if (has504 && !text.includes("504")) return false;
    if (has500 && !text.includes("500") && asString(log["log.level"]) !== "ERROR") return false;
    if (wantsTimeout && !text.includes("timeout")) return false;
    if (wantsSql && !text.includes("sql")) return false;
    if (wantsError && asString(log["log.level"]) !== "ERROR") return false;
    return true;
  });
}

export async function queryLogsByTraceId(input: {
  traceId: string;
  env?: string;
}): Promise<ToolResult> {
  const data = await readMockJson<Record<string, LogPayload>>("logs-by-trace-id.json");
  const payload = data[input.traceId];
  const logs = payload?.result?.data?.logs ?? [];

  if (logs.length === 0) {
    return {
      status: "empty",
      summary: `trace_id ${input.traceId} 未查到链路日志`,
      outputSummary: { traceId: input.traceId, logCount: 0 }
    };
  }

  const errors = logs.filter((log) => log["log.level"] === "ERROR" || log["exception.type"]);
  return {
    status: "ok",
    summary: `trace_id ${input.traceId} 查到 ${logs.length} 条链路日志`,
    data: { logs, errors },
    outputSummary: {
      traceId: input.traceId,
      logCount: logs.length,
      apps: payload?.result?.data?.apps ?? [],
      errorCount: errors.length,
      firstErrorApp: errors[0]?.app_id,
      firstException: errors[0]?.["exception.type"]
    },
    detectedKeywords: detectKeywords(logs)
  };
}

export async function queryLogsByCondition(input: {
  appId: string;
  query: string;
  fromTime?: string;
  toTime?: string;
  env?: string;
  limit?: number;
}): Promise<ToolResult> {
  const limit = input.limit ?? 5;
  const data = await readMockJson<Record<string, LogPayload>>("logs-by-condition.json");
  const allLogs = data[input.appId]?.result?.data?.logs ?? [];
  let matched = applyQuery(allLogs, input.query);

  // The public mock is intentionally small. Simulate the common production
  // failure mode where a broad 504 query returns too many rows.
  const broad504Query =
    input.query.includes("504") &&
    !input.query.toLowerCase().includes("timeout") &&
    !input.query.toLowerCase().includes("sql");
  if (broad504Query) {
    matched = [...allLogs, ...allLogs, ...allLogs];
  }

  const truncated = matched.length > limit;
  const sampleLogs = matched.slice(0, limit);
  const detectedKeywords = detectKeywords(sampleLogs);
  const traceIds = Array.from(
    new Set(matched.map((log) => log["log.trace_id"]).filter(Boolean).map(String))
  );
  const suggestedNextQueries = truncated
    ? [
        "SELECT * WHERE http.status_code = '504' and log.msg ~ 'timeout'",
        "SELECT * WHERE log.msg ~ 'Connection timed out' and log.msg ~ 'SQL'"
      ]
    : [];

  return {
    status: matched.length === 0 ? "empty" : truncated ? "too_many_results" : "ok",
    summary:
      matched.length === 0
        ? "条件日志未命中"
        : truncated
          ? `条件日志命中 ${matched.length} 条，结果过宽，已截断`
          : `条件日志命中 ${matched.length} 条`,
    data: { logs: sampleLogs.map(summarizeLog), traceIds },
    outputSummary: {
      appId: input.appId,
      query: input.query,
      logCount: matched.length,
      returnedCount: sampleLogs.length,
      truncated,
      traceIds
    },
    suggestedNextQueries,
    detectedKeywords
  };
}
