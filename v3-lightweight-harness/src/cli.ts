// CLI 入口：负责解析 diagnose/eval 命令，并把 Runner/Eval 的结构化结果渲染到终端。
import { HarnessRunner } from "./harness/runner.js";
import { renderEvalResults, runEvals } from "./evals/runner.js";

function renderUsage(): void {
  console.log(`Usage:
  npm run diagnose -- "<故障描述>"
  npm run hitl-demo
  npm run eval

Examples:
  npm run diagnose -- "prod 环境 order-service 下单接口从 10:30 开始大量 500，trace_id 是 demo-trace-001，帮我排查。"
  npm run diagnose -- "order-service 下单接口从 10:30 开始大量 504，帮我排查。"
  npm run hitl-demo`);
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

async function runHitlDemo(): Promise<void> {
  const message = "order-service 下单接口从 10:30 开始大量 504，模拟高风险重启，帮我排查。";

  console.log("## HITL pending demo");
  const pendingRunner = new HarnessRunner({ approvalMode: "strict" });
  const pending = await pendingRunner.run(message, "cli-hitl-pending");
  console.log(`status: ${pending.state.status}`);
  console.log(`pendingApprovalId: ${pending.state.pendingApprovalId ?? "(none)"}`);
  console.log(`resumeFromStepId: ${pending.state.resumeFromStepId ?? "(none)"}`);
  console.log(`trace: ${pending.tracePath}`);
  console.log(
    `approvals: ${pending.state.approvals
      .map((approval) => `${approval.toolName}:${approval.riskLevel}:${approval.status}`)
      .join(", ")}`
  );
  console.log(
    `toolTraces: ${pending.state.toolTraces
      .map((trace) => `${trace.toolName}:${trace.status}:${trace.approvalStatus ?? "none"}`)
      .join(", ")}`
  );
  console.log("");

  if (!pending.state.pendingApprovalId) {
    console.log("No pending approval generated.");
    return;
  }

  console.log("## approve -> resume");
  const approved = await pendingRunner.resume(pending.state, {
    approvalId: pending.state.pendingApprovalId,
    decision: "approved"
  });
  console.log(`status: ${approved.state.status}`);
  console.log(`trace: ${approved.tracePath}`);
  console.log(
    `restart_service executed: ${approved.state.toolTraces.some(
      (trace) => trace.toolName === "restart_service" && trace.status === "ok"
    )}`
  );
  console.log("");

  console.log("## reject -> no execution");
  const rejectRunner = new HarnessRunner({ approvalMode: "strict" });
  const pendingForReject = await rejectRunner.run(message, "cli-hitl-reject");
  const rejected = await rejectRunner.resume(pendingForReject.state, {
    approvalId: pendingForReject.state.pendingApprovalId!,
    decision: "rejected"
  });
  console.log(`status: ${rejected.state.status}`);
  console.log(`trace: ${rejected.tracePath}`);
  console.log(
    `restart_service executed: ${rejected.state.toolTraces.some(
      (trace) => trace.toolName === "restart_service" && trace.status === "ok"
    )}`
  );
  console.log(`confidence: ${rejected.state.finalReport?.confidence ?? "unknown"}`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === "eval") {
    const results = await runEvals();
    console.log(renderEvalResults(results));
    process.exitCode = results.every((result) => result.passed) ? 0 : 1;
    return;
  }

  if (command === "hitl-demo") {
    await runHitlDemo();
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
