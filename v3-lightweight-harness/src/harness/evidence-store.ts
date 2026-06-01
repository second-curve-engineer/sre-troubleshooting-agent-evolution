// Evidence Store：收集本轮诊断中可进入报告和 eval 的证据摘要。
import { EvidenceItem } from "../schemas/evidence.js";
import { EvidenceInput } from "../schemas/evidence.js";
import { safetySummary, sanitizeForLlm } from "../security/llm-safety.js";

export class EvidenceStore {
  private nextId = 1;
  private readonly items: EvidenceItem[] = [];

  add(item: Omit<EvidenceInput, "id">): EvidenceItem {
    const sanitized = sanitizeForLlm(item.summary);
    const summary = safetySummary(sanitized);
    const evidence: EvidenceItem = {
      id: `ev-${this.nextId++}`,
      ...item,
      summary: summary ? `${sanitized.text} [security: ${summary}]` : sanitized.text,
      confidence: item.confidence ?? "medium",
      usedInFinalReport: item.usedInFinalReport ?? true,
      safetyFlags: [
        ...(item.safetyFlags ?? []),
        ...sanitized.redactedTypes.map((type) => `redacted:${type}`),
        ...sanitized.promptInjectionFindings.map((finding) => `prompt_injection:${finding.pattern}`)
      ]
    };
    this.items.push(evidence);
    return evidence;
  }

  list(): EvidenceItem[] {
    return [...this.items];
  }
}
