import fs from 'node:fs';
import { SUITE_INSTANCES_PATH } from './paths';
import { Instance, TaskType, toInstance } from './schemas';

export let OFFICIAL_META: Record<string, unknown> = {};

/**
 * 加载代码仓库内预置的官方 SWE-bench Pro 套件实例。
 *
 * 这些实例只包含 Smoke-6 / Core-12 / Confirm-24 三个固定套件引用的任务，
 * 由 scripts/build_fixed_suites.py 从官方数据集中选出后写入
 * src/data/suite_instances.json，运行时不依赖外部数据集路径。
 */
export function loadSuiteInstances(): Instance[] {
  const raw = JSON.parse(fs.readFileSync(SUITE_INSTANCES_PATH, 'utf-8')) as {
    _meta?: Record<string, unknown>;
    instances: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(raw.instances)) {
    throw new Error(`suite instances JSON must contain an "instances" array: ${SUITE_INSTANCES_PATH}`);
  }
  OFFICIAL_META = raw._meta ?? {};
  return raw.instances.map((item) => toInstance(item));
}

/**
 * 从外部导出的官方 SWE-bench Pro JSON 加载完整实例池。
 * 当前运行框架默认使用 loadSuiteInstances() 的预置数据；
 * 此函数保留给需要临时加载完整官方数据集的脚本/高级用法。
 */
export function loadOfficialInstancesFromJson(filePath: string): Instance[] {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
    _meta?: Record<string, unknown>;
    instances: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(raw.instances)) {
    throw new Error(`official dataset JSON must contain an "instances" array: ${filePath}`);
  }
  OFFICIAL_META = raw._meta ?? {};
  return raw.instances.map((item) => toInstance(item));
}

export function splitTests(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map(String);
    return [String(parsed)];
  } catch {
    return [String(value)];
  }
}

export function parsePatchStats(patch: string): { files: number; loc: number } {
  const files = new Set<string>();
  let loc = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const parts = line.split(' b/');
      if (parts.length === 2) files.add(parts[1]!.trim());
    } else if (
      (line.startsWith('+') || line.startsWith('-')) &&
      !line.startsWith('+++') &&
      !line.startsWith('---')
    ) {
      loc += 1;
    }
  }
  return { files: files.size, loc };
}

const EXT_LANG: Record<string, string> = {
  '.py': 'python',
  '.go': 'go',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
};

function inferLanguage(filesHint: string): string {
  const hint = filesHint.toLowerCase();
  for (const [ext, lang] of Object.entries(EXT_LANG)) {
    if (hint.includes(ext)) return lang;
  }
  if (hint.includes('go')) return 'go';
  return 'python';
}

const TASK_KEYWORDS: Array<[TaskType, string[]]> = [
  ['refactor', ['refactor', 'clean up', 'restructure', 'extract', 'migrate']],
  ['feature', ['add', 'support', 'introduce', 'implement', 'new ']],
  ['infra', ['ci', 'docker', 'pipeline', 'deploy', 'build', 'infra', 'audit']],
];

function inferTaskType(statement: string): TaskType {
  const text = statement.toLowerCase();
  if (['bug', 'crash', 'fail', 'wrong', 'incorrect', 'regression'].some((k) => text.includes(k))) {
    return 'bug';
  }
  for (const [task, keywords] of TASK_KEYWORDS) {
    if (keywords.some((k) => text.includes(k))) return task;
  }
  return 'feature';
}

/**
 * 从 Hugging Face 加载真实 SWE-bench Pro 数据集。
 *
 * TS 后端不直接内置 HF 加载；请先通过 scripts/export_official_dataset.py
 * 导出为 JSON，再使用 loadOfficialInstancesFromJson()。
 */
export async function loadHfDataset(_revision?: string | null): Promise<Instance[]> {
  throw new Error(
    'TS 后端暂未内置 Hugging Face datasets 加载；请使用 scripts/export_official_dataset.py 导出 JSON 后，' +
      '再使用 loadOfficialInstancesFromJson() 或预置的 loadSuiteInstances()。',
  );
}

export function loadInstances(
  source: 'official' | 'hf' = 'official',
  pathOrRevision?: string | null,
): Instance[] | Promise<Instance[]> {
  if (source === 'official') {
    if (pathOrRevision) return loadOfficialInstancesFromJson(pathOrRevision);
    return loadSuiteInstances();
  }
  return loadHfDataset(pathOrRevision);
}
