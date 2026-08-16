import crypto from 'node:crypto';
import { loadSeedInstances, SEED_META } from './dataset';
import * as difficulty from './difficulty';
import { Instance, SuiteLevel, SuiteManifest } from './schemas';

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

export function generateSuite(level: SuiteLevel, seed?: number | null): SuiteManifest {
  const instances = loadSeedInstances();
  const finalSeed = seed != null ? seed : crypto.randomInt(0, 10_000);
  const annotated = new Map(
    difficulty.annotate(instances).map((r) => [r.instance_id as string, r]),
  );

  let chosen: Instance[] = [];
  let repoCount: Record<string, number> = {};
  let relax: string[] = [];

  if (level === 'smoke6') {
    const selected: Instance[] = [];
    repoCount = {};
    relax = fillQuotas(
      instances,
      QUOTAS.smoke6!,
      selected,
      repoCount,
      REPO_MAX.smoke6!,
    );
    chosen = selected;
  } else {
    const core: Instance[] = [];
    repoCount = {};
    relax = fillQuotas(
      instances,
      QUOTAS.core12!,
      core,
      repoCount,
      REPO_MAX.core12!,
    );
    chosen = core;
    if (level === 'confirm24') {
      const addon: Instance[] = [];
      const baseRepoCount: Record<string, number> = {};
      for (const r of new Set(core.map((i) => i.repo))) {
        baseRepoCount[r] = repoCount[r] ?? 0;
      }
      relax.push(
        ...fillQuotas(
          instances,
          QUOTAS.confirm24_addon!,
          addon,
          repoCount,
          REPO_MAX.confirm24!,
          core,
          baseRepoCount,
        ),
      );
      chosen = [...core, ...addon];
    }
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  const version = `sbp-mini-${y}.${m}-${level}-s${finalSeed}`;
  const manifest: SuiteManifest = {
    suite_id: `suite-${level}-s${finalSeed}`,
    suite_version: version,
    level,
    seed: finalSeed,
    dataset_revision: String((SEED_META as Record<string, unknown>).version ?? 'seed-demo-v1'),
    evaluator_revision: 'builtin-mock/heuristic-v1',
    scaffold_revision: 'single-turn-patch-scaffold-v1',
    created_at: now,
    quotas: {
      primary: QUOTAS[level === 'smoke6' ? 'smoke6' : 'core12']!,
      ...(level === 'confirm24' ? { addon: QUOTAS.confirm24_addon! } : {}),
    },
    relaxations: relax,
    instances: chosen.map((i) => {
      const row = annotated.get(i.instance_id)!;
      return {
        ...row,
        problem_statement: i.problem_statement,
        requirements: i.requirements,
        interface: i.interface,
        fail_to_pass: i.fail_to_pass,
        pass_to_pass: i.pass_to_pass,
      };
    }),
  };
  return manifest;
}
