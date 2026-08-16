"""FastAPI 入口:REST API + 前端静态页面托管。"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import dataset, difficulty, sampler
from .runner import SECRET_VAULT, RunEngine
from .schemas import ProviderConfig, RunRequest, SuiteLevel, SuiteManifest
from .store import RunStore

WEB_DIR = Path(__file__).parent.parent / "web"

store = RunStore()
engine = RunEngine(store)
_active_tasks: dict[str, asyncio.Task] = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    _recover_orphans()
    yield
    for task in _active_tasks.values():
        task.cancel()


def _recover_orphans() -> None:
    """服务重启后,将中断的运行标记为 failed。"""
    from datetime import datetime, timezone  # noqa: PLC0415

    for summary in store.list_runs():
        if summary["status"] in ("queued", "running", "retesting", "analyzing"):
            state = store.load_state(summary["run_id"])
            if state:
                state["status"] = "failed"
                state["error"] = "服务重启导致运行中断"
                state["ended_at"] = datetime.now(timezone.utc)\
                    .strftime("%Y-%m-%dT%H:%M:%SZ")
                store._write_state(summary["run_id"], state)


app = FastAPI(title="SWE-bench Pro 最小集评测框架", lifespan=lifespan)


# ---------------- 元数据与实例池 ----------------

@app.get("/api/meta")
def get_meta() -> dict:
    instances = dataset.load_instances()
    rows = difficulty.annotate(instances)
    by_lang: dict[str, int] = {}
    by_type: dict[str, int] = {}
    by_repo: dict[str, int] = {}
    by_band: dict[str, int] = {}
    for r in rows:
        by_lang[r["language_family"]] = by_lang.get(r["language_family"], 0) + 1
        by_type[r["task_type"]] = by_type.get(r["task_type"], 0) + 1
        by_repo[r["repo"]] = by_repo.get(r["repo"], 0) + 1
        by_band[r["difficulty"]] = by_band.get(r["difficulty"], 0) + 1
    return {
        "framework": "SWE-bench Pro 分层最小集评测框架",
        "dataset_meta": dataset.SEED_META,
        "instance_count": len(rows),
        "by_language": by_lang, "by_task_type": by_type,
        "by_repo": by_repo, "by_difficulty": by_band,
        "suites": store.list_suites(),
    }


@app.get("/api/instances")
def get_instances(language: Optional[str] = None, task_type: Optional[str] = None,
                  difficulty_band: Optional[str] = None, repo: Optional[str] = None,
                  q: Optional[str] = None) -> list[dict]:
    rows = difficulty.annotate(dataset.load_instances())
    out = []
    for r in rows:
        if language and r["language_family"] != language:
            continue
        if task_type and r["task_type"] != task_type:
            continue
        if difficulty_band and r["difficulty"] != difficulty_band:
            continue
        if repo and r["repo"] != repo:
            continue
        if q and q.lower() not in (
                r["instance_id"] + r["repo"] + (r.get("knowledge_domain") or "")
        ).lower():
            continue
        out.append(r)
    return out


# ---------------- 套件 ----------------

class GenerateSuiteBody(BaseModel):
    level: SuiteLevel = "smoke6"
    seed: int = 20260816


@app.post("/api/suites")
def generate_suite(body: GenerateSuiteBody) -> dict:
    manifest = sampler.generate_suite(body.level, body.seed)
    store.save_suite(manifest)
    return jsonable(manifest)


@app.get("/api/suites")
def list_suites() -> list[dict]:
    return store.list_suites()


@app.get("/api/suites/{suite_id}")
def get_suite(suite_id: str) -> dict:
    manifest = store.load_suite(suite_id)
    if manifest is None:
        raise HTTPException(404, f"suite not found: {suite_id}")
    return jsonable(manifest)


def jsonable(manifest) -> dict:
    import json  # noqa: PLC0415
    return json.loads(manifest.model_dump_json())


# ---------------- 运行 ----------------

@app.get("/api/baselines")
def list_baselines() -> list[dict]:
    """可复用的基线运行(已完成、单端实跑),供候选端评测选择复用源。"""
    return store.list_baselines()


def _resolve_reused_baseline(request: RunRequest) -> tuple[Optional[SuiteManifest], dict]:
    """校验 baseline_run_id 并构造影子 provider_a(仅携带展示信息,不用于实跑)。

    返回 (suite, baseline_request)。复用基线时套件必须与基线运行完全一致,
    未显式指定套件则直接采用基线运行的套件。
    """
    bstate = store.load_state(request.baseline_run_id)
    if bstate is None:
        raise HTTPException(404, f"baseline run not found: {request.baseline_run_id}")
    if bstate.get("status") != "completed" or not bstate.get("report_ready"):
        raise HTTPException(422, f"基线运行 {request.baseline_run_id} 尚未完成,无法复用")
    breq = bstate.get("request", {})
    if breq.get("provider_b"):
        raise HTTPException(422, f"运行 {request.baseline_run_id} 是 A/B 双端运行,不能作为基线复用源")
    if breq.get("baseline_run_id"):
        raise HTTPException(422, f"运行 {request.baseline_run_id} 自身复用了基线,不含实跑基线记录")
    suite = SuiteManifest.model_validate(bstate["suite"])
    if request.suite_id and request.suite_id != suite.suite_id:
        raise HTTPException(
            422, f"套件不一致:基线运行使用 {suite.suite_id},本次选择了 {request.suite_id};"
                 f"复用基线时必须使用同一套件")
    # 套件文件可能被清理,落盘一次保证幂等
    store.save_suite(suite)

    bpa = breq.get("provider_a") or {}
    request.provider_a = ProviderConfig(
        name=bpa.get("name") or "Baseline",
        base_url=bpa.get("base_url") or "",
        model=bpa.get("model") or "",
        api_key="",
        role="baseline",
        temperature=bpa.get("temperature", 0.0),
        top_p=bpa.get("top_p", 1.0),
        max_tokens=bpa.get("max_tokens", 8192),
        reasoning_effort=bpa.get("reasoning_effort"),
        price_input_per_m=bpa.get("price_input_per_m", 0.0),
        price_cached_per_m=bpa.get("price_cached_per_m", 0.0),
        price_output_per_m=bpa.get("price_output_per_m", 0.0),
    )
    return suite, breq


@app.post("/api/runs")
async def create_run(request: RunRequest) -> dict:
    if request.baseline_run_id and request.provider_a is not None:
        raise HTTPException(422, "baseline_run_id 与 provider_a 只能二选一:复用基线时不必填写基线端配置")
    if request.baseline_run_id is None and request.provider_a is None:
        raise HTTPException(422, "缺少推理端:请填写 provider_a,或提供 baseline_run_id 复用已完成基线")
    if request.baseline_run_id and request.provider_b is None:
        raise HTTPException(422, "复用基线时必须提供 provider_b(候选端):本次运行只实跑候选端")

    reuse_suite = None
    if request.baseline_run_id:
        reuse_suite, _ = _resolve_reused_baseline(request)
        request.suite_id = reuse_suite.suite_id

    # 所有端均为真实调用,base_url 与 model 必填
    problems = []
    for p, label in ((request.provider_a, "Provider A"),
                     (request.provider_b, "Provider B")):
        if p is None:
            continue
        if not p.base_url.strip() or not p.model.strip():
            problems.append(f"{label}: 必须填写 base_url 与 model")
    if problems:
        raise HTTPException(422, ";".join(problems))

    if reuse_suite is not None:
        suite = reuse_suite
    elif request.suite_id:
        suite = store.load_suite(request.suite_id)
        if suite is None:
            raise HTTPException(404, f"suite not found: {request.suite_id}")
    else:
        suite = sampler.generate_suite(request.suite_level, request.suite_seed)
        store.save_suite(suite)

    state = store.create_run(request, suite)
    run_id = state["run_id"]
    if request.provider_a and request.provider_a.api_key:
        SECRET_VAULT[run_id] = {"baseline": request.provider_a.api_key}
    if request.provider_b and request.provider_b.api_key:
        SECRET_VAULT.setdefault(run_id, {})["candidate"] = request.provider_b.api_key
    task = asyncio.create_task(engine.execute(run_id))
    _active_tasks[run_id] = task
    task.add_done_callback(lambda t: _active_tasks.pop(run_id, None))
    return {"run_id": run_id, "suite_id": suite.suite_id, "status": state["status"],
            "baseline_run_id": request.baseline_run_id}


@app.get("/api/runs")
def list_runs() -> list[dict]:
    return store.list_runs()


@app.get("/api/runs/{run_id}/state")
def get_run_state(run_id: str) -> dict:
    state = store.load_state(run_id)
    if state is None:
        raise HTTPException(404, f"run not found: {run_id}")
    return state


@app.get("/api/runs/{run_id}/report")
def get_run_report(run_id: str) -> dict:
    if store.load_state(run_id) is None:
        raise HTTPException(404, f"run not found: {run_id}")
    report = store.load_report(run_id)
    if report is None:
        raise HTTPException(409, "报告尚未生成(运行未完成)")
    report["artifacts"] = store.list_trajectories(run_id)
    return report


@app.post("/api/runs/{run_id}/cancel")
async def cancel_run(run_id: str) -> dict:
    task = _active_tasks.get(run_id)
    if task is None:
        raise HTTPException(409, "运行不存在或已结束")
    task.cancel()
    for _ in range(100):
        if task.done():
            break
        await asyncio.sleep(0.05)
    return {"run_id": run_id, "status": "cancelled"}


class ArtifactQuery(BaseModel):
    name: str


@app.post("/api/runs/{run_id}/artifact")
def get_artifact(run_id: str, body: ArtifactQuery) -> dict:
    if store.load_state(run_id) is None:
        raise HTTPException(404, f"run not found: {run_id}")
    if body.name.endswith(".json") and "/" not in body.name:
        traj = store.load_trajectory(run_id, body.name)
        if traj is None:
            raise HTTPException(404, f"artifact not found: {body.name}")
        return traj
    text = store.read_artifact(run_id, body.name)
    if text is None:
        raise HTTPException(404, f"artifact not found: {body.name}")
    return {"name": body.name, "content": text}


@app.delete("/api/runs/{run_id}")
async def delete_run(run_id: str) -> dict:
    task = _active_tasks.get(run_id)
    if task and not task.done():
        raise HTTPException(409, "运行进行中,请先取消")
    if store.load_state(run_id) is None:
        raise HTTPException(404, f"run not found: {run_id}")
    import shutil  # noqa: PLC0415
    shutil.rmtree(store.run_dir(run_id), ignore_errors=True)
    SECRET_VAULT.pop(run_id, None)
    return {"deleted": run_id}


# ---------------- 前端 ----------------

@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
