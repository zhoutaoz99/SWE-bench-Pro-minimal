"""Pydantic 数据模型:Provider 配置、实例、套件清单、运行记录。"""
from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field

LanguageFamily = Literal["python", "go", "javascript", "typescript"]
TaskType = Literal["bug", "feature", "refactor", "infra"]
Difficulty = Literal["easy", "medium", "hard"]
SuiteLevel = Literal["smoke6", "core12", "confirm24"]
RunStatus = Literal[
    "queued", "running", "retesting", "analyzing",
    "completed", "failed", "cancelled",
]


class ProviderConfig(BaseModel):
    """单个推理 Provider 的连接与采样参数(设计文档 §10:显式锁参)。"""
    name: str = "Provider"
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    role: Literal["baseline", "candidate"] = "baseline"
    # 模型参数:不依赖 Provider 端默认值
    temperature: float = 0.0
    top_p: float = 1.0
    max_tokens: int = 8192
    reasoning_effort: Optional[str] = None
    # 计费(美元 / 百万 token),留空则成本按 token 数报告
    price_input_per_m: float = 0.0
    price_cached_per_m: float = 0.0
    price_output_per_m: float = 0.0
    auto_append_v1: bool = True


class Instance(BaseModel):
    """SWE-bench Pro 实例的核心字段(公开集字段子集 + 分层标签)。"""
    instance_id: str
    repo: str
    language_family: str
    task_type: str
    knowledge_domain: str
    problem_statement: str
    requirements: str = ""
    interface: str = ""
    fail_to_pass: list[str] = Field(default_factory=list)
    pass_to_pass: list[str] = Field(default_factory=list)
    gold_files_changed: int = 0
    gold_loc_changed: int = 0
    base_commit: str = ""
    docker_image: str = ""
    p_hist: Optional[float] = None      # 历史参考通过率,用于 D_emp / InfoScore
    runtime_class: str = "medium"       # fast | medium | slow


class SuiteManifest(BaseModel):
    """设计文档 §14 / 附录A:suite_manifest。"""
    suite_id: str
    suite_version: str
    level: SuiteLevel
    seed: int
    dataset_revision: str
    evaluator_revision: str
    scaffold_revision: str
    created_at: str
    quotas: dict[str, dict[str, int]] = Field(default_factory=dict)
    relaxations: list[str] = Field(default_factory=list)
    instances: list[dict] = Field(default_factory=list)


class RunRequest(BaseModel):
    """创建一次评测运行的请求。

    基线与候选端可独立运行:
    - 仅 provider_a:基线单端运行,完成后可作为基线源被后续运行复用;
    - provider_a + provider_b:传统 A/B,两端同跑;
    - baseline_run_id + provider_b:复用已完成基线运行的记录,本次只实跑候选端
      (基线不常更新时避免每次评测重复消耗)。
    """
    provider_a: Optional[ProviderConfig] = None   # 为空则必须提供 baseline_run_id
    provider_b: Optional[ProviderConfig] = None   # 为空则单端评测
    baseline_run_id: Optional[str] = None         # 复用已完成基线运行(与 provider_a 互斥)
    suite_level: SuiteLevel = "smoke6"
    suite_seed: int = 20260816
    suite_id: Optional[str] = None                # 复用已生成的套件
    repeat_disagreements: int = 2                 # S2 分歧复测次数(首次+2=3-run majority)
    turn_limit: int = 50


class UsageInfo(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0


class RunRecord(BaseModel):
    """per_run.jsonl 中的一行:一次 (instance, provider) 执行。"""
    run_index: int = 0
    phase: Literal["S1", "S2"] = "S1"
    instance_id: str
    provider_role: str
    provider_name: str
    model: str
    status: Literal["ok", "error"] = "ok"
    resolved: Optional[bool] = None
    f2p_passed: int = 0
    f2p_total: int = 0
    p2p_passed: int = 0
    p2p_total: int = 0
    usage: UsageInfo = Field(default_factory=UsageInfo)
    ttft_s: Optional[float] = None
    wall_s: float = 0.0
    decode_tps: Optional[float] = None
    finish_reason: Optional[str] = None
    tool_errors: int = 0
    errors: list[str] = Field(default_factory=list)
    cost_usd: float = 0.0
    eval_method: str = "heuristic-patch-parse"
    patch_excerpt: str = ""
    started_at: str = ""
    ended_at: str = ""
