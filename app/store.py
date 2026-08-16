"""运行产物存储(设计文档 §14:runs/ 目录,manifest / jsonl / csv / 报告)。"""
from __future__ import annotations

import csv
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .schemas import RunRequest, SuiteManifest

RUNS_DIR = Path(__file__).parent.parent / "runs"
SUITES_DIR = RUNS_DIR / "suites"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_run_id() -> str:
    return "run-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(2).hex()


class RunStore:
    def __init__(self, root: Path = RUNS_DIR):
        self.root = root
        self.suites_dir = root / "suites"
        self.suites_dir.mkdir(parents=True, exist_ok=True)

    # ---------- 套件 ----------
    def save_suite(self, manifest: SuiteManifest) -> None:
        path = self.suites_dir / f"{manifest.suite_id}.json"
        path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")

    def load_suite(self, suite_id: str) -> Optional[SuiteManifest]:
        path = self.suites_dir / f"{suite_id}.json"
        if not path.exists():
            return None
        return SuiteManifest.model_validate_json(path.read_text(encoding="utf-8"))

    def list_suites(self) -> list[dict]:
        out = []
        for path in sorted(self.suites_dir.glob("suite-*.json"), reverse=True):
            try:
                m = SuiteManifest.model_validate_json(path.read_text(encoding="utf-8"))
                out.append({
                    "suite_id": m.suite_id, "suite_version": m.suite_version,
                    "level": m.level, "seed": m.seed, "created_at": m.created_at,
                    "instance_count": len(m.instances),
                })
            except Exception:
                continue
        return out

    # ---------- 运行 ----------
    def create_run(self, request: RunRequest, suite: SuiteManifest) -> dict:
        run_id = _new_run_id()
        run_dir = self.root / run_id
        (run_dir / "trajectories").mkdir(parents=True, exist_ok=True)

        state = {
            "run_id": run_id,
            "status": "queued",
            "phase": "-",
            "created_at": _now(),
            "ended_at": None,
            "error": None,
            "request": self._sanitize_request(request),
            "baseline_run_id": request.baseline_run_id,
            "suite": json.loads(suite.model_dump_json()),
            # 复用基线时基线端不实跑,进度只统计实跑的端
            "progress": {"done": 0,
                         "total": len(suite.instances)
                         * (2 if request.provider_b and not request.baseline_run_id else 1),
                         "current": None},
            "instance_status": {
                i["instance_id"]: {} for i in suite.instances
            },
            "counts": {"s1": 0, "s2": 0},
            "report_ready": False,
        }
        self._write_state(run_id, state)
        self._write_run_manifest(run_id, request, suite)
        (run_dir / "per_run.jsonl").write_text("", encoding="utf-8")
        return state

    @staticmethod
    def _sanitize_request(request: RunRequest) -> dict:
        data = json.loads(request.model_dump_json())
        for key in ("provider_a", "provider_b"):
            if data.get(key):
                data[key]["api_key"] = "***" if data[key].get("api_key") else ""
        return data

    def _write_run_manifest(self, run_id: str, request: RunRequest, suite: SuiteManifest):
        from .provider import normalize_base_url
        import hashlib

        def provider_block(p):
            base = normalize_base_url(p.base_url, p.auto_append_v1)
            return {
                "role": p.role, "name": p.name, "base_url": base,
                "endpoint_hash": hashlib.sha256(base.encode()).hexdigest()[:12],
                "model": p.model,
                "temperature": p.temperature, "top_p": p.top_p,
                "max_tokens": p.max_tokens, "reasoning_effort": p.reasoning_effort,
            }

        baseline_block = provider_block(request.provider_a) if request.provider_a else None
        if baseline_block and request.baseline_run_id:
            baseline_block["reused_from"] = request.baseline_run_id
        manifest = {
            "run_id": run_id,
            "created_at": _now(),
            "suite_id": suite.suite_id,
            "suite_version": suite.suite_version,
            "repeat_disagreements": request.repeat_disagreements,
            "turn_limit": request.turn_limit,
            "scaffold": "single-turn-patch-scaffold-v1",
            "baseline_run_id": request.baseline_run_id,
            "providers": {
                **({"baseline": baseline_block} if baseline_block else {}),
                **({"candidate": provider_block(request.provider_b)}
                   if request.provider_b else {}),
            },
        }
        run_dir = self.root / run_id
        (run_dir / "suite_manifest.json").write_text(
            json.dumps(json.loads(suite.model_dump_json()), ensure_ascii=False, indent=2),
            encoding="utf-8")
        (run_dir / "run_manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    def run_dir(self, run_id: str) -> Path:
        return self.root / run_id

    def _state_path(self, run_id: str) -> Path:
        return self.root / run_id / "run_state.json"

    def _write_state(self, run_id: str, state: dict) -> None:
        self._state_path(run_id).write_text(
            json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def load_state(self, run_id: str) -> Optional[dict]:
        path = self._state_path(run_id)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def update_state(self, run_id: str, **fields) -> dict:
        state = self.load_state(run_id)
        if state is None:
            raise KeyError(run_id)
        state.update(fields)
        self._write_state(run_id, state)
        return state

    def append_record(self, run_id: str, record: dict) -> None:
        with (self.root / run_id / "per_run.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    def load_records(self, run_id: str) -> list[dict]:
        path = self.root / run_id / "per_run.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in
                path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def import_baseline(self, run_id: str, baseline_run_id: str) -> list[dict]:
        """基线复用:把基线运行中 baseline 角色的记录与失败轨迹拷入当前运行。

        记录原样保留(cost / wall / 判定结果),因此报告与成本汇总无需重算。
        """
        import shutil  # noqa: PLC0415

        records = [r for r in self.load_records(baseline_run_id)
                   if r.get("provider_role") == "baseline"]
        for rec in records:
            self.append_record(run_id, rec)
        src = self.root / baseline_run_id / "trajectories"
        dst = self.root / run_id / "trajectories"
        if src.exists():
            for p in src.glob("*__baseline__*.json"):
                shutil.copy2(p, dst / p.name)
        return records

    def save_trajectory(self, run_id: str, instance_id: str, role: str,
                        run_index: int, payload: dict) -> None:
        safe = instance_id.replace("/", "_").replace(":", "_")
        path = self.root / run_id / "trajectories" / f"{safe}__{role}__r{run_index}.json"
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                        encoding="utf-8")

    def load_trajectory(self, run_id: str, name: str) -> Optional[dict]:
        path = self.root / run_id / "trajectories" / name
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def list_trajectories(self, run_id: str) -> list[str]:
        d = self.root / run_id / "trajectories"
        if not d.exists():
            return []
        return sorted(p.name for p in d.glob("*.json"))

    def write_report(self, run_id: str, report: dict, csv_text: str, md_text: str) -> None:
        run_dir = self.root / run_id
        (run_dir / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        (run_dir / "eval_results.csv").write_text(csv_text, encoding="utf-8-sig")
        (run_dir / "paired_report.md").write_text(md_text, encoding="utf-8")

    def load_report(self, run_id: str) -> Optional[dict]:
        path = self.root / run_id / "report.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def list_runs(self) -> list[dict]:
        out = []
        if not self.root.exists():
            return out
        for d in sorted(self.root.iterdir(), reverse=True):
            state = None
            if d.is_dir() and (d / "run_state.json").exists():
                try:
                    state = json.loads((d / "run_state.json").read_text(encoding="utf-8"))
                except Exception:
                    continue
            if not state:
                continue
            req = state.get("request", {})
            pa = req.get("provider_a", {})
            pb = req.get("provider_b") or {}
            out.append({
                "run_id": state["run_id"],
                "status": state["status"],
                "phase": state.get("phase", "-"),
                "created_at": state.get("created_at"),
                "suite_level": state.get("suite", {}).get("level"),
                "model_a": pa.get("model"),
                "model_b": pb.get("model"),
                "base_url_a": pa.get("base_url"),
                "base_url_b": pb.get("base_url"),
                "baseline_run_id": state.get("baseline_run_id"),
                "progress": state.get("progress", {}),
                "report_ready": state.get("report_ready", False),
            })
        return out

    def list_baselines(self) -> list[dict]:
        """可作为复用源的基线运行:已完成、单端实跑(provider_b 为空)且自身未复用。"""
        out = []
        if not self.root.exists():
            return out
        for d in sorted(self.root.iterdir(), reverse=True):
            if not (d.is_dir() and (d / "run_state.json").exists()):
                continue
            try:
                state = json.loads((d / "run_state.json").read_text(encoding="utf-8"))
            except Exception:
                continue
            req = state.get("request", {})
            if (state.get("status") != "completed" or not state.get("report_ready")
                    or req.get("provider_b") or req.get("baseline_run_id")):
                continue
            suite = state.get("suite", {})
            report = self.load_report(state["run_id"]) or {}
            out.append({
                "run_id": state["run_id"],
                "created_at": state.get("created_at"),
                "model": (req.get("provider_a") or {}).get("model"),
                "name": (req.get("provider_a") or {}).get("name"),
                "base_url": (req.get("provider_a") or {}).get("base_url"),
                "suite_id": suite.get("suite_id"),
                "suite_level": suite.get("level"),
                "suite_version": suite.get("suite_version"),
                "n_instances": len(suite.get("instances", [])),
                "resolved": (report.get("summary") or {}).get("resolved_a"),
            })
        return out

    def read_artifact(self, run_id: str, name: str) -> Optional[str]:
        allowed = {"report.json", "paired_report.md", "run_manifest.json",
                   "suite_manifest.json", "per_run.jsonl", "eval_results.csv"}
        if name not in allowed:
            return None
        path = self.root / run_id / name
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8-sig")


def records_to_csv(records: list[dict]) -> str:
    columns = ["instance_id", "provider_role", "model", "phase", "run_index",
               "status", "resolved", "f2p_passed", "f2p_total",
               "p2p_passed", "p2p_total", "prompt_tokens", "completion_tokens",
               "cached_tokens", "ttft_s", "wall_s", "decode_tps",
               "finish_reason", "cost_usd", "eval_method"]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for rec in records:
        row = dict(rec)
        usage = row.get("usage") or {}
        row["prompt_tokens"] = usage.get("prompt_tokens", 0)
        row["completion_tokens"] = usage.get("completion_tokens", 0)
        row["cached_tokens"] = usage.get("cached_tokens", 0)
        row["resolved"] = ("" if row.get("resolved") is None
                           else ("1" if row["resolved"] else "0"))
        writer.writerow(row)
    return buf.getvalue()
