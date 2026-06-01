// Mock 诊断报告生成器：用结构化假报告先跑通 harness/report/eval 链路。
import { DiagnosisReport } from "../schemas/diagnosis.js";
import { EvidenceItem } from "../schemas/evidence.js";
import { WorkflowDecision } from "../schemas/workflow.js";

export function generateMockDiagnosis(args: {
  decision: WorkflowDecision;
  evidence: EvidenceItem[];
}): DiagnosisReport {
  const evidenceSummaries = args.evidence.map((item) => item.summary);
  const evidenceText = evidenceSummaries.join("\n");
  const isPerformance = args.decision.problemType === "performance";
  const isUnknown = args.decision.problemType === "unknown";
  const hasToolFailure =
    evidenceText.includes("执行超过") ||
    evidenceText.includes("模拟失败") ||
    evidenceText.includes("工具失败") ||
    evidenceText.includes("timeout 处理");

  if (isUnknown) {
    return {
      problemAnalysis: "当前输入缺少开始排障所需的关键信息。",
      collectedEvidence: evidenceSummaries,
      rootCause: "证据不足，暂不能判断根因。",
      fixSuggestions: ["请补充服务名、环境、时间窗口、trace_id 或错误现象。"],
      verificationSteps: ["补充上下文后重新发起诊断。"],
      confidence: "low",
      missingContext: ["service", "env", "time_window", "symptom"]
    };
  }

  if (isPerformance) {
    if (hasToolFailure) {
      return {
        problemAnalysis: "这是一个性能问题，但关键工具调用出现失败或超时，当前证据链不完整。",
        collectedEvidence: evidenceSummaries,
        rootCause: "证据不足，暂不能确认根因；需要先恢复失败工具或补充替代证据。",
        fixSuggestions: [
          "先检查日志平台、慢查询平台或代码检索工具的可用性。",
          "使用替代时间窗口或备用数据源补齐证据。",
          "工具恢复后重新执行同一诊断 case。"
        ],
        verificationSteps: [
          "确认失败工具的 timeout / error 指标恢复正常。",
          "重新运行诊断，检查 trace 中是否拿到关键日志和慢查询证据。"
        ],
        confidence: "low",
        missingContext: ["tool_result"]
      };
    }

    return {
      problemAnalysis: "这是一个 504/timeout 类性能问题，需要先看应用日志，再基于 SQL/MySQL 线索查询慢查询。",
      collectedEvidence: evidenceSummaries,
      rootCause: "当前证据更像 MySQL 慢查询拉长接口响应时间，最终在入口层表现为 504。",
      fixSuggestions: [
        "检查慢 SQL 涉及表的过滤条件和索引设计。",
        "对高频查询增加分页、时间窗口限制或联合索引。",
        "在应用日志中补充 db_schema、query_time、rows_examined 等字段。"
      ],
      verificationSteps: [
        "修复后对比 504 数量、接口 P99 和慢查询数量。",
        "回放同类请求，确认 Query_time 和 rows_examined 下降。"
      ],
      confidence: "medium",
      missingContext: []
    };
  }

  return {
    problemAnalysis: "这是一个接口报错问题，trace 链路和异常栈可以帮助定位首次报错服务。",
    collectedEvidence: evidenceSummaries,
    rootCause: "首次异常指向 inventory-service，库存预占逻辑缺少空值保护。",
    fixSuggestions: [
      "在 InventoryService.reserve 中增加 inventory == null 的显式处理。",
      "返回可识别业务错误，避免 NullPointerException 直接冒泡。",
      "补充缺失库存记录场景的单元测试和接口回归测试。"
    ],
    verificationSteps: [
      "使用相同 skuId 回放下单请求，确认 500 不再出现。",
      "查询修复后 inventory-service 的 NullPointerException 是否下降。"
    ],
    confidence: "high",
    missingContext: []
  };
}
