import { Instance } from './schemas';

const SPEC_NORM_MAX = 8000.0;

export const RUNTIME_EFFICIENCY: Record<string, number> = {
  fast: 1.0,
  medium: 0.6,
  slow: 0.3,
};

function clamp(x: number, lo = 0.0, hi = 1.0): number {
  return Math.max(lo, Math.min(hi, x));
}

export function dStruct(inst: Instance): number {
  const f = clamp(Math.log2(1 + inst.gold_files_changed) / Math.log2(11));
  const l = clamp(Math.log10(1 + inst.gold_loc_changed) / Math.log10(501));
  const t = clamp(Math.log2(1 + inst.fail_to_pass.length) / Math.log2(33));
  const specLen =
    inst.problem_statement.length + inst.requirements.length + inst.interface.length;
  const s = clamp(specLen / SPEC_NORM_MAX);
  return round4(0.4 * f + 0.35 * l + 0.15 * t + 0.1 * s);
}

export function dEmp(inst: Instance): number | null {
  if (inst.p_hist == null) return null;
  return round4(1.0 - inst.p_hist);
}

export function dTotal(inst: Instance, struct?: number | null): number {
  const ds = struct != null ? struct : dStruct(inst);
  const de = dEmp(inst);
  if (de == null) return round4(ds);
  return round4(0.6 * de + 0.4 * ds);
}

export function difficultyBand(
  inst: Instance,
  total?: number | null,
  quantiles?: { q33: number; q75: number } | null,
): string {
  if (inst.p_hist != null) {
    if (inst.p_hist >= 0.7) return 'easy';
    if (inst.p_hist >= 0.3) return 'medium';
    return 'hard';
  }
  const value = total != null ? total : dTotal(inst);
  if (quantiles) {
    if (value <= quantiles.q33) return 'easy';
    if (value <= quantiles.q75) return 'medium';
    return 'hard';
  }
  return 'medium';
}

export function poolQuantiles(instances: Instance[]): { q33: number; q75: number } {
  const values = instances.map((i) => dTotal(i)).sort((a, b) => a - b);
  if (values.length === 0) return { q33: 0.0, q75: 0.0 };

  function pct(p: number): number {
    const idx = Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))));
    return values[idx]!;
  }

  return { q33: pct(1 / 3), q75: pct(0.75) };
}

export function infoScore(
  inst: Instance,
  bandP: number,
  diversityGain = 0.0,
): number {
  const p = inst.p_hist != null ? inst.p_hist : bandP;
  const disc = 4.0 * p * (1.0 - p);
  const rt = RUNTIME_EFFICIENCY[inst.runtime_class] ?? 0.6;
  return round4(0.45 * disc + 0.25 * diversityGain + 0.2 * dStruct(inst) + 0.1 * rt);
}

export function bandPassProb(band: string): number {
  return { easy: 0.74, medium: 0.5, hard: 0.24 }[band] ?? 0.5;
}

export function annotate(instances: Instance[]): Array<Record<string, unknown>> {
  const quantiles = poolQuantiles(instances);
  const rows: Array<Record<string, unknown>> = [];
  for (const inst of instances) {
    const ds = dStruct(inst);
    const dt = dTotal(inst, ds);
    const band = difficultyBand(inst, dt, quantiles);
    rows.push({
      instance_id: inst.instance_id,
      repo: inst.repo,
      language_family: inst.language_family,
      task_type: inst.task_type,
      knowledge_domain: inst.knowledge_domain,
      difficulty: band,
      d_struct: ds,
      d_emp: dEmp(inst),
      d_total: dt,
      p_hist: inst.p_hist,
      files_changed: inst.gold_files_changed,
      loc_changed: inst.gold_loc_changed,
      fail_to_pass_count: inst.fail_to_pass.length,
      runtime_class: inst.runtime_class,
      docker_image: inst.docker_image,
    });
  }
  return rows;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
