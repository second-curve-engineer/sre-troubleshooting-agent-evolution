// Redaction：在文本进入 LLM 上下文或报告前替换常见敏感信息。
export type RedactionResult = {
  text: string;
  redactedTypes: string[];
};

const REDACTION_RULES: Array<{
  type: string;
  pattern: RegExp;
  replacement: string;
}> = [
  {
    type: "authorization_header",
    pattern: /authorization\s*[:=]\s*bearer\s+[a-zA-Z0-9._\-]+/gi,
    replacement: "authorization: Bearer [REDACTED_SECRET]"
  },
  {
    type: "bearer_token",
    pattern: /bearer\s+[a-zA-Z0-9._\-]+/gi,
    replacement: "Bearer [REDACTED_SECRET]"
  },
  {
    type: "api_key",
    pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"',\s]+/gi,
    replacement: "$1=[REDACTED_SECRET]"
  },
  {
    type: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]"
  },
  {
    type: "phone",
    pattern: /\b1[3-9]\d{9}\b/g,
    replacement: "[REDACTED_PHONE]"
  },
  {
    type: "user_id",
    pattern: /\b(user[_-]?id|uid)\s*[:=]\s*[a-zA-Z0-9_-]+/gi,
    replacement: "$1=[REDACTED_USER_ID]"
  }
];

export function redactText(input: string): RedactionResult {
  let text = input;
  const redactedTypes = new Set<string>();

  for (const rule of REDACTION_RULES) {
    if (rule.pattern.test(text)) {
      redactedTypes.add(rule.type);
      text = text.replace(rule.pattern, rule.replacement);
    }
    rule.pattern.lastIndex = 0;
  }

  return {
    text,
    redactedTypes: [...redactedTypes]
  };
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value).text;
  }
  if (Array.isArray(value)) {
    return value.map(redactUnknown);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactUnknown(nested)])
    );
  }
  return value;
}
