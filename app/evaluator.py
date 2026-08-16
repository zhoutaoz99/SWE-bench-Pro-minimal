"""评测器:fail-to-pass + pass-to-pass 判定(设计文档 §2.2 / §11.1)。

启发式判定模型是否产出了结构合法的补丁。
注意:真实的 fail-to-pass 判定必须接入官方 Docker evaluator
(scaleapi/SWE-bench_Pro-os,文档 §5 G2/G3),此处结果仅用于链路演示,
会在报告中以 warning 标注。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .provider import CompletionResult
from .schemas import Instance


@dataclass
class EvalOutcome:
    resolved: bool
    f2p_passed: int
    f2p_total: int
    p2p_passed: int
    p2p_total: int
    method: str
    detail: str = ""


_DIFF_HUNK = re.compile(r"^@@ -\d+(,\d+)? \+\d+(,\d+)? @@", re.MULTILINE)
_DIFF_FILE = re.compile(r"^(--- a/|\+\+\+ b/|\+\+\+ |diff --git )", re.MULTILINE)


def evaluate_heuristic(inst: Instance, completion: CompletionResult) -> EvalOutcome:
    """启发式判定:检查响应是否包含结构合法的 unified diff。

    无法替代官方 Docker evaluator 的测试执行;此判定只回答
    "模型是否输出了可解析的补丁"。
    """
    text = completion.text or ""
    hunks = len(_DIFF_HUNK.findall(text))
    file_markers = len(_DIFF_FILE.findall(text))
    truncated = completion.finish_reason == "length"

    f2p_total = len(inst.fail_to_pass)
    ok = hunks > 0 and file_markers >= 2 and not truncated and completion.ok
    # 启发式:每个 hunk 视为使一个 fail-to-pass 通过(上限为总数)
    f2p_passed = min(hunks, f2p_total) if ok else 0
    p2p_total = len(inst.pass_to_pass)
    p2p_passed = p2p_total if ok else max(0, p2p_total - 1)

    detail = (f"hunks={hunks}, file_markers={file_markers}, "
              f"finish_reason={completion.finish_reason}")
    return EvalOutcome(
        resolved=bool(ok and f2p_passed == f2p_total and f2p_total > 0),
        f2p_passed=f2p_passed, f2p_total=f2p_total,
        p2p_passed=p2p_passed, p2p_total=p2p_total,
        method="heuristic-patch-parse",
        detail=detail,
    )
