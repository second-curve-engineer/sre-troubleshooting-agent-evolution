// Eval Runner：批量执行 case，并输出适合 CI/人工阅读的回归结果。
import { HarnessRunner } from "../harness/runner.js";
import { createJudgeEvaluator } from "../llm/judge-evaluator.js";
import { evalCases } from "./cases.js";
import { EvalCaseResult, evaluateCase } from "./metrics.js";

export async function runEvals(): Promise<EvalCaseResult[]> {
  const results: EvalCaseResult[] = [];
  // judge 实例在整批 eval 中复用（openai 模式共享 HTTP 客户端）
  const judgeEvaluator = createJudgeEvaluator();

  for (const testCase of evalCases) {
    const runner = new HarnessRunner({
      toolExecution: testCase.toolTimeoutMs ? { timeoutMs: testCase.toolTimeoutMs } : undefined
    });
    const result = await runner.run(testCase.input, `eval-${testCase.id}`);

    // LLM-as-judge：仅在 case 指定了 minJudgeScore 且有 finalReport 时调用
    let judgeResult = undefined;
    if (testCase.minJudgeScore !== undefined && result.state.finalReport) {
      judgeResult = await judgeEvaluator.evaluate({
        userMessage: testCase.input,
        finalReport: result.state.finalReport,
        evidence: result.state.evidence.map((e) => ({ source: e.source, summary: e.summary }))
      });
    }

    results.push(
      evaluateCase({
        testCase,
        state: result.state,
        tracePath: result.tracePath,
        judgeResult
      })
    );
  }

  return results;
}

export function renderEvalResults(results: EvalCaseResult[]): string {
  const passedCount = results.filter((result) => result.passed).length;
  const lines = [`Eval results: ${passedCount}/${results.length} passed`, ""];

  for (const result of results) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.id}`);
    for (const check of result.checks) {
      lines.push(`  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.message}`);
    }
    lines.push(`  trace: ${result.tracePath}`);
    lines.push("");
  }

  return lines.join("\n");
}
