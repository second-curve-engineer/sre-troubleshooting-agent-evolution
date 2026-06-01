export type RouterMode = "mock" | "openai";

export type LlmRouterConfig = {
  mode: RouterMode;
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

function asRouterMode(value: string | undefined): RouterMode {
  return value === "openai" ? "openai" : "mock";
}

export function loadLlmRouterConfig(): LlmRouterConfig {
  return {
    mode: asRouterMode(process.env.LLM_ROUTER_MODE ?? process.env.LLM_MODE),
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.LLM_ROUTER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.5",
    timeoutMs: Number(process.env.LLM_ROUTER_TIMEOUT_MS ?? 15000)
  };
}
