"""A/B Runner(设计文档 §4 / §10 / §12)。

S1:每 Provider 每题 1 次(同 prompt、同参数,仅切换 endpoint/model);
S2:只对 A/B 结果不一致的分歧题,每端再跑 repeat_disagreements 次,
    形成 3-run majority(文档 §12 的"只复测 disagreement"成本控制)。
"""
from __future__ import annotations

import asyncio
import time
import traceback
from datetime import datetime, timezone
from typing import Optional

from . import analyzer
from . import live as livemod
from .env import AGENT_TOOLS, AgentWorkspace
from .evaluator import evaluate_heuristic
from .provider import LiveProvider, build_prompt
from .schemas import Instance, ProviderConfig
from .store import RunStore, records_to_csv

_INSTANCE_FIELDS = set(Instance.model_fields.keys())

# Agent scaffold 系统提示(官方 SWE-Agent 形态:工具循环 + 工作区 + 轮次预算)
AGENT_SYSTEM_TMPL = (
    "You are an autonomous software engineer agent solving a real task inside a "
    "dedicated workspace directory.\n"
    "- Interact with the workspace ONLY through the provided tools "
    "(bash / view_file / edit_file / submit).\n"
    "- Create or modify files so that the final workspace state resolves the task. "
    "The submission patch is computed automatically from your file changes "
    "(git diff) — do NOT print the diff yourself.\n"
    "- You have a budget of at most {turns} turns. Call `submit` when the task is done.\n"
    "- Be efficient: inspect first, implement, then verify; avoid repeating "
    "failed commands."
)

# run_id → 原始 api_key(仅进程内,不落盘)
SECRET_VAULT: dict[str, dict[str, str]] = {}


def _to_instance(d: dict) -> Instance:
    return Instance(**{k: v for k, v in d.items() if k in _INSTANCE_FIELDS})


# 执行顺序:简单 → 中等 → 困难(同带内保持套件原顺序);仅影响运行顺序,不改动套件清单
_BAND_ORDER = {"easy": 0, "medium": 1, "hard": 2}


def _by_difficulty(instances: list[dict]) -> list[dict]:
    return sorted(instances, key=lambda i: _BAND_ORDER.get(i.get("difficulty"), 3))


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
        # S1/S2 均按难度带升序执行:先易后难,便于尽早暴露端点/参数问题
        instances = _by_difficulty(suite["instances"])
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
                                         run_index=0, phase="S1",
                                         scaffold=req.scaffold,
                                         turn_limit=req.turn_limit)
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
                    rank = {i["instance_id"]: n for n, i in enumerate(instances)}
                    disagreements = sorted(disagreements,
                                           key=lambda x: rank.get(x, len(rank)))
                    st = self.store.load_state(run_id) or {}
                    st["progress"]["total"] = st["progress"]["done"] + \
                        len(disagreements) * len(providers) * req.repeat_disagreements
                    self.store.update_state(run_id, progress=st["progress"])
                    for iid in disagreements:
                        for run_index in range(1, req.repeat_disagreements + 1):
                            for role, pconf in providers.items():
                                await asyncio.sleep(0)
                                await self._run_once(run_id, by_id[iid], pconf, role,
                                                     run_index=run_index, phase="S2",
                                                     scaffold=req.scaffold,
                                                     turn_limit=req.turn_limit)
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
                                    error=None,
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
                        role: str, run_index: int, phase: str,
                        scaffold: str = "single-turn", turn_limit: int = 200) -> dict:
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

        # 实时视图:注册进程内缓冲,流式增量同步写入(仅本次运行期间有效)
        live_key = livemod.register(run_id, inst.instance_id, role, run_index,
                                    pconf.model, phase)
        agent_meta: dict = {}
        if scaffold == "agent":
            # 官方 SWE-Agent 形态:多轮工具循环,补丁取自工作区 git diff
            completion, agent_meta = await self._agent_loop(
                run_id, inst, pconf, role, run_index, live_key, turn_limit)
        else:
            completion = await provider.complete(
                system, user,
                on_delta=lambda kind, piece: livemod.append_text(live_key, kind, piece))
        livemod.finish(live_key, completion.finish_reason, completion.errors)
        outcome = evaluate_heuristic(inst, completion)

        cost = compute_cost(pconf, completion.prompt_tokens,
                            completion.cached_tokens, completion.completion_tokens)
        record = {
            "run_index": run_index,
            "phase": phase,
            "scaffold": scaffold,
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
            "truncated": completion.finish_reason == "length",
            "turns_used": agent_meta.get("turns", 0),
            "tool_calls": agent_meta.get("tool_calls", 0),
            "tool_errors": ((0 if completion.ok else len(completion.errors))
                            + agent_meta.get("tool_errors", 0)),
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
                "run_index": run_index, "phase": phase, "scaffold": scaffold,
                "eval_detail": outcome.detail,
                "prompt_system": system, "prompt_user": user,
                "response": completion.text,
                "reasoning": completion.reasoning,
                "agent": {k: agent_meta[k] for k in
                          ("turns", "tool_calls", "tool_errors", "submitted")
                          if k in agent_meta},
                "trajectory": agent_meta.get("transcript"),
                "record": record,
            })
        return record

    async def _agent_loop(self, run_id: str, inst: Instance, pconf: ProviderConfig,
                          role: str, run_index: int, live_key: str,
                          turn_limit: int):
        """官方 SWE-Agent 形态的多轮工具循环(设计文档 §6 的最小实现)。

        每轮 = 一次携带完整会话历史与工具定义的请求;模型通过
        bash / view_file / edit_file / submit 与专属工作区交互;
        submit 或轮次预算耗尽后,以工作区 git diff 作为补丁交给评测器。
        token / 成本 / 耗时按轮次累计,实时面板按轮次追加展示。
        """
        from .provider import CompletionResult  # noqa: PLC0415

        safe_id = inst.instance_id.replace("/", "_").replace(":", "_")
        ws = AgentWorkspace(self.store.run_dir(run_id) / "workspaces" / safe_id
                            / f"{role}_r{run_index}")
        ws.seed(inst)
        provider = LiveProvider(pconf)
        system = AGENT_SYSTEM_TMPL.format(turns=turn_limit)
        _, user = build_prompt(inst)
        user += ("\n\nThe full task specification is also available in "
                 "TASK.md inside the workspace.")
        messages: list[dict] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        completion = CompletionResult(ok=True)
        completion.text = ""
        prompt_tokens = completion_tokens = cached_tokens = 0
        tool_call_count = tool_errors = turns_used = 0
        submitted = False
        truncated = False
        last_text = ""
        reasoning_parts: list[str] = []
        transcript: list[dict] = []
        started = time.perf_counter()

        for turn in range(1, turn_limit + 1):
            await asyncio.sleep(0)
            header = f"\n\n──────── 轮次 {turn}/{turn_limit} ────────\n"
            livemod.append_text(live_key, "reasoning", header)
            livemod.append_text(live_key, "content", header)
            step = await provider.agent_step(
                messages, AGENT_TOOLS,
                on_delta=lambda kind, piece: livemod.append_text(live_key, kind, piece))
            prompt_tokens += step.prompt_tokens
            completion_tokens += step.completion_tokens
            cached_tokens += step.cached_tokens
            if step.ttft_s is not None and completion.ttft_s is None:
                completion.ttft_s = step.ttft_s
            if not step.ok:
                completion.ok = False
                completion.errors.extend(step.errors)
                transcript.append({"role": "assistant", "error": step.errors})
                break
            turns_used = turn
            if step.finish_reason == "length":
                truncated = True
            if step.text:
                last_text = step.text
            if step.reasoning:
                reasoning_parts.append(f"〔Turn {turn}〕\n{step.reasoning[:4000]}")
            messages.append(step.assistant_message)
            transcript.append(step.assistant_message)

            if step.tool_calls:
                for call in step.tool_calls:
                    tool_call_count += 1
                    result_text, is_err = await ws.execute_tool(
                        call["name"], call["arguments"])
                    if is_err:
                        tool_errors += 1
                    tool_msg = {"role": "tool", "tool_call_id": call["id"],
                                "content": result_text}
                    messages.append(tool_msg)
                    transcript.append({"role": "tool", "tool_call_id": call["id"],
                                       "name": call["name"],
                                       "content": result_text[:2000]})
                    brief = call["arguments"][:120].replace("\n", " ")
                    livemod.append_text(
                        live_key, "content",
                        f"⚙ {call['name']}({brief})"
                        f"{' ✗' if is_err else ''}\n{result_text[:600]}\n")
                    if call["name"] == "submit":
                        submitted = True
                        break
                if submitted:
                    break
            else:
                # 无工具调用视为空转:提醒行动,避免烧完轮次预算
                note = ("You did not call any tool. Use the tools to work on the "
                        "task, or call `submit` when you are done.")
                messages.append({"role": "user", "content": note})
                livemod.append_text(live_key, "content",
                                    "(未调用工具 — 已追加行动提醒)\n")

        patch = ws.final_patch()
        if not patch.strip() and last_text.strip():
            # 兜底:工作区无变更时,退回最后一步正文(可能含模型直接输出的 diff)
            patch = last_text
        completion.text = patch
        completion.reasoning = "\n\n".join(reasoning_parts)
        completion.prompt_tokens = prompt_tokens
        completion.completion_tokens = completion_tokens
        completion.cached_tokens = cached_tokens
        completion.wall_s = time.perf_counter() - started
        # 工作区已有变更则以最终状态为准;仅当无补丁且发生截断时保留 length 信号
        completion.finish_reason = ("length" if truncated and not patch.strip()
                                    else "stop")
        completion.decode_tps = (
            completion_tokens / (completion.wall_s - completion.ttft_s)
            if completion.ttft_s and completion.wall_s > completion.ttft_s
            and completion_tokens else None)
        meta = {"turns": turns_used, "tool_calls": tool_call_count,
                "tool_errors": tool_errors, "submitted": submitted,
                "transcript": transcript}
        return completion, meta


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
        # 旧运行未存 scaffold 字段 —— 一律按历史行为(单轮)恢复
        scaffold=data.get("scaffold") or "single-turn",
        turn_limit=data.get("turn_limit", 50),
    )
