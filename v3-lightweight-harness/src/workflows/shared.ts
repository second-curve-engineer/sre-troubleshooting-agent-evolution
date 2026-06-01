// Workflow 共享步骤：放置多个 workflow 都会复用的 app 解析和代码问答逻辑。
import { AppInfo } from "../schemas/app.js";
import { RunState } from "../schemas/run.js";
import { EvidenceStore } from "../harness/evidence-store.js";
import { ToolInvoker } from "./types.js";

export async function resolveAppForWorkflow(args: {
  state: RunState;
  evidence: EvidenceStore;
  invokeTool: ToolInvoker;
  userMessage: string;
}): Promise<void> {
  const appResult = await args.invokeTool(
    args.state,
    "step-resolve-app",
    "resolve_app",
    {
      query: args.state.decision?.appHint ?? args.userMessage
    },
    ["resolve_app"]
  );

  if (appResult.status !== "ok") return;

  args.state.app = appResult.data as AppInfo;
  args.evidence.add({
    source: "resolve_app",
    kind: "app",
    summary: `应用解析为 ${args.state.app.appId}，代码库 ${args.state.app.codebasePath}`,
    confidence: "high",
    usedInFinalReport: true
  });
}

export async function askCodeIfPossible(args: {
  state: RunState;
  evidence: EvidenceStore;
  invokeTool: ToolInvoker;
}): Promise<void> {
  if (!args.state.app?.codebasePath) return;

  const codeResult = await args.invokeTool(
    args.state,
    "step-code",
    "ask_codebase",
    {
      codebasePath: "inventory-service",
      question: "根据 trace 异常栈定位代码根因"
    },
    ["ask_codebase"]
  );

  args.evidence.add({
    source: "ask_codebase",
    kind: "code",
    summary: `${codeResult.summary}; 文件=${String((codeResult.outputSummary ?? {}).file ?? "unknown")}:${String((codeResult.outputSummary ?? {}).line ?? "")}`,
    confidence: codeResult.status === "ok" ? "high" : "medium",
    usedInFinalReport: true
  });
}
