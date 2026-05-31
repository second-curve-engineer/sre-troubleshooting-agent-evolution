import { RunState } from "../schemas/run.js";
import { ToolName } from "../tools/tool-registry.js";
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

  return {
    id: args.testCase.id,
    passed: checks.every((check) => check.passed),
    checks,
    tracePath: args.tracePath
  };
}
