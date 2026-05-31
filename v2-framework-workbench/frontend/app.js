const chatLog = document.querySelector("#chatLog");
const form = document.querySelector("#chatForm");
const input = document.querySelector("#messageInput");
const sendBtn = document.querySelector("#sendBtn");
const exampleBtn = document.querySelector("#exampleBtn");
const modeLabel = document.querySelector("#modeLabel");
const toolTrace = document.querySelector("#toolTrace");
const evidenceList = document.querySelector("#evidenceList");
const traceCount = document.querySelector("#traceCount");

let sessionId = localStorage.getItem("v2-session-id") || null;

const example =
  "order-service 下单接口从 10:30 开始出现大量 500，trace_id 是 demo-trace-001，帮我排查。";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAnswer(text) {
  return escapeHtml(text).replace(/^## (.+)$/gm, "<h2>$1</h2>");
}

function appendMessage(role, text, loading = false) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = role === "user" ? "用户" : "诊断助手";
  article.innerHTML = `
    <div class="avatar">${label}</div>
    <div class="bubble ${loading ? "loading" : ""}">${loading ? escapeHtml(text) : renderAnswer(text)}</div>
  `;
  chatLog.appendChild(article);
  chatLog.scrollTop = chatLog.scrollHeight;
  return article;
}

function renderTrace(items) {
  toolTrace.innerHTML = "";
  traceCount.textContent = String(items.length);
  if (!items.length) {
    toolTrace.innerHTML = '<li class="muted">本轮未返回工具路径</li>';
    return;
  }
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="step-num">${i + 1}</span>
      <span class="step-name">${escapeHtml(item.name)}</span>
      <span class="step-status">${escapeHtml(item.status)}</span>
    `;
    toolTrace.appendChild(li);
  });
}

function renderEvidence(items) {
  evidenceList.innerHTML = "";
  if (!items.length) {
    evidenceList.innerHTML = '<li class="muted">本轮未返回结构化证据</li>';
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    evidenceList.appendChild(li);
  }
}

function setBusy(isBusy) {
  sendBtn.disabled = isBusy;
  exampleBtn.disabled = isBusy;
  input.disabled = isBusy;
  sendBtn.innerHTML = isBusy
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg> 分析中…`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg> 诊断`;
}

exampleBtn.addEventListener("click", () => {
  input.value = example;
  input.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  appendMessage("user", message);
  input.value = "";
  setBusy(true);
  const loadingNode = appendMessage("assistant", "正在分析问题、查询日志并整理证据...", true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session_id: sessionId }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    sessionId = data.session_id;
    localStorage.setItem("v2-session-id", sessionId);
    modeLabel.textContent = data.mode === "agent" ? "Agent mode" : "Demo mode";
    loadingNode.querySelector(".bubble").classList.remove("loading");
    loadingNode.querySelector(".bubble").innerHTML = renderAnswer(data.answer);
    renderTrace(data.tool_trace || []);
    renderEvidence(data.evidence || []);
  } catch (error) {
    loadingNode.querySelector(".bubble").classList.remove("loading");
    loadingNode.querySelector(".bubble").textContent = `诊断请求失败：${error.message}`;
  } finally {
    setBusy(false);
    input.focus();
    chatLog.scrollTop = chatLog.scrollHeight;
  }
});
