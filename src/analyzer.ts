import { RunRequest } from './schemas';

type Rec = Record<string, any>;

const BAND_ORDER: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
function round6(x: number): number {
  return Math.round(x * 1000000) / 1000000;
}

function costSpeed(records: Rec[], role: string): Rec {
  const rs = records.filter((r) => r.provider_role === role && r.status === 'ok');
  const solvedRuns = rs.filter((r) => r.resolved);
  const n = rs.length || 1;
  const walls = rs.filter((r) => r.wall_s).map((r) => r.wall_s);
  const ttfts = rs.filter((r) => r.ttft_s != null).map((r) => r.ttft_s);
  const tps = rs.filter((r) => r.decode_tps != null).map((r) => r.decode_tps);
  const ptok = rs.reduce((s, r) => s + (r.usage?.prompt_tokens ?? 0), 0);
  const ctok = rs.reduce((s, r) => s + (r.usage?.completion_tokens ?? 0), 0);
  const ktok = rs.reduce((s, r) => s + (r.usage?.cached_tokens ?? 0), 0);
  const cost = rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  return {
    runs: rs.length,
    errors: records.filter((r) => r.provider_role === role && r.status !== 'ok').length,
    resolved_runs: solvedRuns.length,
    avg_wall_s: walls.length ? round3(walls.reduce((a, b) => a + b, 0) / walls.length) : null,
    avg_ttft_s: ttfts.length ? round3(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
    avg_decode_tps: tps.length ? round1(tps.reduce((a, b) => a + b, 0) / tps.length) : null,
    total_prompt_tokens: ptok,
    total_completion_tokens: ctok,
    total_cached_tokens: ktok,
    total_cost_usd: round4(cost),
    cost_per_solved: solvedRuns.length ? round4(cost / solvedRuns.length) : null,
    truncated_runs: rs.filter((r) => r.finish_reason === 'length').length,
    avg_tool_errors: round3(rs.reduce((s, r) => s + (r.tool_errors ?? 0), 0) / n),
  };
}

function firstRecord(records: Rec[], iid: string): Rec | null {
  return (
    records.find((r) => r.instance_id === iid && (r.phase === 'main' || r.phase === 'S1')) ||
    records.find((r) => r.instance_id === iid) ||
    null
  );
}

export function buildReport(
  runId: string,
  records: Rec[],
  suite: Rec,
  request: RunRequest,
): Rec {
  const role = records[0]?.provider_role || 'provider';
  const instMeta = new Map<string, Rec>(suite.instances.map((i: Rec) => [i.instance_id, i]));
  const ids: string[] = suite.instances
    .map((i: Rec) => i.instance_id as string)
    .sort((a: string, b: string) => {
      const da = BAND_ORDER[instMeta.get(a)?.difficulty ?? 'medium'] ?? 3;
      const db = BAND_ORDER[instMeta.get(b)?.difficulty ?? 'medium'] ?? 3;
      return da - db;
    });

  const perBand: Record<string, Rec> = {};
  const perTask: Rec[] = [];

  for (const iid of ids) {
    const meta = instMeta.get(iid)!;
    const band = String(meta.difficulty ?? 'medium');
    const rec = firstRecord(records, iid);
    const resolved = rec && rec.status === 'ok' ? Boolean(rec.resolved) : null;
    const cell = (perBand[band] ||= {
      difficulty: band,
      total: 0,
      resolved: 0,
    });
    cell.total += 1;
    if (resolved) cell.resolved += 1;

    perTask.push({
      instance_id: iid,
      repo: meta.repo,
      language_family: meta.language_family,
      task_type: meta.task_type,
      difficulty: band,
      d_struct: meta.d_struct,
      resolved,
      status: rec ? (rec.status === 'ok' ? (rec.resolved ? 'pass' : 'fail') : 'error') : 'pending',
      cost: rec ? round6(rec.cost_usd ?? 0) : null,
      wall_s: rec ? (rec.wall_s ?? null) : null,
      turns: rec ? (rec.turns_used ?? null) : null,
      runs: rec ? (rec.resolved != null ? (rec.resolved ? 'P' : 'F') : 'E') : '',
      truncated: rec ? Boolean(rec.truncated) : false,
      finish_reason: rec ? (rec.finish_reason ?? null) : null,
      tool_errors: rec ? (rec.tool_errors ?? 0) : 0,
    });
  }

  const resolvedCount = perTask.filter((t) => t.resolved).length;
  const warnings: string[] = [
    'Resolved 由官方 Docker 测试环境判定(fail-to-pass / pass-to-pass 真实退出码)。',
    '当前 scaffold 为多轮 Agent;与官方 SWE-Agent 50-turn scaffold 仍为本地最小实现,绝对分数可能不可比。',
  ];

  return {
    run_id: runId,
    mode: 'single',
    suite: {
      suite_id: suite.suite_id,
      suite_version: suite.suite_version,
      level: suite.level,
    },
    providers: {
      provider: {
        name: request.provider?.name,
        base_url: request.provider?.base_url,
        model: request.provider?.model,
      },
    },
    summary: {
      n_instances: ids.length,
      resolved: resolvedCount,
    },
    per_band: ['easy', 'medium', 'hard']
      .filter((b) => perBand[b])
      .map((b) => perBand[b]),
    per_task: perTask,
    cost_speed: {
      provider: costSpeed(records, role),
    },
    warnings,
  };
}

function mark(v: boolean | null | undefined): string {
  if (v == null) return 'ERR';
  return v ? 'PASS' : 'FAIL';
}

export function renderMarkdown(report: Rec): string {
  const s = report.summary;
  const p = report.providers.provider;
  const cs = report.cost_speed.provider;
  const lines = [
    `# 评测报告 — ${report.run_id}`,
    '',
    `- 套件:\`${report.suite.suite_version}\`(${report.suite.level},${s.n_instances} 题)`,
    `- 模式:${report.mode}`,
    `- Provider:${p?.name ?? '-'} / \`${p?.model ?? '-'}\``,
    '',
    '## 汇总',
    '',
    `- Resolved **${s.resolved}** / ${s.n_instances}`,
    '',
    '## 分难度统计',
    '',
    '| 难度 | 题数 | Resolved |',
    '|---|---:|---:|',
    ...report.per_band.map((b: Rec) => `| ${b.difficulty} | ${b.total} | ${b.resolved} |`),
    '',
    '## 每任务明细',
    '',
    '| Task | Stratum | Result | Cost | Wall | Turns |',
    '|---|---|---|---:|---:|---:|',
    ...report.per_task.map((t: Rec) =>
      `| \`${t.instance_id}\` | ${t.difficulty} | ${mark(t.resolved)} | ${t.cost ?? '-'} | ${t.wall_s ?? '-'} | ${t.turns ?? '-'} |`,
    ),
    '',
    '## 成本与速度',
    '',
    `- tokens(in/out/cache)= ${cs.total_prompt_tokens.toLocaleString()}/` +
      `${cs.total_completion_tokens.toLocaleString()}/${cs.total_cached_tokens.toLocaleString()};` +
      `成本 $${cs.total_cost_usd};每解一题 $${cs.cost_per_solved};` +
      `平均 TTFT ${cs.avg_ttft_s}s;平均 decode ${cs.avg_decode_tps} tok/s;` +
      `截断 ${cs.truncated_runs} 次;API 错误 ${cs.errors} 次`,
    '',
    '## 风险与限制',
    '',
    ...report.warnings.map((w: string) => `- ${w}`),
  ];
  return lines.join('\n') + '\n';
}

// ---------- 运行后对比(两次独立单端运行) ----------

export interface ComparisonResult {
  run_a: Rec;
  run_b: Rec;
  suite: Rec;
  matrix: Rec;
  per_band: Rec[];
  per_task: Rec[];
}

function statusOfTask(t: Rec | undefined): 'pass' | 'fail' | 'error' | 'pending' {
  if (!t) return 'pending';
  if (t.resolved == null) return t.status === 'error' ? 'error' : 'pending';
  return t.resolved ? 'pass' : 'fail';
}

export function buildComparison(reportA: Rec, reportB: Rec): ComparisonResult {
  const tasksA = new Map<string, Rec>(reportA.per_task.map((t: Rec) => [t.instance_id, t]));
  const tasksB = new Map<string, Rec>(reportB.per_task.map((t: Rec) => [t.instance_id, t]));
  const ids = [
    ...new Set<string>([
      ...reportA.per_task.map((t: Rec) => t.instance_id),
      ...reportB.per_task.map((t: Rec) => t.instance_id),
    ]),
  ];

  const matrix: Rec = { both_pass: 0, both_fail: 0, a_only: 0, b_only: 0, errors: 0 };
  const perBand: Record<string, Rec> = {};
  const perTask: Rec[] = [];

  for (const iid of ids) {
    const ta = tasksA.get(iid);
    const tb = tasksB.get(iid);
    const band = String(ta?.difficulty ?? tb?.difficulty ?? 'medium');
    const sa = statusOfTask(ta);
    const sb = statusOfTask(tb);
    const cell = (perBand[band] ||= {
      difficulty: band,
      total: 0,
      a_resolved: 0,
      b_resolved: 0,
      disagree: 0,
    });
    cell.total += 1;
    if (sa === 'pass') cell.a_resolved += 1;
    if (sb === 'pass') cell.b_resolved += 1;

    if (sa === 'error' || sb === 'error') {
      matrix.errors += 1;
    } else if (sa === 'pass' && sb === 'pass') {
      matrix.both_pass += 1;
    } else if (sa === 'fail' && sb === 'fail') {
      matrix.both_fail += 1;
    } else if (sa === 'pass' && sb === 'fail') {
      matrix.a_only += 1;
      cell.disagree += 1;
    } else if (sa === 'fail' && sb === 'pass') {
      matrix.b_only += 1;
      cell.disagree += 1;
    }

    perTask.push({
      instance_id: iid,
      repo: ta?.repo ?? tb?.repo,
      language_family: ta?.language_family ?? tb?.language_family,
      task_type: ta?.task_type ?? tb?.task_type,
      difficulty: band,
      d_struct: ta?.d_struct ?? tb?.d_struct,
      status_a: sa,
      status_b: sb,
      resolved_a: ta?.resolved ?? null,
      resolved_b: tb?.resolved ?? null,
      cost_a: ta?.cost ?? null,
      cost_b: tb?.cost ?? null,
      wall_a: ta?.wall_s ?? null,
      wall_b: tb?.wall_s ?? null,
      turns_a: ta?.turns ?? null,
      turns_b: tb?.turns ?? null,
    });
  }

  return {
    run_a: reportA,
    run_b: reportB,
    suite: reportA.suite || reportB.suite,
    matrix,
    per_band: ['easy', 'medium', 'hard']
      .filter((b) => perBand[b])
      .map((b) => perBand[b]),
    per_task: perTask,
  };
}
