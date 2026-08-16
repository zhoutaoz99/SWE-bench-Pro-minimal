import { z } from 'zod';

// ---------- Literal types ----------

export type LanguageFamily = 'python' | 'go' | 'javascript' | 'typescript';
export type TaskType = 'bug' | 'feature' | 'refactor' | 'infra';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type SuiteLevel = 'smoke6' | 'core12' | 'confirm24';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'retesting'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'cancelled';

// ---------- Provider Routing ----------

export interface ProviderRouting {
  order: string[];
  only: string[];
  ignore: string[];
  allow_fallbacks: boolean | null;
  quantizations: string[];
  sort: 'price' | 'throughput' | null;
  require_parameters: boolean | null;
  data_policy: 'deny' | 'flexible' | null;
}

export const providerRoutingSchema = z.object({
  order: z.array(z.string()).default([]),
  only: z.array(z.string()).default([]),
  ignore: z.array(z.string()).default([]),
  allow_fallbacks: z.boolean().nullable().default(null),
  quantizations: z.array(z.string()).default([]),
  sort: z.enum(['price', 'throughput']).nullable().default(null),
  require_parameters: z.boolean().nullable().default(null),
  data_policy: z.enum(['deny', 'flexible']).nullable().default(null),
});

export function providerRoutingIsEmpty(r: ProviderRouting | null | undefined): boolean {
  if (!r) return true;
  return !(
    r.order.length ||
    r.only.length ||
    r.ignore.length ||
    r.quantizations.length ||
    r.allow_fallbacks != null ||
    r.sort != null ||
    r.require_parameters != null ||
    r.data_policy != null
  );
}

export function providerRoutingToRequestDict(r: ProviderRouting | null | undefined): Record<string, unknown> {
  if (!r || providerRoutingIsEmpty(r)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ['order', 'only', 'ignore', 'quantizations'] as const) {
    const value = r[key];
    if (value && value.length) out[key] = value;
  }
  for (const key of ['allow_fallbacks', 'sort', 'require_parameters', 'data_policy'] as const) {
    const value = r[key];
    if (value != null) out[key] = value;
  }
  return out;
}

// ---------- Provider Config ----------

export interface ProviderConfig {
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  role: 'baseline' | 'candidate';
  temperature: number;
  top_p: number;
  max_tokens: number;
  reasoning_effort: string | null;
  price_input_per_m: number;
  price_cached_per_m: number;
  price_output_per_m: number;
  auto_append_v1: boolean;
  provider: ProviderRouting | null;
}

export const providerConfigSchema = z.object({
  name: z.string().default('Provider'),
  base_url: z.string().default(''),
  model: z.string().default(''),
  api_key: z.string().default(''),
  role: z.enum(['baseline', 'candidate']).default('baseline'),
  temperature: z.number().default(1.0),
  top_p: z.number().default(0.95),
  max_tokens: z.number().int().default(32768),
  reasoning_effort: z.string().nullable().default('max'),
  price_input_per_m: z.number().default(0.0),
  price_cached_per_m: z.number().default(0.0),
  price_output_per_m: z.number().default(0.0),
  auto_append_v1: z.boolean().default(true),
  provider: providerRoutingSchema.nullable().optional().default(null),
});

// ---------- Instance ----------

export interface Instance {
  instance_id: string;
  repo: string;
  language_family: string;
  task_type: string;
  knowledge_domain: string;
  problem_statement: string;
  requirements: string;
  interface: string;
  fail_to_pass: string[];
  pass_to_pass: string[];
  gold_files_changed: number;
  gold_loc_changed: number;
  base_commit: string;
  docker_image: string;
  p_hist: number | null;
  runtime_class: string;
}

export function toInstance(d: Record<string, unknown>): Instance {
  return {
    instance_id: String(d.instance_id ?? ''),
    repo: String(d.repo ?? ''),
    language_family: String(d.language_family ?? ''),
    task_type: String(d.task_type ?? ''),
    knowledge_domain: String(d.knowledge_domain ?? ''),
    problem_statement: String(d.problem_statement ?? ''),
    requirements: String(d.requirements ?? ''),
    interface: String(d.interface ?? ''),
    fail_to_pass: Array.isArray(d.fail_to_pass) ? d.fail_to_pass.map(String) : [],
    pass_to_pass: Array.isArray(d.pass_to_pass) ? d.pass_to_pass.map(String) : [],
    gold_files_changed: Number(d.gold_files_changed ?? 0),
    gold_loc_changed: Number(d.gold_loc_changed ?? 0),
    base_commit: String(d.base_commit ?? ''),
    docker_image: String(d.docker_image ?? ''),
    p_hist: d.p_hist == null ? null : Number(d.p_hist),
    runtime_class: String(d.runtime_class ?? 'medium'),
  };
}

// ---------- Suite Manifest ----------

export interface SuiteManifest {
  suite_id: string;
  suite_version: string;
  level: SuiteLevel;
  seed: number;
  dataset_revision: string;
  evaluator_revision: string;
  scaffold_revision: string;
  created_at: string;
  quotas: Record<string, Record<string, number>>;
  relaxations: string[];
  instances: Array<Record<string, unknown>>;
}

export const suiteManifestSchema = z.object({
  suite_id: z.string(),
  suite_version: z.string(),
  level: z.enum(['smoke6', 'core12', 'confirm24']),
  seed: z.number(),
  dataset_revision: z.string(),
  evaluator_revision: z.string(),
  scaffold_revision: z.string(),
  created_at: z.string(),
  quotas: z.record(z.record(z.number())).default({}),
  relaxations: z.array(z.string()).default([]),
  instances: z.array(z.record(z.unknown())).default([]),
});

// ---------- Run Request ----------

export interface RunRequest {
  provider_a: ProviderConfig | null;
  provider_b: ProviderConfig | null;
  baseline_run_id: string | null;
  suite_level: SuiteLevel;
  suite_seed: number;
  suite_id: string | null;
  repeat_disagreements: number;
  scaffold: 'agent' | 'single-turn';
  turn_limit: number;
}

export const runRequestSchema = z.object({
  provider_a: providerConfigSchema.nullable().optional().default(null),
  provider_b: providerConfigSchema.nullable().optional().default(null),
  baseline_run_id: z.string().nullable().optional().default(null),
  suite_level: z.enum(['smoke6', 'core12', 'confirm24']).default('smoke6'),
  suite_seed: z.number().int().default(20260816),
  suite_id: z.string().nullable().optional().default(null),
  repeat_disagreements: z.number().int().default(2),
  scaffold: z.enum(['agent', 'single-turn']).default('agent'),
  turn_limit: z.number().int().default(200),
});

// ---------- Usage / Run Record ----------

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
}

export interface RunRecord {
  run_index: number;
  phase: 'S1' | 'S2';
  instance_id: string;
  provider_role: string;
  provider_name: string;
  model: string;
  status: 'ok' | 'error';
  resolved: boolean | null;
  f2p_passed: number;
  f2p_total: number;
  p2p_passed: number;
  p2p_total: number;
  usage: UsageInfo;
  ttft_s: number | null;
  wall_s: number;
  decode_tps: number | null;
  finish_reason: string | null;
  truncated: boolean;
  tool_errors: number;
  errors: string[];
  cost_usd: number;
  eval_method: string;
  patch_excerpt: string;
  started_at: string;
  ended_at: string;
  turns_used: number;
  tool_calls: number;
}

// ---------- HTTP body schemas ----------

export const generateSuiteBodySchema = z.object({
  level: z.enum(['smoke6', 'core12', 'confirm24']).default('smoke6'),
  seed: z.number().int().default(20260816),
});

export const saveProfileBodySchema = z.object({
  name: z.string(),
  config: providerConfigSchema,
});

export const testProviderBodySchema = z.object({
  provider: providerConfigSchema,
});

export const artifactQuerySchema = z.object({
  name: z.string(),
});

export const liveDetailQuerySchema = z.object({
  instance_id: z.string(),
  role: z.string(),
  run_index: z.coerce.number().int().default(0),
  r_offset: z.coerce.number().int().default(0),
  c_offset: z.coerce.number().int().default(0),
});
