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


class ProviderRouting(BaseModel):
    """OpenRouter Provider Routing:请求体顶层 `provider` 对象。

    仅对支持路由的网关(如 OpenRouter)生效,其他 OpenAI 兼容端点留空即可。
    - only:硬限制,只允许列出的 Provider,不可用则请求直接失败;
    - ignore:排除列出的 Provider;
    - order:按优先顺序尝试;
    - allow_fallbacks=False 时禁用降级(仅在 order/only 命中失败后不换 Provider)。
    """
    order: list[str] = Field(default_factory=list)
    only: list[str] = Field(default_factory=list)
    ignore: list[str] = Field(default_factory=list)
    allow_fallbacks: Optional[bool] = None
    quantizations: list[str] = Field(default_factory=list)
    sort: Optional[Literal["price", "throughput"]] = None
    require_parameters: Optional[bool] = None
    data_policy: Optional[Literal["deny", "flexible"]] = None

    def is_empty(self) -> bool:
        return not any(
            (self.order, self.only, self.ignore, self.quantizations,
             self.allow_fallbacks, self.sort, self.require_parameters,
             self.data_policy))

    def to_request_dict(self) -> dict:
        """生成剔除空字段后的请求体 provider 对象。"""
        if self.is_empty():
            return {}
        out: dict = {}
        for key in ("order", "only", "ignore", "quantizations"):
            value = getattr(self, key)
            if value:
                out[key] = value
        for key in ("allow_fallbacks", "sort", "require_parameters", "data_policy"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        return out


class ProviderConfig(BaseModel):
    """单个推理 Provider 的连接与采样参数(设计文档 §10:显式锁参)。"""
    name: str = "Provider"
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    role: Literal["baseline", "candidate"] = "baseline"
    # 模型参数:不依赖 Provider 端默认值。
    # 注意:推理模型的思考 token 计入 max_tokens,预算不足会先于补丁输出耗尽(finish_reason=length)
    temperature: float = 1.0
    top_p: float = 0.95
    max_tokens: int = 32768
    # 默认 max(最大思考力度);置 None/清空则请求不携带该参数(端点不支持时可清空)
    reasoning_effort: Optional[str] = "max"
    # 计费(美元 / 百万 token),留空则成本按 token 数报告
    price_input_per_m: float = 0.0
    price_cached_per_m: float = 0.0
    price_output_per_m: float = 0.0
    auto_append_v1: bool = True
    # OpenRouter 等网关的 Provider 路由(请求体顶层 provider 对象),留空不发送
    provider: Optional[ProviderRouting] = None


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
    # 评测 scaffold:agent = 官方 SWE-Agent 形态的多轮工具循环(默认);
    # single-turn = 旧版单轮补丁生成。两端必须同 scaffold 才可比。
    scaffold: Literal["agent", "single-turn"] = "agent"
    turn_limit: int = 200                         # Agent 模式每任务最大轮数(对齐官方)


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
    truncated: bool = False               # finish_reason == "length",输出被 max_tokens 截断
    tool_errors: int = 0
    errors: list[str] = Field(default_factory=list)
    cost_usd: float = 0.0
    eval_method: str = "heuristic-patch-parse"
    patch_excerpt: str = ""
    started_at: str = ""
    ended_at: str = ""
    # Agent scaffold 专用:实际使用的轮数 / 工具调用次数(单轮模式为 0)
    turns_used: int = 0
    tool_calls: int = 0
