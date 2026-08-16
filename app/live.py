"""运行中实例的实时输出缓冲(仅进程内,服务重启即失,不落盘)。

LiveProvider 流式回调把 reasoning/content 增量写入此处,
监控页通过 /api/runs/{id}/live 与 /live-detail 轮询增量拉取,近似流式展示。
单线程事件循环内写入、线程池端点只读,GIL 下一致性足够(最坏读到略旧一拍)。
"""
from __future__ import annotations

from datetime import datetime, timezone

# key: f"{run_id}::{instance_id}::{role}::r{run_index}"
LIVE: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def register(run_id: str, instance_id: str, role: str, run_index: int,
             model: str, phase: str) -> str:
    key = f"{run_id}::{instance_id}::{role}::r{run_index}"
    LIVE[key] = {
        "run_id": run_id, "instance_id": instance_id,
        "provider_role": role, "run_index": run_index,
        "model": model, "phase": phase,
        "status": "streaming",
        "reasoning": "", "content": "",
        "started_at": _now(), "updated_at": _now(),
        "finish_reason": None, "errors": [],
    }
    return key


def append_text(key: str, kind: str, piece: str) -> None:
    entry = LIVE.get(key)
    if entry is None or kind not in ("reasoning", "content"):
        return
    entry[kind] += piece
    entry["updated_at"] = _now()


def finish(key: str, finish_reason: str | None = None,
           errors: list[str] | None = None) -> None:
    entry = LIVE.get(key)
    if entry is None:
        return
    entry["status"] = "done"
    entry["finish_reason"] = finish_reason
    if errors:
        entry["errors"] = list(errors)
    entry["updated_at"] = _now()


def _meta(entry: dict) -> dict:
    return {
        "instance_id": entry["instance_id"],
        "provider_role": entry["provider_role"],
        "run_index": entry["run_index"],
        "model": entry["model"], "phase": entry["phase"],
        "status": entry["status"],
        "reasoning_chars": len(entry["reasoning"]),
        "content_chars": len(entry["content"]),
        "started_at": entry["started_at"], "updated_at": entry["updated_at"],
        "finish_reason": entry["finish_reason"],
    }


def list_entries(run_id: str) -> list[dict]:
    """该运行全部实时条目的元信息(不含正文,轮询用)。"""
    return [_meta(e) for e in LIVE.values() if e["run_id"] == run_id]


def get_detail(run_id: str, instance_id: str, role: str, run_index: int,
               r_offset: int = 0, c_offset: int = 0) -> dict | None:
    """按字符偏移增量返回正文切片,客户端只取新增部分。"""
    key = f"{run_id}::{instance_id}::{role}::r{run_index}"
    entry = LIVE.get(key)
    if entry is None:
        return None
    r, c = entry["reasoning"], entry["content"]
    return {
        **_meta(entry),
        "r_offset": len(r), "c_offset": len(c),
        "reasoning_part": r[r_offset:] if 0 <= r_offset <= len(r) else "",
        "content_part": c[c_offset:] if 0 <= c_offset <= len(c) else "",
    }


def drop_run(run_id: str) -> None:
    for key in [k for k, e in LIVE.items() if e["run_id"] == run_id]:
        del LIVE[key]
