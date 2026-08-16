"""多轮 Agent 工作区环境(官方 SWE-Agent scaffold 的最小本地实现)。

每个 (run, instance, role, 轮次) 拥有独立工作区目录:
- 种子阶段写入 TASK.md(完整任务规格)并做 git 基线提交(TASK.md 不入库);
- 模型通过 bash / view_file / edit_file / submit 四个工具与工作区交互;
- 结束时以工作区文件变更的 git diff 提取 unified diff 作为最终补丁。

⚠️ 隔离性差异:官方评测在 Docker 容器内执行命令;本框架为最小实现,
bash 直接在宿主机工作区内执行(仅 cwd 限定 + 超时 + 输出截断),
只应在可信评测环境下使用。设环境变量 SBP_AGENT_BASH=0 可禁用 bash 工具,
SBP_AGENT_BASH_TIMEOUT 可调整单条命令超时(秒,默认 60)。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Optional

from .schemas import Instance

BASH_TIMEOUT = float(os.environ.get("SBP_AGENT_BASH_TIMEOUT", "60"))
OUTPUT_CAP = 8000          # 工具输出回传给模型的字符上限(超长保留首尾)
BASH_ENABLED = os.environ.get("SBP_AGENT_BASH", "1") != "0"

# OpenAI function-calling 工具定义(与下方 execute_tool 一一对应)
AGENT_TOOLS = [
    {"type": "function", "function": {
        "name": "bash",
        "description": ("Run a bash command inside the workspace. The working directory "
                        "is the workspace root. stdout and stderr are combined; long "
                        "output is truncated. Timeout per command applies."),
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "The bash command to run"}},
            "required": ["command"]},
    }},
    {"type": "function", "function": {
        "name": "view_file",
        "description": "View a text file in the workspace with 1-based line numbers.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "File path relative to the workspace"},
            "start_line": {"type": "integer", "description": "First line to show (optional)"},
            "end_line": {"type": "integer", "description": "Last line to show (optional)"}},
            "required": ["path"]},
    }},
    {"type": "function", "function": {
        "name": "edit_file",
        "description": ("Edit a file by exact search/replace. old_text must match exactly "
                        "once (include surrounding lines to disambiguate). To create a new "
                        "file, pass old_text as an empty string."),
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "File path relative to the workspace"},
            "old_text": {"type": "string", "description": "Exact text to replace (empty = create file)"},
            "new_text": {"type": "string", "description": "Replacement text"}},
            "required": ["path", "old_text", "new_text"]},
    }},
    {"type": "function", "function": {
        "name": "submit",
        "description": ("Submit the current workspace file changes as the final patch. "
                        "Call this once the task is complete."),
        "parameters": {"type": "object", "properties": {}},
    }},
]


def _truncate(text: str, cap: int = OUTPUT_CAP) -> str:
    if len(text) <= cap:
        return text
    half = cap // 2
    return (text[:half] + f"\n... [输出超长,已截断,共 {len(text)} 字符] ...\n"
            + text[-half:])


class AgentWorkspace:
    """单个 (实例, 端, 轮次) 的沙箱工作区与工具执行器。"""

    def __init__(self, root: Path):
        # resolve() 保证后续 (root / path).resolve() 与 root 一致
        # (Windows 临时目录可能是 8.3 短路径形态,不 resolve 会误判逃逸)
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.submitted = False
        self._bash = shutil.which("bash") if BASH_ENABLED else None
        self._git = shutil.which("git")
        self.git_ready = False

    # ---------- 种子与补丁 ----------

    def seed(self, inst: Instance) -> None:
        """写入任务规格 TASK.md 并建立 git 基线(TASK.md 与 .gitignore 不计入补丁)。"""
        spec = (
            f"# Task: {inst.instance_id}\n\n"
            f"## Problem Statement\n{inst.problem_statement}\n\n"
            f"## Requirements\n{inst.requirements or '(none)'}\n\n"
            f"## Interface\n{inst.interface or '(none)'}\n\n"
            "## Output\nYour submission is the set of file changes in this workspace "
            "(a unified diff is computed automatically). Call the `submit` tool when done.\n"
        )
        (self.root / "TASK.md").write_text(spec, encoding="utf-8")
        (self.root / ".gitignore").write_text("TASK.md\n", encoding="utf-8")
        if self._git:
            self._git_run("init", "-q")
            self._git_run("config", "user.email", "agent@scaffold.local")
            self._git_run("config", "user.name", "agent-scaffold")
            # .gitignore 纳入基线提交,避免它出现在最终补丁里
            self._git_run("add", ".gitignore")
            self._git_run("commit", "-q", "--allow-empty", "-m", "baseline")
            self.git_ready = True

    def _git_run(self, *args: str) -> tuple[int, str]:
        import subprocess  # noqa: PLC0415
        proc = subprocess.run([self._git, *args], cwd=self.root,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace")
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")

    def final_patch(self) -> str:
        """以 git diff 提取工作区相对基线的 unified diff;无 git 时退化为伪 diff。"""
        if self.git_ready:
            self._git_run("add", "-A")
            code, diff = self._git_run("diff", "--cached", "--no-color")
            if code == 0 and diff.strip():
                return diff
        return self._fallback_patch()

    def _fallback_patch(self) -> str:
        """无 git / 空仓库:把工作区文件(排除种子文件)拼成 new-file 风格 diff。"""
        parts: list[str] = []
        for path in sorted(self.root.rglob("*")):
            if path.is_dir() or path.name in ("TASK.md", ".gitignore") \
                    or ".git" in path.parts:
                continue
            rel = path.relative_to(self.root).as_posix()
            try:
                lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
            except (UnicodeDecodeError, OSError):
                continue
            body = "".join(f"+{ln}" for ln in lines)
            parts.append(
                f"diff --git a/{rel} b/{rel}\n"
                "--- /dev/null\n"
                f"+++ b/{rel}\n"
                f"@@ -0,0 +1,{len(lines)} @@\n{body}")
        return "".join(parts)

    # ---------- 工具实现 ----------

    def _resolve(self, rel_path: str) -> Path:
        p = (self.root / rel_path).resolve()
        if not p.is_relative_to(self.root):
            raise ValueError(f"path escapes workspace: {rel_path}")
        return p

    async def run_bash(self, command: str) -> tuple[str, bool]:
        if not BASH_ENABLED:
            return "bash tool disabled by SBP_AGENT_BASH=0", True
        if not self._bash:
            return ("bash is not available on this host; "
                    "use view_file / edit_file instead.", True)
        proc = await asyncio.create_subprocess_exec(
            self._bash, "-c", command, cwd=str(self.root),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), BASH_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return _truncate(f"[timeout after {BASH_TIMEOUT:.0f}s] {command}"), True
        text = out.decode("utf-8", "replace")
        return _truncate(text), proc.returncode not in (0, None)

    def view_file(self, path: str, start_line: Optional[int] = None,
                  end_line: Optional[int] = None) -> tuple[str, bool]:
        try:
            p = self._resolve(path)
        except (ValueError, OSError) as exc:
            return f"error: {exc}", True
        if not p.is_file():
            return f"error: file not found: {path}", True
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:
            return f"error: {exc}", True
        lo = max(1, int(start_line or 1))
        hi = min(len(lines), int(end_line or len(lines)))
        numbered = "\n".join(f"{n:>6}| {lines[n - 1]}"
                             for n in range(lo, hi + 1))
        return f"(lines {lo}-{hi} of {len(lines)})\n{numbered or '(empty range)'}", False

    def edit_file(self, path: str, old_text: str, new_text: str) -> tuple[str, bool]:
        try:
            p = self._resolve(path)
        except (ValueError, OSError) as exc:
            return f"error: {exc}", True
        if not p.exists():
            if old_text:
                return f"error: file does not exist: {path} " \
                       f"(pass empty old_text to create it)", True
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(new_text, encoding="utf-8")
            return f"created {path} ({len(new_text)} chars)", False
        if not p.is_file():
            return f"error: not a file: {path}", True
        content = p.read_text(encoding="utf-8", errors="replace")
        count = content.count(old_text)
        if count == 0:
            return "error: old_text not found in file; include exact text " \
                   "(copy from view_file)", True
        if count > 1:
            return f"error: old_text matches {count} locations; add surrounding " \
                   f"context to make it unique", True
        p.write_text(content.replace(old_text, new_text, 1), encoding="utf-8")
        return f"edited {path}", False

    async def execute_tool(self, name: str, arguments: str) -> tuple[str, bool]:
        """执行一次工具调用,返回 (回传文本, 是否出错)。submit 仅置位不产生输出。"""
        try:
            args = json.loads(arguments) if arguments and arguments.strip() else {}
        except ValueError:
            return f"error: invalid tool arguments JSON: {arguments[:200]}", True

        if name == "submit":
            self.submitted = True
            return "submitted", False
        if name == "bash":
            cmd = args.get("command")
            if not isinstance(cmd, str) or not cmd.strip():
                return "error: bash requires a non-empty 'command'", True
            return await self.run_bash(cmd)
        if name == "view_file":
            path = args.get("path")
            if not isinstance(path, str) or not path:
                return "error: view_file requires 'path'", True
            return self.view_file(path, args.get("start_line"), args.get("end_line"))
        if name == "edit_file":
            path = args.get("path")
            if not isinstance(path, str) or not path:
                return "error: edit_file requires 'path'", True
            return self.edit_file(path, args.get("old_text") or "",
                                  args.get("new_text") or "")
        return f"error: unknown tool: {name}", True
