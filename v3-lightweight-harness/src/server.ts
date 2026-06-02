// API server：暴露 diagnose / trace viewer / HITL resume，供前端复盘 Agent 执行链路。
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { z } from "zod";
import { ApprovalMode } from "./harness/approval-policy.js";
import { HarnessRunner } from "./harness/runner.js";
import { TraceStore } from "./harness/trace-store.js";
import { RunState } from "./schemas/run.js";

const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? "127.0.0.1";
const FRONTEND_DIR = join(process.cwd(), "frontend");

const DiagnoseRequestSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
  approvalMode: z.enum(["auto", "strict"]).optional()
});

type PendingRun = {
  runner: HarnessRunner;
  state: RunState;
};

const traces = new TraceStore();
const pendingRuns = new Map<string, PendingRun>();

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendError(response: ServerResponse, statusCode: number, message: string): void {
  sendJson(response, statusCode, { error: message });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function summarizeState(state: RunState, tracePath?: string): Record<string, unknown> {
  return {
    runId: state.runId,
    sessionId: state.sessionId,
    status: state.status,
    pendingApprovalId: state.pendingApprovalId,
    route: state.decision?.route,
    problemType: state.decision?.problemType,
    router: state.router,
    approvals: state.approvals,
    toolTraces: state.toolTraces,
    evidence: state.evidence,
    llmCalls: state.llmCalls,
    reportGeneration: state.reportGeneration,
    finalReport: state.finalReport,
    tracePath
  };
}

async function handleDiagnose(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = DiagnoseRequestSchema.parse(await readJson(request));
  const approvalMode: ApprovalMode = body.approvalMode ?? "auto";
  const runner = new HarnessRunner({ approvalMode });
  const result = await runner.run(body.message, body.sessionId ?? "web");

  if (result.state.status === "waiting_approval" && result.state.pendingApprovalId) {
    pendingRuns.set(result.state.pendingApprovalId, {
      runner,
      state: result.state
    });
  }

  sendJson(response, 200, summarizeState(result.state, result.tracePath));
}

async function handleApproval(
  approvalId: string,
  decision: "approved" | "rejected",
  response: ServerResponse
): Promise<void> {
  const pending = pendingRuns.get(approvalId);
  if (!pending) {
    sendError(response, 404, `pending approval ${approvalId} not found`);
    return;
  }

  const result = await pending.runner.resume(pending.state, {
    approvalId,
    decision
  });
  pendingRuns.delete(approvalId);

  if (result.state.status === "waiting_approval" && result.state.pendingApprovalId) {
    pendingRuns.set(result.state.pendingApprovalId, {
      runner: pending.runner,
      state: result.state
    });
  }

  sendJson(response, 200, summarizeState(result.state, result.tracePath));
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const normalized = normalize(relativePath);
  if (normalized.startsWith("..")) {
    sendError(response, 403, "invalid path");
    return;
  }

  const filePath = join(FRONTEND_DIR, normalized);
  const contentTypeByExt: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  };

  try {
    await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypeByExt[extname(filePath)] ?? "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendError(response, 404, "not found");
  }
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  try {
    if (request.method === "GET" && pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "POST" && pathname === "/api/diagnose") {
      await handleDiagnose(request, response);
      return;
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
    if (request.method === "POST" && approvalMatch) {
      await handleApproval(approvalMatch[1], approvalMatch[2] === "approve" ? "approved" : "rejected", response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/traces") {
      sendJson(response, 200, { traces: await traces.list() });
      return;
    }

    const traceMatch = pathname.match(/^\/api\/traces\/([^/]+)$/);
    if (request.method === "GET" && traceMatch) {
      sendJson(response, 200, await traces.read(traceMatch[1]));
      return;
    }

    if (request.method === "GET") {
      await serveStatic(pathname, response);
      return;
    }

    sendError(response, 405, "method not allowed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(response, 500, message);
  }
}

createServer((request, response) => {
  void route(request, response);
}).listen(PORT, HOST, () => {
  console.log(`V3 trace viewer: http://${HOST}:${PORT}`);
});
