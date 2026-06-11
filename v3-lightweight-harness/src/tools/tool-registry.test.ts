import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HarnessRunner } from "../harness/runner.js";
import { RunState } from "../schemas/run.js";
import { ToolResult } from "../schemas/tool.js";
import { ToolName, ToolRegistry } from "./tool-registry.js";

describe("per-tool input schema", () => {
  const registry = new ToolRegistry();

  it("normalizes valid input with schema defaults", () => {
    const validation = registry.validateInvocation({
      toolName: "query_logs_by_condition",
      input: {
        appId: "order-service",
        query: "http.status_code = '504'"
      },
      allowedTools: ["query_logs_by_condition"]
    });

    expect(validation.success).toBe(true);
    if (validation.success) {
      expect(validation.input.env).toBe("prod");
      expect(validation.input.limit).toBe(20);
    }
  });

  it("rejects invalid types, unknown fields and unsafe limits", () => {
    const validation = registry.validateInvocation({
      toolName: "query_logs_by_condition",
      input: {
        appId: "order-service",
        query: "timeout",
        limit: "500",
        unexpected: true
      },
      allowedTools: ["query_logs_by_condition"]
    });

    expect(validation.success).toBe(false);
    if (!validation.success) {
      expect(validation.result.retryable).toBe(false);
      expect(validation.result.outputSummary?.validationType).toBe("invalid_tool_input");
      expect(validation.result.outputSummary?.validationIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "limit" }),
          expect.objectContaining({ code: "unrecognized_keys" })
        ])
      );
    }
  });

  it("rejects codebase paths that escape the project root", () => {
    const validation = registry.validateInvocation({
      toolName: "ask_codebase",
      input: {
        appId: "inventory-service",
        codebasePath: "../../private-source",
        question: "定位异常"
      },
      allowedTools: ["ask_codebase"]
    });

    expect(validation.success).toBe(false);
    if (!validation.success) {
      expect(validation.result.outputSummary?.validationIssues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "codebasePath" })])
      );
    }
  });

  it("checks the step whitelist before input schema validation", () => {
    const validation = registry.validateInvocation({
      toolName: "restart_service",
      input: {},
      allowedTools: ["query_logs_by_condition"]
    });

    expect(validation.success).toBe(false);
    if (!validation.success) {
      expect(validation.result.outputSummary?.validationType).toBe("tool_not_allowed");
    }
  });

  it("does not create approval records for invalid high-risk input", async () => {
    const runner = new HarnessRunner({ approvalMode: "strict" });
    const state: RunState = {
      runId: "run-invalid-high-risk",
      sessionId: "test",
      agentSpanId: randomUUID(),
      status: "running",
      userMessage: "test invalid high-risk input",
      approvals: [],
      completedSteps: {},
      evidence: [],
      toolTraces: [],
      llmCalls: []
    };
    const invokeTool = (
      runner as unknown as {
        invokeTool(
          state: RunState,
          stepId: string,
          toolName: ToolName,
          input: Record<string, unknown>,
          allowedTools: ToolName[]
        ): Promise<ToolResult>;
      }
    ).invokeTool.bind(runner);

    const result = await invokeTool(
      state,
      "step-invalid-restart",
      "restart_service",
      {
        appId: "order-service",
        reason: "short"
      },
      ["restart_service"]
    );

    expect(result.status).toBe("error");
    expect(result.outputSummary?.validationType).toBe("invalid_tool_input");
    expect(state.approvals).toHaveLength(0);
    expect(state.toolTraces).toHaveLength(1);
    expect(state.toolTraces[0]?.status).toBe("error");
    expect(state.toolTraces[0]?.approvalStatus).toBeUndefined();
    expect(state.toolTraces[0]?.attemptCount).toBe(1);
  });
});
