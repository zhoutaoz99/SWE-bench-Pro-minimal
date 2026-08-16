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
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    ttft_s: Optional[float] = None
    wall_s: float = 0.0
    decode_tps: Optional[float] = None
    finish_reason: Optional[str] = None
    errors: list[str] = field(default_factory=list)
    ok: bool = True


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

    async def complete(self, system: str, user: str) -> CompletionResult:
        result = CompletionResult()
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

        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"

        start = time.perf_counter()
        chunks: list[str] = []
        usage: dict = {}
        finish_reason: Optional[str] = None
        first_token_at: Optional[float] = None

        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            for attempt in range(MAX_RETRIES + 1):
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
                            return result
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
                                fr = choices[0].get("finish_reason")
                                if fr:
                                    finish_reason = fr
                            if obj.get("usage"):
                                usage = obj["usage"]
                    break
                except (httpx.HTTPStatusError, httpx.TransportError,
                        httpx.TimeoutException) as exc:
                    result.errors.append(f"attempt {attempt + 1}: {type(exc).__name__}: {exc}")
                    if attempt < MAX_RETRIES:
                        await asyncio.sleep(1.5 * (attempt + 1))
                        continue
                    result.ok = False
                    result.wall_s = time.perf_counter() - start
                    return result

        wall = time.perf_counter() - start
        ttft = (first_token_at - start) if first_token_at is not None else None
        text = "".join(chunks)
        prompt_tokens = usage.get("prompt_tokens") or _estimate_tokens(system + user)
        completion_tokens = usage.get("completion_tokens") or _estimate_tokens(text)
        details = usage.get("prompt_tokens_details") or {}
        result.text = text
        result.prompt_tokens = prompt_tokens
        result.completion_tokens = completion_tokens
        result.cached_tokens = details.get("cached_tokens", 0) or 0
        result.ttft_s = ttft
        result.wall_s = wall
        result.decode_tps = (
            completion_tokens / (wall - ttft) if ttft and wall > ttft and completion_tokens else None
        )
        result.finish_reason = finish_reason or "stop"
        return result


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)
