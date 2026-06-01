// Evidence Store：收集本轮诊断中可进入报告和 eval 的证据摘要。
import { EvidenceItem } from "../schemas/evidence.js";

export class EvidenceStore {
  private nextId = 1;
  private readonly items: EvidenceItem[] = [];

  add(item: Omit<EvidenceItem, "id">): EvidenceItem {
    const evidence: EvidenceItem = {
      id: `ev-${this.nextId++}`,
      ...item
    };
    this.items.push(evidence);
    return evidence;
  }

  list(): EvidenceItem[] {
    return [...this.items];
  }
}
