import { HarnessRunner } from "../harness/runner.js";
import { evalCases } from "./cases.js";
import { EvalCaseResult, evaluateCase } from "./metrics.js";

export async function runEvals(): Promise<EvalCaseResult[]> {
  const runner = new HarnessRunner();
  const results: EvalCaseResult[] = [];

  for (const testCase of evalCases) {
    const result = await runner.run(testCase.input, `eval-${testCase.id}`);
    results.push(
      evaluateCase({
        testCase,
        state: result.state,
        tracePath: result.tracePath
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
