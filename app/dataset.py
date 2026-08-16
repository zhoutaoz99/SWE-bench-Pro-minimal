"""数据集加载:默认使用内置种子实例池,可选从 Hugging Face 加载真实 SWE-bench Pro。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .schemas import Instance

SEED_PATH = Path(__file__).parent / "data" / "seed_instances.json"

# 种子池元数据(版本指纹,进入 suite_manifest)
SEED_META: dict = {}


def load_seed_instances() -> list[Instance]:
    """加载内置演示实例池(36 题,基于设计文档 §15 候选池扩展)。"""
    global SEED_META
    raw = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    SEED_META = raw.get("_meta", {})
    return [Instance(**item) for item in raw["instances"]]


def load_hf_dataset(revision: Optional[str] = None) -> list[Instance]:
    """从 Hugging Face ScaleAI/SWE-bench_Pro 加载真实公开集。

    需要安装 `datasets`;revision 必须为具体 commit SHA(设计文档 §5.1 版本冻结)。
    语言/任务类型等分层标签在真实数据中不存在,这里从 gold patch 文件扩展名、
    问题描述与仓库推断(设计文档 §17 的二次推断策略)。
    """
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "加载真实数据集需要安装 datasets: pip install datasets "
            "(当前环境使用内置种子池即可运行全流程)"
        ) from exc

    if not revision:
        raise ValueError("按设计文档 §5.1,长期基线必须冻结 dataset revision(commit SHA)")

    ds = load_dataset("ScaleAI/SWE-bench_Pro", split="test", revision=revision)
    instances: list[Instance] = []
    for row in ds:
        gold_patch = row.get("gold_patch") or ""
        files, loc = _parse_patch_stats(gold_patch)
        lang = _infer_language(files or row.get("repo", ""))
        instances.append(Instance(
            instance_id=row["instance_id"],
            repo=row.get("repo", ""),
            language_family=lang,
            task_type=_infer_task_type(row.get("problem_statement", "")),
            knowledge_domain=row.get("category", "unknown"),
            problem_statement=row.get("problem_statement", ""),
            requirements=row.get("requirements", "") or "",
            interface=row.get("interface", "") or "",
            fail_to_pass=_split_tests(row.get("fail_to_pass")),
            pass_to_pass=_split_tests(row.get("pass_to_pass")),
            gold_files_changed=files,
            gold_loc_changed=loc,
            base_commit=row.get("base_commit", ""),
            docker_image=row.get("dockerhub_tag", ""),
            p_hist=None,
            runtime_class="medium",
        ))
    return instances


def _split_tests(value) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(x) for x in value]
    try:
        parsed = json.loads(value)
        return [str(x) for x in parsed] if isinstance(parsed, list) else [str(parsed)]
    except (TypeError, ValueError):
        return [value]


def _parse_patch_stats(patch: str) -> tuple[int, int]:
    files, loc = set(), 0
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            parts = line.split(" b/")
            if len(parts) == 2:
                files.add(parts[1].strip())
        elif line.startswith(("+", "-")) and not line.startswith(("+++", "---")):
            loc += 1
    return len(files), loc


_EXT_LANG = {
    ".py": "python", ".go": "go", ".js": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
}


def _infer_language(files_hint: str) -> str:
    hint = files_hint.lower()
    for ext, lang in _EXT_LANG.items():
        if ext in hint:
            return lang
    if "go" in hint:
        return "go"
    return "python"


_TASK_KEYWORDS = [
    ("refactor", ("refactor", "clean up", "restructure", "extract", "migrate")),
    ("feature", ("add", "support", "introduce", "implement", "new ")),
    ("infra", ("ci", "docker", "pipeline", "deploy", "build", "infra", "audit")),
]


def _infer_task_type(statement: str) -> str:
    text = statement.lower()
    if any(k in text for k in ("bug", "crash", "fail", "wrong", "incorrect", "regression")):
        return "bug"
    for task, keywords in _TASK_KEYWORDS:
        if any(k in text for k in keywords):
            return task
    return "feature"


def load_instances(source: str = "seed", revision: Optional[str] = None) -> list[Instance]:
    if source == "hf":
        return load_hf_dataset(revision)
    return load_seed_instances()
