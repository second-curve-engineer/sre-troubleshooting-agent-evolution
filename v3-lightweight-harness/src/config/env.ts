// 读取 LLM 相关环境变量，决定 router/report 使用 mock 还是真实 OpenAI-compatible API。
export type LlmMode = "mock" | "openai";

export type LlmConfig = {
  mode: LlmMode;
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

export type ToolExecutionConfig = {
  timeoutMs: number;
};

function asLlmMode(value: string | undefined): LlmMode {
  return value === "openai" ? "openai" : "mock";
}

export function loadLlmConfig(): LlmConfig {
  return {
    mode: asLlmMode(process.env.LLM_MODE ?? process.env.LLM_ROUTER_MODE ?? process.env.LLM_REPORT_MODE),
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? process.env.LLM_ROUTER_MODEL ?? process.env.LLM_REPORT_MODEL ?? "gpt-5.5",
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? process.env.LLM_ROUTER_TIMEOUT_MS ?? process.env.LLM_REPORT_TIMEOUT_MS ?? 15000)
  };
}

export function loadToolExecutionConfig(): ToolExecutionConfig {
  return {
    timeoutMs: Number(process.env.TOOL_TIMEOUT_MS ?? 3000)
  };
}
