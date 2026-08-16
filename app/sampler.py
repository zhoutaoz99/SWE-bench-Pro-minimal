"""分层抽样器(设计文档 §6 / §8 / §9)。

按难度/任务类型/语言/仓库配额建立槽位,每轮从候选池选择
InfoScore + diversity_gain 最高且满足约束的任务;
配额无法满足时按 仓库上限 → 相邻难度带 的顺序放宽并记录。
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone

from . import dataset, difficulty
from .schemas import Instance, SuiteLevel, SuiteManifest

QUOTAS: dict[str, dict[str, int]] = {
    "smoke6": {"easy": 2, "medium": 2, "hard": 2},
    "core12": {"easy": 2, "medium": 6, "hard": 4},
    # confirm24 = core12 基础上再补 12 题(文档 §8.3:中等难度仍占一半左右)
    "confirm24_addon": {"easy": 2, "medium": 6, "hard": 4},
}

REPO_MAX = {"smoke6": 1, "core12": 2, "confirm24": 2}

# Core-12 约束:至少覆盖的仓库数 / 每类任务最低数量(文档 §8.2)
TYPE_FLOOR = {"bug": 3, "feature": 3, "refactor": 2, "infra": 2}


def _diversity_gain(inst: Instance, selected: list[Instance]) -> float:
    """奖励尚未覆盖的语言/仓库/任务类型/知识域(4 维命中率)。"""
    dims = ["language_family", "task_type", "repo", "knowledge_domain"]
    fresh = 0
    for dim in dims:
        covered = {getattr(s, dim) for s in selected}
        if getattr(inst, dim) not in covered:
            fresh += 1
    return fresh / len(dims)


def _select_band(candidates: list[Instance], band: str, selected: list[Instance],
                 repo_count: dict[str, int], repo_max: int,
                 type_needs: dict[str, int]) -> tuple[Optional[Instance], list[str]]:
    """在一个难度带内选择最优候选(InfoScore + 多样性,平分按 instance_id)。"""
    relaxations: list[str] = []
    pool = [c for c in candidates if difficulty.difficulty_band(c) == band]

    def eligible(c: Instance, relax_repo: bool) -> bool:
        if repo_count.get(c.repo, 0) >= repo_max and not relax_repo:
            return False
        return True

    def score(c: Instance) -> float:
        band_p = difficulty.band_pass_prob(band)
        # 未满足的任务类型配额给予额外加分,推动类型覆盖
        type_bonus = 0.15 if type_needs.get(c.task_type, 0) > 0 else 0.0
        return difficulty.info_score(c, band_p, _diversity_gain(c, selected)) + type_bonus

    for relax_repo in (False, True):
        avail = [c for c in pool if eligible(c, relax_repo)]
        if relax_repo and avail:
            relaxations.append(f"{band}: 仓库上限约束放宽(候选不足)")
        if avail:
            return max(avail, key=lambda c: (score(c), c.instance_id)), relaxations
    return None, relaxations


def _fill_quotas(candidates: list[Instance], quotas: dict[str, int],
                 selected: list[Instance], repo_count: dict[str, int],
                 repo_max: int, base_selected: list[Instance] | None = None,
                 base_repo_count: dict[str, int] | None = None) -> list[str]:
    """按配额贪心填充;难度带候选枯竭时向相邻带漂移。"""
    relaxations: list[str] = []
    taken_ids = {i.instance_id for i in selected}

    def pick_band(band: str) -> Optional[Instance]:
        base = base_selected or []
        base_rc = base_repo_count or {}
        type_needs = dict(TYPE_FLOOR)
        for i in selected:
            if i.task_type in type_needs and type_needs[i.task_type] > 0:
                type_needs[i.task_type] -= 1
        inst, rel = _select_band(
            [c for c in candidates if c.instance_id not in taken_ids],
            band, base + selected,
            {**base_rc, **repo_count}, repo_max, type_needs,
        )
        relaxations.extend(rel)
        return inst

    # 每轮优先补数量缺口最大的带,保证带间均衡
    remaining = dict(quotas)
    drift_order = {"easy": ["medium"], "medium": ["easy", "hard"], "hard": ["medium"]}
    while any(v > 0 for v in remaining.values()):
        band = max((b for b in remaining if remaining[b] > 0),
                   key=lambda b: (remaining[b], b))
        inst = pick_band(band)
        if inst is None:
            # 本带候选枯竭:从配额已满的相邻带漂移补位
            for alt in drift_order.get(band, []):
                if remaining.get(alt, 0) > 0:
                    continue
                inst = pick_band(alt)
                if inst is not None:
                    relaxations.append(
                        f"{band} 候选池耗尽,由相邻带 {alt} 漂移补位({inst.instance_id})")
                    break
            if inst is None:
                relaxations.append(f"{band} 带配额缺口 {remaining[band]} 无法满足(候选池不足)")
                remaining[band] = 0
                continue
        selected.append(inst)
        taken_ids.add(inst.instance_id)
        repo_count[inst.repo] = repo_count.get(inst.repo, 0) + 1
        remaining[band] -= 1
    return relaxations


def generate_suite(level: SuiteLevel, seed: int | None = None) -> SuiteManifest:
    """生成套件清单。抽样完全确定性(由配额+分数决定),seed 记录进版本指纹。"""
    instances = dataset.load_instances()
    seed = seed if seed is not None else secrets.randbelow(10_000)
    annotated = {r["instance_id"]: r for r in difficulty.annotate(instances)}

    if level == "smoke6":
        selected: list[Instance] = []
        repo_count: dict[str, int] = {}
        relax = _fill_quotas(instances, QUOTAS["smoke6"], selected, repo_count,
                             REPO_MAX["smoke6"])
        chosen = selected
    else:
        # Core-12 作为 Confirm-24 的基础(同一 level 内自洽)
        core: list[Instance] = []
        repo_count: dict[str, int] = {}
        relax = _fill_quotas(instances, QUOTAS["core12"], core, repo_count,
                             REPO_MAX["core12"])
        chosen = core
        if level == "confirm24":
            addon: list[Instance] = []
            relax += _fill_quotas(instances, QUOTAS["confirm24_addon"], addon,
                                  repo_count, REPO_MAX["confirm24"],
                                  base_selected=core, base_repo_count={
                                      r: repo_count.get(r, 0) for r in {i.repo for i in core}})
            chosen = core + addon

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    version = f"sbp-mini-{datetime.now().strftime('%Y.%m')}-{level}-s{seed}"
    manifest = SuiteManifest(
        suite_id=f"suite-{level}-s{seed}",
        suite_version=version,
        level=level,
        seed=seed,
        dataset_revision=dataset.SEED_META.get("version", "seed-demo-v1"),
        evaluator_revision="builtin-mock/heuristic-v1",
        scaffold_revision="single-turn-patch-scaffold-v1",
        created_at=now,
        quotas={"primary": QUOTAS["smoke6" if level == "smoke6" else "core12"],
                **({"addon": QUOTAS["confirm24_addon"]} if level == "confirm24" else {})},
        relaxations=relax,
        instances=[dict(annotated[i.instance_id],
                        problem_statement=i.problem_statement,
                        requirements=i.requirements,
                        interface=i.interface,
                        fail_to_pass=i.fail_to_pass,
                        pass_to_pass=i.pass_to_pass)
                   for i in chosen],
    )
    return manifest
