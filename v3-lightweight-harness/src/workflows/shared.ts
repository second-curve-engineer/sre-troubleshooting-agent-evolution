// Workflow 共享步骤：放置多个 workflow 都会复用的 app 解析和代码问答逻辑。
import { AppInfo, AppInfoSchema } from "../schemas/app.js";
import { RunState } from "../schemas/run.js";
import { EvidenceStore } from "../harness/evidence-store.js";
import { readMockJson } from "../tools/data.js";
import { ToolInvoker, WorkflowContext } from "./types.js";

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
    summary: `应用解析为 ${args.state.app.appId}`,
    confidence: "high",
    usedInFinalReport: true
  });
}

/**
 * 调用 ask_codebase 工具，将源码根因分析结果写入 evidence。
 *
 * @param context     workflow 上下文
 * @param stackTrace  从上游日志结果中提取的异常栈（可选）
 *                    有值时走真实文件读取 + LLM 分析路径；无值时降级为 mock。
 * @param errorAppId  首次抛出异常的 app_id（可选）
 *                    用户描述的入口服务（state.app）和实际报错服务可能不同，
 *                    例如用户说 order-service 报 500，根因在 inventory-service。
 *                    传入后优先用该服务的 appId / codebasePath。
 */
export async function askCodeIfPossible(
  context: WorkflowContext,
  stackTrace?: string,
  errorAppId?: string
): Promise<void> {
  if (!context.state.app) return;

  // 默认使用入口服务的 appId / codebasePath
  let appId = context.state.app.appId;
  let codebasePath = context.state.app.codebasePath;

  // 异常来自另一个服务时，查 app-registry 获取该服务的 appId / codebasePath
  // 直接读 JSON（不经 invokeTool），不影响 toolTraces
  if (errorAppId && errorAppId !== context.state.app.appId) {
    try {
      const registry = await readMockJson<unknown[]>("app-registry.json");
      const errorApp = registry
        .map((item) => AppInfoSchema.parse(item))
        .find((app) => app.appId === errorAppId);
      if (errorApp) {
        appId = errorApp.appId;
        codebasePath = errorApp.codebasePath;
      }
    } catch {
      // 查不到则继续使用入口服务
    }
  }

  const codeResult = await context.invokeTool(
    context.state,
    "step-code",
    "ask_codebase",
    {
      appId,
      ...(codebasePath ? { codebasePath } : {}),
      question: "根据 trace 异常栈定位代码根因",
      ...(stackTrace ? { stackTrace } : {})
    },
    ["ask_codebase"]
  );

  const codeSummary = await context.evidenceSummarizer.summarize({
    toolName: "ask_codebase",
    toolResult: codeResult
  });
  context.evidence.add({
    source: "ask_codebase",
    kind: "code",
    summary: codeSummary,
    confidence: codeResult.status === "ok" ? "high" : "medium",
    usedInFinalReport: true
  });
}
