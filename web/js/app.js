/* SWE-bench Pro 最小集评测框架 - 前端逻辑(原生 JS,无外部依赖) */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ---------------- API ---------------- */
async function api(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { msg = (await resp.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return resp.json();
}

function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- Tab 切换 ---------------- */
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  $$(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  $$(".tabpanel").forEach((p) => p.classList.remove("active"));
  $(`#tab-${btn.dataset.tab}`).classList.add("active");
  if (btn.dataset.tab === "monitor") { refreshRuns(); }
  if (btn.dataset.tab === "report") { loadReportOptions(); }
  if (btn.dataset.tab === "compare") { loadCompareOptions(); }
  if (btn.dataset.tab === "pool") { loadPool(); }
});

function gotoTab(name, runId = null) {
  $(`#tabs .tab[data-tab="${name}"]`).click();
  if (runId && name === "monitor") selectRun(runId);
  if (runId && name === "report") { $("#report-select").value = runId; renderReport(runId); }
}

/* ---------------- 新建评测 ---------------- */
const SEGMENTS = { "suite-level": "smoke6" };
Object.keys(SEGMENTS).forEach((id) => {
  $(`#${id}`).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    $$(`#${id} button`).forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    SEGMENTS[id] = btn.dataset.v;
    if (id === "suite-level") SELECTED_SUITE_ID = null;
  });
});

/* ----- 已保存套件复用 ----- */
let SELECTED_SUITE_ID = null;
let suitesCache = [];

function readProvider(role) {
  const grid = $(`[data-provider="${role}"]`);
  const get = (n) => grid.querySelector(`[name="${n}"]`).value.trim();
  const num = (n, d) => { const v = parseFloat(get(n)); return isNaN(v) ? d : v; };
  // OpenRouter Provider 路由:列表字段逗号分隔,枚举/布尔留空则不发送
  const splitList = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const routing = {};
  ["only", "ignore", "order"].forEach((k) => {
    const list = splitList(get(`pr_${k}`));
    if (list.length) routing[k] = list;
  });
  if (get("pr_allow_fallbacks")) routing.allow_fallbacks = get("pr_allow_fallbacks") === "true";
  if (get("pr_sort")) routing.sort = get("pr_sort");
  if (get("pr_require_parameters")) routing.require_parameters = get("pr_require_parameters") === "true";
  if (get("pr_data_policy")) routing.data_policy = get("pr_data_policy");
  return {
    name: get("name") || "Provider",
    base_url: get("base_url"),
    model: get("model"),
    api_key: get("api_key"),
    role: "provider",
    temperature: num("temperature", 1.0),
    top_p: num("top_p", 0.95),
    max_tokens: Math.round(num("max_tokens", 32768)),
    reasoning_effort: get("reasoning_effort") || null,
    price_input_per_m: num("price_input_per_m", 0),
    price_cached_per_m: num("price_cached_per_m", 0),
    price_output_per_m: num("price_output_per_m", 0),
    provider: Object.keys(routing).length ? routing : null,
  };
}

/* ----- Provider 配置档案:保存 / 载入 / 删除 ----- */
let profilesCache = [];

async function refreshProfiles() {
  try {
    profilesCache = await api("/api/provider-profiles");
  } catch (_) { profilesCache = []; }
  ["provider"].forEach((role) => {
    const sel = $(`#profile-select-${role}`);
    const cur = sel.value;
    sel.innerHTML = `<option value="">📂 已保存配置(${profilesCache.length})</option>` +
      profilesCache.map((p) =>
        `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.model || "-")}</option>`).join("");
    sel.value = profilesCache.some((p) => p.id === cur) ? cur : "";
  });
}

function fillProviderForm(role, conf) {
  const grid = $(`[data-provider="${role}"]`);
  const set = (n, v) => { grid.querySelector(`[name="${n}"]`).value = v ?? ""; };
  set("name", conf.name); set("base_url", conf.base_url);
  set("model", conf.model); set("api_key", conf.api_key || "");
  set("temperature", conf.temperature ?? 1.0); set("top_p", conf.top_p ?? 0.95);
  set("max_tokens", conf.max_tokens ?? 32768); set("reasoning_effort", conf.reasoning_effort || "max");
  set("price_input_per_m", conf.price_input_per_m || "");
  set("price_cached_per_m", conf.price_cached_per_m || "");
  set("price_output_per_m", conf.price_output_per_m || "");
  const pr = conf.provider || {};
  set("pr_only", (pr.only || []).join(","));
  set("pr_ignore", (pr.ignore || []).join(","));
  set("pr_order", (pr.order || []).join(","));
  set("pr_allow_fallbacks", pr.allow_fallbacks === false ? "false" : "");
  set("pr_sort", pr.sort || "");
  set("pr_require_parameters", pr.require_parameters === true ? "true" : "");
  set("pr_data_policy", pr.data_policy || "");
}

["provider"].forEach((role) => {
  $(`#profile-select-${role}`).addEventListener("change", (e) => {
    const p = profilesCache.find((x) => x.id === e.target.value);
    if (!p) return;
    fillProviderForm(role, p.config || {});
    toast(`已载入配置「${p.name}」(可继续修改,保存将覆盖)`);
  });

  $(`#btn-save-${role}`).addEventListener("click", async (btnEv) => {
    const conf = readProvider(role);
    if (!conf.base_url || !conf.model) {
      toast("请先填写 Base URL 与 Model ID 后再保存");
      return;
    }
    const name = conf.name || conf.model;
    const btn = btnEv.currentTarget;
    btn.disabled = true;
    try {
      const res = await api("/api/provider-profiles", "POST", { name, config: conf });
      toast(`已保存 Provider 配置「${name}」`);
      await refreshProfiles();
      $(`#profile-select-${role}`).value = res.id;
    } catch (err) {
      toast(`保存失败:${err.message}`, 5200);
    } finally {
      btn.disabled = false;
    }
  });

  $(`#btn-del-profile-${role}`).addEventListener("click", async () => {
    const sel = $(`#profile-select-${role}`);
    const p = profilesCache.find((x) => x.id === sel.value);
    if (!p) { toast("请先在下拉框选择要删除的配置"); return; }
    if (!confirm(`删除 Provider 配置「${p.name}」?`)) return;
    try {
      await api(`/api/provider-profiles/${encodeURIComponent(p.id)}`, "DELETE");
      toast(`已删除「${p.name}」`);
      await refreshProfiles();
    } catch (err) { toast(`删除失败:${err.message}`); }
  });
});

/* ----- Provider 连通性测试 ----- */
async function testProviderConn(role) {
  const btn = $(`#btn-test-${role}`);
  const status = $(`#test-status-${role}`);
  if (!btn || btn.disabled) return;
  const conf = readProvider(role);
  if (!conf.base_url || !conf.model) {
    toast("请先填写 Base URL 与 Model ID 后再测试连通");
    return;
  }
  btn.disabled = true;
  status.className = "test-status testing";
  status.textContent = "测试中…";
  status.title = "";
  try {
    const res = await api("/api/test-provider", "POST", { provider: conf });
    if (res.ok) {
      const ttft = res.ttft_s != null ? ` · TTFT ${Math.round(res.ttft_s * 1000)}ms` : "";
      const only = res.provider_routing && res.provider_routing.only;
      const routing = only ? ` · 仅 ${only.join("/")}` : "";
      const reasoning = res.reasoning_chars > 0
        ? ` · 思考型(本次 ${res.reasoning_chars} 字符思维链)` : "";
      status.className = "test-status ok";
      status.textContent = `✓ 连通 · ${res.wall_s}s${ttft}${routing}${reasoning}`;
    } else {
      const first = ((res.errors && res.errors[0]) || "请求失败");
      status.className = "test-status fail";
      status.textContent = `✗ ${first.slice(0, 140)}`;
      status.title = (res.errors || []).join(" | ");
    }
  } catch (err) {
    status.className = "test-status fail";
    status.textContent = `✗ ${err.message.slice(0, 140)}`;
  } finally {
    btn.disabled = false;
  }
}

$("#btn-test-provider").addEventListener("click", () => testProviderConn("provider"));

function buildRunBody() {
  return {
    provider: readProvider("provider"),
    suite_level: SEGMENTS["suite-level"],
    suite_id: SELECTED_SUITE_ID,
    scaffold: "agent",
    turn_limit: parseInt($("#turn-limit").value) || 50,
    dataset_source: "official",
    docker_enabled: true,
    evaluator: "official",
  };
}

async function startRun(body) {
  const res = await api("/api/runs", "POST", body);
  toast(`评测已启动:${res.run_id}`);
  gotoTab("monitor", res.run_id);
}

$("#btn-start").addEventListener("click", async () => {
  const body = buildRunBody();
  if (!body.provider.base_url || !body.provider.model) {
    toast("请先填写 Base URL 与 Model ID", 4200);
    return;
  }
  $("#btn-start").disabled = true;
  $("#start-note").textContent = "提交中…";
  try {
    await startRun(body);
  } catch (err) {
    toast(`启动失败:${err.message}`, 4200);
    $("#start-note").textContent = err.message;
  } finally {
    $("#btn-start").disabled = false;
    setTimeout(() => { $("#start-note").textContent = ""; }, 5000);
  }
});

/* ---------------- 运行监控 ---------------- */
let selectedRunId = null;
let monitorTimer = null;
let liveFastTimer = null;
let liveEntries = [];
let liveSel = null;
let autoOpenedLive = false; // 本次选中运行是否已自动打开过实时面板

/* 实时输出面板的高速轮询：面板打开时以更细粒度拉取流式增量，视觉上接近逐字输出 */
function startLiveFastPoll() {
  stopLiveFastPoll();
  liveFastTimer = setInterval(() => updateLivePanel(), 300);
}
function stopLiveFastPoll() {
  if (liveFastTimer) { clearInterval(liveFastTimer); liveFastTimer = null; }
}

const STATUS_BADGE = {
  queued: ["pending", "排队中"], running: ["running", "运行中"],
  analyzing: ["running", "分析中"],
  completed: ["done", "已完成"], failed: ["fail", "失败"],
  cancelled: ["cancel", "已取消"],
};

const TERMINAL_STATUS = ["completed", "failed", "cancelled"];

async function refreshRuns() {
  const runs = await api("/api/runs");
  const tbody = $("#runs-table tbody");
  tbody.innerHTML = runs.map((r) => {
    const [cls, label] = STATUS_BADGE[r.status] || ["pending", r.status];
    const pct = r.progress && r.progress.total
      ? Math.round((r.progress.done / r.progress.total) * 100) : 0;
    return `<tr data-run="${r.run_id}" class="clickable">
      <td class="mono">${esc(r.run_id)}</td>
      <td><span class="badge ${cls}">${label}</span></td>
      <td>${esc(r.suite_level || "-")}</td>
      <td class="mono">${esc(r.provider_name || "—")} / ${esc(r.model || "—")}</td>
      <td style="min-width:110px"><div class="progress" style="height:6px"><div class="progress-bar" style="width:${pct}%"></div></div><span style="font-size:11px;color:var(--muted)">${r.progress.done}/${r.progress.total}</span></td>
      <td style="font-size:12px;color:var(--muted)">${esc((r.created_at || "").replace("T", " ").slice(0, 19))}</td>
      <td>${r.report_ready ? `<button class="btn sm primary" data-view="${r.run_id}">报告</button>` : ""}
          ${TERMINAL_STATUS.includes(r.status)
            ? `<button class="btn sm danger" data-del="${r.run_id}" title="删除该运行的全部产物">删除</button>` : ""}</td>
    </tr>`;
  }).join("");
  $("#runs-empty").style.display = runs.length ? "none" : "block";
}

$("#runs-table").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    const runId = del.dataset.del;
    if (!confirm(`删除运行 ${runId}?\n其全部产物(清单 / 记录 / 报告 / 轨迹)将被永久删除,不可恢复。`)) return;
    try {
      await api(`/api/runs/${encodeURIComponent(runId)}`, "DELETE");
      toast(`已删除 ${runId}`);
      if (selectedRunId === runId) {
        selectedRunId = null;
        clearInterval(monitorTimer);
        closeLivePanel();
        $("#monitor-detail").style.display = "none";
      }
      await refreshRuns();
      loadReportOptions();
      loadCompareOptions();
    } catch (err) { toast(`删除失败:${err.message}`, 4000); }
    return;
  }
  const view = e.target.closest("[data-view]");
  if (view) { gotoTab("report", view.dataset.view); return; }
  const tr = e.target.closest("tr[data-run]");
  if (tr) selectRun(tr.dataset.run);
});
$("#btn-refresh-runs").addEventListener("click", refreshRuns);

async function selectRun(runId) {
  selectedRunId = runId;
  autoOpenedLive = false;
  closeLivePanel();
  $("#monitor-detail").style.display = "block";
  $("#monitor-title").textContent = `运行详情 · ${runId}`;
  clearInterval(monitorTimer);
  await pollMonitor();
  monitorTimer = setInterval(pollMonitor, 1200);
}

async function pollMonitor() {
  if (!selectedRunId) return;
  let st, liveInfo;
  try {
    [st, liveInfo] = await Promise.all([
      api(`/api/runs/${selectedRunId}/state`),
      api(`/api/runs/${selectedRunId}/live`).catch(() => ({ entries: [] })),
    ]);
  } catch (_) { clearInterval(monitorTimer); return; }
  liveEntries = liveInfo.entries || [];
  renderLiveStats(liveInfo.summary);

  const [cls, label] = STATUS_BADGE[st.status] || ["pending", st.status];
  const { done, total } = st.progress;
  $("#prog-bar").style.width = total ? `${(done / total) * 100}%` : "0%";
  $("#prog-text").textContent = `${done} / ${total}`;
  $("#phase-badge").textContent = `${label} · ${st.phase}`;
  $("#phase-badge").style.background =
    ["completed"].includes(st.status) ? "#d1fae5" : "#dbeafe";
  $("#btn-cancel").style.display =
    ["queued", "running", "analyzing"].includes(st.status) ? "" : "none";
  $("#btn-view-report").style.display = st.report_ready ? "" : "none";

  const suite = st.suite || { instances: [] };
  const bandOrder = { easy: 0, medium: 1, hard: 2 };
  const orderedInsts = [...suite.instances]
    .sort((a, b) => (bandOrder[a.difficulty] ?? 3) - (bandOrder[b.difficulty] ?? 3));
  $("#inst-grid").innerHTML = orderedInsts.map((inst) => {
    const stat = (st.instance_status || {})[inst.instance_id] || {};
    const chip = (v) => v ? `<span class="res-tag res-${v[0].toUpperCase()}">${{ p: "PASS", f: "FAIL", e: "ERR", r: "…" }[v[0].toLowerCase()] || v}</span>` : `<span class="res-tag" style="background:#f1f5f9;color:#94a3b8">—</span>`;
    const runsOf = (role) => Object.keys(stat)
      .filter((k) => k.startsWith(role) && k !== role)
      .sort()
      .map((k) => chip(stat[k]))
      .map((c, i) => `<span class="spark">${c}</span>`).join("");
    const cur = (st.progress.current || {});
    const running = cur.instance_id === inst.instance_id;
    const pulling = running && cur.phase === "pull_image";
    const streaming = liveEntries.some((e) =>
      e.instance_id === inst.instance_id && e.status === "streaming");
    const selected = liveSel && liveSel.iid === inst.instance_id;
    return `<div class="inst-cell clickable" data-iid="${esc(inst.instance_id)}"
      ${running ? 'style="border-color:var(--primary);box-shadow:0 0 0 2px rgba(37,99,235,.15)"' : ""}
      ${selected ? 'data-selected="1"' : ""}>
      <div class="iid">${streaming ? '<span style="color:#ef4444" title="流式输出中">●</span> ' : ""}${esc(inst.instance_id)}</div>
${pulling ? '<div style="color:#2563eb;font-size:11px;margin:2px 0">⏳ 正在拉取镜像（可能需要几分钟）…</div>' : ""}
      <div class="meta">${esc(inst.repo)} · ${esc(inst.language_family)} · ${esc(inst.task_type)} · ${esc(inst.difficulty)}</div>
      <div class="res">
        <span class="res-tag res-a">M</span>${chip(stat.provider)}${runsOf("provider")}
      </div>
    </div>`;
  }).join("");

  if (liveSel) updateLivePanel();
  // 运行后默认打开实时输出面板：首个流式条目出现时自动打开一次
  // (用户手动收起后不再自动弹出；切换运行时重新允许)
  else if (!autoOpenedLive) {
    const streaming = liveEntries.find((e) => e.status === "streaming");
    if (streaming) {
      autoOpenedLive = true;
      openLivePanel(streaming.instance_id);
    }
  }

  if (["completed", "failed", "cancelled"].includes(st.status)) {
    clearInterval(monitorTimer);
    stopLiveFastPoll();
    refreshRuns();
    if (st.status === "completed") { loadReportOptions(); loadCompareOptions(); }
    if (st.status === "failed") toast(`运行失败:${(st.error || "").split("\n").slice(-2)[0]}`, 5000);
  }
}

function renderLiveStats(summary) {
  const box = $("#live-stats");
  if (!box) return;
  if (!summary || !summary.total_tokens) {
    box.style.display = "none";
    return;
  }
  box.style.display = "flex";
  $("#live-rate").textContent =
    summary.overall_tps != null ? summary.overall_tps.toFixed(1) : "—";
  $("#live-cache").textContent = `${Number(summary.cache_hit_rate || 0).toFixed(1)}%`;
  $("#live-input").textContent = Number(summary.prompt_tokens || 0).toLocaleString();
  $("#live-output").textContent = Number(summary.completion_tokens || 0).toLocaleString();
  $("#live-cost").textContent = `$${Number(summary.cost_usd || 0).toFixed(6)}`;
  $("#live-stream-count").textContent = summary.streaming_count
    ? ` · ${summary.streaming_count} 路流式输出中`
    : "";
}

/* ---------------- 实时输出面板 ---------------- */

function stickScroll(pre, mutate) {
  const pinned = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48;
  mutate();
  if (pinned) pre.scrollTop = pre.scrollHeight;
}

function closeLivePanel() {
  liveSel = null;
  stopLiveFastPoll();
  $("#live-panel").style.display = "none";
}

$("#btn-live-close").addEventListener("click", closeLivePanel);

$("#inst-grid").addEventListener("click", (e) => {
  const cell = e.target.closest(".inst-cell");
  if (!cell || !cell.dataset.iid) return;
  if (liveSel && liveSel.iid === cell.dataset.iid) { closeLivePanel(); return; }
  openLivePanel(cell.dataset.iid);
});

function openLivePanel(iid) {
  const entries = liveEntries
    .filter((e) => e.instance_id === iid)
    .sort((a, b) => (a.provider_role + a.run_index)
      .localeCompare(b.provider_role + b.run_index));
  liveSel = null;
  $("#live-panel").style.display = "block";
  $("#live-iid").textContent = iid;
  $("#live-meta").innerHTML = "";
  $("#live-tabs").innerHTML = "";
  $("#live-turns").innerHTML = "";
  if (!entries.length) {
    $("#live-meta").innerHTML =
      `该实例暂无实时数据:尚未执行到该题,或服务重启导致进程内缓冲丢失。` +
      `完成的实例可在「📊 结果报告」页查看记录与失败轨迹。`;
    $("#live-body").style.display = "none";
    return;
  }
  $("#live-body").style.display = "";
  startLiveFastPoll();
  $("#live-tabs").innerHTML = entries.map((e, i) =>
    `<button class="btn sm${i === pickLiveEntry(entries) ? " primary" : ""}"
       data-role="${esc(e.provider_role)}" data-run="${e.run_index}">
       ${esc(e.model)} · r${e.run_index}${e.status === "streaming" ? " ●" : ""}</button>`).join("");
  $("#live-tabs").querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", () => switchLiveTab(iid, btn.dataset.role, +btn.dataset.run)));
  const first = entries[pickLiveEntry(entries)];
  switchLiveTab(iid, first.provider_role, first.run_index);
}

function pickLiveEntry(entries) {
  const idx = entries.findIndex((e) => e.status === "streaming");
  return idx >= 0 ? idx : entries.length - 1;
}

function switchLiveTab(iid, role, runIndex) {
  liveSel = {
    iid, role, runIndex,
    turn: 0, rOffset: 0, cOffset: 0, tOffset: 0, finalized: false,
    blocks: new Map(), // turn -> { root, rPre, cPre, rLen, cLen }
  };
  $("#live-turns").innerHTML = "";
  $("#live-tabs").querySelectorAll("button").forEach((btn) =>
    btn.classList.toggle("primary",
      btn.dataset.role === role && +btn.dataset.run === runIndex));
  updateLivePanel(true);
}

/* 渲染一轮对话块：外层 details 控制整轮，内层两个 details 分别收纳思考过程与模型输出，
   流式到对应内容时自动展开，进入下一轮时自动收起(用户手动展开不受影响) */
function makeTurnBlock(turnIdx, label) {
  const box = document.createElement("details");
  box.className = "live-turn";
  box.open = true;
  box.style.cssText = "border:1px solid #e2e8f0;border-radius:8px;margin:6px 0;background:#fff";
  const sum = document.createElement("summary");
  sum.style.cssText = "cursor:pointer;padding:6px 10px;font-size:12.5px;font-weight:600;background:#f1f5f9;border-radius:8px;user-select:none";
  box.appendChild(sum);

  const mkSection = (title, color, preStyle) => {
    const wrap = document.createElement("details");
    wrap.style.cssText = "margin:8px 10px 0";
    const s = document.createElement("summary");
    s.style.cssText = `cursor:pointer;font-size:11.5px;color:${color};user-select:none`;
    s.textContent = title;
    const pre = document.createElement("pre");
    pre.className = "patch";
    pre.style.cssText = preStyle;
    wrap.append(s, pre);
    return { wrap, sum: s, pre };
  };
  const r = mkSection("🧠 思考过程 (reasoning)", "#7c3aed",
    "max-height:200px;min-height:40px;overflow:auto;white-space:pre-wrap;margin:4px 0");
  const c = mkSection("📄 模型输出 (content)", "#2563eb",
    "max-height:260px;min-height:40px;overflow:auto;white-space:pre-wrap;margin:4px 0");
  const t = mkSection("🔧 工具调用 (tools)", "#059669",
    "max-height:260px;min-height:40px;overflow:auto;white-space:pre-wrap;margin:4px 0;font-size:12px");
  box.append(r.wrap, c.wrap, t.wrap);
  $("#live-turns").appendChild(box);
  const blk = {
    root: box, sum,
    rWrap: r.wrap, rSum: r.sum, rPre: r.pre,
    cWrap: c.wrap, cSum: c.sum, cPre: c.pre,
    tWrap: t.wrap, tSum: t.sum, tPre: t.pre,
    rLen: 0, cLen: 0, tLen: 0, label,
    rAutoOpened: false, rAutoClosed: false, cAutoOpened: false,
    rUserOpen: null, tUserOpen: null, // 用户手动展开/收起过则为 true/false,未手动操作过为 null
  };
  box.addEventListener("toggle", () => { if (box.open) refreshTurnSummary(blk, turnIdx); });
  // 区分「自动逻辑」与「用户点击」造成的展开/收起：
  // 自动逻辑在改 open 前置 AutoPending, toggle 事件异步触发后清除;
  // 否则该次切换来自用户点击,记录其当前意图,新一轮自动收起时予以尊重。
  const trackSection = (wrap, key) => {
    wrap.addEventListener("toggle", () => {
      if (blk[key + "AutoPending"]) { blk[key + "AutoPending"] = false; return; }
      blk[key + "UserOpen"] = wrap.open;
    });
  };
  trackSection(r.wrap, "r");
  trackSection(t.wrap, "t");
  return blk;
}

/* 思考过程输出完毕后自动收起(仅在自动展开过且尚未收起时执行一次) */
function autoCollapseReasoning(blk) {
  if (blk.rAutoOpened && !blk.rAutoClosed) {
    blk.rAutoPending = true;
    blk.rWrap.open = false;
    blk.rAutoClosed = true;
  }
}

/* 工具节标题：收起时仍显示本轮调用过的工具名 */
function refreshToolSummary(blk) {
  const names = [...blk.tPre.textContent.matchAll(/⚙ ([A-Za-z_0-9]+)\(/g)].map((m) => m[1]);
  blk.tSum.textContent = "🔧 工具调用 (tools)" + (names.length ? ` · ${names.join(", ")}` : "");
}

function refreshTurnSummary(blk, turnIdx) {
  blk.sum.innerHTML =
    `第 ${turnIdx + 1} 轮${blk.label ? ` · ${esc(blk.label)}` : ""}` +
    ` <span style="color:#7c3aed;font-weight:400">🧠 ${blk.rLen.toLocaleString()} 字符</span>` +
    ` <span style="color:#2563eb;font-weight:400">📄 ${blk.cLen.toLocaleString()} 字符</span>` +
    ` <span style="color:#059669;font-weight:400">🔧 ${blk.tLen.toLocaleString()} 字符</span>`;
}

async function updateLivePanel(immediate = false) {
  if (!liveSel || !selectedRunId) return;
  if (liveSel.fetching) return; // 上一次请求未返回，跳过本轮，避免乱序
  const sel = liveSel; // 固定本次请求所属的面板会话；期间切换标签/关闭面板则丢弃过期响应
  const { iid, role, runIndex, turn, rOffset, cOffset, tOffset } = liveSel;
  const meta = liveEntries.find((e) =>
    e.instance_id === iid && e.provider_role === role && e.run_index === runIndex);
  if (!meta) {
    $("#live-meta").innerHTML = "实时缓冲已失效(实例尚未开始或缓冲被清理)。";
    return;
  }
  const finished = meta.status === "done" && (() => {
    let r = 0, c = 0, t = 0;
    for (const b of (liveSel.blocks?.values() || [])) { r += b.rLen; c += b.cLen; t += b.tLen; }
    return r >= (meta.reasoning_chars || 0) && c >= (meta.content_chars || 0)
      && t >= (meta.tool_chars || 0);
  })();
  if (finished && liveSel.finalized && !immediate) return;
  liveSel.fetching = true;
  let d;
  try {
    d = await api(`/api/runs/${selectedRunId}/live-detail`
      + `?instance_id=${encodeURIComponent(iid)}&role=${encodeURIComponent(role)}`
      + `&run_index=${runIndex}&turn=${turn}&r_offset=${rOffset}&c_offset=${cOffset}&t_offset=${tOffset}`);
  } catch (err) {
    if (liveSel === sel) {
      liveSel.fetching = false;
      $("#live-meta").innerHTML = esc(err.message);
    }
    return;
  }
  if (liveSel !== sel) return; // 面板已关闭或切换到其他标签/实例，丢弃过期响应
  liveSel.fetching = false;

  // 依次应用各轮增量：已有轮追加文本，新轮建块
  for (const part of d.parts || []) {
    let blk = liveSel.blocks.get(part.turn);
    if (!blk) {
      // 新一轮开始：上一轮仅收起思考与工具两节(用户手动展开的除外)，模型输出跨轮保持展开
      for (const b of liveSel.blocks.values()) {
        if (!b.rUserOpen) { b.rAutoPending = true; b.rWrap.open = false; }
        if (!b.tUserOpen) { b.tAutoPending = true; b.tWrap.open = false; }
      }
      blk = makeTurnBlock(part.turn, part.label || "");
      liveSel.blocks.set(part.turn, blk);
      blk.root.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    if (part.reasoning) {
      if (!blk.rAutoOpened) { blk.rAutoPending = true; blk.rWrap.open = true; blk.rAutoOpened = true; }
      stickScroll(blk.rPre, () => { blk.rPre.textContent += part.reasoning; });
    }
    if (part.content) {
      if (!blk.cAutoOpened) { blk.cWrap.open = true; blk.cAutoOpened = true; }
      // 思考过程输出完毕(正文开始流式)：自动收起思考，正文保持常开
      autoCollapseReasoning(blk);
      stickScroll(blk.cPre, () => { blk.cPre.textContent += part.content; });
    }
    if (part.tool) {
      // 新调用开始(⏳)自动展开；结果输出完(✓/✗)自动收起，摘要行保留工具名
      if (part.tool.includes("⏳")) { blk.tAutoPending = true; blk.tWrap.open = true; }
      autoCollapseReasoning(blk);
      stickScroll(blk.tPre, () => { blk.tPre.textContent += part.tool; });
      refreshToolSummary(blk);
      if (/^\s*[✓✗]/m.test(part.tool)) { blk.tAutoPending = true; blk.tWrap.open = false; }
    }
    blk.rLen = blk.rPre.textContent.length;
    blk.cLen = blk.cPre.textContent.length;
    blk.tLen = blk.tPre.textContent.length;
    refreshTurnSummary(blk, part.turn);
  }
  liveSel.turn = Math.max(d.turn ?? 0, (d.turns_total || 1) - 1);
  liveSel.rOffset = d.r_offset;
  liveSel.cOffset = d.c_offset;
  liveSel.tOffset = d.t_offset;
  liveSel.finalized = finished;
  const liveInput = d.prompt_tokens || 0;
  const liveOutput = d.completion_tokens || 0;
  const liveCache = d.cached_tokens || 0;
  const liveCacheRate = liveInput > 0 ? Math.min(100, (liveCache / liveInput) * 100).toFixed(1) : "0.0";
  const liveRate = d.decode_tps != null ? d.decode_tps.toFixed(1) : "—";
  const liveCost = `$${Number(d.cost_usd || 0).toFixed(6)}`;

  $("#live-meta").innerHTML =
    `<b>${esc(d.model)}</b> · Provider · ${esc(d.phase)} · run ${runIndex}` +
    ` · 已进行 <b>${d.turns_total || 0}</b> 轮` +
    (d.status === "streaming"
      ? ' · <span style="color:#2563eb">● 流式输出中…</span>'
      : ` · 已结束 finish=${esc(d.finish_reason || "—")}`)
    + ` · ⚡ 该条 <b>${liveRate}</b> tok/s · 💾 缓存 <b>${liveCacheRate}%</b>`
    + ` · 🔢 输入 <b>${liveInput.toLocaleString()}</b> · 输出 <b>${liveOutput.toLocaleString()}</b>`
    + ` · 💰 <b>${liveCost}</b>`
    + ` · 更新于 ${esc((d.updated_at || "").replace("T", " ").slice(11, 23))} UTC`;
}

$("#btn-cancel").addEventListener("click", async () => {
  if (!selectedRunId) return;
  try { await api(`/api/runs/${selectedRunId}/cancel`, "POST"); toast("正在取消…"); }
  catch (err) { toast(err.message); }
});
$("#btn-view-report").addEventListener("click", () => gotoTab("report", selectedRunId));

/* ---------------- SVG 图表工具 ---------------- */
function svgGroupedBar(labels, series, opts = {}) {
  const W = 460, H = 240, padL = 40, padB = 40, padT = 24;
  const maxV = Math.max(1, ...series.flatMap((s) => s.values));
  const gw = (W - padL - 20) / labels.length;
  const barW = Math.min(26, (gw - 12) / series.length);
  const y = (v) => padT + (H - padT - padB) * (1 - v / maxV);
  let bars = "", grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = (maxV / 4) * g;
    grid += `<line x1="${padL}" y1="${y(v)}" x2="${W - 10}" y2="${y(v)}" stroke="#eef1f5"/>
      <text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#94a3b8">${Number.isInteger(v) ? v : v.toFixed(1)}</text>`;
  }
  labels.forEach((lab, i) => {
    const cx = padL + gw * i + gw / 2;
    series.forEach((s, si) => {
      const v = s.values[i] || 0;
      const bx = cx - (series.length * barW + 6) / 2 + si * (barW + 3);
      bars += `<rect x="${bx}" y="${y(v)}" width="${barW}" height="${H - padB - y(v)}" rx="3" fill="${s.color}">
        <title>${esc(s.name)} · ${lab}: ${v}</title></rect>`;
      if (v > 0) bars += `<text x="${bx + barW / 2}" y="${y(v) - 4}" text-anchor="middle" font-size="10" font-weight="700" fill="#334155">${v}</text>`;
    });
    bars += `<text x="${cx}" y="${H - padB + 16}" text-anchor="middle" font-size="11" fill="#64748b">${esc(lab)}</text>`;
  });
  const legend = series.map((s) =>
    `<span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%">${grid}${bars}</svg>
    <div class="legend">${legend}${opts.extra || ""}</div>`;
}

function svgMatrix(m) {
  const cells = [
    { label: "双端通过", v: m.both_pass, sub: "Both PASS", color: "#d1fae5", tc: "#065f46" },
    { label: "仅 A 通过", v: m.a_only, sub: "Run A 领先", color: "#fee2e2", tc: "#991b1b" },
    { label: "仅 B 通过", v: m.b_only, sub: "Run B 领先", color: "#fef3c7", tc: "#92400e" },
    { label: "双端失败", v: m.both_fail, sub: "Both FAIL", color: "#f1f5f9", tc: "#64748b" },
  ];
  return `<div class="matrix-grid">${cells.map((c) => `
    <div class="matrix-cell" style="background:${c.color}">
      <div class="mc-v" style="color:${c.tc}">${c.v}</div>
      <div class="mc-l" style="color:${c.tc}">${esc(c.label)}</div>
      <div class="mc-s" style="color:${c.tc};opacity:.7">${esc(c.sub)}</div>
    </div>`).join("")}
    ${m.errors ? `<div class="matrix-err">另有 ${m.errors} 题存在执行错误(不计入矩阵)</div>` : ""}
  </div>`;
}

function svgHBars(items, unit = "", fmt = (v) => v) {
  const maxV = Math.max(1e-9, ...items.map((i) => i.value));
  return `<div class="hbars">${items.map((it) => `
    <div class="hbar-row">
      <span class="hbar-label">${esc(it.label)}</span>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(it.value / maxV) * 100}%;background:${it.color}"></div></div>
      <span class="hbar-val">${esc(fmt(it.value))}${esc(unit)}</span>
    </div>`).join("")}</div>`;
}

function svgDonut(counts) {
  const entries = Object.entries(counts).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const colors = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4", "#84cc16", "#f97316"];
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0, segs = "";
  entries.forEach(([k, v], i) => {
    const frac = v / total;
    segs += `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${colors[i % colors.length]}"
      stroke-width="22" stroke-dasharray="${frac * C} ${C}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 70 70)"><title>${esc(k)}: ${v}</title></circle>`;
    offset += frac * C;
  });
  const legend = entries.map(([k, v], i) =>
    `<span><span class="sw" style="background:${colors[i % colors.length]}"></span>${esc(k)} (${v})</span>`).join("");
  return `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
    <svg viewBox="0 0 140 140" width="128">${segs}
      <text x="70" y="66" text-anchor="middle" font-size="24" font-weight="800" fill="#334155">${total}</text>
      <text x="70" y="84" text-anchor="middle" font-size="10" fill="#94a3b8">实例</text></svg>
    <div class="legend" style="flex-direction:column;align-items:flex-start;gap:4px">${legend}</div>
  </div>`;
}

/* ---------------- 结果报告(单次运行) ---------------- */
let lastRenderedReport = null;
let userPickedReport = null;

async function loadReportOptions() {
  const runs = await api("/api/runs");
  const done = runs.filter((r) => r.report_ready);
  $("#report-select").innerHTML = done.length
    ? done.map((r) => `<option value="${r.run_id}">${r.run_id} · ${r.suite_level} · ${esc(r.provider_name || "—")} / ${esc(r.model || "—")}</option>`).join("")
    : `<option value="">(暂无已完成运行)</option>`;
  if (done.length) {
    const target = (userPickedReport && done.some((r) => r.run_id === userPickedReport))
      ? userPickedReport : done[0].run_id;
    $("#report-select").value = target;
    if (target !== lastRenderedReport) renderReport(target);
  }
}

$("#report-select").addEventListener("change", (e) => {
  userPickedReport = e.target.value;
  renderReport(e.target.value);
});

async function renderReport(runId) {
  if (!runId) return;
  lastRenderedReport = runId;
  $("#report-body").innerHTML = `<div class="empty">加载报告中…</div>`;
  let rep;
  try { rep = await api(`/api/runs/${runId}/report`); }
  catch (err) { $("#report-body").innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  try { renderReportDom(rep); }
  catch (err) {
    $("#report-body").innerHTML =
      `<div class="empty">报告渲染出错:${esc(err.message)}<br><pre style="text-align:left">${esc(err.stack || "")}</pre></div>`;
  }
}

function renderReportDom(rep) {
  const p = rep.providers?.provider || {};
  const s = rep.summary || {};
  const cs = rep.cost_speed?.provider || {};

  const head = `
  <div class="card">
    <div class="rep-head">
      <div>
        <h2 style="font-size:18px">评测报告 · <span class="mono">${esc(rep.run_id)}</span></h2>
        <div style="color:var(--muted);font-size:12.5px;margin-top:6px">
          套件 <b>${esc(rep.suite.suite_version)}</b>(${esc(rep.suite.level)},${s.n_instances} 题)
          · 模式 <b>${esc(rep.mode)}</b><br>
          <span class="badge a">${esc(p.name || "Provider")} / ${esc(p.model || "—")} @ ${esc(p.base_url || "—")}</span>
        </div>
      </div>
    </div>
    <div class="stat-cards">
      <div class="stat-card"><div class="k">Resolved</div><div class="v" style="color:var(--c-a)">${s.resolved} <small style="font-size:12px">/ ${s.n_instances}</small></div><div class="s">${pct(s.resolved, s.n_instances)}</div></div>
      <div class="stat-card"><div class="k">Cost / Solved</div><div class="v">${cs.cost_per_solved != null ? "$" + cs.cost_per_solved : "—"}</div><div class="s">总 $${cs.total_cost_usd ?? 0}</div></div>
      <div class="stat-card"><div class="k">输出截断</div><div class="v" style="${cs.truncated_runs ? "color:var(--red)" : ""}">${cs.truncated_runs || 0}</div><div class="s">finish=length 次数</div></div>
      <div class="stat-card"><div class="k">API 错误</div><div class="v">${cs.errors || 0}</div><div class="s">非模型失败次数</div></div>
    </div>
  </div>`;

  const bandLabels = rep.per_band.map((b) => ({ easy: "Easy", medium: "Medium", hard: "Hard" }[b.difficulty] || b.difficulty));
  const resolvedChart = svgGroupedBar(
    [...bandLabels, "全部"],
    [{ name: "Resolved", color: "var(--c-a)", values: [...rep.per_band.map((b) => b.resolved), s.resolved] }]);

  const speedItems = [
    { label: "平均 TTFT", value: cs.avg_ttft_s || 0, color: "var(--c-a)" },
    { label: "平均 Wall (s)", value: cs.avg_wall_s || 0, color: "#93c5fd" },
    { label: "平均 decode", value: cs.avg_decode_tps || 0, color: "#fcd34d" },
  ];
  const tokenItems = [
    { label: "输入 tokens", value: cs.total_prompt_tokens, color: "var(--c-a)" },
    { label: "输出 tokens", value: cs.total_completion_tokens, color: "#93c5fd" },
    { label: "缓存 tokens", value: cs.total_cached_tokens, color: "#fcd34d" },
  ];
  const fmtTok = (v) => v.toLocaleString();

  const charts = `
  <div class="chart-row">
    <div class="card"><div class="chart-title">分难度 Resolved</div>${resolvedChart}</div>
    <div class="card"><div class="chart-title">速度指标</div>${svgHBars(speedItems, " s")}</div>
  </div>
  <div class="chart-row">
    <div class="card"><div class="chart-title">Token 用量</div>${svgHBars(tokenItems, "", fmtTok)}</div>
    <div class="card"><div class="chart-title">成本与吞吐</div>${svgHBars([
      { label: "总成本", value: cs.total_cost_usd || 0, color: "#ef4444" },
      { label: "Cost / Solved", value: cs.cost_per_solved || 0, color: "#f59e0b" },
      { label: "平均 decode", value: cs.avg_decode_tps || 0, color: "#10b981" },
    ], "", (v) => typeof v === "number" ? v.toFixed(4) : v)}</div>
  </div>`;

  const taskRows = rep.per_task.map((t, idx) => {
    const mark = (v) => v === null || v === undefined
      ? `<span class="badge err">ERR</span>` : v
        ? `<span class="badge pass">PASS</span>` : `<span class="badge fail">FAIL</span>`;
    return `
    <tr class="task-row clickable" data-idx="${idx}">
      <td><span class="collapsed-arrow">▸</span> <span class="mono">${esc(t.instance_id)}</span></td>
      <td><span class="badge neutral">${esc(t.difficulty)}</span></td>
      <td>${esc(t.repo)}</td>
      <td>${esc(t.language_family)}</td>
      <td>${esc(t.task_type)}</td>
      <td>${mark(t.resolved)}</td>
      <td class="mono">${t.runs || "—"}</td>
      <td class="mono">${t.wall_s ?? "—"}s</td>
      <td class="mono">${t.turns ?? "—"}</td>
      <td class="mono">${t.cost != null ? "$" + t.cost : "—"}</td>
    </tr>
    <tr class="detail-row" id="detail-${idx}" style="display:none">
      <td colspan="10"><div class="task-detail" data-loaded="0" data-iid="${esc(t.instance_id)}">点击展开加载明细…</div></td>
    </tr>`;
  }).join("");

  $("#report-body").innerHTML = head + charts + `
  <div class="card">
    <div class="card-head"><h3>每任务明细(点击行展开轨迹)</h3></div>
    <div class="table-scroll">
    <table class="table">
      <thead><tr>
        <th>Task</th><th>难度</th><th>仓库</th><th>语言</th><th>类型</th>
        <th>Result</th><th>Runs</th><th>Wall</th><th>Turns</th><th>Cost</th>
      </tr></thead>
      <tbody>${taskRows}</tbody>
    </table></div>
  </div>
  <div class="warn-box"><b>⚠️ 风险与限制</b><ul>${rep.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`;

  $$(".task-row").forEach((tr) => tr.addEventListener("click", () => toggleTaskDetail(tr, rep)));
}

function runTag(c) {
  const map = { P: ["res-P", "P"], F: ["res-F", "F"], E: ["res-E", "E"] };
  const [cls, ch] = map[c] || ["res-R", "?"];
  return `<span class="res-tag ${cls}" title="${{ P: "PASS", F: "FAIL", E: "ERROR" }[ch] || ""}">${ch}</span>`;
}

function pct(a, b) { return b ? `${(a / b * 100).toFixed(1)}%` : "-"; }

async function toggleTaskDetail(tr, rep) {
  const idx = tr.dataset.idx;
  const row = $(`#detail-${idx}`);
  const open = row.style.display !== "none";
  row.style.display = open ? "none" : "";
  tr.classList.toggle("expanded", !open);
  if (open) return;
  const box = row.querySelector(".task-detail");
  if (box.dataset.loaded === "1") return;
  const iid = box.dataset.iid;
  const safe = iid.replace(/\//g, "_").replace(/:/g, "_");
  const trajs = (rep.artifacts || []).filter((n) => n.startsWith(safe + "__"));
  const t = rep.per_task[idx];
  let html = `<div style="font-size:12.5px;line-height:1.9">
    <b>难度分数</b> D_struct=${t.d_struct} · <b>成本</b> $${t.cost ?? "—"}
    · <b>用时</b> ${t.wall_s ?? "—"}s · <b>轮次</b> ${t.turns ?? "—"}</div>`;
  if (!trajs.length) {
    html += `<div class="empty" style="padding:12px 0">该任务无失败轨迹(通过任务按存储策略不保存)</div>`;
  } else {
    html += `<div style="margin-top:8px"><b style="font-size:12.5px">失败轨迹(${trajs.length})</b>
      ${trajs.map((n) => `<div style="margin-top:8px">
        <button class="btn sm traj-btn" data-name="${esc(n)}">📄 ${esc(n)}</button>
        <div class="traj-view" data-name="${esc(n)}" style="display:none;margin-top:6px"></div>
      </div>`).join("")}</div>`;
  }
  box.innerHTML = html;
  box.dataset.loaded = "1";
  box.querySelectorAll(".traj-btn").forEach((btn) => btn.addEventListener("click", async () => {
    const view = box.querySelector(`.traj-view[data-name="${CSS.escape(btn.dataset.name)}"]`);
    if (view.style.display !== "none") { view.style.display = "none"; return; }
    view.style.display = "";
    if (view.dataset.loaded) return;
    try {
      const traj = await api(`/api/runs/${rep.run_id}/artifact`, "POST", { name: btn.dataset.name });
      const rec = traj.record || {};
      const truncated = rec.truncated || rec.finish_reason === "length";
      const response = traj.response || "";
      const reasoning = traj.reasoning || "";
      const ag = traj.agent || {};
      const transcript = ag.turns != null ? (traj.trajectory || []) : null;
      const toolLines = transcript
        ? transcript.filter((m) => m.role === "tool")
          .map((m, i) => `#${i + 1} ${(m.name || "tool")} → ${String(m.content || "").split("\n")[0].slice(0, 120)}`)
          : null;
      view.innerHTML = `
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">
          模型 <b>${esc(traj.model)}</b> · ${esc(traj.provider_role)} · run ${traj.run_index} · ${esc(traj.eval_detail || "")}<br>
          tokens in/out = ${rec.usage?.prompt_tokens ?? 0}/${rec.usage?.completion_tokens ?? 0}
          · TTFT ${rec.ttft_s ?? "—"}s · wall ${rec.wall_s ?? "—"}s · finish=${esc(rec.finish_reason || "—")}
          ${ag.turns != null ? ` · <b>scaffold=${esc(traj.scaffold || "agent")}</b>:${ag.turns} 轮 / ${ag.tool_calls ?? rec.tool_calls ?? 0} 次工具调用${ag.tool_errors ? `(含 ${ag.tool_errors} 次出错)` : ""}${ag.submitted ? " · 已主动 submit" : " · 未 submit(轮次耗尽或异常退出)"}` : ""}
          ${rec.errors?.length ? `<br><span style="color:var(--red)">errors: ${esc(rec.errors.join(" | ").slice(0, 300))}</span>` : ""}
        </div>
        ${truncated ? `<div style="font-size:12.5px;color:var(--red);margin-bottom:6px">⚠ 输出被 max_tokens 截断(finish_reason=length):模型未产出完整补丁,本题按失败判定。推理模型的思考 token 计入同一预算,请调高 Max Output Tokens 或设置 Reasoning Effort。</div>` : ""}
        ${toolLines && toolLines.length ? `<details style="margin-bottom:6px">
          <summary style="font-size:12px;cursor:pointer">工具调用记录(${toolLines.length} 次,逐轮)</summary>
          <pre class="patch" style="max-height:220px;overflow:auto">${esc(toolLines.join("\n"))}</pre>
        </details>` : ""}
        <div style="font-size:12px;margin-bottom:4px"><b>模型输出(content${ag.turns != null ? " = 工作区补丁" : ""})</b>${response ? "" : ' — <span style="color:var(--red)">为空</span>'}</div>
        <pre class="patch">${esc(response.slice(0, 3000))}</pre>
        ${reasoning ? `<details style="margin-top:6px">
          <summary style="font-size:12px;cursor:pointer">思考过程(reasoning,共 ${reasoning.length} 字符${reasoning.length > 10000 ? ",仅显示前 10000" : ""})</summary>
          <pre class="patch" style="max-height:300px;overflow:auto">${esc(reasoning.slice(0, 10000))}</pre>
        </details>` : ""}`;
      view.dataset.loaded = "1";
    } catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  }));
}

/* ---------------- 运行后对比 ---------------- */
let compareRunsCache = [];
let compareRendered = null;

async function loadCompareOptions() {
  try {
    const runs = await api("/api/runs");
    compareRunsCache = runs.filter((r) => r.report_ready);
    const opts = (sel) => {
      const cur = sel.value;
      sel.innerHTML = compareRunsCache.length
        ? compareRunsCache.map((r) => `<option value="${r.run_id}">${r.run_id} · ${r.suite_level} · ${esc(r.provider_name || "—")} / ${esc(r.model || "—")}</option>`).join("")
        : `<option value="">(暂无已完成运行)</option>`;
      if (compareRunsCache.some((r) => r.run_id === cur)) sel.value = cur;
      else if (compareRunsCache.length) sel.value = compareRunsCache[0].run_id;
    };
    opts($("#compare-a"));
    opts($("#compare-b"));
    if (compareRunsCache.length > 1 && $("#compare-b").value === $("#compare-a").value) {
      $("#compare-b").value = compareRunsCache[1].run_id;
    }
    if (compareRendered) renderCompare();
  } catch (_) { /* ignore */ }
}

$("#btn-compare").addEventListener("click", renderCompare);

async function renderCompare() {
  const runA = $("#compare-a").value;
  const runB = $("#compare-b").value;
  if (!runA || !runB) {
    toast("请选择两次已完成运行");
    return;
  }
  if (runA === runB) {
    toast("请选择两个不同的运行");
    return;
  }
  $("#compare-body").innerHTML = `<div class="empty">对比中…</div>`;
  try {
    const c = await api("/api/compare", "POST", { run_a: runA, run_b: runB });
    compareRendered = c;
    renderCompareDom(c);
  } catch (err) {
    $("#compare-body").innerHTML = `<div class="warn-box">${esc(err.message)}</div>`;
  }
}

function providerLabel(r) {
  const p = r.providers?.provider || {};
  return `${p.name || "Provider"} / ${p.model || "—"}`;
}

function renderCompareDom(c) {
  const sA = c.run_a.summary || {};
  const sB = c.run_b.summary || {};
  const csA = c.run_a.cost_speed?.provider || {};
  const csB = c.run_b.cost_speed?.provider || {};
  const pa = providerLabel(c.run_a);
  const pb = providerLabel(c.run_b);
  const m = c.matrix;
  const n = sA.n_instances || sB.n_instances || 1;

  const head = `
  <div class="card">
    <div class="rep-head">
      <div>
        <h2 style="font-size:18px">运行后对比</h2>
        <div style="color:var(--muted);font-size:12.5px;margin-top:6px">
          套件 <b>${esc(c.suite.suite_version)}</b>(${esc(c.suite.level)},${n} 题)
          · 两次运行相互独立,不涉及双端复测
        </div>
      </div>
    </div>
    <div class="stat-cards">
      <div class="stat-card"><div class="k">Resolved · A</div><div class="v" style="color:var(--c-a)">${sA.resolved ?? 0} <small style="font-size:12px">/ ${sA.n_instances ?? 0}</small></div><div class="s">${pct(sA.resolved, sA.n_instances)}</div></div>
      <div class="stat-card"><div class="k">Resolved · B</div><div class="v" style="color:var(--c-b)">${sB.resolved ?? 0} <small style="font-size:12px">/ ${sB.n_instances ?? 0}</small></div><div class="s">${pct(sB.resolved, sB.n_instances)}</div></div>
      <div class="stat-card"><div class="k">A 领先 / B 领先</div><div class="v">${m.a_only} / ${m.b_only}</div><div class="s">双过 ${m.both_pass} · 双败 ${m.both_fail} · 错误 ${m.errors}</div></div>
      <div class="stat-card"><div class="k">Cost / Solved · A</div><div class="v">${csA.cost_per_solved != null ? "$" + csA.cost_per_solved : "—"}</div><div class="s">总 $${csA.total_cost_usd ?? 0}</div></div>
      <div class="stat-card"><div class="k">Cost / Solved · B</div><div class="v">${csB.cost_per_solved != null ? "$" + csB.cost_per_solved : "—"}</div><div class="s">总 $${csB.total_cost_usd ?? 0}</div></div>
    </div>
  </div>`;

  const bandLabels = c.per_band.map((b) => ({ easy: "Easy", medium: "Medium", hard: "Hard" }[b.difficulty] || b.difficulty));
  const bandChart = svgGroupedBar(
    [...bandLabels, "全部"],
    [
      { name: "A", color: "var(--c-a)", values: [...c.per_band.map((b) => b.a_resolved), sA.resolved] },
      { name: "B", color: "var(--c-b)", values: [...c.per_band.map((b) => b.b_resolved), sB.resolved] },
    ]);

  const charts = `
  <div class="chart-row">
    <div class="card"><div class="chart-title">分难度 Resolved 对比</div>${bandChart}</div>
    <div class="card"><div class="chart-title">成对结果矩阵(独立运行后统计)</div>${svgMatrix(m)}</div>
  </div>`;

  const taskRows = c.per_task.map((t) => {
    const mark = (v) => v === "pass" ? `<span class="badge pass">PASS</span>` : v === "fail" ? `<span class="badge fail">FAIL</span>` : v === "error" ? `<span class="badge err">ERR</span>` : `<span class="badge neutral">—</span>`;
    return `<tr>
      <td><span class="mono">${esc(t.instance_id)}</span></td>
      <td><span class="badge neutral">${esc(t.difficulty)}</span></td>
      <td>${esc(t.repo)}</td>
      <td>${esc(t.language_family)}</td>
      <td>${esc(t.task_type)}</td>
      <td>${mark(t.status_a)}</td>
      <td>${mark(t.status_b)}</td>
      <td class="mono">${t.cost_a != null ? "$" + t.cost_a : "—"}</td>
      <td class="mono">${t.cost_b != null ? "$" + t.cost_b : "—"}</td>
      <td class="mono">${t.wall_a ?? "—"}s</td>
      <td class="mono">${t.wall_b ?? "—"}s</td>
      <td class="mono">${t.turns_a ?? "—"}</td>
      <td class="mono">${t.turns_b ?? "—"}</td>
    </tr>`;
  }).join("");

  $("#compare-body").innerHTML = head + charts + `
  <div class="card">
    <div class="card-head"><h3>每任务对比</h3></div>
    <div class="table-scroll">
    <table class="table">
      <thead><tr>
        <th>Task</th><th>难度</th><th>仓库</th><th>语言</th><th>类型</th>
        <th>A</th><th>B</th>
        <th>Cost A</th><th>Cost B</th><th>Wall A</th><th>Wall B</th><th>Turns A</th><th>Turns B</th>
      </tr></thead>
      <tbody>${taskRows}</tbody>
    </table></div>
  </div>
  <div style="font-size:12.5px;color:var(--muted);margin-top:8px">
    对比仅基于两次独立运行的报告，不包含分歧复测或自动 GREEN/YELLOW/RED 决策。
  </div>`;
}

/* ---------------- 实例与套件 ---------------- */
let poolMeta = null;

async function loadPool() {
  try {
    poolMeta = await api("/api/meta");
    const m = poolMeta;
    $("#pool-stats").innerHTML = `
      <div class="stat-tile"><div class="v">${m.instance_count}</div><div class="k">候选实例(冻结 revision:${esc(m.dataset_meta.version || "-")})</div></div>
      <div class="stat-tile"><div class="v">${Object.keys(m.by_language).length}</div><div class="k">语言 · ${Object.entries(m.by_language).map(([k, v]) => `${k}:${v}`).join(" ")}</div></div>
      <div class="stat-tile"><div class="v">${Object.keys(m.by_repo).length}</div><div class="k">仓库</div></div>
      <div class="stat-tile"><div class="v">${m.by_difficulty.easy}/${m.by_difficulty.medium}/${m.by_difficulty.hard}</div><div class="k">Easy / Medium / Hard</div></div>`;
    const fill = (id, options) => {
      const sel = $(id);
      const cur = sel.value;
      sel.innerHTML = `<option value="">${sel.options[0]?.text || "全部"}</option>` +
        options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
      sel.value = cur;
    };
    fill("#f-lang", Object.keys(m.by_language).map((k) => [k, k]));
    fill("#f-type", Object.keys(m.by_task_type).map((k) => [k, k]));
    fill("#f-band", ["easy", "medium", "hard"].map((k) => [k, k]));
    renderPoolTable();
  } catch (err) {
    poolMeta = null;
    $("#pool-stats").innerHTML = `<div class="warn-box">无法加载官方数据集实例池：${esc(err.message || err)}</div>`;
    $("#pool-table tbody").innerHTML = `<tr><td colspan="12" class="empty">预置套件实例数据加载失败</td></tr>`;
  }
  loadSuites();
}

async function renderPoolTable() {
  const params = new URLSearchParams();
  if ($("#f-lang").value) params.set("language", $("#f-lang").value);
  if ($("#f-type").value) params.set("task_type", $("#f-type").value);
  if ($("#f-band").value) params.set("difficulty_band", $("#f-band").value);
  if ($("#f-q").value) params.set("q", $("#f-q").value);
  const rows = await api(`/api/instances?${params}`);
  $("#pool-table tbody").innerHTML = rows.map((r) => `<tr>
    <td class="mono">${esc(r.instance_id)}</td>
    <td>${esc(r.repo)}</td>
    <td><span class="lang-chip lang-${esc(r.language_family)}">${esc(r.language_family)}</span></td>
    <td>${esc(r.task_type)}</td>
    <td><span class="badge ${r.difficulty === "easy" ? "pass" : r.difficulty === "hard" ? "fail" : "YELLOW"}">${esc(r.difficulty)}</span></td>
    <td class="mono">${r.d_struct.toFixed(3)}</td>
    <td class="mono">${r.d_emp != null ? r.d_emp.toFixed(3) : "—"}</td>
    <td class="mono">${r.p_hist != null ? r.p_hist.toFixed(2) : "—"}</td>
    <td class="mono">${r.files_changed}</td>
    <td class="mono">${r.loc_changed}</td>
    <td class="mono">${r.fail_to_pass_count}</td>
    <td>${esc(r.runtime_class)}</td>
  </tr>`).join("") || `<tr><td colspan="12" class="empty">无匹配实例</td></tr>`;
}
["#f-lang", "#f-type", "#f-band"].forEach((id) =>
  $(id).addEventListener("change", renderPoolTable));
let qTimer;
$("#f-q").addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(renderPoolTable, 300);
});

async function loadSuites() {
  const suites = await api("/api/suites");
  suitesCache = suites;
  $("#suites-table tbody").innerHTML = suites.map((s) => `<tr>
    <td class="mono">${esc(s.suite_id)}</td>
    <td>${esc(s.level)}</td><td>${s.instance_count}</td>
    <td style="font-size:12px;color:var(--muted)">${esc((s.created_at || "").replace("T", " ").slice(0, 19))}</td>
    <td style="white-space:nowrap">
      <button class="btn sm" data-suite="${esc(s.suite_id)}">查看</button>
      <button class="btn sm primary" data-run-suite="${esc(s.suite_id)}">运行</button>
    </td>
  </tr>`).join("") || `<tr><td colspan="5" class="empty">暂无套件</td></tr>`;
  $$("#suites-table [data-suite]").forEach((b) =>
    b.addEventListener("click", () => showSuite(b.dataset.suite)));
  $$("#suites-table [data-run-suite]").forEach((b) =>
    b.addEventListener("click", () => quickRunSuite(b.dataset.runSuite)));
}

async function showSuite(suiteId) {
  const m = await api(`/api/suites/${suiteId}`);
  const count = (key) => m.instances.reduce((acc, i) =>
    (acc[i[key]] = (acc[i[key]] || 0) + 1, acc), {});
  $("#suite-detail").innerHTML = `
    <div class="chart-title">${esc(m.suite_version)} · ${m.instances.length} 题</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><div class="chart-title" style="font-size:12px">难度构成</div>${svgDonut(count("difficulty"))}</div>
      <div><div class="chart-title" style="font-size:12px">语言构成</div>${svgDonut(count("language_family"))}</div>
      <div><div class="chart-title" style="font-size:12px">任务类型</div>${svgDonut(count("task_type"))}</div>
      <div><div class="chart-title" style="font-size:12px">仓库分布</div>${svgDonut(count("repo"))}</div>
    </div>
    ${m.relaxations?.length ? `<div class="warn-box" style="margin-top:10px"><b>抽样放宽记录:</b><ul>${m.relaxations.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
    <details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px;color:var(--muted)">实例清单</summary>
      <div class="table-scroll"><table class="table"><thead><tr><th>ID</th><th>难度</th><th>D_struct</th><th>InfoScore 要素(p_hist)</th></tr></thead>
      <tbody>${m.instances.map((i) => `<tr><td class="mono">${esc(i.instance_id)}</td><td>${esc(i.difficulty)}</td><td class="mono">${i.d_struct?.toFixed(3)}</td><td class="mono">${i.p_hist ?? "—"}</td></tr>`).join("")}</tbody></table></div>
    </details>`;
}

async function quickRunSuite(suiteId) {
  const suite = suitesCache.find((s) => s.suite_id === suiteId);
  const pa = readProvider("provider");
  if (!pa.base_url || !pa.model) {
    selectSuiteInForm(suiteId);
    toast("请先填写 Provider 配置后再运行", 4200);
    return;
  }

  const label = suite ? `${suite.suite_id}(${suite.level}, ${suite.instance_count}题)` : suiteId;
  if (!confirm(`使用当前 Provider 配置运行套件 ${label}？`)) return;

  const body = buildRunBody();
  body.suite_id = suiteId;
  body.dataset_source = "official";
  body.docker_enabled = true;
  body.evaluator = "official";

  const btn = $("#btn-start");
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  try {
    await startRun(body);
  } catch (err) {
    toast(`启动失败:${err.message}`, 4200);
  } finally {
    btn.disabled = prevDisabled;
  }
}

function selectSuiteInForm(suiteId) {
  SELECTED_SUITE_ID = suiteId;
  gotoTab("run");
  const s = suitesCache.find((x) => x.suite_id === suiteId);
  if (s) {
    SEGMENTS["suite-level"] = s.level;
    $$("#suite-level button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.v === s.level);
    });
  }
  toast(`已选择套件 ${suiteId}，请确认 Provider 配置后点击启动`, 3600);
}

/* ---------------- 初始化 ---------------- */
refreshRuns();
loadReportOptions();
loadCompareOptions();
loadPool();
refreshProfiles();
