// Report Adapter 单测：验证真实 LLM report 失败时会 fallback 到 mock report。
import { describe, expect, it } from "vitest";
import { OpenAiDiagnosisGenerator } from "./report-adapter.js";

const input = {
  userMessage: "order-service 下单接口从 10:30 开始大量 504，帮我排查。",
  decision: {
    problemType: "performance" as const,
    route: "performance" as const,
    reason: "输入包含 504"
  },
  evidence: [
    {
      id: "ev-1",
      source: "query_mysql_slow_log",
      kind: "slow_query" as const,
      summary: "查到 2 条 MySQL 慢查询，最大 Query_time=5.83s",
      safetyFlags: [],
      confidence: "high" as const,
      usedInFinalReport: true
    }
  ]
};

describe("OpenAiDiagnosisGenerator", () => {
  it("falls back to mock report when api key is missing", async () => {
    const generator = new OpenAiDiagnosisGenerator({
      mode: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "test-model",
      timeoutMs: 1000
    });

    const result = await generator.generate(input);

    expect(result.trace.source).toBe("fallback");
    expect(result.trace.error).toContain("OPENAI_API_KEY");
    expect(result.report.problemAnalysis).toContain("504");
    expect(result.report.confidence).toBe("medium");
  });
});
