"""推理 Provider 客户端。

LiveProvider:任意 OpenAI 兼容 /chat/completions 端点(用户输入 base_url + model),
  流式请求以测得真实 TTFT / decode tok/s,429/5xx/超时按文档 §10 重试。
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from .schemas import Instance, ProviderConfig

RETRYABLE_STATUS = {429, 500, 502, 503, 504}
MAX_RETRIES = 2
REQUEST_TIMEOUT = 300.0


@dataclass
class CompletionResult:
    text: str = ""
    # 推理模型的思维链(流式 delta.reasoning_content / delta.reasoning)。
    # 思考 token 计入 max_tokens 预算,若耗尽则 text 为空、finish_reason=length。
    reasoning: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    ttft_s: Optional[float] = None
    wall_s: float = 0.0
    decode_tps: Optional[float] = None
    finish_reason: Optional[str] = None
    errors: list[str] = field(default_factory=list)
    ok: bool = True
    # 多轮 Agent 模式:本步请求的工具调用与可回填会话历史的 assistant 消息
    tool_calls: list[dict] = field(default_factory=list)   # [{id, name, arguments}]
    assistant_message: Optional[dict] = None


def normalize_base_url(base_url: str, auto_append_v1: bool = True) -> str:
    url = base_url.strip().rstrip("/")
    if not auto_append_v1:
        return url
    # 已带版本路径(/v1、/v2、/compatible-mode 等)则不再追加
    if url.endswith(("/v1", "/v2")) or "/v1/" in url or "/compatible-mode" in url:
        return url
    return url + "/v1"


def build_prompt(inst: Instance) -> tuple[str, str]:
    """构造与官方对齐的固定 prompt(文档 §10:两端完全一致)。"""
    system = (
        "You are an expert software engineer working on a real repository. "
        "Solve the task and output ONLY a unified diff patch (git diff format) "
        "that resolves the problem statement."
    )
    user = f"""## Problem Statement
{inst.problem_statement}

## Requirements
{inst.requirements or '(none)'}

## Interface
{inst.interface or '(none)'}

## Output Format
Output a single unified diff patch. Do not include explanations outside the diff."""
    return system, user


class LiveProvider:
    """OpenAI 兼容端点的最小客户端(流式)。"""

    def __init__(self, config: ProviderConfig):
        self.config = config
        self.endpoint = normalize_base_url(config.base_url, config.auto_append_v1) + "/chat/completions"

    async def complete(self, system: str, user: str, *,
                       retries: int = MAX_RETRIES,
                       timeout: float = REQUEST_TIMEOUT,
                       on_delta=None) -> CompletionResult:
        """on_delta(kind, piece):每收到一段流式增量时同步回调
        (kind ∈ {"reasoning", "content"}),供实时视图使用;必须轻量。"""
        body = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": self.config.temperature,
            "top_p": self.config.top_p,
            "max_tokens": self.config.max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if self.config.reasoning_effort:
            body["reasoning_effort"] = self.config.reasoning_effort
        if self.config.provider is not None:
            routing = self.config.provider.to_request_dict()
            if routing:
                body["provider"] = routing
        result = CompletionResult()
        await self._do_stream(body, result, on_delta=on_delta,
                              retries=retries, timeout=timeout)
        return result

    async def agent_step(self, messages: list[dict], tools: list[dict], *,
                         retries: int = MAX_RETRIES,
                         timeout: float = REQUEST_TIMEOUT,
                         on_delta=None) -> CompletionResult:
        """多轮 Agent 模式的单步:携带完整会话历史与工具定义请求一步,
        流式累积 content / reasoning / tool_calls 增量。

        返回的 CompletionResult 中:
        - text / reasoning:本步正文与思考;
        - tool_calls:模型发起的工具调用 [{id, name, arguments(JSON 串)}];
        - assistant_message:可直接 append 回 messages 的 assistant 消息。
        """
        body = {
            "model": self.config.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "temperature": self.config.temperature,
            "top_p": self.config.top_p,
            "max_tokens": self.config.max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if self.config.reasoning_effort:
            body["reasoning_effort"] = self.config.reasoning_effort
        if self.config.provider is not None:
            routing = self.config.provider.to_request_dict()
            if routing:
                body["provider"] = routing
        result = CompletionResult()
        await self._do_stream(body, result, on_delta=on_delta,
                              retries=retries, timeout=timeout)
        calls = [{"id": c["id"] or f"call_{i}", "name": c["name"],
                  "arguments": c["arguments"]}
                 for i, c in enumerate(result.tool_calls)]
        result.tool_calls = calls
        msg: dict = {"role": "assistant", "content": result.text or ""}
        if calls:
            msg["tool_calls"] = [
                {"id": c["id"], "type": "function",
                 "function": {"name": c["name"], "arguments": c["arguments"]}}
                for c in calls]
            msg["content"] = result.text  # 部分端点不接受 null content
        result.assistant_message = msg
        return result

    async def _do_stream(self, body: dict, result: CompletionResult, *,
                         on_delta=None, retries: int, timeout: float) -> None:
        """执行带重试的流式 /chat/completions 请求,把全部结果写入 result。"""
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"

        start = time.perf_counter()
        chunks: list[str] = []
        reasoning_chunks: list[str] = []
        # OpenAI 流式协议:tool_calls 按 index 分片,id/name 首包携带、arguments 逐段拼接
        tool_acc: dict[int, dict] = {}
        usage: dict = {}
        finish_reason: Optional[str] = None
        first_token_at: Optional[float] = None
        prompt_probe = "".join(
            m.get("content") or "" for m in body.get("messages", []))

        async with httpx.AsyncClient(timeout=timeout) as client:
            for attempt in range(retries + 1):
                try:
                    async with client.stream("POST", self.endpoint,
                                             json=body, headers=headers) as resp:
                        if resp.status_code in RETRYABLE_STATUS:
                            raise httpx.HTTPStatusError(
                                f"HTTP {resp.status_code}", request=resp.request,
                                response=resp)
                        if resp.status_code >= 400:
                            detail = (await resp.aread()).decode("utf-8", "replace")[:400]
                            result.ok = False
                            result.errors.append(f"HTTP {resp.status_code}: {detail}")
                            return
                        async for line in resp.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            payload = line[5:].strip()
                            if payload == "[DONE]":
                                break
                            try:
                                obj = json.loads(payload)
                            except ValueError:
                                continue
                            if first_token_at is None:
                                first_token_at = time.perf_counter()
                            choices = obj.get("choices") or []
                            if choices:
                                delta = choices[0].get("delta") or {}
                                piece = delta.get("content")
                                if piece:
                                    chunks.append(piece)
                                    if on_delta:
                                        on_delta("content", piece)
                                # DeepSeek 系流式用 reasoning_content,
                                # OpenRouter 对 o 系等用 reasoning
                                rpiece = (delta.get("reasoning_content")
                                          or delta.get("reasoning"))
                                if rpiece:
                                    reasoning_chunks.append(rpiece)
                                    if on_delta:
                                        on_delta("reasoning", rpiece)
                                for tc in delta.get("tool_calls") or []:
                                    idx = tc.get("index") or 0
                                    slot = tool_acc.setdefault(
                                        idx, {"id": "", "name": "", "arguments": ""})
                                    if tc.get("id"):
                                        slot["id"] = tc["id"]
                                    fn = tc.get("function") or {}
                                    if fn.get("name"):
                                        slot["name"] = fn["name"]
                                    if fn.get("arguments"):
                                        slot["arguments"] += fn["arguments"]
                                fr = choices[0].get("finish_reason")
                                if fr:
                                    finish_reason = fr
                            if obj.get("usage"):
                                usage = obj["usage"]
                    break
                except (httpx.HTTPStatusError, httpx.TransportError,
                        httpx.TimeoutException) as exc:
                    result.errors.append(f"attempt {attempt + 1}: {type(exc).__name__}: {exc}")
                    if attempt < retries:
                        await asyncio.sleep(1.5 * (attempt + 1))
                        continue
                    result.ok = False
                    result.wall_s = time.perf_counter() - start
                    return

        wall = time.perf_counter() - start
        ttft = (first_token_at - start) if first_token_at is not None else None
        text = "".join(chunks)
        reasoning = "".join(reasoning_chunks)
        prompt_tokens = usage.get("prompt_tokens") or _estimate_tokens(prompt_probe)
        completion_tokens = (usage.get("completion_tokens")
                             or _estimate_tokens(text + reasoning))
        details = usage.get("prompt_tokens_details") or {}
        result.text = text
        result.reasoning = reasoning
        result.tool_calls = [tool_acc[i] for i in sorted(tool_acc)]
        result.prompt_tokens = prompt_tokens
        result.completion_tokens = completion_tokens
        result.cached_tokens = details.get("cached_tokens", 0) or 0
        result.ttft_s = ttft
        result.wall_s = wall
        result.decode_tps = (
            completion_tokens / (wall - ttft) if ttft and wall > ttft and completion_tokens else None
        )
        result.finish_reason = finish_reason or "stop"


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)
