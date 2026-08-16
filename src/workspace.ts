import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Instance } from './schemas';

const BASH_TIMEOUT = Number(process.env.SBP_AGENT_BASH_TIMEOUT || '60');
const OUTPUT_CAP = 8000;
const BASH_ENABLED = process.env.SBP_AGENT_BASH !== '0';
const DOCKER_REPO_DIR = process.env.SBP_OFFICIAL_REPO_DIR || '/testbed';
const DOCKER_TIMEOUT = Number(process.env.SBP_DOCKER_TIMEOUT || '120');

export interface AgentWorkspaceOptions {
  docker?: boolean;
  image?: string;
  repoDir?: string;
}

export const AGENT_TOOLS: Array<Record<string, unknown>> = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a bash command inside the workspace. The working directory is the workspace root. stdout and stderr are combined; long output is truncated. Timeout per command applies.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The bash command to run' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_file',
      description: 'View a text file in the workspace with 1-based line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace' },
          start_line: { type: 'integer', description: 'First line to show (optional)' },
          end_line: { type: 'integer', description: 'Last line to show (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit a file by exact search/replace. old_text must match exactly once (include surrounding lines to disambiguate). To create a new file, pass old_text as an empty string.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace' },
          old_text: { type: 'string', description: 'Exact text to replace (empty = create file)' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit',
      description:
        'Submit the current workspace file changes as the final patch. Call this once the task is complete.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function countOccurrences(text: string, sub: string): number {
  if (sub === '') return text.length + 1;
  return text.split(sub).length - 1;
}

function truncate(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  const half = Math.floor(cap / 2);
  return (
    text.slice(0, half) +
    `\n... [输出超长,已截断,共 ${text.length} 字符] ...\n` +
    text.slice(-half)
  );
}

function which(cmd: string): string | null {
  const pathVar = process.env.PATH || '';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext.toLowerCase());
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // continue
      }
    }
  }
  return null;
}

function dockerAvailable(): boolean {
  const res = spawnSync('docker', ['--version'], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 10_000,
  });
  return res.status === 0;
}

export class AgentWorkspace {
  readonly root: string;
  submitted = false;
  gitReady = false;
  private readonly bash: string | null;
  private readonly git: string | null;
  private readonly docker: boolean;
  private readonly image: string;
  private readonly repoDir: string;
  private readonly containerName: string;
  private containerReady = false;

  constructor(root: string, options: AgentWorkspaceOptions = {}) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.docker = Boolean(options.docker);
    this.image = options.image || '';
    this.repoDir = options.repoDir || DOCKER_REPO_DIR;
    this.containerName =
      'sbp-' +
      this.root
        .split(path.sep)
        .filter(Boolean)
        .slice(-4)
        .join('-')
        .replace(/[^a-zA-Z0-9_.-]/g, '-') +
      '-' +
      Date.now().toString(36);
    this.bash = BASH_ENABLED ? which('bash') : null;
    this.git = which('git');
  }

  seed(inst: Instance): void {
    const spec =
      `# Task: ${inst.instance_id}\n\n` +
      `## Problem Statement\n${inst.problem_statement}\n\n` +
      `## Requirements\n${inst.requirements || '(none)'}\n\n` +
      `## Interface\n${inst.interface || '(none)'}\n\n` +
      '## Output\nYour submission is the set of file changes in this workspace ' +
      '(a unified diff is computed automatically). Call the `submit` tool when done.\n';

    if (this.docker) {
      this.ensureContainer();
      this.dockerWriteFile(path.posix.join(this.repoDir, 'TASK.md'), spec);
      // 避免 TASK.md 进入最终 git diff
      this.dockerSync([
        'exec',
        this.containerName,
        'sh',
        '-c',
        `printf 'TASK.md\\n' >> ${this.repoDir}/.git/info/exclude 2>/dev/null || true`,
      ]);
      return;
    }

    fs.writeFileSync(path.join(this.root, 'TASK.md'), spec, 'utf-8');
    fs.writeFileSync(path.join(this.root, '.gitignore'), 'TASK.md\n', 'utf-8');
    if (this.git) {
      this.gitRun('init', '-q');
      this.gitRun('config', 'user.email', 'agent@scaffold.local');
      this.gitRun('config', 'user.name', 'agent-scaffold');
      this.gitRun('add', '.gitignore');
      this.gitRun('commit', '-q', '--allow-empty', '-m', 'baseline');
      this.gitReady = true;
    }
  }

  dispose(): void {
    if (this.docker && this.containerReady) {
      this.dockerSync(['rm', '-f', this.containerName]);
      this.containerReady = false;
    }
  }

  private gitRun(...args: string[]): { code: number; output: string } {
    if (!this.git) return { code: 1, output: 'git not found' };
    const res = spawnSync(this.git, args, {
      cwd: this.root,
      encoding: 'utf-8',
      windowsHide: true,
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    return { code: res.status ?? 1, output };
  }

  finalPatch(): string {
    if (this.docker) {
      this.ensureContainer();
      this.dockerSync(['exec', this.containerName, 'git', '-C', this.repoDir, 'add', '-A']);
      const diffRes = this.dockerSync([
        'exec',
        this.containerName,
        'git',
        '-C',
        this.repoDir,
        'diff',
        '--cached',
        '--no-color',
      ]);
      if (diffRes.code === 0 && diffRes.output.trim()) return diffRes.output;
      const headRes = this.dockerSync([
        'exec',
        this.containerName,
        'git',
        '-C',
        this.repoDir,
        'diff',
        'HEAD',
        '--no-color',
      ]);
      if (headRes.code === 0 && headRes.output.trim()) return headRes.output;
      return '';
    }

    if (this.gitReady) {
      this.gitRun('add', '-A');
      const diffRes = this.gitRun('diff', '--cached', '--no-color');
      if (diffRes.code === 0 && diffRes.output.trim()) return diffRes.output;
    }
    return this.fallbackPatch();
  }

  private fallbackPatch(): string {
    const parts: string[] = [];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.git') continue;
          walk(full);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    };
    walk(this.root);
    files.sort();
    for (const file of files) {
      const rel = path.relative(this.root, file).split(path.sep).join('/');
      if (rel === 'TASK.md' || rel === '.gitignore') continue;
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.match(/[^\n]*\n|[^\n]+$/g) || [];
      const body = lines.map((ln) => `+${ln}`).join('');
      parts.push(
        `diff --git a/${rel} b/${rel}\n` +
          '--- /dev/null\n' +
          `+++ b/${rel}\n` +
          `@@ -0,0 +1,${lines.length} @@\n${body}`,
      );
    }
    return parts.join('');
  }

  private resolvePath(relPath: string): string {
    const p = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return p;
  }

  private resolveDockerPath(relPath: string): string {
    const p = path.posix.resolve(this.repoDir, relPath);
    if (!p.startsWith(this.repoDir.endsWith('/') ? this.repoDir : this.repoDir + '/') && p !== this.repoDir) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return p;
  }

  async runBash(command: string, signal?: AbortSignal): Promise<[string, boolean]> {
    if (this.docker) {
      this.ensureContainer();
      if (!command.trim()) return ["error: bash requires a non-empty 'command'", true];
      const full = `cd ${this.repoDir} && ${command}`;
      return this.runDockerAsync(['bash', '-lc', full], signal);
    }

    if (!BASH_ENABLED) return ['bash tool disabled by SBP_AGENT_BASH=0', true];
    if (!this.bash) {
      return [
        'bash is not available on this host; use view_file / edit_file instead.',
        true,
      ];
    }
    if (signal?.aborted) return ['[cancelled] command', true];
    return new Promise((resolvePromise) => {
      const proc = spawn(this.bash!, ['-c', command], {
        cwd: this.root,
        windowsHide: true,
      });
      let out = '';
      let timedOut = false;
      let cancelled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cancelled = true;
        proc.kill();
      };
      proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')));
      proc.stderr.on('data', (d: Buffer) => (out += d.toString('utf-8')));
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, BASH_TIMEOUT * 1000);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (err) => {
        cleanup();
        resolvePromise([truncate(`error: ${err.message}`), true]);
      });
      proc.on('close', (code) => {
        cleanup();
        if (cancelled) {
          resolvePromise([truncate('[cancelled] command'), true]);
        } else if (timedOut) {
          resolvePromise([truncate(`[timeout after ${Math.round(BASH_TIMEOUT)}s] ${command}`), true]);
        } else {
          resolvePromise([truncate(out), code !== 0 && code != null]);
        }
      });
    });
  }

  private runDockerAsync(args: string[], signal?: AbortSignal): Promise<[string, boolean]> {
    return new Promise((resolvePromise) => {
      const proc = spawn('docker', ['exec', this.containerName, ...args], {
        windowsHide: true,
      });
      let out = '';
      let timedOut = false;
      let cancelled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cancelled = true;
        proc.kill();
      };
      proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')));
      proc.stderr.on('data', (d: Buffer) => (out += d.toString('utf-8')));
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, DOCKER_TIMEOUT * 1000);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (err) => {
        cleanup();
        resolvePromise([truncate(`error: ${err.message}`), true]);
      });
      proc.on('close', (code) => {
        cleanup();
        if (cancelled) {
          resolvePromise([truncate('[cancelled] docker command'), true]);
        } else if (timedOut) {
          resolvePromise([truncate(`[timeout after ${Math.round(DOCKER_TIMEOUT)}s] docker exec`), true]);
        } else {
          resolvePromise([truncate(out), code !== 0 && code != null]);
        }
      });
    });
  }

  viewFile(
    filePath: string,
    startLine?: number | null,
    endLine?: number | null,
  ): [string, boolean] {
    if (this.docker) {
      this.ensureContainer();
      let p: string;
      try {
        p = this.resolveDockerPath(filePath);
      } catch (err) {
        return [`error: ${(err as Error).message}`, true];
      }
      const res = this.dockerSync(['exec', this.containerName, 'cat', p]);
      if (res.code !== 0) {
        return [`error: file not found: ${filePath}`, true];
      }
      let lines = res.output.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const lo = Math.max(1, Number(startLine || 1));
      const hi = Math.min(lines.length, Number(endLine || lines.length));
      const numbered = lines
        .slice(lo - 1, hi)
        .map((line, i) => `${String(lo + i).padStart(6)}| ${line}`)
        .join('\n');
      return [`(lines ${lo}-${hi} of ${lines.length})\n${numbered || '(empty range)'}`, false];
    }

    let p: string;
    try {
      p = this.resolvePath(filePath);
    } catch (err) {
      return [`error: ${(err as Error).message}`, true];
    }
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      return [`error: file not found: ${filePath}`, true];
    }
    let lines: string[];
    try {
      const text = fs.readFileSync(p, 'utf-8');
      lines = text.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    } catch (err) {
      return [`error: ${(err as Error).message}`, true];
    }
    const lo = Math.max(1, Number(startLine || 1));
    const hi = Math.min(lines.length, Number(endLine || lines.length));
    const numbered = lines
      .slice(lo - 1, hi)
      .map((line, i) => `${String(lo + i).padStart(6)}| ${line}`)
      .join('\n');
    return [`(lines ${lo}-${hi} of ${lines.length})\n${numbered || '(empty range)'}`, false];
  }

  editFile(filePath: string, oldText: string, newText: string): [string, boolean] {
    if (this.docker) {
      this.ensureContainer();
      let p: string;
      try {
        p = this.resolveDockerPath(filePath);
      } catch (err) {
        return [`error: ${(err as Error).message}`, true];
      }
      const existsRes = this.dockerSync(['exec', this.containerName, 'sh', '-c', `test -f "${p}" && echo yes || echo no`]);
      const exists = existsRes.output.trim() === 'yes';
      if (!exists) {
        if (oldText) {
          return [
            `error: file does not exist: ${filePath} (pass empty old_text to create it)`,
            true,
          ];
        }
        this.dockerWriteFile(p, newText);
        return [`created ${filePath} (${newText.length} chars)`, false];
      }
      const readRes = this.dockerSync(['exec', this.containerName, 'cat', p]);
      if (readRes.code !== 0) return [`error: cannot read ${filePath}`, true];
      const content = readRes.output;
      const count = countOccurrences(content, oldText);
      if (count === 0) {
        return [
          'error: old_text not found in file; include exact text (copy from view_file)',
          true,
        ];
      }
      if (count > 1) {
        return [
          `error: old_text matches ${count} locations; add surrounding context to make it unique`,
          true,
        ];
      }
      this.dockerWriteFile(p, content.replace(oldText, newText));
      return [`edited ${filePath}`, false];
    }

    let p: string;
    try {
      p = this.resolvePath(filePath);
    } catch (err) {
      return [`error: ${(err as Error).message}`, true];
    }
    if (!fs.existsSync(p)) {
      if (oldText) {
        return [
          `error: file does not exist: ${filePath} (pass empty old_text to create it)`,
          true,
        ];
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, newText, 'utf-8');
      return [`created ${filePath} (${newText.length} chars)`, false];
    }
    if (!fs.statSync(p).isFile()) {
      return [`error: not a file: ${filePath}`, true];
    }
    const content = fs.readFileSync(p, 'utf-8');
    const count = countOccurrences(content, oldText);
    if (count === 0) {
      return [
        'error: old_text not found in file; include exact text (copy from view_file)',
        true,
      ];
    }
    if (count > 1) {
      return [
        `error: old_text matches ${count} locations; add surrounding context to make it unique`,
        true,
      ];
    }
    fs.writeFileSync(p, content.replace(oldText, newText), 'utf-8');
    return [`edited ${filePath}`, false];
  }

  async executeTool(name: string, argumentsJson: string, signal?: AbortSignal): Promise<[string, boolean]> {
    let args: Record<string, unknown>;
    try {
      args = argumentsJson && argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
    } catch {
      return [`error: invalid tool arguments JSON: ${argumentsJson.slice(0, 200)}`, true];
    }

    if (name === 'submit') {
      this.submitted = true;
      return ['submitted', false];
    }
    if (name === 'bash') {
      const cmd = args.command;
      if (typeof cmd !== 'string' || !cmd.trim()) {
        return ["error: bash requires a non-empty 'command'", true];
      }
      return this.runBash(cmd, signal);
    }
    if (name === 'view_file') {
      const p = args.path;
      if (typeof p !== 'string' || !p) {
        return ["error: view_file requires 'path'", true];
      }
      return this.viewFile(p, args.start_line as number | undefined, args.end_line as number | undefined);
    }
    if (name === 'edit_file') {
      const p = args.path;
      if (typeof p !== 'string' || !p) {
        return ["error: edit_file requires 'path'", true];
      }
      return this.editFile(
        p,
        typeof args.old_text === 'string' ? args.old_text : '',
        typeof args.new_text === 'string' ? args.new_text : '',
      );
    }
    return [`error: unknown tool: ${name}`, true];
  }

  // ---------- Docker helpers ----------

  private ensureContainer(): void {
    if (this.containerReady) return;
    if (!dockerAvailable()) {
      throw new Error('Docker is not available or daemon is not running');
    }
    if (!this.image) {
      throw new Error('Docker workspace requires an official image (docker_image)');
    }
    const existing = this.dockerSync(['ps', '-a', '--filter', `name=${this.containerName}`, '--format', '{{.Names}}']);
    const name = existing.output.trim();
    if (!name) {
      const create = this.dockerSync([
        'create',
        '--name',
        this.containerName,
        '-i',
        this.image,
        ...this.keepAliveArgs(),
      ]);
      if (create.code !== 0) {
        throw new Error(`docker create failed: ${create.output}`);
      }
      const start = this.dockerSync(['start', this.containerName]);
      if (start.code !== 0) {
        throw new Error(`docker start failed: ${start.output}`);
      }
    } else {
      const running = this.dockerSync(['ps', '--filter', `name=${this.containerName}`, '--format', '{{.Names}}']);
      if (!running.output.trim()) {
        const start = this.dockerSync(['start', this.containerName]);
        if (start.code !== 0) {
          throw new Error(`docker start failed: ${start.output}`);
        }
      }
    }
    this.containerReady = true;
  }

  /** 返回让容器保持运行的命令参数。
   * 这些 SWE-bench 官方镜像的 ENTRYPOINT 是 ["/bin/sh"]，
   * 直接传 `sleep infinity` 会被 /bin/sh 当作脚本文件打开而失败，
   * 所以需要根据 ENTRYPOINT 决定是否用 `-c` 传命令字符串。
   */
  private keepAliveArgs(): string[] {
    const inspect = this.dockerSync([
      'image',
      'inspect',
      this.image,
      '--format',
      '{{json .Config.Entrypoint}}',
    ]);
    let entrypoint: unknown = null;
    try {
      entrypoint = JSON.parse(inspect.output.trim());
    } catch {
      entrypoint = null;
    }

    if (Array.isArray(entrypoint) && entrypoint.length === 1 && entrypoint[0] === '/bin/sh') {
      return ['-c', 'sleep infinity'];
    }
    if (
      Array.isArray(entrypoint) &&
      entrypoint.length === 2 &&
      entrypoint[0] === '/bin/sh' &&
      entrypoint[1] === '-c'
    ) {
      return ['sleep infinity'];
    }
    return ['sh', '-c', 'sleep infinity'];
  }

  private dockerSync(args: string[], input?: string): { code: number; output: string } {
    const res = spawnSync('docker', args, {
      encoding: 'utf-8',
      windowsHide: true,
      input,
      timeout: DOCKER_TIMEOUT * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    return { code: res.status ?? 1, output };
  }

  private dockerWriteFile(containerPath: string, content: string): void {
    const dir = path.posix.dirname(containerPath);
    const mk = this.dockerSync(['exec', this.containerName, 'sh', '-c', `mkdir -p "${dir}"`]);
    if (mk.code !== 0) throw new Error(`docker mkdir failed: ${mk.output}`);
    const write = this.dockerSync(
      ['exec', '-i', this.containerName, 'sh', '-c', `cat > "${containerPath}"`],
      content,
    );
    if (write.code !== 0) throw new Error(`docker write failed: ${write.output}`);
  }
}
