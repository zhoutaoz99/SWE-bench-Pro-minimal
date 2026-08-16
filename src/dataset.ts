import fs from 'node:fs';
import { SEED_PATH } from './paths';
import { Instance, TaskType, toInstance } from './schemas';

export let SEED_META: Record<string, unknown> = {};

export function loadSeedInstances(): Instance[] {
  const raw = JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8')) as {
    _meta?: Record<string, unknown>;
    instances: Array<Record<string, unknown>>;
  };
  SEED_META = raw._meta ?? {};
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
 * TS 后端默认使用内置种子池；如需真实数据集，建议先通过 Python sidecar
 * 或 HF 导出为 JSON 后复用 loadInstances('seed') 路径。
 * 这里保留接口占位，避免破坏调用方结构。
 */
export async function loadHfDataset(_revision?: string | null): Promise<Instance[]> {
  throw new Error(
    'TS 后端暂未内置 Hugging Face datasets 加载；请使用内置种子池，' +
      '或先用 Python sidecar 将真实数据集导出为 JSON。',
  );
}

export function loadInstances(source: 'seed' | 'hf' = 'seed', revision?: string | null): Instance[] | Promise<Instance[]> {
  if (source === 'hf') return loadHfDataset(revision);
  return loadSeedInstances();
}
