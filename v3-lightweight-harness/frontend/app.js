const chatLog = document.querySelector("#chatLog");
const form = document.querySelector("#diagnoseForm");
const input = document.querySelector("#messageInput");
const sendBtn = document.querySelector("#sendBtn");
const exampleBtn = document.querySelector("#exampleBtn");
const strictMode = document.querySelector("#strictMode");
const modeLabel = document.querySelector("#modeLabel");
const runStatus = document.querySelector("#runStatus");
const summaryGrid = document.querySelector("#summaryGrid");
const toolTrace = document.querySelector("#toolTrace");
const toolCount = document.querySelector("#toolCount");
const llmCalls = document.querySelector("#llmCalls");
const llmCount = document.querySelector("#llmCount");
const evidenceList = document.querySelector("#evidenceList");
const evidenceCount = document.querySelector("#evidenceCount");
const traceList = document.querySelector("#traceList");
const refreshBtn = document.querySelector("#refreshBtn");

const example =
  "order-service 下单接口从 10:30 开始大量 504，帮我排查。";
const hitlExample =
  "order-service 下单接口从 10:30 开始大量 504，模拟高风险重启，帮我排查。";

let sessionId = localStorage.getItem("v3-session-id") || `web-${crypto.randomUUID()}`;
localStorage.setItem("v3-session-id", sessionId);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusPill(value) {
  return `<span class="pill ${escapeHtml(value)}">${escapeHtml(value ?? "unknown")}</span>`;
}

function appendMessage(role, html, loading = false) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.innerHTML = `
    <div class="avatar">${role === "user" ? "用户" : "V3"}</div>
    <div class="bubble ${loading ? "loading" : ""}">${html}</div>
  `;
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
  return article;
}

function renderReport(report) {
  if (!report) return "<p>本次 run 未生成报告。</p>";
  const list = (items) => `<ul>${(items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  return `
    <h3>问题分析</h3>
    <p>${escapeHtml(report.problemAnalysis)}</p>
    <h3>已收集证据</h3>
    ${list(report.collectedEvidence)}
    <h3>根因判断</h3>
    <p>${escapeHtml(report.rootCause)}</p>
    <h3>修复建议</h3>
    ${list(report.fixSuggestions)}
    <h3>后续验证</h3>
    ${list(report.verificationSteps)}
    <p>confidence: <code>${escapeHtml(report.confidence)}</code></p>
  `;
}

function renderApproval(state) {
  if (state.status !== "waiting_approval" || !state.pendingApprovalId) return "";
  const approval = (state.approvals || []).find((item) => item.approvalId === state.pendingApprovalId);
  return `
    <div class="approvalBox">
      <strong>等待人工审批</strong>
      <div class="muted mono">${escapeHtml(state.pendingApprovalId)}</div>
      <div>tool: <code>${escapeHtml(approval?.toolName)}</code> · risk: <code>${escapeHtml(approval?.riskLevel)}</code></div>
      <div class="approvalActions">
        <button class="approve" type="button" data-approval="${escapeHtml(state.pendingApprovalId)}" data-decision="approve">Approve</button>
        <button class="reject" type="button" data-approval="${escapeHtml(state.pendingApprovalId)}" data-decision="reject">Reject</button>
      </div>
    </div>
  `;
}

function renderSummary(state) {
  runStatus.textContent = state.status || "unknown";
  runStatus.className = `badge ${state.status || ""}`;
  const metrics = [
    ["Run ID", state.runId],
    ["Session", state.sessionId],
    ["Route", state.route],
    ["Problem", state.problemType],
    ["Router", `${state.router?.source || "unknown"} / ${state.router?.confidence ?? "-"}`],
    ["LLM Tokens", (state.llmCalls || []).reduce((sum, call) => sum + (call.tokenUsage?.totalTokens || 0), 0)]
  ];
  summaryGrid.innerHTML = metrics
    .map(
      ([label, value]) => `
        <div class="metric">
          <div class="metricLabel">${escapeHtml(label)}</div>
          <div class="metricValue">${escapeHtml(value ?? "-")}</div>
        </div>
      `
    )
    .join("");
}

function renderTools(items) {
  toolCount.textContent = String(items?.length || 0);
  if (!items?.length) {
    toolTrace.innerHTML = '<li class="muted">暂无工具调用</li>';
    return;
  }
  toolTrace.innerHTML = items
    .map(
      (item, index) => `
        <li>
          <span class="stepNum">${index + 1}</span>
          <div>
            <div class="stepName">${escapeHtml(item.toolName)}</div>
            <div class="stepMeta">${escapeHtml(item.stepId)} · ${escapeHtml(item.durationMs)}ms · risk=${escapeHtml(item.riskLevel)}</div>
          </div>
          ${statusPill(item.status)}
        </li>
      `
    )
    .join("");
}

function renderLlmCalls(items) {
  llmCount.textContent = String(items?.length || 0);
  if (!items?.length) {
    llmCalls.innerHTML = '<div class="muted">暂无 LLM 调用</div>';
    return;
  }
  llmCalls.innerHTML = items
    .map((item) => {
      const used = item.tokenUsage?.totalTokens ?? 0;
      return `
        <div class="llmItem">
          <div class="row">
            <strong>${escapeHtml(item.role)}</strong>
            ${statusPill(item.source)}
          </div>
          <div class="mono">${escapeHtml(item.modelTier)} · ${escapeHtml(item.model)}</div>
          <div class="muted">tokens ${used}/${escapeHtml(item.tokenBudget)} · timeout ${escapeHtml(item.timeoutMs)}ms</div>
          ${(item.notes || []).map((note) => `<div class="muted">${escapeHtml(note)}</div>`).join("")}
        </div>
      `;
    })
    .join("");
}

function renderEvidence(items) {
  evidenceCount.textContent = String(items?.length || 0);
  if (!items?.length) {
    evidenceList.innerHTML = '<li class="muted">暂无证据</li>';
    return;
  }
  evidenceList.innerHTML = items
    .map((item) => `<li><strong>${escapeHtml(item.source)}</strong> · ${escapeHtml(item.summary)}</li>`)
    .join("");
}

function renderState(state) {
  renderSummary(state);
  renderTools(state.toolTraces || []);
  renderLlmCalls(state.llmCalls || []);
  renderEvidence(state.evidence || []);
  modeLabel.textContent = state.status === "waiting_approval" ? "HITL pending" : "Harness mode";
}

function setBusy(isBusy) {
  sendBtn.disabled = isBusy;
  exampleBtn.disabled = isBusy;
  input.disabled = isBusy;
  strictMode.disabled = isBusy;
  sendBtn.textContent = isBusy ? "分析中…" : "诊断";
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function loadTraces() {
  const response = await fetch("/api/traces");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!data.traces?.length) {
    traceList.innerHTML = '<div class="muted">暂无历史 trace</div>';
    return;
  }
  traceList.innerHTML = data.traces
    .map(
      (trace) => `
        <div class="traceItem" data-run-id="${escapeHtml(trace.runId)}">
          <div class="row">
            <strong class="mono">${escapeHtml(trace.runId)}</strong>
            ${statusPill(trace.status)}
          </div>
          <div class="muted">${escapeHtml(trace.route || "-")} · ${escapeHtml(trace.problemType || "-")} · ${escapeHtml(trace.confidence || "-")}</div>
        </div>
      `
    )
    .join("");
}

async function loadTrace(runId) {
  const response = await fetch(`/api/traces/${encodeURIComponent(runId)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const trace = await response.json();
  renderState({
    ...trace.run,
    route: trace.run.decision?.route,
    problemType: trace.run.decision?.problemType
  });
  appendMessage("assistant", `<p>已加载历史 trace：<code>${escapeHtml(runId)}</code></p>${renderReport(trace.run.finalReport)}`);
}

exampleBtn.addEventListener("click", () => {
  input.value = strictMode.checked ? hitlExample : example;
  input.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  appendMessage("user", escapeHtml(message));
  input.value = "";
  setBusy(true);
  const loadingNode = appendMessage("assistant", "正在执行 router、workflow 和工具调用…", true);

  try {
    const state = await postJson("/api/diagnose", {
      message,
      sessionId,
      approvalMode: strictMode.checked ? "strict" : "auto"
    });
    sessionId = state.sessionId;
    localStorage.setItem("v3-session-id", sessionId);
    renderState(state);
    loadingNode.querySelector(".bubble").classList.remove("loading");
    loadingNode.querySelector(".bubble").innerHTML = `${renderReport(state.finalReport)}${renderApproval(state)}`;
    await loadTraces();
  } catch (error) {
    loadingNode.querySelector(".bubble").classList.remove("loading");
    loadingNode.querySelector(".bubble").textContent = `诊断请求失败：${error.message}`;
  } finally {
    setBusy(false);
    input.focus();
  }
});

chatLog.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-approval]");
  if (!button) return;
  button.disabled = true;
  try {
    const approvalId = button.dataset.approval;
    const decision = button.dataset.decision;
    const state = await postJson(`/api/approvals/${approvalId}/${decision}`);
    renderState(state);
    appendMessage("assistant", `<p>审批结果：<code>${escapeHtml(decision)}</code></p>${renderReport(state.finalReport)}`);
    await loadTraces();
  } catch (error) {
    appendMessage("assistant", `<p>审批失败：${escapeHtml(error.message)}</p>`);
  }
});

traceList.addEventListener("click", async (event) => {
  const item = event.target.closest("[data-run-id]");
  if (!item) return;
  await loadTrace(item.dataset.runId);
});

refreshBtn.addEventListener("click", () => {
  void loadTraces();
});

void loadTraces();
