#!/usr/bin/env python3
"""Build src/data/fixed_suites.json from the official SWE-bench Pro dataset.

The generated suites are deterministic and keep the same three suite IDs as before:
  - suite-smoke6-fixed   (6 instances)
  - suite-core12-fixed   (12 instances)
  - suite-confirm24-fixed (24 instances, a superset of Core-12)

Usage:
    python scripts/build_fixed_suites.py \
        --dataset runs/official_swebench_pro.json \
        --output src/data/fixed_suites.json \
        --instances-output src/data/suite_instances.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

TYPE_FLOOR = {"bug": 3, "feature": 3, "refactor": 2, "infra": 2}
BAND_PASS_PROB = {"easy": 0.74, "medium": 0.5, "hard": 0.24}
RUNTIME_EFFICIENCY = {"fast": 1.0, "medium": 0.6, "slow": 0.3}
QUOTAS = {
    "smoke6": {"easy": 2, "medium": 2, "hard": 2},
    "core12": {"easy": 2, "medium": 6, "hard": 4},
    "confirm24_addon": {"easy": 2, "medium": 6, "hard": 4},
}
REPO_MAX = {"smoke6": 1, "core12": 2, "confirm24": 2}


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def d_struct(i) -> float:
    f = clamp(math.log2(1 + i["gold_files_changed"]) / math.log2(11))
    l = clamp(math.log10(1 + i["gold_loc_changed"]) / math.log10(501))
    t = clamp(math.log2(1 + len(i["fail_to_pass"])) / math.log2(33))
    spec_len = len(i["problem_statement"]) + len(i["requirements"]) + len(i["interface"])
    s = clamp(spec_len / 8000.0)
    return round(0.4 * f + 0.35 * l + 0.15 * t + 0.1 * s, 4)


def pool_quantiles(instances):
    values = sorted(d_struct(i) for i in instances)
    n = len(values)
    if n == 0:
        return {"q33": 0.0, "q75": 0.0}
    idx = lambda p: min(n - 1, max(0, round(p * (n - 1))))
    return {"q33": values[idx(1 / 3)], "q75": values[idx(0.75)]}


def difficulty_band(i, quantiles):
    v = d_struct(i)
    if v <= quantiles["q33"]:
        return "easy"
    if v <= quantiles["q75"]:
        return "medium"
    return "hard"


def annotate(instances):
    q = pool_quantiles(instances)
    return [(i, difficulty_band(i, q)) for i in instances]


def diversity_gain(inst, selected):
    dims = ["language_family", "task_type", "repo", "knowledge_domain"]
    covered = {s[dim] for s in selected for dim in dims}
    fresh = sum(1 for dim in dims if inst[dim] not in {s[dim] for s in selected})
    return fresh / len(dims)


def score(inst, band, selected, type_needs):
    p = BAND_PASS_PROB[band]
    disc = 4.0 * p * (1.0 - p)
    rt = RUNTIME_EFFICIENCY.get(inst.get("runtime_class", "medium"), 0.6)
    type_bonus = 0.15 if type_needs.get(inst["task_type"], 0) > 0 else 0.0
    return round(
        0.45 * disc + 0.25 * diversity_gain(inst, selected) + 0.2 * d_struct(inst) + 0.1 * rt + type_bonus,
        6,
    )


def select_band(candidates, band, selected, repo_count, repo_max, type_needs):
    pool = [c for c in candidates if c["__band"] == band]
    relaxations = []

    def eligible(c, relax_repo):
        return (repo_count.get(c["repo"], 0) < repo_max) or relax_repo

    for relax_repo in (False, True):
        avail = [c for c in pool if eligible(c, relax_repo)]
        if relax_repo and avail:
            relaxations.append(f"{band}: 仓库上限约束放宽(候选不足)")
        if avail:
            best = max(avail, key=lambda c: (score(c, band, selected, type_needs), c["instance_id"]))
            return best, relaxations
    return None, relaxations


def fill_quotas(candidates, quotas, selected, repo_count, repo_max, base_selected=None):
    base_selected = base_selected or []
    base_repo_count = {}
    for i in base_selected:
        base_repo_count[i["repo"]] = base_repo_count.get(i["repo"], 0) + 1
    repo_count = {**base_repo_count, **repo_count}
    relaxations = []
    taken_ids = {i["instance_id"] for i in [*base_selected, *selected]}
    remaining = dict(quotas)
    drift_order = {
        "easy": ["medium"],
        "medium": ["easy", "hard"],
        "hard": ["medium"],
    }

    while any(v > 0 for v in remaining.values()):
        bands = [b for b, v in remaining.items() if v > 0]
        band = max(bands, key=lambda b: (remaining[b], b))

        type_needs = dict(TYPE_FLOOR)
        for i in [*base_selected, *selected]:
            if type_needs.get(i["task_type"], 0) > 0:
                type_needs[i["task_type"]] -= 1

        inst, rel = select_band(
            [c for c in candidates if c["instance_id"] not in taken_ids],
            band,
            [*base_selected, *selected],
            repo_count,
            repo_max,
            type_needs,
        )
        relaxations.extend(rel)

        if inst is None:
            for alt in drift_order.get(band, []):
                if remaining.get(alt, 0) > 0:
                    continue
                inst, rel = select_band(
                    [c for c in candidates if c["instance_id"] not in taken_ids],
                    alt,
                    [*base_selected, *selected],
                    repo_count,
                    repo_max,
                    type_needs,
                )
                relaxations.extend(rel)
                if inst is not None:
                    relaxations.append(f"{band} 候选池耗尽,由相邻带 {alt} 漂移补位({inst['instance_id']})")
                    break
        if inst is None:
            relaxations.append(f"{band} 带配额缺口 {remaining[band]} 无法满足(候选池不足)")
            remaining[band] = 0
            continue

        selected.append(inst)
        taken_ids.add(inst["instance_id"])
        repo_count[inst["repo"]] = repo_count.get(inst["repo"], 0) + 1
        remaining[band] -= 1

    return relaxations


def build_suites(instances):
    annotated = annotate(instances)
    pool = []
    for i, band in annotated:
        item = dict(i)
        item["__band"] = band
        pool.append(item)

    # Smoke-6
    smoke_selected = []
    smoke_relax = fill_quotas(
        pool,
        QUOTAS["smoke6"],
        smoke_selected,
        {},
        REPO_MAX["smoke6"],
    )
    smoke_ids = [i["instance_id"] for i in smoke_selected]

    # Core-12
    core_selected = []
    core_relax = fill_quotas(
        pool,
        QUOTAS["core12"],
        core_selected,
        {},
        REPO_MAX["core12"],
    )
    core_ids = [i["instance_id"] for i in core_selected]

    # Confirm-24 = Core-12 + 12 add-on instances
    addon_selected = []
    addon_relax = fill_quotas(
        pool,
        QUOTAS["confirm24_addon"],
        addon_selected,
        {},
        REPO_MAX["confirm24"],
        base_selected=core_selected,
    )
    confirm_ids = core_ids + [i["instance_id"] for i in addon_selected]

    return {
        "_meta": {
            "name": "sbp-fixed-suites-official",
            "description": "固定套件定义：由官方 ScaleAI/SWE-bench_Pro 数据集构造，不再使用演示种子。",
            "version": "official-v1",
        },
        "suites": [
            {
                "suite_id": "suite-smoke6-fixed",
                "name": "Smoke-6 固定冒烟套件",
                "level": "smoke6",
                "description": "固定 6 题（官方数据集构造），用于快速连通性验证。",
                "instance_ids": smoke_ids,
                "relaxations": smoke_relax,
            },
            {
                "suite_id": "suite-core12-fixed",
                "name": "Core-12 固定核心套件",
                "level": "core12",
                "description": "固定 12 题（官方数据集构造），用于 Provider A/B 核心对比。",
                "instance_ids": core_ids,
                "relaxations": core_relax,
            },
            {
                "suite_id": "suite-confirm24-fixed",
                "name": "Confirm-24 固定确认套件",
                "level": "confirm24",
                "description": "固定 24 题（官方数据集构造，Core-12 超集），用于更强结论确认。",
                "instance_ids": confirm_ids,
                "relaxations": addon_relax,
            },
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="runs/official_swebench_pro.json", help="Official dataset JSON exported by export_official_dataset.py")
    parser.add_argument("--output", default="src/data/fixed_suites.json", help="Output fixed_suites.json path")
    parser.add_argument("--instances-output", default="src/data/suite_instances.json", help="Output preloaded suite instances JSON path")
    args = parser.parse_args()

    with open(args.dataset, "r", encoding="utf-8") as f:
        data = json.load(f)
    instances = data["instances"]
    payload = build_suites(instances)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    referenced_ids = {i for s in payload["suites"] for i in s["instance_ids"]}
    suite_instances = [x for x in instances if x["instance_id"] in referenced_ids]
    if len(suite_instances) != len(referenced_ids):
        print("warning: some suite instance IDs were not found in the dataset", file=sys.stderr)
    instances_payload = {
        "_meta": {
            "name": "sbp-official-suite-instances",
            "description": "预置官方 SWE-bench Pro 套件实例：仅包含 Smoke-6/Core-12/Confirm-24 固定套件引用的实例，供仓库内直接运行。",
            "version": payload["_meta"]["version"],
            "source": data.get("_meta"),
            "instance_count": len(suite_instances),
        },
        "instances": suite_instances,
    }
    inst_out = Path(args.instances_output)
    inst_out.parent.mkdir(parents=True, exist_ok=True)
    with open(inst_out, "w", encoding="utf-8") as f:
        json.dump(instances_payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    for suite in payload["suites"]:
        print(f"{suite['suite_id']}: {len(suite['instance_ids'])} instances")
        for rid in suite["instance_ids"]:
            inst = next((x for x in instances if x["instance_id"] == rid), None)
            if inst:
                print(f"  - {rid} [{inst['repo']} / {inst['language_family']} / {inst['task_type']}]")
    print(f"Wrote {args.output}")
    print(f"Wrote {args.instances_output} ({len(suite_instances)} instances)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
