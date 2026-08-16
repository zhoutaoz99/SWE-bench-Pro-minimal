#!/usr/bin/env python3
"""Export ScaleAI/SWE-bench_Pro from Hugging Face to the JSON format used by this framework.

Usage:
    pip install datasets duckdb
    python scripts/export_official_dataset.py \
        --revision <commit_sha> \
        --split test \
        --output runs/official_swebench_pro.json \
        [--limit 12] \
        [--dockerhub-username jefzda]

The output JSON shape is:
{
  "_meta": {"name": "ScaleAI/SWE-bench_Pro", "revision": "...", "split": "..."},
  "instances": [
    {
      "instance_id": "...",
      "repo": "...",
      "base_commit": "...",
      "problem_statement": "...",
      "requirements": "...",
      "interface": "...",
      "fail_to_pass": ["..."],
      "pass_to_pass": ["..."],
      "test_patch": "...",
      "gold_patch": "...",
      "docker_image": "jefzda/sweap-images:<dockerhub_tag>",
      "language_family": "python",
      "task_type": "bug",
      "knowledge_domain": "backend",
      "gold_files_changed": 1,
      "gold_loc_changed": 1,
      "p_hist": null,
      "runtime_class": "medium",
      "repo_directory": "/testbed"
    }
  ]
}
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys

# Default Docker Hub user/org that hosts SWE-bench Pro images.
DEFAULT_DOCKERHUB_USERNAME = "jefzda"
DATASET_ID = "ScaleAI/SWE-bench_Pro"
PARQUET_URL = (
    "https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro/resolve/"
    "refs%2Fconvert%2Fparquet/default/test/0000.parquet"
)


def split_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str):
        s = v.strip()
        if s.startswith("["):
            try:
                parsed = ast.literal_eval(s)
                if isinstance(parsed, list):
                    return [str(x) for x in parsed]
            except Exception:
                pass
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return [str(x) for x in parsed]
            except Exception:
                pass
        return [s]
    return [str(v)]


def parse_patch_stats(patch: str):
    files = set()
    loc = 0
    for line in (patch or "").splitlines():
        if line.startswith("diff --git "):
            parts = line.split(" b/")
            if len(parts) == 2:
                files.add(parts[1].strip())
        elif (line.startswith("+") or line.startswith("-")) and not line.startswith("+++") and not line.startswith("---"):
            loc += 1
    return len(files), loc


def map_language(value: str) -> str:
    return {
        "js": "javascript",
        "ts": "typescript",
        "go": "go",
        "python": "python",
    }.get(str(value or "").lower(), str(value or "python"))


def infer_task_type(specificity):
    items = split_list(specificity)
    text = " ".join(items).lower()
    if any("bug" in s for s in items):
        return "bug"
    if any("feat" in s for s in items):
        return "feature"
    if any(("refactor" in s) or ("enh" in s) or ("debt" in s) for s in items):
        return "refactor"
    if "infra" in text or "devops" in text or "infrastructure" in text:
        return "infra"
    return "feature"


def infer_knowledge_domain(categories):
    items = split_list(categories)
    if not items:
        return "backend"
    text = " ".join(items)
    if "full_stack" in text:
        return "full-stack"
    if "front_end" in text or "ui_ux" in text:
        return "frontend"
    if "desktop" in text:
        return "desktop"
    if "infrastructure" in text or "devops" in text:
        return "infra"
    if "database" in text:
        return "database"
    if "security" in text:
        return "security"
    if "api" in text:
        return "api"
    return items[0].replace("_knowledge", "").replace("_", "-")


def build_docker_image(row, username: str) -> str:
    tag = row.get("dockerhub_tag") or ""
    if tag:
        return f"{username}/sweap-images:{tag}"
    # Fallback: derive the same tag as scaleapi/SWE-bench_Pro-os helper_code/image_uri.py
    uid = row.get("instance_id", "")
    repo = row.get("repo", "")
    if not uid or not repo:
        return ""
    try:
        repo_base, repo_name = repo.lower().split("/")
    except ValueError:
        return ""
    hsh = uid.replace("instance_", "")
    if "element-hq" in repo.lower() and "element-web" in repo.lower():
        repo_name = "element"
        if hsh.endswith("-vnan"):
            hsh = hsh[:-5]
    elif hsh.endswith("-vnan"):
        hsh = hsh[:-5]
    tag = f"{repo_base}.{repo_name}-{hsh}"
    if len(tag) > 128:
        tag = tag[:128]
    return f"{username}/sweap-images:{tag}"


def load_rows(args):
    """Load dataset rows either via `datasets` or via DuckDB parquet fallback."""
    if not args.parquet:
        try:
            from datasets import load_dataset
            print(f"Loading {DATASET_ID} (revision={args.revision or 'latest'}, split={args.split}) ...")
            ds = load_dataset(DATASET_ID, split=args.split, revision=args.revision)
            return list(ds)
        except ImportError:
            print("`datasets` not installed; falling back to DuckDB parquet reader.", file=sys.stderr)

    import duckdb
    source = args.parquet or PARQUET_URL
    print(f"Loading parquet from {source} ...")
    con = duckdb.connect()
    rows = con.execute(f"SELECT * FROM '{source}'").fetchall()
    cols = [d[0] for d in con.description]
    return [dict(zip(cols, row)) for row in rows]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", default=None, help="HF dataset revision/commit SHA (recommended fixed)")
    parser.add_argument("--split", default="test", help="Dataset split (default: test)")
    parser.add_argument("--output", default="runs/official_swebench_pro.json")
    parser.add_argument("--limit", type=int, default=None, help="Only export first N instances (for smoke test)")
    parser.add_argument("--parquet", default=None, help="Local parquet file or URL (optional; skips `datasets` dependency)")
    parser.add_argument("--dockerhub-username", default=DEFAULT_DOCKERHUB_USERNAME, help="Docker Hub user/org hosting sweap-images")
    args = parser.parse_args()

    rows = load_rows(args)
    if args.limit:
        rows = rows[: args.limit]

    instances = []
    for row in rows:
        f2p = split_list(row.get("FAIL_TO_PASS") or row.get("fail_to_pass"))
        p2p = split_list(row.get("PASS_TO_PASS") or row.get("pass_to_pass"))
        patch = row.get("patch", row.get("gold_patch", ""))
        test_patch = row.get("test_patch", "")
        files_changed, loc_changed = parse_patch_stats(patch)
        instances.append(
            {
                "instance_id": row.get("instance_id", ""),
                "repo": row.get("repo", ""),
                "base_commit": row.get("base_commit", ""),
                "problem_statement": row.get("problem_statement", ""),
                "requirements": row.get("requirements", ""),
                "interface": row.get("interface", ""),
                "fail_to_pass": f2p,
                "pass_to_pass": p2p,
                "test_patch": test_patch,
                "gold_patch": patch,
                "docker_image": build_docker_image(row, args.dockerhub_username),
                "language_family": map_language(row.get("repo_language", row.get("language_family", "python"))),
                "task_type": infer_task_type(row.get("issue_specificity") or row.get("task_type")),
                "knowledge_domain": infer_knowledge_domain(row.get("issue_categories") or row.get("knowledge_domain")),
                "gold_files_changed": files_changed,
                "gold_loc_changed": loc_changed,
                "p_hist": None,
                "runtime_class": row.get("runtime_class", "medium"),
                "repo_directory": "/testbed",
                "install": "",
                "test_cmd": "",
            }
        )

    payload = {
        "_meta": {
            "name": DATASET_ID,
            "revision": args.revision or "latest",
            "split": args.split,
            "version": f"official-{args.revision or 'latest'}",
            "instance_count": len(instances),
            "dockerhub_username": args.dockerhub_username,
        },
        "instances": instances,
    }
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Exported {len(instances)} instances -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
