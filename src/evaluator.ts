import { spawn, spawnSync } from 'node:child_process';
import { Instance } from './schemas';

export interface EvalOutcome {
  resolved: boolean;
  f2p_passed: number;
  f2p_total: number;
  p2p_passed: number;
  p2p_total: number;
  method: string;
  detail: string;
}

export interface OfficialEvalOptions {
  image?: string;
  repoDir?: string;
  timeoutMs?: number;
}

/**
 * 在官方 SWE-bench Pro Docker 镜像中执行真实测试判定。
 *
 * 流程：
 * 1. 用实例的 docker_image 启动一个一次性容器（镜像内已包含 base commit 仓库）。
 * 2. 写入 agent 生成的 patch 和官方 test_patch。
 * 3. 应用 agent patch 与 test patch。
 * 4. 逐个运行 fail_to_pass / pass_to_pass（或使用实例自带 test_cmd）。
 * 5. 以真实退出码判定 PASS/FAIL，计算 resolved。
 *
 * 这是“最小官方环境”实现：不依赖 swebench Python 包，但使用官方 Docker 镜像与测试用例。
 */
export async function evaluateOfficialDocker(
  inst: Instance,
  patch: string,
  options: OfficialEvalOptions = {},
): Promise<EvalOutcome> {
  const image = options.image || inst.docker_image;
  const repoDir = options.repoDir || process.env.SBP_OFFICIAL_REPO_DIR || '/testbed';
  const timeoutMs = options.timeoutMs || Number(process.env.SBP_EVAL_TIMEOUT || '600000');
  const method = 'official-docker-test-runner-v1';

  const f2pTotal = inst.fail_to_pass.length;
  const p2pTotal = inst.pass_to_pass.length;
  const baseOutcome: EvalOutcome = {
    resolved: false,
    f2p_passed: 0,
    f2p_total: f2pTotal,
    p2p_passed: 0,
    p2p_total: p2pTotal,
    method,
    detail: '',
  };

  if (!image) {
    return { ...baseOutcome, detail: 'missing docker_image' };
  }
  if (!dockerAvailable()) {
    return { ...baseOutcome, detail: 'docker unavailable or daemon not running' };
  }
  if (!patch.trim()) {
    return { ...baseOutcome, detail: 'empty agent patch' };
  }

  const container = `sbp-eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const create = dockerSync([
      'create',
      '--name',
      container,
      '-i',
      image,
      'sleep',
      'infinity',
    ]);
    if (create.code !== 0) {
      return { ...baseOutcome, detail: `docker create failed: ${create.output.slice(0, 500)}` };
    }
    const start = dockerSync(['start', container]);
    if (start.code !== 0) {
      dockerSync(['rm', '-f', container]);
      return { ...baseOutcome, detail: `docker start failed: ${start.output.slice(0, 500)}` };
    }

    dockerWriteFile(container, '/tmp/agent.patch', patch);
    if (inst.test_patch) {
      dockerWriteFile(container, '/tmp/test.patch', inst.test_patch);
    }

    const applyAgent = applyPatch(container, repoDir, '/tmp/agent.patch');
    if (!applyAgent.ok) {
      return { ...baseOutcome, detail: `apply agent patch failed: ${applyAgent.output.slice(0, 500)}` };
    }
    if (inst.test_patch) {
      const applyTest = applyPatch(container, repoDir, '/tmp/test.patch');
      if (!applyTest.ok) {
        return { ...baseOutcome, detail: `apply test patch failed: ${applyTest.output.slice(0, 500)}` };
      }
    }
    if (inst.install && inst.install.trim()) {
      const installRes = dockerSync([
        'exec',
        container,
        'bash',
        '-lc',
        `cd ${repoDir} && ${inst.install}`,
      ]);
      if (installRes.code !== 0) {
        return { ...baseOutcome, detail: `install failed: ${installRes.output.slice(0, 500)}` };
      }
    }

    const results = await runTests(container, repoDir, inst, timeoutMs);

    const f2pPassed = results.f2pPassed;
    const p2pPassed = results.p2pPassed;
    const resolved = f2pTotal > 0 && f2pPassed === f2pTotal && p2pPassed === p2pTotal;
    return {
      resolved,
      f2p_passed: f2pPassed,
      f2p_total: f2pTotal,
      p2p_passed: p2pPassed,
      p2p_total: p2pTotal,
      method,
      detail: results.detail,
    };
  } finally {
    dockerSync(['rm', '-f', container]);
  }
}

// ---------- internal helpers ----------

function dockerAvailable(): boolean {
  const res = spawnSync('docker', ['--version'], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 10_000,
  });
  return res.status === 0;
}

function dockerSync(args: string[], input?: string): { code: number; output: string } {
  const res = spawnSync('docker', args, {
    encoding: 'utf-8',
    windowsHide: true,
    input,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  return { code: res.status ?? 1, output };
}

function dockerWriteFile(container: string, containerPath: string, content: string): void {
  const dir = containerPath.includes('/') ? containerPath.slice(0, containerPath.lastIndexOf('/')) : '/tmp';
  dockerSync(['exec', container, 'sh', '-c', `mkdir -p "${dir}"`]);
  const write = dockerSync(
    ['exec', '-i', container, 'sh', '-c', `cat > "${containerPath}"`],
    content,
  );
  if (write.code !== 0) {
    throw new Error(`docker write failed: ${write.output.slice(0, 300)}`);
  }
}

function applyPatch(
  container: string,
  repoDir: string,
  patchPath: string,
): { ok: boolean; output: string } {
  const gitApply = dockerSync([
    'exec',
    container,
    'bash',
    '-lc',
    `cd ${repoDir} && git apply --whitespace=nowarn "${patchPath}"`,
  ]);
  if (gitApply.code === 0) return { ok: true, output: gitApply.output };
  const patchApply = dockerSync([
    'exec',
    container,
    'bash',
    '-lc',
    `cd ${repoDir} && patch -p1 --batch --forward < "${patchPath}"`,
  ]);
  return { ok: patchApply.code === 0, output: patchApply.output };
}

async function runTests(
  container: string,
  repoDir: string,
  inst: Instance,
  timeoutMs: number,
): Promise<{ f2pPassed: number; p2pPassed: number; detail: string }> {
  const f2pTotal = inst.fail_to_pass.length;
  const p2pTotal = inst.pass_to_pass.length;

  // 如果官方数据提供了统一 test_cmd，则整批跑一次，退出码 0 视为全部通过。
  if (inst.test_cmd && inst.test_cmd.trim()) {
    const cmd = `cd ${repoDir} && ${inst.test_cmd}`;
    const res = await runCommandInContainer(container, cmd, timeoutMs);
    const allPass = res.code === 0;
    const detail = `test_cmd exit=${res.code}\n${res.output.slice(0, 2000)}`;
    return {
      f2pPassed: allPass ? f2pTotal : 0,
      p2pPassed: allPass ? p2pTotal : 0,
      detail,
    };
  }

  let f2pPassed = 0;
  let p2pPassed = 0;
  const details: string[] = [];
  for (const test of inst.fail_to_pass) {
    const cmd = buildTestCommand(inst, test, repoDir);
    const res = await runCommandInContainer(container, cmd, timeoutMs);
    const ok = res.code === 0;
    if (ok) f2pPassed += 1;
    details.push(`F2P ${ok ? 'PASS' : 'FAIL'} ${test} (exit=${res.code})`);
  }
  for (const test of inst.pass_to_pass) {
    const cmd = buildTestCommand(inst, test, repoDir);
    const res = await runCommandInContainer(container, cmd, timeoutMs);
    const ok = res.code === 0;
    if (ok) p2pPassed += 1;
    details.push(`P2P ${ok ? 'PASS' : 'FAIL'} ${test} (exit=${res.code})`);
  }
  return {
    f2pPassed,
    p2pPassed,
    detail: details.join('\n') || 'no tests',
  };
}

function buildTestCommand(inst: Instance, test: string, repoDir: string): string {
  if (inst.test_cmd && inst.test_cmd.trim()) {
    return `cd ${repoDir} && ${inst.test_cmd}`;
  }
  const lang = (inst.language_family || '').toLowerCase();
  if (lang.includes('go')) {
    // go test 需要包路径；test id 形如 "pkg/foo_test.go::TestName" 或 "pkg::TestName"
    const pkg = test.split('::')[0] || test;
    return `cd ${repoDir} && go test ${pkg} -run '${test.split('::')[1] || ''}' -count=1`;
  }
  if (lang.includes('javascript') || lang.includes('typescript')) {
    return `cd ${repoDir} && (npx jest ${test} --runInBand --silent 2>&1 || npm test -- ${test} --runInBand --silent 2>&1)`;
  }
  // Python 默认
  return `cd ${repoDir} && python -m pytest ${test} -q --no-header -p no:cacheprovider`;
}

function runCommandInContainer(
  container: string,
  command: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const proc = spawn('docker', ['exec', container, 'bash', '-lc', command], {
      windowsHide: true,
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')));
    proc.stderr.on('data', (d: Buffer) => (out += d.toString('utf-8')));
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, output: `error: ${err.message}\n${out}` });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolvePromise({ code: 124, output: `[timeout after ${Math.round(timeoutMs / 1000)}s]\n${out}` });
      } else {
        resolvePromise({ code: code ?? 1, output: out });
      }
    });
  });
}
