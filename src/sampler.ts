import fs from 'node:fs';
import { loadSuiteInstances, OFFICIAL_META } from './dataset';
import * as difficulty from './difficulty';
import { Instance, SuiteLevel, SuiteManifest } from './schemas';
import { FIXED_SUITES_PATH } from './paths';

export const QUOTAS: Record<string, Record<string, number>> = {
  smoke6: { easy: 2, medium: 2, hard: 2 },
  core12: { easy: 2, medium: 6, hard: 4 },
  confirm24_addon: { easy: 2, medium: 6, hard: 4 },
};

export const REPO_MAX: Record<string, number> = {
  smoke6: 1,
  core12: 2,
  confirm24: 2,
};

export const TYPE_FLOOR: Record<string, number> = {
  bug: 3,
  feature: 3,
  refactor: 2,
  infra: 2,
};

function diversityGain(inst: Instance, selected: Instance[]): number {
  const dims: Array<keyof Instance> = [
    'language_family',
    'task_type',
    'repo',
    'knowledge_domain',
  ];
  let fresh = 0;
  for (const dim of dims) {
    const covered = new Set(selected.map((s) => String(s[dim])));
    if (!covered.has(String(inst[dim]))) fresh += 1;
  }
  return fresh / dims.length;
}

function selectBand(
  candidates: Instance[],
  band: string,
  selected: Instance[],
  repoCount: Record<string, number>,
  repoMax: number,
  typeNeeds: Record<string, number>,
): { inst: Instance | null; relaxations: string[] } {
  const relaxations: string[] = [];
  const pool = candidates.filter((c) => difficulty.difficultyBand(c) === band);

  function eligible(c: Instance, relaxRepo: boolean): boolean {
    if ((repoCount[c.repo] ?? 0) >= repoMax && !relaxRepo) return false;
    return true;
  }

  function score(c: Instance): number {
    const bandP = difficulty.bandPassProb(band);
    const typeBonus = (typeNeeds[c.task_type] ?? 0) > 0 ? 0.15 : 0.0;
    return difficulty.infoScore(c, bandP, diversityGain(c, selected)) + typeBonus;
  }

  for (const relaxRepo of [false, true]) {
    const avail = pool.filter((c) => eligible(c, relaxRepo));
    if (relaxRepo && avail.length > 0) {
      relaxations.push(`${band}: 仓库上限约束放宽(候选不足)`);
    }
    if (avail.length > 0) {
      let best = avail[0]!;
      for (const c of avail) {
        const sc = score(c);
        const bestSc = score(best);
        if (sc > bestSc || (sc === bestSc && c.instance_id > best.instance_id)) {
          best = c;
        }
      }
      return { inst: best, relaxations };
    }
  }
  return { inst: null, relaxations };
}

function fillQuotas(
  candidates: Instance[],
  quotas: Record<string, number>,
  selected: Instance[],
  repoCount: Record<string, number>,
  repoMax: number,
  baseSelected: Instance[] = [],
  baseRepoCount: Record<string, number> = {},
): string[] {
  const relaxations: string[] = [];
  const takenIds = new Set(selected.map((i) => i.instance_id));

  function pickBand(band: string): Instance | null {
    const typeNeeds: Record<string, number> = { ...TYPE_FLOOR };
    for (const i of selected) {
      if (typeNeeds[i.task_type] != null && typeNeeds[i.task_type] > 0) {
        typeNeeds[i.task_type] -= 1;
      }
    }
    const { inst, relaxations: rel } = selectBand(
      candidates.filter((c) => !takenIds.has(c.instance_id)),
      band,
      [...baseSelected, ...selected],
      { ...baseRepoCount, ...repoCount },
      repoMax,
      typeNeeds,
    );
    relaxations.push(...rel);
    return inst;
  }

  const remaining: Record<string, number> = { ...quotas };
  const driftOrder: Record<string, string[]> = {
    easy: ['medium'],
    medium: ['easy', 'hard'],
    hard: ['medium'],
  };

  while (Object.values(remaining).some((v) => v > 0)) {
    const bands = Object.keys(remaining).filter((b) => remaining[b]! > 0);
    let band = bands[0]!;
    for (const b of bands) {
      if (
        remaining[b]! > remaining[band]! ||
        (remaining[b]! === remaining[band]! && b > band)
      ) {
        band = b;
      }
    }

    let inst = pickBand(band);
    if (inst == null) {
      for (const alt of driftOrder[band] ?? []) {
        if ((remaining[alt] ?? 0) > 0) continue;
        inst = pickBand(alt);
        if (inst != null) {
          relaxations.push(
            `${band} 候选池耗尽,由相邻带 ${alt} 漂移补位(${inst.instance_id})`,
          );
          break;
        }
      }
      if (inst == null) {
        relaxations.push(
          `${band} 带配额缺口 ${remaining[band]} 无法满足(候选池不足)`,
        );
        remaining[band] = 0;
        continue;
      }
    }
    selected.push(inst);
    takenIds.add(inst.instance_id);
    repoCount[inst.repo] = (repoCount[inst.repo] ?? 0) + 1;
    remaining[band]! -= 1;
  }
  return relaxations;
}

export interface FixedSuiteDefinition {
  suite_id: string;
  name: string;
  level: SuiteLevel;
  description?: string;
  instance_ids: string[];
}

export function loadFixedSuiteDefinitions(): FixedSuiteDefinition[] {
  const raw = JSON.parse(fs.readFileSync(FIXED_SUITES_PATH, 'utf-8')) as {
    suites?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(raw.suites)) {
    throw new Error(`fixed_suites.json must contain a "suites" array`);
  }
  return raw.suites.map((s) => ({
    suite_id: String(s.suite_id ?? ''),
    name: String(s.name ?? s.suite_id ?? ''),
    level: String(s.level ?? 'smoke6') as SuiteLevel,
    description: s.description ? String(s.description) : '',
    instance_ids: Array.isArray(s.instance_ids) ? s.instance_ids.map(String) : [],
  }));
}

function fixedSuiteMetaVersion(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(FIXED_SUITES_PATH, 'utf-8')) as {
      _meta?: { version?: string };
    };
    return String(raw._meta?.version ?? 'official-v1');
  } catch {
    return 'official-v1';
  }
}

export function listFixedSuites(): Array<Record<string, unknown>> {
  const version = fixedSuiteMetaVersion();
  return loadFixedSuiteDefinitions().map((d) => ({
    suite_id: d.suite_id,
    name: d.name,
    level: d.level,
    description: d.description,
    instance_count: d.instance_ids.length,
    created_at: 'fixed',
    dataset_revision: version,
    evaluator_revision: 'official-docker-test-runner-v1',
  }));
}

export function getFixedSuite(suiteId: string): SuiteManifest {
  const def = loadFixedSuiteDefinitions().find((d) => d.suite_id === suiteId);
  if (!def) throw new Error(`fixed suite not found: ${suiteId}`);
  return generateSuite(def.level, 0);
}

export function generateSuite(
  level: SuiteLevel,
  _seed?: number | null,
): SuiteManifest {
  const instances = loadSuiteInstances();
  const byId = new Map(instances.map((i) => [i.instance_id, i]));
  const defs = loadFixedSuiteDefinitions();
  const def = defs.find((d) => d.level === level);
  if (!def) {
    throw new Error(`未找到固定套件定义: ${level};请在 src/data/fixed_suites.json 中维护`);
  }

  const chosen: Instance[] = [];
  for (const id of def.instance_ids) {
    const inst = byId.get(id);
    if (!inst) {
      throw new Error(`固定套件 ${def.suite_id} 引用了不存在的实例: ${id}`);
    }
    chosen.push(inst);
  }

  const annotated = new Map(
    difficulty.annotate(chosen).map((r) => [r.instance_id as string, r]),
  );
  const quotas: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
  for (const i of chosen) {
    const band = difficulty.difficultyBand(i);
    quotas[band] = (quotas[band] || 0) + 1;
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const meta = OFFICIAL_META as Record<string, unknown>;
  const manifest: SuiteManifest = {
    suite_id: def.suite_id,
    suite_version: `sbp-fixed-${def.suite_id}`,
    level,
    seed: 0,
    dataset_revision: String(meta.version ?? 'official-v1'),
    evaluator_revision: 'official-docker-test-runner-v1',
    scaffold_revision: 'agent-scaffold-v1',
    created_at: now,
    quotas: { primary: quotas },
    relaxations: ['固定套件：不随机抽样，题目由 src/data/fixed_suites.json 固定'],
    instances: chosen.map((i) => {
      const row = annotated.get(i.instance_id)!;
      return {
        ...row,
        problem_statement: i.problem_statement,
        requirements: i.requirements,
        interface: i.interface,
        fail_to_pass: i.fail_to_pass,
        pass_to_pass: i.pass_to_pass,
        // 评测必需字段：没有 test_patch 则 F2P 测试无从注入，仓库/安装信息缺失会导致评测跑错目录
        base_commit: i.base_commit,
        repo_directory: i.repo_directory,
        install: i.install,
        test_cmd: i.test_cmd,
        test_patch: i.test_patch,
      };
    }),
  };
  return manifest;
}
