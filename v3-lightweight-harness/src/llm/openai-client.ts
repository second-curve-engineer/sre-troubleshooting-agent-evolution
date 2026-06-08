// OpenAI-compatible Chat Completions 客户端。
// 封装 fetch / AbortController / response 解析 / 错误分类 / 自动重试，
// 各 adapter 只关心 messages 构造和结果处理。
// 支持所有 /chat/completions 兼容网关（OpenAI、DeepSeek、Moonshot、通义等）。
import { TokenUsage } from "../schemas/llm.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionOptions = {
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" | "text" };
};

export type ChatCompletionResult = {
  content: string;
  tokenUsage: TokenUsage;
};

// 可重试错误：网络抖动、超时、限流（429）、服务端临时故障（5xx）。
// adapter 层 catch 到此类错误时，可以选择等待后重试，或直接降级。
export class LlmRetryableError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = "LlmRetryableError";
  }
}

// 不可重试错误：认证失败（401）、请求格式非法（400）、模型不存在（404）等。
// 重试无意义，adapter 应立即降级并记录原因。
export class LlmFatalError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = "LlmFatalError";
  }
}

type RawResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
};

// HTTP 状态码 → 错误分类。
// 429（限流）、5xx（服务端故障）、网络中断 → 可重试。
// 400（参数错误）、401（认证失败）、404（模型不存在）→ 不可重试。
function classifyHttpError(status: number, message: string): LlmRetryableError | LlmFatalError {
  if (status === 429 || status >= 500) {
    return new LlmRetryableError(message, status);
  }
  return new LlmFatalError(message, status);
}

const RETRY_DELAYS_MS = [500, 1000];  // 最多重试 2 次，退避 500ms / 1000ms。

export class OpenAiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  // 调用 /chat/completions，内置重试（仅对可重试错误）。
  // 抛出的异常类型：LlmRetryableError（重试耗尽）或 LlmFatalError（不可重试）。
  // adapter 层统一 catch Error，无需感知具体子类，但可按需区分处理。
  async complete(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
    let lastError: Error = new Error("unreachable");

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this.attempt(options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // 不可重试错误（认证失败、参数错误等）立即向上抛，不浪费重试次数。
        if (err instanceof LlmFatalError) {
          throw err;
        }

        const delayMs = RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) {
          // 重试次数耗尽，抛出最后一次错误。
          break;
        }
        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  // 单次 HTTP 调用，成功返回结果，失败抛出已分类的错误。
  private async attempt(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: options.model,
          temperature: options.temperature ?? 0,
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
          messages: options.messages
        })
      });

      const data = (await response.json()) as RawResponse;
      if (!response.ok) {
        throw classifyHttpError(
          response.status,
          data.error?.message ?? `LLM HTTP ${response.status}`
        );
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        // 模型返回空内容，视为可重试（可能是服务端临时异常）。
        throw new LlmRetryableError("LLM returned empty content");
      }

      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;
      return {
        content,
        tokenUsage: {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens: data.usage?.total_tokens ?? promptTokens + completionTokens
        }
      };
    } catch (err) {
      // AbortController 触发（超时）→ 可重试。
      // 已分类的 Llm*Error 直接上抛，不重复包装。
      if (err instanceof LlmRetryableError || err instanceof LlmFatalError) {
        throw err;
      }
      throw new LlmRetryableError(
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
