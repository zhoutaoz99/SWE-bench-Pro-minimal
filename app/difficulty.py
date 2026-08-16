"""难度评分与信息增益(设计文档 §7)。

D_struct = 0.40*F + 0.35*L + 0.15*T + 0.10*S   —— 结构难度
D_emp   = 1 - p_hist                            —— 经验难度(可选)
D_total = 0.6*D_emp + 0.4*D_struct
InfoScore = 0.45*4p(1-p) + 0.25*diversity + 0.20*D_struct + 0.10*runtime_eff
"""
from __future__ import annotations

import math
from typing import Optional

from .schemas import Instance

# 规格长度归一化上限(约 8000 字符)
_SPEC_NORM_MAX = 8000.0

RUNTIME_EFFICIENCY = {"fast": 1.0, "medium": 0.6, "slow": 0.3}


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def d_struct(inst: Instance) -> float:
    """结构难度:文件数 / LOC / fail-to-pass 数 / 规格长度。"""
    f = _clamp(math.log2(1 + inst.gold_files_changed) / math.log2(11))
    l = _clamp(math.log10(1 + inst.gold_loc_changed) / math.log10(501))
    t = _clamp(math.log2(1 + len(inst.fail_to_pass)) / math.log2(33))
    spec_len = len(inst.problem_statement) + len(inst.requirements) + len(inst.interface)
    s = _clamp(spec_len / _SPEC_NORM_MAX)
    return round(0.40 * f + 0.35 * l + 0.15 * t + 0.10 * s, 4)


def d_emp(inst: Instance) -> Optional[float]:
    if inst.p_hist is None:
        return None
    return round(1.0 - inst.p_hist, 4)


def d_total(inst: Instance, struct: Optional[float] = None) -> float:
    """融合难度:有历史通过率时按 0.6/0.4 加权,否则退化为 D_struct。"""
    ds = struct if struct is not None else d_struct(inst)
    de = d_emp(inst)
    if de is None:
        return round(ds, 4)
    return round(0.6 * de + 0.4 * ds, 4)


def difficulty_band(inst: Instance, total: Optional[float] = None,
                    quantiles: Optional[dict[str, float]] = None) -> str:
    """难度分层。有 p_hist 时直接按历史通过率分带(文档 §7.2):
    easy ≥ 0.7;medium 0.3–0.7(区分区);hard < 0.3。
    否则用候选池 D_total 三分位。"""
    if inst.p_hist is not None:
        if inst.p_hist >= 0.7:
            return "easy"
        if inst.p_hist >= 0.3:
            return "medium"
        return "hard"
    value = total if total is not None else d_total(inst)
    if quantiles:
        if value <= quantiles["q33"]:
            return "easy"
        if value <= quantiles["q75"]:
            return "medium"
        return "hard"
    return "medium"


def pool_quantiles(instances: list[Instance]) -> dict[str, float]:
    values = sorted(d_total(i) for i in instances)
    if not values:
        return {"q33": 0.0, "q75": 0.0}

    def pct(p: float) -> float:
        idx = min(len(values) - 1, max(0, round(p * (len(values) - 1))))
        return values[idx]

    return {"q33": pct(1 / 3), "q75": pct(0.75)}


def info_score(inst: Instance, band_p: float,
               diversity_gain: float = 0.0) -> float:
    """区分度优先级(文档 §7.3)。4p(1-p) 在 p=0.5 时最大。"""
    p = band_p if inst.p_hist is None else inst.p_hist
    disc = 4.0 * p * (1.0 - p)
    rt = RUNTIME_EFFICIENCY.get(inst.runtime_class, 0.6)
    return round(
        0.45 * disc + 0.25 * diversity_gain + 0.20 * d_struct(inst) + 0.10 * rt,
        4,
    )


def band_pass_prob(band: str) -> float:
    """无历史数据时按难度带估计的基准通过率(用于 InfoScore 的 p)。"""
    return {"easy": 0.74, "medium": 0.50, "hard": 0.24}.get(band, 0.5)


def annotate(instances: list[Instance]) -> list[dict]:
    """为候选池每题计算标准化标签与分数(文档 §9 步骤 3-4)。"""
    quantiles = pool_quantiles(instances)
    rows: list[dict] = []
    for inst in instances:
        ds = d_struct(inst)
        dt = d_total(inst, ds)
        band = difficulty_band(inst, dt, quantiles)
        rows.append({
            "instance_id": inst.instance_id,
            "repo": inst.repo,
            "language_family": inst.language_family,
            "task_type": inst.task_type,
            "knowledge_domain": inst.knowledge_domain,
            "difficulty": band,
            "d_struct": ds,
            "d_emp": d_emp(inst),
            "d_total": dt,
            "p_hist": inst.p_hist,
            "files_changed": inst.gold_files_changed,
            "loc_changed": inst.gold_loc_changed,
            "fail_to_pass_count": len(inst.fail_to_pass),
            "runtime_class": inst.runtime_class,
            "docker_image": inst.docker_image,
        })
    return rows
