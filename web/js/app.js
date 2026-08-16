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
  if (btn.dataset.tab === "pool") { loadPool(); }
});

function gotoTab(name, runId = null) {
  $(`#tabs .tab[data-tab="${name}"]`).click();
  if (runId && name === "monitor") selectRun(runId);
  if (runId && name === "report") { $("#report-select").value = runId; renderReport(runId); }
}

/* ---------------- 新建评测 ---------------- */
const SEGMENTS = { "suite-level": "smoke6", "scaffold-mode": "agent" };
Object.keys(SEGMENTS).forEach((id) => {
  $(`#${id}`).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    $$(`#${id} button`).forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    SEGMENTS[id] = btn.dataset.v;
  });
});

$("#enable-b").addEventListener("change", (e) => {
  $("#form-b").classList.toggle("disabled", !e.target.checked);
});

/* ----- 基线来源:本次填写 / 复用已完成基线 ----- */
let BASELINE_MODE = "new";
let baselinesCache = [];

$("#baseline-source").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  $$("#baseline-source button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  BASELINE_MODE = btn.dataset.v;
  applyBaselineMode();
});

function applyBaselineMode() {
  const reuse = BASELINE_MODE === "reuse";
  $("#reuse-row").style.display = reuse ? "" : "none";
  $("#form-a").classList.toggle("disabled", reuse);
  // 复用基线时套件与评测模式由基线运行决定,锁定套件层级 / seed / scaffold / 轮次
  $("#setting-suite").classList.toggle("disabled", reuse);
  $("#suite-seed").disabled = reuse;
  $("#setting-scaffold").classList.toggle("disabled", reuse);
  $$("#scaffold-mode button").forEach((b) => { b.disabled = reuse; });
  $("#turn-limit").disabled = reuse;
  // 复用基线必须有候选端,锁定为启用
  $("#enable-b").checked = true;
  $("#enable-b").disabled = reuse;
  $("#enable-b-wrap").style.opacity = reuse ? ".45" : "";
  $("#enable-b-wrap").style.pointerEvents = reuse ? "none" : "";
  $("#form-b").classList.remove("disabled");
  if (reuse) loadBaselines();
}

function syncScaffoldFromBaseline(b) {
  // scaffold 必须与基线一致(后端强校验);轮次对齐以保证公平
  const sc = b.scaffold || "single-turn";
  $$("#scaffold-mode button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.v === sc);
  });
  SEGMENTS["scaffold-mode"] = sc;
  if (b.turn_limit) $("#turn-limit").value = b.turn_limit;
}

async function loadBaselines() {
  try {
    const list = await api("/api/baselines");
    baselinesCache = list;
    const sel = $("#reuse-baseline");
    if (!list.length) {
      sel.innerHTML = `<option value="">(暂无可复用的基线运行 — 先单独跑一次基线端)</option>`;
      $("#reuse-hint").textContent = "没有已完成的单端基线运行。先在“新建评测”中取消勾选 A/B 对比、仅跑基线端,完成后即可在此复用。";
      return;
    }
    sel.innerHTML = list.map((b) =>
      `<option value="${b.run_id}">${b.run_id} · ${esc(b.model || "-")} · ${esc(b.suite_level)} · ${b.scaffold === "agent" ? "Agent" : "单轮"} · Resolved ${b.resolved ?? "-"}/${b.n_instances}</option>`
    ).join("");
    $("#reuse-hint").textContent = "基线记录(含成本/耗时)将原样导入本次运行;S2 分歧复测仅补跑候选端。";
    sel.dispatchEvent(new Event("change"));
  } catch (err) {
    $("#reuse-hint").textContent = `基线列表加载失败:${err.message}`;
  }
}

$("#reuse-baseline").addEventListener("change", (e) => {
  const b = baselinesCache.find((x) => x.run_id === e.target.value);
  if (!b) return;
  syncScaffoldFromBaseline(b);
  $("#reuse-hint").textContent =
    `将沿用套件 ${b.suite_id}(${b.suite_version},${b.n_instances} 题,${b.scaffold || "single-turn"} 模式);` +
    "S2 分歧复测仅补跑候选端,基线保持该运行的结果。";
});

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
    name: get("name") || (role === "a" ? "Baseline" : "Candidate"),
    base_url: get("base_url"),
    model: get("model"),
    api_key: get("api_key"),
    role: role === "a" ? "baseline" : "candidate",
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
  ["a", "b"].forEach((role) => {
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

["a", "b"].forEach((role) => {
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
      const hint = /not found/i.test(err.message)
        ? "(接口不存在:后端服务是旧进程,请重启后加载新功能)" : "";
      toast(`保存失败:${err.message}${hint}`, 5200);
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
      // 思考型模型:16 token 预算内只够输出思维链,回答未产出属正常,但评测需更大预算
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

$("#btn-test-a").addEventListener("click", () => testProviderConn("a"));
$("#btn-test-b").addEventListener("click", () => testProviderConn("b"));

$("#btn-start").addEventListener("click", async () => {
  const reuse = BASELINE_MODE === "reuse";
  if (reuse && !$("#reuse-baseline").value) {
    toast("请先选择一个可复用的基线运行(或切回“本次填写”)", 4200);
    return;
  }
  const body = {
    provider_a: reuse ? null : readProvider("a"),
    provider_b: $("#enable-b").checked ? readProvider("b") : null,
    baseline_run_id: reuse ? $("#reuse-baseline").value : null,
    suite_level: SEGMENTS["suite-level"],
    suite_seed: parseInt($("#suite-seed").value) || 20260816,
    repeat_disagreements: parseInt($("#repeat-dis").value) || 0,
    scaffold: SEGMENTS["scaffold-mode"],
    turn_limit: parseInt($("#turn-limit").value) || 200,
  };
  if (!reuse && !$("#enable-b").checked && !SEGMENTS_HINTED_SINGLE) {
    SEGMENTS_HINTED_SINGLE = true;
    toast("将仅运行基线端:完成后可作为基线源,在后续候选端评测中复用", 4600);
  }
  $("#btn-start").disabled = true;
  $("#start-note").textContent = "提交中…";
  try {
    const res = await api("/api/runs", "POST", body);
    toast(reuse && res.baseline_run_id
      ? `评测已启动:${res.run_id}(基线复用 ${res.baseline_run_id})`
      : `评测已启动:${res.run_id}`);
    gotoTab("monitor", res.run_id);
  } catch (err) {
    toast(`启动失败:${err.message}`, 4200);
    $("#start-note").textContent = err.message;
  } finally {
    $("#btn-start").disabled = false;
    setTimeout(() => { $("#start-note").textContent = ""; }, 5000);
  }
});
let SEGMENTS_HINTED_SINGLE = false;

/* ---------------- 运行监控 ---------------- */
let selectedRunId = null;
let monitorTimer = null;
let liveEntries = [];          // /live 元信息(长度/状态,不含正文)
let liveSel = null;            // 当前查看的实时条目 {iid, role, runIndex, rOffset, cOffset}

const STATUS_BADGE = {
  queued: ["pending", "排队中"], running: ["running", "运行中"],
  retesting: ["running", "S2 复测"], analyzing: ["running", "分析中"],
  completed: ["done", "已完成"], failed: ["fail", "失败"],
  cancelled: ["cancel", "已取消"],
};

// 终态运行才可删除(进行中的需先取消,与后端 DELETE 校验一致)
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
      <td class="mono">${r.baseline_run_id
        ? `<span title="基线复用自 ${esc(r.baseline_run_id)}">🔗 ${esc(r.model_a || "-")}</span>`
        : esc(r.model_a || "-")}</td>
      <td class="mono">${esc(r.model_b || (r.baseline_run_id ? "—" : "-"))}</td>
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
    let runs = [];
    try { runs = await api("/api/runs"); } catch (_) { /* 提示信息降级为不带复用说明 */ }
    const reusedBy = runs.filter((o) => o.baseline_run_id === runId).map((o) => o.run_id);
    const msg = [`删除运行 ${runId}?`, "其全部产物(清单 / 记录 / 报告 / 轨迹)将被永久删除,不可恢复。"];
    if (reusedBy.length) msg.push(`注意:运行 ${reusedBy.join("、")} 复用过它作基线;旧报告自包含不受影响,但不能再以它为复用源新建评测。`);
    if (!confirm(msg.join("\n"))) return;
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
      { // 删除的运行可能正在可复用基线列表中;保留用户当前选择的基线
        const sel = $("#reuse-baseline");
        const prev = sel.value;
        await loadBaselines();
        if (prev && sel.querySelector(`option[value="${CSS.escape(prev)}"]`)) {
          sel.value = prev;
          sel.dispatchEvent(new Event("change"));
        }
      }
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

  const [cls, label] = STATUS_BADGE[st.status] || ["pending", st.status];
  const { done, total } = st.progress;
  $("#prog-bar").style.width = total ? `${(done / total) * 100}%` : "0%";
  $("#prog-text").textContent = `${done} / ${total}`;
  $("#phase-badge").textContent = `${label} · ${st.phase}`;
  $("#phase-badge").style.background =
    ["completed"].includes(st.status) ? "#d1fae5" : "#dbeafe";
  $("#btn-cancel").style.display =
    ["queued", "running", "retesting", "analyzing"].includes(st.status) ? "" : "none";
  $("#btn-view-report").style.display = st.report_ready ? "" : "none";

  const suite = st.suite || { instances: [] };
  // 与后端执行顺序一致:简单 → 中等 → 困难(同带内保持套件顺序)
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
    const streaming = liveEntries.some((e) =>
      e.instance_id === inst.instance_id && e.status === "streaming");
    const selected = liveSel && liveSel.iid === inst.instance_id;
    return `<div class="inst-cell clickable" data-iid="${esc(inst.instance_id)}"
      ${running ? 'style="border-color:var(--primary);box-shadow:0 0 0 2px rgba(37,99,235,.15)"' : ""}
      ${selected ? 'data-selected="1"' : ""}>
      <div class="iid">${streaming ? '<span style="color:#ef4444" title="流式输出中">●</span> ' : ""}${esc(inst.instance_id)}</div>
      <div class="meta">${esc(inst.repo)} · ${esc(inst.language_family)} · ${esc(inst.task_type)} · ${esc(inst.difficulty)}</div>
      <div class="res">
        <span class="res-tag res-a">A</span>${chip(stat.baseline)}${runsOf("baseline")}
        <span style="width:6px"></span>
        <span class="res-tag res-b">B</span>${chip(stat.candidate)}${runsOf("candidate")}
      </div>
    </div>`;
  }).join("");

  if (liveSel) updateLivePanel();

  if (["completed", "failed", "cancelled"].includes(st.status)) {
    clearInterval(monitorTimer);
    refreshRuns();
    if (st.status === "completed") loadReportOptions();
    if (st.status === "failed") toast(`运行失败:${(st.error || "").split("\n").slice(-2)[0]}`, 5000);
  }
}

/* ---------------- 实时输出面板 ---------------- */

function stickScroll(pre, mutate) {
  const pinned = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48;
  mutate();
  if (pinned) pre.scrollTop = pre.scrollHeight;
}

function closeLivePanel() {
  liveSel = null;
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
  $("#live-reasoning").textContent = "";
  $("#live-content").textContent = "";
  $("#live-r-len").textContent = "";
  $("#live-c-len").textContent = "";
  if (!entries.length) {
    $("#live-meta").innerHTML =
      `该实例暂无实时数据:尚未执行到该题、基线为复用导入(不实跑),或服务重启导致进程内缓冲丢失。` +
      `完成的实例可在「📊 结果报告」页查看记录与失败轨迹。`;
    $("#live-body").style.display = "none";
    return;
  }
  $("#live-body").style.display = "";
  // 多条目(A/B、S2 复测)用页签切换,默认选正在流式输出的那个
  $("#live-tabs").innerHTML = entries.map((e, i) =>
    `<button class="btn sm${i === pickLiveEntry(entries) ? " primary" : ""}"
       data-role="${esc(e.provider_role)}" data-run="${e.run_index}">
       ${e.provider_role === "baseline" ? "A" : "B"}·r${e.run_index}${e.status === "streaming" ? " ●" : ""}</button>`).join("");
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
  liveSel = { iid, role, runIndex, rOffset: 0, cOffset: 0 };
  $("#live-reasoning").textContent = "";
  $("#live-content").textContent = "";
  $("#live-r-len").textContent = "";
  $("#live-c-len").textContent = "";
  $("#live-tabs").querySelectorAll("button").forEach((btn) =>
    btn.classList.toggle("primary",
      btn.dataset.role === role && +btn.dataset.run === runIndex));
  updateLivePanel(true);
}

async function updateLivePanel(immediate = false) {
  if (!liveSel || !selectedRunId) return;
  const { iid, role, runIndex, rOffset, cOffset } = liveSel;
  const meta = liveEntries.find((e) =>
    e.instance_id === iid && e.provider_role === role && e.run_index === runIndex);
  if (!meta) {
    $("#live-meta").innerHTML = "实时缓冲已失效(实例尚未开始或缓冲被清理)。";
    return;
  }
  const finished = meta.status === "done"
    && meta.reasoning_chars <= rOffset && meta.content_chars <= cOffset;
  if (finished && !immediate) return;   // 已取完且结束,跳过本轮
  let d;
  try {
    d = await api(`/api/runs/${selectedRunId}/live-detail`
      + `?instance_id=${encodeURIComponent(iid)}&role=${encodeURIComponent(role)}`
      + `&run_index=${runIndex}&r_offset=${rOffset}&c_offset=${cOffset}`);
  } catch (err) { $("#live-meta").innerHTML = esc(err.message); return; }
  liveSel.rOffset = d.r_offset;
  liveSel.cOffset = d.c_offset;
  const rPre = $("#live-reasoning"), cPre = $("#live-content");
  if (d.reasoning_part) stickScroll(rPre, () => { rPre.textContent += d.reasoning_part; });
  if (d.content_part) stickScroll(cPre, () => { cPre.textContent += d.content_part; });
  $("#live-r-len").textContent = `${d.reasoning_chars} 字符`;
  $("#live-c-len").textContent = `${d.content_chars} 字符`;
  $("#live-meta").innerHTML =
    `<b>${esc(d.model)}</b> · ${role === "baseline" ? "A(基线)" : "B(候选)"} · ${esc(d.phase)} · run ${runIndex}` +
    (d.status === "streaming"
      ? ' · <span style="color:#2563eb">● 流式输出中…</span>'
      : ` · 已结束 finish=${esc(d.finish_reason || "—")}`)
    + ` · 更新于 ${esc((d.updated_at || "").replace("T", " ").slice(11, 23))} UTC`;
}

$("#btn-cancel").addEventListener("click", async () => {
  if (!selectedRunId) return;
  try { await api(`/api/runs/${selectedRunId}/cancel`, "POST"); toast("已取消"); }
  catch (err) { toast(err.message); }
});
$("#btn-view-report").addEventListener("click", () => gotoTab("report", selectedRunId));

/* ---------------- SVG 图表工具 ---------------- */
function svgGroupedBar(labels, series, opts = {}) {
  // series: [{name, values, color}]
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
    { label: "仅 Baseline", v: m.baseline_only, sub: "n10 · 回退信号", color: "#fee2e2", tc: "#991b1b" },
    { label: "仅 Candidate", v: m.candidate_only, sub: "n01 · 改善信号", color: "#fef3c7", tc: "#92400e" },
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

/* ---------------- 结果报告 ---------------- */
let reportCache = null;
let lastRenderedReport = null;
let userPickedReport = null;

async function loadReportOptions() {
  const runs = await api("/api/runs");
  const done = runs.filter((r) => r.report_ready);
  $("#report-select").innerHTML = done.length
    ? done.map((r) => `<option value="${r.run_id}">${r.run_id} · ${r.suite_level} · ${r.baseline_run_id ? "🔗 " : ""}${esc(r.model_a)}${r.model_b ? " vs " + esc(r.model_b) : ""}</option>`).join("")
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
  reportCache = rep;
  const ab = rep.mode === "A/B";
  const p = rep.providers;
  const s = rep.summary;
  const cs = rep.cost_speed;
  const dec = rep.decision;

  const decColor = { GREEN: "#d1fae5", YELLOW: "#fef3c7", RED: "#fee2e2" }[dec.level] || "#f1f5f9";

  const head = `
  <div class="card">
    <div class="rep-head">
      <div>
        <h2 style="font-size:18px">评测报告 · <span class="mono">${esc(rep.run_id)}</span></h2>
        <div style="color:var(--muted);font-size:12.5px;margin-top:6px">
          套件 <b>${esc(rep.suite.suite_version)}</b>(${esc(rep.suite.level)},${s.n_instances} 题)
          · 模式 <b>${esc(rep.mode)}</b><br>
          <span class="badge a">A · ${esc(p.baseline.name)} / ${esc(p.baseline.model)} @ ${esc(p.baseline.base_url)}</span>
          ${ab ? ` <span class="badge b">B · ${esc(p.candidate.name)} / ${esc(p.candidate.model)} @ ${esc(p.candidate.base_url)}</span>` : ""}
          ${rep.baseline_reused_from ? ` <span class="badge neutral" title="基线端结果复用自该运行,未重新执行">🔗 基线复用 ${esc(rep.baseline_reused_from)}</span>` : ""}
        </div>
      </div>
      ${ab ? `<div style="text-align:center">
        <div class="decision-badge" style="background:${decColor}">${dec.level}</div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:6px;max-width:260px">${esc(dec.reasons.join(";"))}</div>
      </div>` : ""}
    </div>
    <div class="stat-cards">
      <div class="stat-card"><div class="k">Resolved · Baseline</div><div class="v" style="color:var(--c-a)">${s.resolved_a} <small style="font-size:12px">/ ${s.n_instances}</small></div><div class="s">${pct(s.resolved_a, s.n_instances)}</div></div>
      ${ab ? `<div class="stat-card"><div class="k">Resolved · Candidate</div><div class="v" style="color:var(--c-b)">${s.resolved_b} <small style="font-size:12px">/ ${s.n_instances}</small></div><div class="s">${pct(s.resolved_b, s.n_instances)}</div></div>` : ""}
      ${ab ? `<div class="stat-card"><div class="k">Disagreement Rate</div><div class="v">${(rep.stats.disagreement_rate * 100).toFixed(1)}%</div><div class="s">paired_delta ${rep.stats.paired_delta} · McNemar p=${rep.stats.mcnemar_p}</div></div>` : ""}
      ${ab ? `<div class="stat-card"><div class="k">稳定 baseline-only</div><div class="v">${rep.stable_baseline_only.length}</div><div class="s">复测后仍同方向</div></div>` : ""}
      <div class="stat-card"><div class="k">Cost / Solved · A</div><div class="v">${cs.baseline.cost_per_solved != null ? "$" + cs.baseline.cost_per_solved : "—"}</div><div class="s">总 $${cs.baseline.total_cost_usd}</div></div>
      ${ab ? `<div class="stat-card"><div class="k">Cost / Solved · B</div><div class="v">${cs.candidate.cost_per_solved != null ? "$" + cs.candidate.cost_per_solved : "—"}</div><div class="s">总 $${cs.candidate.total_cost_usd}</div></div>` : ""}
      <div class="stat-card"><div class="k">输出截断 · A</div><div class="v" style="${cs.baseline.truncated_runs ? "color:var(--red)" : ""}">${cs.baseline.truncated_runs}</div><div class="s">finish=length 次数</div></div>
      ${ab ? `<div class="stat-card"><div class="k">输出截断 · B</div><div class="v" style="${cs.candidate.truncated_runs ? "color:var(--red)" : ""}">${cs.candidate.truncated_runs}</div><div class="s">finish=length 次数</div></div>` : ""}
    </div>
  </div>`;

  const bandLabels = rep.per_band.map((b) => ({ easy: "Easy", medium: "Medium", hard: "Hard" }[b.difficulty] || b.difficulty));
  const resolvedChart = svgGroupedBar(
    [...bandLabels, "全部"],
    [
      { name: "Baseline", color: "var(--c-a)", values: [...rep.per_band.map((b) => b.baseline), s.resolved_a] },
      ...(ab ? [{ name: "Candidate", color: "var(--c-b)", values: [...rep.per_band.map((b) => b.candidate), s.resolved_b] }] : []),
    ]);

  const disChart = ab ? svgGroupedBar(
    bandLabels,
    [{ name: "分歧题数", color: "#ef4444", values: rep.per_band.map((b) => b.disagree) }]) : "";

  const matrixHtml = ab ? svgMatrix(rep.matrix) : `<div class="empty">单端评测无成对矩阵</div>`;

  const speedItems = [
    { label: "A · 平均 TTFT", value: cs.baseline.avg_ttft_s || 0, color: "var(--c-a)" },
    ...(ab ? [{ label: "B · 平均 TTFT", value: cs.candidate.avg_ttft_s || 0, color: "var(--c-b)" }] : []),
    { label: "A · 平均 Wall (s)", value: cs.baseline.avg_wall_s || 0, color: "#93c5fd" },
    ...(ab ? [{ label: "B · 平均 Wall (s)", value: cs.candidate.avg_wall_s || 0, color: "#fcd34d" }] : []),
  ];
  const tokenItems = [
    { label: "A · 输入 tokens", value: cs.baseline.total_prompt_tokens, color: "var(--c-a)" },
    { label: "A · 输出 tokens", value: cs.baseline.total_completion_tokens, color: "#93c5fd" },
    ...(ab ? [
      { label: "B · 输入 tokens", value: cs.candidate.total_prompt_tokens, color: "var(--c-b)" },
      { label: "B · 输出 tokens", value: cs.candidate.total_completion_tokens, color: "#fcd34d" }] : []),
  ];
  const fmtTok = (v) => v.toLocaleString();

  const charts = `
  <div class="chart-row">
    <div class="card"><div class="chart-title">分难度 Resolved 对比</div>${resolvedChart}</div>
    <div class="card"><div class="chart-title">成对结果矩阵(majority)</div>${matrixHtml}</div>
  </div>
  ${ab ? `<div class="chart-row">
    <div class="card"><div class="chart-title">分难度分歧分布</div>${disChart}</div>
    <div class="card"><div class="chart-title">速度指标</div>${svgHBars(speedItems, " s")}</div>
  </div>` : `<div class="chart-row"><div class="card"><div class="chart-title">速度指标</div>${svgHBars(speedItems, " s")}</div><div class="card"></div></div>`}
  <div class="chart-row">
    <div class="card"><div class="chart-title">Token 用量</div>${svgHBars(tokenItems, "", fmtTok)}</div>
    <div class="card"><div class="chart-title">解码吞吐 (tok/s)</div>${svgHBars([
      { label: "A · decode", value: cs.baseline.avg_decode_tps || 0, color: "var(--c-a)" },
      ...(ab ? [{ label: "B · decode", value: cs.candidate.avg_decode_tps || 0, color: "var(--c-b)" }] : []),
    ])}</div>
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
      <td>${mark(t.baseline)}</td>
      ${ab ? `<td>${mark(t.candidate)}</td>` : ""}
      ${ab ? `<td>${t.stable ? `<span class="badge fail">稳定分歧</span>` : t.runs_a.length > 1 ? `<span class="badge neutral">复测一致</span>` : "—"}</td>` : ""}
      <td class="mono">${t.runs_a.split("").map(runTag).join("")}</td>
      ${ab ? `<td class="mono">${t.runs_b ? t.runs_b.split("").map(runTag).join("") : "—"}</td>` : ""}
      <td class="mono">${t.wall_a ?? "—"}s</td>
      ${ab ? `<td class="mono">${t.wall_b ?? "—"}s</td>` : ""}
      <td class="mono">${t.turns_a ?? "—"}</td>
      ${ab ? `<td class="mono">${t.turns_b ?? "—"}</td>` : ""}
    </tr>
    <tr class="detail-row" id="detail-${idx}" style="display:none">
      <td colspan="${ab ? 14 : 10}"><div class="task-detail" data-loaded="0" data-iid="${esc(t.instance_id)}">点击展开加载明细…</div></td>
    </tr>`;
  }).join("");

  const stableHtml = ab ? `
  <div class="card">
    <div class="chart-title">稳定分歧任务(S5 深挖建议)</div>
    ${rep.stable_baseline_only.length || rep.stable_candidate_only.length ? `
      <div style="font-size:13px">
      ${rep.stable_baseline_only.length ? `<div style="margin-bottom:6px"><b style="color:var(--red)">仅 Baseline 通过(候选端回退):</b><br>${rep.stable_baseline_only.map((i) => `<span class="mono" style="margin-right:12px">${esc(i)}</span>`).join("")}</div>` : ""}
      ${rep.stable_candidate_only.length ? `<div><b style="color:var(--green)">仅 Candidate 通过(基线端落后):</b><br>${rep.stable_candidate_only.map((i) => `<span class="mono" style="margin-right:12px">${esc(i)}</span>`).join("")}</div>` : ""}
      </div>` : `<div class="empty">无稳定方向性分歧</div>`}
    <div style="margin-top:10px;font-size:12.5px;color:var(--muted)">💡 ${esc(dec.advice)}</div>
  </div>` : "";

  $("#report-body").innerHTML = head + charts + stableHtml + `
  <div class="card">
    <div class="card-head"><h3>每任务明细(点击行展开轨迹)</h3></div>
    <div class="table-scroll">
    <table class="table">
      <thead><tr>
        <th>Task</th><th>难度</th><th>仓库</th><th>语言</th><th>类型</th>
        <th>Baseline</th>${ab ? "<th>Candidate</th><th>稳定?</th>" : ""}
        <th>Runs A</th>${ab ? "<th>Runs B</th>" : ""}
        <th>Wall A</th>${ab ? "<th>Wall B</th>" : ""}
        <th>Turns A</th>${ab ? "<th>Turns B</th>" : ""}
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
    <b>难度分数</b> D_struct=${t.d_struct} · <b>成本</b> A=$${t.cost_a}${t.cost_b != null ? ` B=$${t.cost_b}` : ""}
    · <b>用时</b> A=${t.wall_a}s${t.wall_b != null ? ` B=${t.wall_b}s` : ""}</div>`;
  if (!trajs.length) {
    html += `<div class="empty" style="padding:12px 0">该任务无失败轨迹(双端通过,按存储策略不保存)</div>`;
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

/* ---------------- 实例与套件 ---------------- */
let poolMeta = null;

async function loadPool() {
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
  $("#suites-table tbody").innerHTML = suites.map((s) => `<tr>
    <td class="mono">${esc(s.suite_id)}</td>
    <td>${esc(s.level)}</td><td>${s.instance_count}</td>
    <td style="font-size:12px;color:var(--muted)">${esc((s.created_at || "").replace("T", " ").slice(0, 19))}</td>
    <td><button class="btn sm" data-suite="${esc(s.suite_id)}">查看</button></td>
  </tr>`).join("") || `<tr><td colspan="5" class="empty">暂无套件</td></tr>`;
  $$("#suites-table [data-suite]").forEach((b) =>
    b.addEventListener("click", () => showSuite(b.dataset.suite)));
}

$("#btn-gen-suite").addEventListener("click", async () => {
  try {
    const m = await api("/api/suites", "POST", {
      level: $("#gen-level").value,
      seed: parseInt($("#gen-seed").value) || 20260816,
    });
    toast(`已生成 ${m.suite_id}(${m.instances.length} 题)`);
    loadSuites();
    showSuite(m.suite_id);
  } catch (err) { toast(err.message); }
});

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

/* ---------------- 初始化 ---------------- */
refreshRuns();
loadReportOptions();
loadPool();
refreshProfiles();
