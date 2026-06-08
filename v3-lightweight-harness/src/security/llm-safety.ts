// LLM Safety：统一封装进入 LLM/报告前的脱敏和 prompt injection 拦截。
// 流程：redactText（脱敏）→ redactInjectionPatterns（注入文本替换）
// 命中的注入模式被替换为 [INJECTION_BLOCKED]，模型不会看到原始注入文本。
import { redactInjectionPatterns, PromptInjectionFinding } from "./prompt-injection.js";
import { redactText } from "./redaction.js";

export type SafetyResult = {
  text: string;
  redactedTypes: string[];
  promptInjectionFindings: PromptInjectionFinding[];
};

export function sanitizeForLlm(input: string): SafetyResult {
  const redacted = redactText(input);
  const { text, findings: promptInjectionFindings } = redactInjectionPatterns(redacted.text);

  return {
    text,
    redactedTypes: redacted.redactedTypes,
    promptInjectionFindings
  };
}

export function safetySummary(result: SafetyResult): string | undefined {
  const parts: string[] = [];
  if (result.redactedTypes.length > 0) {
    parts.push(`redacted=${result.redactedTypes.join(",")}`);
  }
  if (result.promptInjectionFindings.length > 0) {
    parts.push(
      `prompt_injection=${result.promptInjectionFindings
        .map((finding) => finding.pattern)
        .join(",")}`
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}
