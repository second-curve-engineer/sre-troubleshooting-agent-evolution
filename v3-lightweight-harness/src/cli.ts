// CLI 入口：负责解析 diagnose/eval 命令，并把 Runner/Eval 的结构化结果渲染到终端。
import { HarnessRunner } from "./harness/runner.js";
import { renderEvalResults, runEvals } from "./evals/runner.js";

function renderUsage(): void {
  console.log(`Usage:
  npm run diagnose -- "<故障描述>"
  npm run eval

Examples:
  npm run diagnose -- "prod 环境 order-service 下单接口从 10:30 开始大量 500，trace_id 是 demo-trace-001，帮我排查。"
  npm run diagnose -- "order-service 下单接口从 10:30 开始大量 504，帮我排查。"`);
}

function renderReport(result: Awaited<ReturnType<HarnessRunner["run"]>>): void {
  const report = result.state.finalReport;
  console.log(`run_id: ${result.state.runId}`);
  console.log(`route: ${result.state.decision?.route}`);
  console.log(`problem_type: ${result.state.decision?.problemType}`);
  console.log(`trace: ${result.tracePath}`);
  console.log("");

  if (!report) {
    console.log("No report generated.");
    return;
  }

  console.log("## 问题分析");
  console.log(report.problemAnalysis);
  console.log("");
  console.log("## 已收集证据");
  for (const item of report.collectedEvidence) {
    console.log(`- ${item}`);
  }
  console.log("");
  console.log("## 根因判断");
  console.log(report.rootCause);
  console.log("");
  console.log("## 修复建议");
  for (const item of report.fixSuggestions) {
    console.log(`- ${item}`);
  }
  console.log("");
  console.log("## 后续验证");
  for (const item of report.verificationSteps) {
    console.log(`- ${item}`);
  }
  console.log("");
  console.log(`confidence: ${report.confidence}`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === "eval") {
    const results = await runEvals();
    console.log(renderEvalResults(results));
    process.exitCode = results.every((result) => result.passed) ? 0 : 1;
    return;
  }

  if (command !== "diagnose") {
    renderUsage();
    return;
  }
  const message = rest.join(" ").trim();
  if (!message) {
    renderUsage();
    process.exitCode = 1;
    return;
  }

  const runner = new HarnessRunner();
  const result = await runner.run(message);
  renderReport(result);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
