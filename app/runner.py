"""A/B Runner(设计文档 §4 / §10 / §12)。

S1:每 Provider 每题 1 次(同 prompt、同参数,仅切换 endpoint/model);
S2:只对 A/B 结果不一致的分歧题,每端再跑 repeat_disagreements 次,
    形成 3-run majority(文档 §12 的"只复测 disagreement"成本控制)。
"""
from __future__ import annotations

import asyncio
import traceback
from datetime import datetime, timezone
from typing import Optional

from . import analyzer
from .evaluator import evaluate_heuristic
from .provider import LiveProvider, build_prompt
from .schemas import Instance, ProviderConfig
from .store import RunStore, records_to_csv

_INSTANCE_FIELDS = set(Instance.model_fields.keys())

# run_id → 原始 api_key(仅进程内,不落盘)
SECRET_VAULT: dict[str, dict[str, str]] = {}


def _to_instance(d: dict) -> Instance:
    return Instance(**{k: v for k, v in d.items() if k in _INSTANCE_FIELDS})


def compute_cost(pconf: ProviderConfig, prompt_tokens: int,
                 cached_tokens: int, completion_tokens: int) -> float:
    uncached = max(0, prompt_tokens - cached_tokens)
    return (uncached / 1e6 * pconf.price_input_per_m
            + cached_tokens / 1e6 * pconf.price_cached_per_m
            + completion_tokens / 1e6 * pconf.price_output_per_m)


class RunEngine:
    def __init__(self, store: RunStore):
        self.store = store

    async def execute(self, run_id: str) -> None:
        state = self.store.load_state(run_id)
        if state is None:
            return
        request_data = state["request"]
        # api_key 已脱敏存储,真实 key 通过进程内缓存回填
        req = _restore_request(request_data, SECRET_VAULT.get(run_id, {}))

        suite = state["suite"]
        instances = suite["instances"]
        # 基线与候选端可独立运行:复用基线时基线记录直接导入,本次只实跑候选端
        providers: dict[str, ProviderConfig] = {}
        if req.baseline_run_id:
            providers["candidate"] = req.provider_b
        else:
            providers["baseline"] = req.provider_a
            if req.provider_b is not None:
                providers["candidate"] = req.provider_b

        try:
            self.store.update_state(run_id, status="running", phase="S1 主评测")
            if req.baseline_run_id:
                imported = self.store.import_baseline(run_id, req.baseline_run_id)
                st = self.store.load_state(run_id) or {}
                for rec in imported:
                    istat = st["instance_status"].setdefault(rec["instance_id"], {})
                    if rec["status"] != "ok":
                        badge = "error"
                    else:
                        badge = "pass" if rec["resolved"] else "fail"
                    istat[f"baseline_r{rec['run_index']}"] = badge
                    if rec["run_index"] == 0:
                        istat["baseline"] = badge
                self.store.update_state(run_id, instance_status=st["instance_status"])
            for inst in instances:
                for role, pconf in providers.items():
                    await asyncio.sleep(0)  # 让出事件循环,保证取消/查询可响应
                    await self._run_once(run_id, inst, pconf, role,
                                         run_index=0, phase="S1")
                    st = self.store.load_state(run_id) or {}
                    st["counts"]["s1"] = st["counts"].get("s1", 0) + 1
                    st["progress"]["done"] = st["counts"]["s1"] + st["counts"].get("s2", 0)
                    st["progress"]["current"] = None
                    self.store.update_state(run_id, **{
                        "counts": st["counts"], "progress": st["progress"]})

            # A/B 对比可用(双端同跑,或复用基线 + 实跑候选端)即触发分歧检测;
            # 复用基线时 providers 仅含 candidate,S2 只补跑候选端,基线保持导入结果
            if "candidate" in providers:
                records = self.store.load_records(run_id)
                disagreements = analyzer.disagreement_ids(records)
                if disagreements and req.repeat_disagreements > 0:
                    self.store.update_state(run_id, phase="S2 分歧复测", status="retesting")
                    by_id = {i["instance_id"]: i for i in instances}
                    st = self.store.load_state(run_id) or {}
                    st["progress"]["total"] = st["progress"]["done"] + \
                        len(disagreements) * len(providers) * req.repeat_disagreements
                    self.store.update_state(run_id, progress=st["progress"])
                    for iid in disagreements:
                        for run_index in range(1, req.repeat_disagreements + 1):
                            for role, pconf in providers.items():
                                await asyncio.sleep(0)
                                await self._run_once(run_id, by_id[iid], pconf, role,
                                                     run_index=run_index, phase="S2")
                                st = self.store.load_state(run_id) or {}
                                st["counts"]["s2"] = st["counts"].get("s2", 0) + 1
                                st["progress"]["done"] = (st["counts"]["s1"]
                                                          + st["counts"]["s2"])
                                self.store.update_state(run_id, counts=st["counts"],
                                                        progress=st["progress"])

            self.store.update_state(run_id, status="analyzing", phase="分析汇总")
            records = self.store.load_records(run_id)
            report = analyzer.build_report(run_id, records, suite, req)
            csv_text = records_to_csv(records)
            md_text = analyzer.render_markdown(report)
            self.store.write_report(run_id, report, csv_text, md_text)
            st = self.store.load_state(run_id) or {}
            st["progress"]["current"] = None
            self.store.update_state(run_id, status="completed", phase="完成",
                                    report_ready=True, progress=st["progress"],
                                    ended_at=datetime.now(timezone.utc)
                                    .strftime("%Y-%m-%dT%H:%M:%SZ"))
        except asyncio.CancelledError:
            self.store.update_state(run_id, status="cancelled", phase="已取消",
                                    ended_at=datetime.now(timezone.utc)
                                    .strftime("%Y-%m-%dT%H:%M:%SZ"))
            raise
        except Exception:
            self.store.update_state(run_id, status="failed", phase="失败",
                                    error=traceback.format_exc()[-2000:],
                                    ended_at=datetime.now(timezone.utc)
                                    .strftime("%Y-%m-%dT%H:%M:%SZ"))

    async def _run_once(self, run_id: str, inst_dict: dict, pconf: ProviderConfig,
                        role: str, run_index: int, phase: str) -> dict:
        inst = _to_instance(inst_dict)
        provider = LiveProvider(pconf)
        system, user = build_prompt(inst)
        started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

        st = self.store.load_state(run_id) or {}
        st["progress"]["current"] = {"instance_id": inst.instance_id, "role": role,
                                     "phase": phase}
        istat = st["instance_status"].setdefault(inst.instance_id, {})
        istat[f"{role}_r{run_index}"] = "running"
        self.store.update_state(run_id, progress=st["progress"],
                                instance_status=st["instance_status"])

        completion = await provider.complete(system, user)
        outcome = evaluate_heuristic(inst, completion)

        cost = compute_cost(pconf, completion.prompt_tokens,
                            completion.cached_tokens, completion.completion_tokens)
        record = {
            "run_index": run_index,
            "phase": phase,
            "instance_id": inst.instance_id,
            "provider_role": role,
            "provider_name": pconf.name,
            "model": pconf.model,
            "status": "ok" if completion.ok else "error",
            "resolved": (None if not completion.ok else bool(outcome.resolved)),
            "f2p_passed": outcome.f2p_passed, "f2p_total": outcome.f2p_total,
            "p2p_passed": outcome.p2p_passed, "p2p_total": outcome.p2p_total,
            "usage": {"prompt_tokens": completion.prompt_tokens,
                      "completion_tokens": completion.completion_tokens,
                      "cached_tokens": completion.cached_tokens},
            "ttft_s": completion.ttft_s,
            "wall_s": round(completion.wall_s, 3),
            "decode_tps": completion.decode_tps,
            "finish_reason": completion.finish_reason,
            "tool_errors": 0 if completion.ok else len(completion.errors),
            "errors": completion.errors,
            "cost_usd": round(cost, 6),
            "eval_method": outcome.method,
            "patch_excerpt": (completion.text or "")[:600],
            "started_at": started,
            "ended_at": datetime.now(timezone.utc)
                        .strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        }
        self.store.append_record(run_id, record)

        st = self.store.load_state(run_id) or {}
        istat = st["instance_status"].setdefault(inst.instance_id, {})
        if completion.ok:
            badge = "pass" if outcome.resolved else "fail"
        else:
            badge = "error"
        istat[f"{role}_r{run_index}"] = badge
        istat[f"{role}"] = badge if run_index == 0 else istat.get(f"{role}", badge)
        self.store.update_state(run_id, instance_status=st["instance_status"])

        # 文档 §14:仅保存失败与分歧任务的完整轨迹,减少存储
        if badge in ("fail", "error"):
            self.store.save_trajectory(run_id, inst.instance_id, role, run_index, {
                "instance_id": inst.instance_id,
                "provider_role": role, "model": pconf.model,
                "run_index": run_index, "phase": phase,
                "eval_detail": outcome.detail,
                "prompt_system": system, "prompt_user": user,
                "response": completion.text, "record": record,
            })
        return record


def _restore_request(data: dict, secrets: dict) -> "RunRequest":
    """用进程内密钥缓存回填脱敏后的 api_key。"""
    from .schemas import ProviderConfig, RunRequest  # noqa: PLC0415

    def fix(p: Optional[dict], role: str) -> Optional[ProviderConfig]:
        if p is None:
            return None
        p = dict(p)
        key = secrets.get(role)
        if key:
            p["api_key"] = key
        return ProviderConfig(**p)

    return RunRequest(
        provider_a=fix(data["provider_a"], "baseline"),
        provider_b=fix(data.get("provider_b"), "candidate"),
        baseline_run_id=data.get("baseline_run_id"),
        suite_level=data.get("suite_level", "smoke6"),
        suite_seed=data.get("suite_seed", 0),
        repeat_disagreements=data.get("repeat_disagreements", 2),
        turn_limit=data.get("turn_limit", 50),
    )
