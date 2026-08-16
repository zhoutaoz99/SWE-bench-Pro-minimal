import { RunRequest } from './schemas';

type Rec = Record<string, any>;

function pairKey(instanceId: string, role: string): string {
  return `${instanceId}::${role}`;
}

function firstRun(records: Rec[]): Map<string, Rec> {
  const out = new Map<string, Rec>();
  for (const r of records) {
    if (r.phase === 'S1') {
      const k = pairKey(r.instance_id, r.provider_role);
      if (!out.has(k)) out.set(k, r);
    }
  }
  return out;
}

function majority(records: Rec[]): Map<string, boolean | null> {
  const votes = new Map<string, boolean[]>();
  for (const r of records) {
    if (r.resolved != null) {
      const k = pairKey(r.instance_id, r.provider_role);
      const arr = votes.get(k) || [];
      arr.push(Boolean(r.resolved));
      votes.set(k, arr);
    }
  }
  const out = new Map<string, boolean | null>();
  for (const [k, v] of votes) {
    out.set(k, v.length ? v.filter(Boolean).length * 2 > v.length : null);
  }
  return out;
}

export function disagreementIds(records: Rec[]): string[] {
  const first = firstRun(records);
  const ids = new Set(records.map((r) => r.instance_id));
  const out: string[] = [];
  for (const iid of [...ids].sort()) {
    const a = first.get(pairKey(iid, 'baseline'));
    const b = first.get(pairKey(iid, 'candidate'));
    if (!a || !b) continue;
    const ra = a.status !== 'ok' ? null : a.resolved;
    const rb = b.status !== 'ok' ? null : b.resolved;
    if (ra != null && rb != null && ra !== rb) out.push(iid);
    else if ((ra == null) !== (rb == null)) out.push(iid);
  }
  return out;
}

function mcnemarExact(n10: number, n01: number): number {
  const n = n10 + n01;
  if (n === 0) return 1.0;
  const k = Math.min(n10, n01);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += comb(n, i) * Math.pow(0.5, n);
  return Math.min(1.0, 2 * tail);
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = (result * (n - k + i)) / i;
  }
  return result;
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

function decision(
  stableBaselineOnly: number,
  perBandCounts: Record<string, Rec>,
  concentration: string[],
): Rec {
  const swept = Object.values(perBandCounts).some(
    (cnt) =>
      (cnt.baseline === 0 && cnt.candidate === cnt.total && cnt.total >= 3) ||
      (cnt.candidate === 0 && cnt.baseline === cnt.total && cnt.total >= 3),
  );
  let level: 'RED' | 'YELLOW' | 'GREEN';
  if (stableBaselineOnly >= 3 || swept) level = 'RED';
  else if (stableBaselineOnly === 2 || concentration.length > 0) level = 'YELLOW';
  else level = 'GREEN';

  const reasons: string[] = [];
  if (stableBaselineOnly) reasons.push(`稳定 baseline-only 失败 ${stableBaselineOnly} 个`);
  if (concentration.length) reasons.push('回退集中于:' + concentration.join(';'));
  if (swept) reasons.push('存在某一类别出现 0/3 vs 3/3 的完全扫荡');
  if (!reasons.length) reasons.push('无稳定方向性回退');
  const advice = {
    GREEN: '两端能力一致性好,可继续用 Core-12 做日常回归。',
    YELLOW: '存在边界性回退信号,建议扩展 Confirm-24 并对分歧类别做轨迹级分析。',
    RED: '出现系统性回退,不建议仅凭价格切换 Provider;先做 S5 深挖。',
  }[level];
  return { level, reasons, advice };
}

export function buildReport(
  runId: string,
  records: Rec[],
  suite: Rec,
  request: RunRequest,
): Rec {
  const abMode = request.provider_b != null;
  const instMeta = new Map<string, Rec>(suite.instances.map((i: Rec) => [i.instance_id, i]));
  const first = firstRun(records);
  const maj = majority(records);
  const bandOrder: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
  const ids: string[] = suite.instances
    .map((i: Rec) => i.instance_id as string)
    .sort((a: string, b: string) => {
      const metaA = instMeta.get(a);
      const metaB = instMeta.get(b);
      const da = bandOrder[metaA?.difficulty ?? 'medium'] ?? 3;
      const db = bandOrder[metaB?.difficulty ?? 'medium'] ?? 3;
      return da - db;
    });

  const statusOf = (iid: string, role: string, source?: Map<string, Rec> | null): boolean | null => {
    if (source) {
      const r = source.get(pairKey(iid, role));
      if (!r || r.status !== 'ok') return null;
      return r.resolved;
    }
    return maj.get(pairKey(iid, role)) ?? null;
  };

  const aStats = costSpeed(records, 'baseline');
  const bStats = abMode ? costSpeed(records, 'candidate') : null;

  const matrix: Rec = {
    both_pass: 0,
    both_fail: 0,
    baseline_only: 0,
    candidate_only: 0,
    errors: 0,
  };
  const perBand: Record<string, Rec> = {};
  const stableBaselineOnly: Rec[] = [];
  const stableCandidateOnly: Rec[] = [];
  const perTask: Rec[] = [];

  for (const iid of ids) {
    const meta = instMeta.get(iid)!;
    const band = String(meta.difficulty ?? 'medium');
    const ra = statusOf(iid, 'baseline', first);
    const rb = abMode ? statusOf(iid, 'candidate', first) : null;
    const cell = (perBand[band] ||= {
      difficulty: band,
      total: 0,
      baseline: 0,
      candidate: 0,
      disagree: 0,
    });
    cell.total += 1;
    if (ra) cell.baseline += 1;
    if (abMode && rb) cell.candidate += 1;

    const retested = records.some((r) => r.instance_id === iid && r.phase === 'S2');
    const stableFlag = Boolean(retested && ra != null && rb != null && ra !== rb);

    const row: Rec = {
      instance_id: iid,
      repo: meta.repo,
      language_family: meta.language_family,
      task_type: meta.task_type,
      difficulty: band,
      d_struct: meta.d_struct,
      baseline: ra,
      candidate: rb,
      stable: abMode ? stableFlag : null,
      cost_a: sumCost(records, iid, 'baseline'),
      wall_a: avgField(records, iid, 'baseline', 'wall_s'),
      cost_b: abMode ? sumCost(records, iid, 'candidate') : null,
      wall_b: abMode ? avgField(records, iid, 'candidate', 'wall_s') : null,
      runs_a: runSummary(records, iid, 'baseline'),
      runs_b: abMode ? runSummary(records, iid, 'candidate') : null,
      turns_a: avgField(records, iid, 'baseline', 'turns_used'),
      turns_b: abMode ? avgField(records, iid, 'candidate', 'turns_used') : null,
    };

    if (abMode) {
      if (ra == null || rb == null) {
        matrix.errors += 1;
      } else if (ra && rb) {
        matrix.both_pass += 1;
      } else if (!ra && !rb) {
        matrix.both_fail += 1;
      } else if (ra && !rb) {
        matrix.baseline_only += 1;
        cell.disagree += 1;
      } else {
        matrix.candidate_only += 1;
        cell.disagree += 1;
      }
      if (stableFlag) {
        if (ra) stableBaselineOnly.push(row);
        else stableCandidateOnly.push(row);
      }
    }
    perTask.push(row);
  }

  const warnings: string[] = [];
  warnings.push('Resolved 判定为补丁结构启发式;正式结论需接入官方 Docker evaluator(scaleapi/SWE-bench_Pro-os)。');
  warnings.push('当前 scaffold 为单轮补丁生成;与官方 SWE-Agent 50-turn scaffold 的绝对分数不可比。');
  if (request.baseline_run_id) {
    warnings.push(
      `基线结果复用自 ${request.baseline_run_id}(未重新执行):` +
        'S2 分歧复测仅对候选端补跑,基线端保持该运行时的结果;' +
        '基线 Provider 或参数变更后需重新跑一次基线运行。',
    );
  }

  const stats: Rec = { n: ids.length };
  let decisionObj: Rec = {
    level: 'N/A',
    reasons: ['单端评测,无 A/B 对比'],
    advice: '',
  };
  if (abMode) {
    const n10 = matrix.baseline_only;
    const n01 = matrix.candidate_only;
    const n = ids.length || 1;
    stats.n10_baseline_only = n10;
    stats.n01_candidate_only = n01;
    stats.paired_delta = round4((n01 - n10) / n);
    stats.disagreement_rate = round4((n10 + n01) / n);
    stats.mcnemar_p = round4(mcnemarExact(n10, n01));
    const conc = concentration(stableBaselineOnly);
    decisionObj = decision(stableBaselineOnly.length, perBand, conc);
  }

  return {
    run_id: runId,
    mode: abMode ? 'A/B' : 'single',
    baseline_reused_from: request.baseline_run_id,
    suite: {
      suite_id: suite.suite_id,
      suite_version: suite.suite_version,
      level: suite.level,
    },
    providers: {
      baseline: {
        name: request.provider_a?.name,
        base_url: request.provider_a?.base_url,
        model: request.provider_a?.model,
      },
      ...(abMode
        ? {
            candidate: {
              name: request.provider_b?.name,
              base_url: request.provider_b?.base_url,
              model: request.provider_b?.model,
            },
          }
        : {}),
    },
    summary: {
      n_instances: ids.length,
      resolved_a: ids.filter((iid) => statusOf(iid, 'baseline')).length,
      resolved_b: abMode ? ids.filter((iid) => statusOf(iid, 'candidate')).length : null,
    },
    matrix,
    stats,
    per_band: ['easy', 'medium', 'hard']
      .filter((b) => perBand[b])
      .map((b) => perBand[b]),
    stable_baseline_only: stableBaselineOnly.map((r) => r.instance_id),
    stable_candidate_only: stableCandidateOnly.map((r) => r.instance_id),
    decision: decisionObj,
    cost_speed: {
      baseline: aStats,
      ...(bStats ? { candidate: bStats } : {}),
    },
    per_task: perTask,
    warnings,
  };
}

function sumCost(records: Rec[], iid: string, role: string): number {
  return round6(
    records
      .filter((r) => r.instance_id === iid && r.provider_role === role)
      .reduce((s, r) => s + (r.cost_usd ?? 0), 0),
  );
}

function avgField(records: Rec[], iid: string, role: string, field: string): number | null {
  const vals = records
    .filter(
      (r) =>
        r.instance_id === iid &&
        r.provider_role === role &&
        r[field] != null,
    )
    .map((r) => r[field]);
  return vals.length ? round3(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

function runSummary(records: Rec[], iid: string, role: string): string {
  const rs = records
    .filter((r) => r.instance_id === iid && r.provider_role === role)
    .sort((a, b) => a.run_index - b.run_index);
  return rs
    .map((r) => (r.resolved ? 'P' : r.status !== 'ok' ? 'E' : 'F'))
    .join('');
}

function concentration(stableRows: Rec[]): string[] {
  const out: string[] = [];
  for (const dim of ['task_type', 'language_family', 'repo']) {
    const counts = new Map<string, number>();
    for (const row of stableRows) {
      const key = String(row[dim] ?? '');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [k, v] of counts) {
      if (v >= 2) out.push(`${dim}=${k}×${v}`);
    }
  }
  return out;
}

function mark(v: boolean | null | undefined): string {
  if (v == null) return 'ERR';
  return v ? 'PASS' : 'FAIL';
}

export function renderMarkdown(report: Rec): string {
  const s = report.summary;
  const p = report.providers;
  const lines = [
    `# Paired Report — ${report.run_id}`,
    '',
    `- 套件:\`${report.suite.suite_version}\`(${report.suite.level},${s.n_instances} 题)`,
    `- 模式:${report.mode}`,
    `- Baseline:${p.baseline.name} / \`${p.baseline.model}\`` +
      (report.baseline_reused_from
        ? `(结果复用自 \`${report.baseline_reused_from}\`,未重新执行)`
        : ''),
  ];
  if (report.mode === 'A/B') {
    lines.push(`- Candidate:${p.candidate.name} / \`${p.candidate.model}\``);
  }
  lines.push(
    '',
    '## 汇总',
    '',
    `- Resolved:Baseline **${s.resolved_a}**` +
      (s.resolved_b != null ? ` / Candidate **${s.resolved_b}**` : '') +
      ` 共 ${s.n_instances} 题`,
  );
  if (report.mode === 'A/B') {
    const m = report.matrix;
    const st = report.stats;
    lines.push(
      `- 成对矩阵:双过 ${m.both_pass} | 双败 ${m.both_fail} | ` +
        `仅 Baseline 过 ${m.baseline_only} | 仅 Candidate 过 ${m.candidate_only}` +
        ` | 错误 ${m.errors}`,
      `- paired_delta = ${st.paired_delta},disagreement_rate = ${st.disagreement_rate}` +
        `,McNemar p = ${st.mcnemar_p}(小样本仅供参考)`,
      `- 决策:**${report.decision.level}** — ${report.decision.reasons.join(';')}`,
    );
  }
  lines.push('', '## 分难度统计', '', '| 难度 | 题数 | Baseline | Candidate | 分歧 |', '|---|---:|---:|---:|---:|');
  for (const row of report.per_band) {
    const cand = report.mode === 'A/B' ? String(row.candidate) : '-';
    lines.push(`| ${row.difficulty} | ${row.total} | ${row.baseline} | ${cand} | ${row.disagree} |`);
  }
  lines.push('', '## 每任务明细', '', '| Task | Stratum | Baseline | Candidate | Stable? | Cost A | Cost B | Wall A | Wall B |', '|---|---|---|---|---|---:|---:|---:|---:|');
  for (const t of report.per_task) {
    lines.push(
      `| \`${t.instance_id}\` | ${t.difficulty} | ${mark(t.baseline)} | ` +
        `${t.candidate == null ? '-' : mark(t.candidate)} | ` +
        `${t.stable ? '✓' : '-'} | ${t.cost_a} | ` +
        `${t.cost_b == null ? '-' : t.cost_b} | ${t.wall_a} | ${t.wall_b == null ? '-' : t.wall_b} |`,
    );
  }
  const cs = report.cost_speed;
  lines.push('', '## 成本与速度', '');
  for (const [role, label] of [
    ['baseline', 'Baseline'],
    ['candidate', 'Candidate'],
  ] as const) {
    if (!cs[role]) continue;
    const c = cs[role];
    lines.push(
      `- **${label}**:tokens(in/out/cache)= ${c.total_prompt_tokens.toLocaleString()}/` +
        `${c.total_completion_tokens.toLocaleString()}/${c.total_cached_tokens.toLocaleString()};` +
        `成本 $${c.total_cost_usd};每解一题 $${c.cost_per_solved};` +
        `平均 TTFT ${c.avg_ttft_s}s;平均 decode ${c.avg_decode_tps} tok/s;` +
        `截断 ${c.truncated_runs} 次;API 错误 ${c.errors} 次`,
    );
  }
  lines.push('', '## 风险与限制', '');
  lines.push(...report.warnings.map((w: string) => `- ${w}`));
  return lines.join('\n') + '\n';
}

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
