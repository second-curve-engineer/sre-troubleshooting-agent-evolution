// Prompt Injection 防护：识别日志/用户输入中试图改写系统指令的文本。
export type PromptInjectionFinding = {
  pattern: string;
  severity: "medium" | "high";
};

const INJECTION_RULES: Array<{
  pattern: string;
  regex: RegExp;
  severity: "medium" | "high";
}> = [
  {
    pattern: "ignore_previous_instructions",
    regex: /ignore (all )?(previous|above) instructions/gi,
    severity: "high"
  },
  {
    pattern: "chinese_ignore_previous",
    regex: /忽略(以上|之前|前面).{0,12}(指令|规则|要求)/g,
    severity: "high"
  },
  {
    pattern: "reveal_system_prompt",
    regex: /(show|reveal|print).{0,20}(system prompt|developer message|hidden prompt)/gi,
    severity: "high"
  },
  {
    pattern: "act_as_system",
    regex: /(你现在是|act as).{0,20}(system|系统|developer|管理员)/gi,
    severity: "medium"
  },
  {
    pattern: "tool_instruction_in_log",
    regex: /(调用|执行|call|use).{0,20}(tool|工具|delete|drop|回滚|发布)/gi,
    severity: "medium"
  }
];

export function detectPromptInjection(input: string): PromptInjectionFinding[] {
  const findings: PromptInjectionFinding[] = [];
  for (const rule of INJECTION_RULES) {
    if (rule.regex.test(input)) {
      findings.push({
        pattern: rule.pattern,
        severity: rule.severity
      });
    }
    rule.regex.lastIndex = 0;
  }
  return findings;
}

// 将命中的注入模式原地替换为 [INJECTION_BLOCKED]，模型不会看到原始注入文本。
// 比追加警告更彻底：不依赖模型"理解并遵守"安全提示，直接消除威胁。
export function redactInjectionPatterns(input: string): {
  text: string;
  findings: PromptInjectionFinding[];
} {
  const findings = detectPromptInjection(input);
  if (findings.length === 0) {
    return { text: input, findings };
  }

  let text = input;
  for (const rule of INJECTION_RULES) {
    text = text.replace(rule.regex, "[INJECTION_BLOCKED]");
    rule.regex.lastIndex = 0;
  }
  return { text, findings };
}
