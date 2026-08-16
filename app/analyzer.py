"""Analyzer:指标体系与统计判定(设计文档 §11 / §12 / §14)。"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Optional

from .schemas import RunRequest


# ---------------- 基础聚合 ----------------

def _first_run(records: list[dict]) -> dict[tuple[str, str], dict]:
    out = {}
    for r in records:
        if r["phase"] == "S1":
            out[(r["instance_id"], r["provider_role"])] = r
    return out


def _majority(records: list[dict]) -> dict[tuple[str, str], Optional[bool]]:
    votes: dict[tuple[str, str], list[bool]] = defaultdict(list)
    for r in records:
        if r["resolved"] is not None:
            votes[(r["instance_id"], r["provider_role"])].append(bool(r["resolved"]))
    return {k: (sum(v) * 2 > len(v)) if v else None for k, v in votes.items()}


def disagreement_ids(records: list[dict]) -> list[str]:
    """S1 首轮结果中 A/B 状态不一致的实例(文档 §12 S2 触发条件)。"""
    first = _first_run(records)
    ids = {r["instance_id"] for r in records}
    out = []
    for iid in sorted(ids):
        a = first.get((iid, "baseline"))
        b = first.get((iid, "candidate"))
        if a is None or b is None:
            continue
        ra = None if a["status"] != "ok" else a["resolved"]
        rb = None if b["status"] != "ok" else b["resolved"]
        if ra is not None and rb is not None and ra != rb:
            out.append(iid)
        elif (ra is None) != (rb is None):
            out.append(iid)  # 一端错误同样视为分歧,需复测确认
    return out


def _mcnemar_exact(n10: int, n01: int) -> float:
    """精确二项 McNemar(双侧)。Core-12 阶段仅作参考(文档 §11.3)。"""
    n = n10 + n01
    if n == 0:
        return 1.0
    k = min(n10, n01)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) * (0.5 ** n)
    return min(1.0, 2 * tail)


def _cost_speed(records: list[dict], role: str) -> dict:
    rs = [r for r in records if r["provider_role"] == role and r["status"] == "ok"]
    solved_runs = [r for r in rs if r["resolved"]]
    n = len(rs) or 1
    walls = [r["wall_s"] for r in rs if r.get("wall_s")]
    ttfts = [r["ttft_s"] for r in rs if r.get("ttft_s") is not None]
    tps = [r["decode_tps"] for r in rs if r.get("decode_tps") is not None]
    ptok = sum(r["usage"]["prompt_tokens"] for r in rs)
    ctok = sum(r["usage"]["completion_tokens"] for r in rs)
    ktok = sum(r["usage"]["cached_tokens"] for r in rs)
    cost = sum(r.get("cost_usd", 0) for r in rs)
    return {
        "runs": len(rs),
        "errors": len([r for r in records
                       if r["provider_role"] == role and r["status"] != "ok"]),
        "resolved_runs": len(solved_runs),
        "avg_wall_s": round(sum(walls) / len(walls), 3) if walls else None,
        "avg_ttft_s": round(sum(ttfts) / len(ttfts), 3) if ttfts else None,
        "avg_decode_tps": round(sum(tps) / len(tps), 1) if tps else None,
        "total_prompt_tokens": ptok,
        "total_completion_tokens": ctok,
        "total_cached_tokens": ktok,
        "total_cost_usd": round(cost, 4),
        "cost_per_solved": round(cost / len(solved_runs), 4) if solved_runs else None,
        "truncated_runs": len([r for r in rs if r.get("finish_reason") == "length"]),
        "avg_tool_errors": round(sum(r.get("tool_errors", 0) for r in rs) / n, 3),
    }


def _decision(stable_baseline_only: int, per_band_counts: dict,
              concentration: list[str]) -> dict:
    """文档 §12 决策阈值(诊断而非学术显著性)。"""
    swept = any(
        cnt["baseline"] == 0 and cnt["candidate"] == cnt["total"] and cnt["total"] >= 3
        or cnt["candidate"] == 0 and cnt["baseline"] == cnt["total"] and cnt["total"] >= 3
        for cnt in per_band_counts.values()
    )
    if stable_baseline_only >= 3 or swept:
        level = "RED"
    elif stable_baseline_only == 2 or concentration:
        level = "YELLOW"
    else:
        level = "GREEN"

    reasons = []
    if stable_baseline_only:
        reasons.append(f"稳定 baseline-only 失败 {stable_baseline_only} 个")
    if concentration:
        reasons.append("回退集中于:" + ";".join(concentration))
    if swept:
        reasons.append("存在某一类别出现 0/3 vs 3/3 的完全扫荡")
    if not reasons:
        reasons.append("无稳定方向性回退")
    advice = {
        "GREEN": "两端能力一致性好,可继续用 Core-12 做日常回归。",
        "YELLOW": "存在边界性回退信号,建议扩展 Confirm-24 并对分歧类别做轨迹级分析。",
        "RED": "出现系统性回退,不建议仅凭价格切换 Provider;先做 S5 深挖。",
    }[level]
    return {"level": level, "reasons": reasons, "advice": advice}


def build_report(run_id: str, records: list[dict], suite: dict,
                 request: RunRequest) -> dict:
    ab_mode = request.provider_b is not None
    inst_meta = {i["instance_id"]: i for i in suite["instances"]}
    first = _first_run(records)
    maj = _majority(records)
    # 明细行与执行顺序一致:简单 → 中等 → 困难(同带内保持套件顺序)
    band_order = {"easy": 0, "medium": 1, "hard": 2}
    ids = [i["instance_id"] for i in
           sorted(suite["instances"],
                  key=lambda x: band_order.get(x.get("difficulty"), 3))]

    def status_of(iid: str, role: str, source: dict | None = None) -> Optional[bool]:
        if source is not None:
            r = source.get((iid, role))
            if r is None or r["status"] != "ok":
                return None
            return r["resolved"]
        return maj.get((iid, role))

    a_stats = _cost_speed(records, "baseline")
    b_stats = _cost_speed(records, "candidate") if ab_mode else None

    matrix = {"both_pass": 0, "both_fail": 0, "baseline_only": 0, "candidate_only": 0,
              "errors": 0}
    per_band: dict[str, dict] = {}
    stable_baseline_only: list[dict] = []
    stable_candidate_only: list[dict] = []
    per_task: list[dict] = []

    for iid in ids:
        meta = inst_meta[iid]
        band = meta.get("difficulty", "medium")
        ra, rb = status_of(iid, "baseline"), (status_of(iid, "candidate") if ab_mode else None)
        cell = per_band.setdefault(
            band, {"difficulty": band, "total": 0,
                   "baseline": 0, "candidate": 0, "disagree": 0})
        cell["total"] += 1
        if ra:
            cell["baseline"] += 1
        if ab_mode and rb:
            cell["candidate"] += 1

        retested = any(r["phase"] == "S2" for r in records if r["instance_id"] == iid)
        # 稳定分歧 = 复测后 majority 结果仍方向不一致(文档 §11.1 Stable Disagreement)
        stable_flag = bool(retested and ra is not None and rb is not None and ra != rb)

        row = {
            "instance_id": iid, "repo": meta.get("repo"),
            "language_family": meta.get("language_family"),
            "task_type": meta.get("task_type"),
            "difficulty": band, "d_struct": meta.get("d_struct"),
            "baseline": ra, "candidate": rb,
            "stable": stable_flag if ab_mode else None,
            "cost_a": _sum_cost(records, iid, "baseline"),
            "wall_a": _avg_field(records, iid, "baseline", "wall_s"),
            "cost_b": _sum_cost(records, iid, "candidate") if ab_mode else None,
            "wall_b": _avg_field(records, iid, "candidate", "wall_s") if ab_mode else None,
            "runs_a": _run_summary(records, iid, "baseline"),
            "runs_b": _run_summary(records, iid, "candidate") if ab_mode else None,
            # Agent scaffold:各端平均使用的轮数(单轮模式为 0)
            "turns_a": _avg_field(records, iid, "baseline", "turns_used"),
            "turns_b": (_avg_field(records, iid, "candidate", "turns_used")
                        if ab_mode else None),
        }
        if ab_mode:
            if ra is None or rb is None:
                matrix["errors"] += 1
            elif ra and rb:
                matrix["both_pass"] += 1
            elif not ra and not rb:
                matrix["both_fail"] += 1
            elif ra and not rb:
                matrix["baseline_only"] += 1
                cell["disagree"] += 1
            else:
                matrix["candidate_only"] += 1
                cell["disagree"] += 1

            if stable_flag:
                if ra:
                    stable_baseline_only.append(row)
                else:
                    stable_candidate_only.append(row)
        per_task.append(row)

    warnings: list[str] = []
    warnings.append("Resolved 判定为补丁结构启发式;正式结论需接入官方 Docker evaluator(scaleapi/SWE-bench_Pro-os)。")
    warnings.append("当前 scaffold 为单轮补丁生成;与官方 SWE-Agent 50-turn scaffold 的绝对分数不可比。")
    if request.baseline_run_id:
        warnings.append(
            f"基线结果复用自 {request.baseline_run_id}(未重新执行):"
            "S2 分歧复测仅对候选端补跑,基线端保持该运行时的结果;"
            "基线 Provider 或参数变更后需重新跑一次基线运行。")

    stats: dict = {"n": len(ids)}
    decision: dict = {"level": "N/A", "reasons": ["单端评测,无 A/B 对比"], "advice": ""}
    if ab_mode:
        n10, n01 = matrix["baseline_only"], matrix["candidate_only"]
        n = len(ids) or 1
        stats.update({
            "n10_baseline_only": n10,
            "n01_candidate_only": n01,
            "paired_delta": round((n01 - n10) / n, 4),
            "disagreement_rate": round((n10 + n01) / n, 4),
            "mcnemar_p": round(_mcnemar_exact(n10, n01), 4),
        })
        conc = _concentration(stable_baseline_only)
        decision = _decision(len(stable_baseline_only), per_band, conc)

    return {
        "run_id": run_id,
        "mode": "A/B" if ab_mode else "single",
        "baseline_reused_from": request.baseline_run_id,
        "suite": {"suite_id": suite.get("suite_id"),
                  "suite_version": suite.get("suite_version"),
                  "level": suite.get("level")},
        "providers": {
            "baseline": {"name": request.provider_a.name,
                         "base_url": request.provider_a.base_url,
                         "model": request.provider_a.model},
            **({"candidate": {"name": request.provider_b.name,
                              "base_url": request.provider_b.base_url,
                              "model": request.provider_b.model}}
               if ab_mode else {}),
        },
        "summary": {
            "n_instances": len(ids),
            "resolved_a": sum(1 for iid in ids if status_of(iid, "baseline")),
            "resolved_b": sum(1 for iid in ids if status_of(iid, "candidate"))
            if ab_mode else None,
        },
        "matrix": matrix,
        "stats": stats,
        "per_band": [per_band[b] for b in ("easy", "medium", "hard") if b in per_band],
        "stable_baseline_only": [r["instance_id"] for r in stable_baseline_only],
        "stable_candidate_only": [r["instance_id"] for r in stable_candidate_only],
        "decision": decision,
        "cost_speed": {"baseline": a_stats, **({"candidate": b_stats} if ab_mode else {})},
        "per_task": per_task,
        "warnings": warnings,
    }


def _sum_cost(records: list[dict], iid: str, role: str) -> float:
    return round(sum(r.get("cost_usd", 0) for r in records
                     if r["instance_id"] == iid and r["provider_role"] == role), 6)


def _avg_field(records: list[dict], iid: str, role: str, field: str) -> Optional[float]:
    vals = [r[field] for r in records
            if r["instance_id"] == iid and r["provider_role"] == role
            and r.get(field) is not None]
    return round(sum(vals) / len(vals), 3) if vals else None


def _run_summary(records: list[dict], iid: str, role: str) -> str:
    rs = sorted([r for r in records
                 if r["instance_id"] == iid and r["provider_role"] == role],
                key=lambda r: r["run_index"])
    return "".join(
        "P" if r["resolved"] else ("E" if r["status"] != "ok" else "F") for r in rs)


def _concentration(stable_rows: list[dict]) -> list[str]:
    """同类别的稳定 baseline-only 失败 ≥2 视为集中回退。"""
    out = []
    for dim in ("task_type", "language_family", "repo"):
        counts: dict[str, int] = defaultdict(int)
        for row in stable_rows:
            counts[row[dim]] += 1
        hits = [f"{dim}={k}×{v}" for k, v in counts.items() if v >= 2]
        out.extend(hits)
    return out


# ---------------- Markdown 报告(文档 §14 推荐摘要表) ----------------

def _mark(v: Optional[bool]) -> str:
    if v is None:
        return "ERR"
    return "PASS" if v else "FAIL"


def render_markdown(report: dict) -> str:
    s = report["summary"]
    p = report["providers"]
    lines = [
        f"# Paired Report — {report['run_id']}",
        "",
        f"- 套件:`{report['suite']['suite_version']}`({report['suite']['level']},{s['n_instances']} 题)",
        f"- 模式:{report['mode']}",
        f"- Baseline:{p['baseline']['name']} / `{p['baseline']['model']}`"
        + (f"(结果复用自 `{report.get('baseline_reused_from')}`,未重新执行)"
           if report.get("baseline_reused_from") else ""),
    ]
    if report["mode"] == "A/B":
        lines.append(f"- Candidate:{p['candidate']['name']} / `{p['candidate']['model']}`")
    lines += [
        "",
        "## 汇总",
        "",
        f"- Resolved:Baseline **{s['resolved_a']}**"
        + (f" / Candidate **{s['resolved_b']}**" if s['resolved_b'] is not None else "")
        + f" 共 {s['n_instances']} 题",
    ]
    if report["mode"] == "A/B":
        m, st = report["matrix"], report["stats"]
        lines += [
            f"- 成对矩阵:双过 {m['both_pass']} | 双败 {m['both_fail']} | "
            f"仅 Baseline 过 {m['baseline_only']} | 仅 Candidate 过 {m['candidate_only']}"
            f" | 错误 {m['errors']}",
            f"- paired_delta = {st['paired_delta']},disagreement_rate = {st['disagreement_rate']}"
            f",McNemar p = {st['mcnemar_p']}(小样本仅供参考)",
            f"- 决策:**{report['decision']['level']}** — {';'.join(report['decision']['reasons'])}",
        ]
    lines += ["", "## 分难度统计", "",
              "| 难度 | 题数 | Baseline | Candidate | 分歧 |", "|---|---:|---:|---:|---:|"]
    for row in report["per_band"]:
        cand = str(row["candidate"]) if report["mode"] == "A/B" else "-"
        lines.append(f"| {row['difficulty']} | {row['total']} | {row['baseline']} | "
                     f"{cand} | {row['disagree']} |")

    lines += ["", "## 每任务明细", "",
              "| Task | Stratum | Baseline | Candidate | Stable? | Cost A | Cost B | Wall A | Wall B |",
              "|---|---|---|---|---|---:|---:|---:|---:|"]
    for t in report["per_task"]:
        lines.append(
            f"| `{t['instance_id']}` | {t['difficulty']} | {_mark(t['baseline'])} | "
            f"{_mark(t['candidate']) if t['candidate'] is not None else '-'} | "
            f"{'✓' if t['stable'] else '-'} | {t['cost_a']} | "
            f"{t['cost_b'] if t['cost_b'] is not None else '-'} | "
            f"{t['wall_a']} | {t['wall_b'] if t['wall_b'] is not None else '-'} |")

    cs = report["cost_speed"]
    lines += ["", "## 成本与速度", ""]
    for role, label in (("baseline", "Baseline"), ("candidate", "Candidate")):
        if role not in cs:
            continue
        c = cs[role]
        lines.append(
            f"- **{label}**:tokens(in/out/cache)= {c['total_prompt_tokens']:,}/"
            f"{c['total_completion_tokens']:,}/{c['total_cached_tokens']:,};"
            f"成本 ${c['total_cost_usd']};每解一题 ${c['cost_per_solved']};"
            f"平均 TTFT {c['avg_ttft_s']}s;平均 decode {c['avg_decode_tps']} tok/s;"
            f"截断 {c['truncated_runs']} 次;API 错误 {c['errors']} 次")
    lines += ["", "## 风险与限制", ""]
    lines += [f"- {w}" for w in report["warnings"]]
    return "\n".join(lines) + "\n"
