// Eval 指标：基于运行后的 state/trace 检查路由、工具顺序、证据和 token 成本。
import { RunState } from "../schemas/run.js";
import { ToolName } from "../tools/tool-registry.js";
import { JudgeEvaluatorOutput } from "../llm/judge-evaluator.js";
import { EvalCase } from "./cases.js";

export type EvalCheck = {
  name: string;
  passed: boolean;
  message: string;
};

export type EvalCaseResult = {
  id: string;
  passed: boolean;
  checks: EvalCheck[];
  tracePath: string;
};

function containsOrderedSubsequence(actual: string[], expected: string[]): boolean {
  let cursor = 0;
  for (const item of actual) {
    if (item === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return expected.length === 0;
}

function evidenceText(state: RunState): string {
  return [
    ...state.evidence.map((item) => item.summary),
    state.finalReport?.problemAnalysis ?? "",
    state.finalReport?.rootCause ?? "",
    ...(state.finalReport?.collectedEvidence ?? []),
    ...(state.finalReport?.fixSuggestions ?? []),
    ...(state.finalReport?.verificationSteps ?? [])
  ].join("\n");
}

export function evaluateCase(args: {
  testCase: EvalCase;
  state: RunState;
  tracePath: string;
  judgeResult?: JudgeEvaluatorOutput;
}): EvalCaseResult {
  const actualRoute = args.state.decision?.route;
  const actualTools = args.state.toolTraces.map((trace) => trace.toolName as ToolName);
  const routerTokens = args.state.router?.tokenUsage?.totalTokens ?? 0;
  const text = evidenceText(args.state);

  const checks: EvalCheck[] = [
    {
      name: "route",
      passed: actualRoute === args.testCase.expectedRoute,
      message: `expected ${args.testCase.expectedRoute}, actual ${actualRoute ?? "unknown"}`
    },
    {
      name: "tool_order",
      passed: containsOrderedSubsequence(actualTools, args.testCase.expectedTools),
      message: `expected ${args.testCase.expectedTools.join(" -> ") || "(none)"}, actual ${actualTools.join(" -> ") || "(none)"}`
    },
    {
      name: "evidence_keywords",
      passed: args.testCase.expectedEvidenceKeywords.every((keyword) => text.includes(keyword)),
      message: `expected keywords: ${args.testCase.expectedEvidenceKeywords.join(", ")}`
    },
    {
      name: "report_fields",
      passed: Boolean(
        args.state.finalReport?.problemAnalysis &&
          args.state.finalReport.rootCause &&
          args.state.finalReport.fixSuggestions.length > 0 &&
          args.state.finalReport.verificationSteps.length > 0
      ),
      message: "final report has required fields"
    }
  ];

  if (args.testCase.expectedConfidence) {
    checks.push({
      name: "confidence",
      passed: args.state.finalReport?.confidence === args.testCase.expectedConfidence,
      message: `expected ${args.testCase.expectedConfidence}, actual ${args.state.finalReport?.confidence ?? "unknown"}`
    });
  }

  if (args.testCase.expectedUsedLlm !== undefined) {
    checks.push({
      name: "router_used_llm",
      passed: args.state.router?.usedLlm === args.testCase.expectedUsedLlm,
      message: `expected ${args.testCase.expectedUsedLlm}, actual ${args.state.router?.usedLlm ?? "unknown"}`
    });
  }

  if (args.testCase.maxRouterTokens !== undefined) {
    checks.push({
      name: "router_token_budget",
      passed: routerTokens <= args.testCase.maxRouterTokens,
      message: `expected <= ${args.testCase.maxRouterTokens}, actual ${routerTokens}`
    });
  }

  // 这是 eval 回归检查，不是运行时熔断；用于发现某个 role 的模型策略开始超预算。
  const overBudgetCalls = args.state.llmCalls.filter(
    (call) => call.tokenUsage && call.tokenUsage.totalTokens > call.tokenBudget
  );
  checks.push({
    name: "llm_policy_budget",
    passed: overBudgetCalls.length === 0,
    message:
      overBudgetCalls.length === 0
        ? `all ${args.state.llmCalls.length} llm calls within policy budget`
        : overBudgetCalls
            .map((call) => `${call.role}:${call.tokenUsage?.totalTokens ?? 0}/${call.tokenBudget}`)
            .join(", ")
  });

  if (args.testCase.expectedApprovals) {
    for (const expected of args.testCase.expectedApprovals) {
      const matched = args.state.approvals.some(
        (approval) =>
          approval.toolName === expected.toolName &&
          approval.riskLevel === expected.riskLevel &&
          approval.status === expected.status
      );
      checks.push({
        name: `approval_${expected.toolName}`,
        passed: matched,
        message: `expected ${expected.toolName} risk=${expected.riskLevel} status=${expected.status}`
      });
    }
  }

  if (args.testCase.expectedToolStatuses) {
    for (const expected of args.testCase.expectedToolStatuses) {
      const matched = args.state.toolTraces.some(
        (trace) => trace.toolName === expected.toolName && trace.status === expected.status
      );
      checks.push({
        name: `tool_status_${expected.toolName}_${expected.status}`,
        passed: matched,
        message: `expected ${expected.toolName} status=${expected.status}`
      });
    }
  }

  // Golden Answer：对 finalReport 核心字段做结构化关键词比对，比 evidence_keywords 更精准。
  // 这是质量基线，换模型或改 prompt 后只要 rootCause/fixSuggestions 出现回退立即可见。
  if (args.testCase.goldenAnswer) {
    const rootCause = args.state.finalReport?.rootCause ?? "";
    const fixText = (args.state.finalReport?.fixSuggestions ?? []).join("\n");
    const analysisText = args.state.finalReport?.problemAnalysis ?? "";
    const { rootCauseKeywords, fixKeywords, problemAnalysisKeywords } = args.testCase.goldenAnswer;

    const rootCauseMissing = rootCauseKeywords.filter((k) => !rootCause.includes(k));
    checks.push({
      name: "golden_root_cause",
      passed: rootCauseMissing.length === 0,
      message:
        rootCauseMissing.length === 0
          ? `rootCause contains all golden keywords: ${rootCauseKeywords.join(", ")}`
          : `rootCause missing: ${rootCauseMissing.join(", ")}`
    });

    const fixMissing = fixKeywords.filter((k) => !fixText.includes(k));
    checks.push({
      name: "golden_fix",
      passed: fixMissing.length === 0,
      message:
        fixMissing.length === 0
          ? `fixSuggestions contains all golden keywords: ${fixKeywords.join(", ")}`
          : `fixSuggestions missing: ${fixMissing.join(", ")}`
    });

    const analysisMissing = problemAnalysisKeywords.filter((k) => !analysisText.includes(k));
    checks.push({
      name: "golden_analysis",
      passed: analysisMissing.length === 0,
      message:
        analysisMissing.length === 0
          ? `problemAnalysis contains all golden keywords: ${problemAnalysisKeywords.join(", ")}`
          : `problemAnalysis missing: ${analysisMissing.join(", ")}`
    });
  }

  // LLM-as-judge：仅在 testCase 指定了 minJudgeScore 且 runner 传入了 judgeResult 时执行
  if (args.testCase.minJudgeScore !== undefined && args.judgeResult) {
    const minScore = args.testCase.minJudgeScore;
    const { score, reasoning, passed: judgePassed } = args.judgeResult;
    checks.push({
      name: "judge_quality",
      passed: judgePassed && score >= minScore,
      message: `score=${score.toFixed(2)} (min=${minScore}): ${reasoning}`
    });
  }

  return {
    id: args.testCase.id,
    passed: checks.every((check) => check.passed),
    checks,
    tracePath: args.tracePath
  };
}
