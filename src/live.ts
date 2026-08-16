interface LiveEntry {
  run_id: string;
  instance_id: string;
  provider_role: string;
  run_index: number;
  model: string;
  phase: string;
  status: 'streaming' | 'done';
  reasoning: string;
  content: string;
  started_at: string;
  updated_at: string;
  finish_reason: string | null;
  errors: string[];
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  decode_tps: number | null;
  elapsed_s: number;
  price_input_per_m: number;
  price_cached_per_m: number;
  price_output_per_m: number;
}

export interface LivePrices {
  price_input_per_m: number;
  price_cached_per_m: number;
  price_output_per_m: number;
}

const LIVE = new Map<string, LiveEntry>();

function now(): string {
  return new Date().toISOString();
}

function keyFor(
  runId: string,
  instanceId: string,
  role: string,
  runIndex: number,
): string {
  return `${runId}::${instanceId}::${role}::r${runIndex}`;
}

export function register(
  runId: string,
  instanceId: string,
  role: string,
  runIndex: number,
  model: string,
  phase: string,
  prices: LivePrices = {
    price_input_per_m: 0,
    price_cached_per_m: 0,
    price_output_per_m: 0,
  },
): string {
  const key = keyFor(runId, instanceId, role, runIndex);
  LIVE.set(key, {
    run_id: runId,
    instance_id: instanceId,
    provider_role: role,
    run_index: runIndex,
    model,
    phase,
    status: 'streaming',
    reasoning: '',
    content: '',
    started_at: now(),
    updated_at: now(),
    finish_reason: null,
    errors: [],
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    cost_usd: 0,
    decode_tps: null,
    elapsed_s: 0,
    price_input_per_m: prices.price_input_per_m || 0,
    price_cached_per_m: prices.price_cached_per_m || 0,
    price_output_per_m: prices.price_output_per_m || 0,
  });
  return key;
}

export function appendText(key: string, kind: 'reasoning' | 'content', piece: string): void {
  const entry = LIVE.get(key);
  if (!entry || (kind !== 'reasoning' && kind !== 'content')) return;
  entry[kind] += piece;
  entry.updated_at = now();
}

export interface LiveUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
}

export function updateUsage(
  key: string,
  usage: Partial<LiveUsage>,
  extra: { decode_tps?: number | null; elapsed_s?: number | null } = {},
): void {
  const entry = LIVE.get(key);
  if (!entry) return;
  if (usage.prompt_tokens != null) entry.prompt_tokens = usage.prompt_tokens;
  if (usage.completion_tokens != null) entry.completion_tokens = usage.completion_tokens;
  if (usage.cached_tokens != null) entry.cached_tokens = usage.cached_tokens;
  if ('decode_tps' in extra) entry.decode_tps = extra.decode_tps ?? null;
  if ('elapsed_s' in extra) entry.elapsed_s = extra.elapsed_s ?? 0;

  const uncached = Math.max(0, entry.prompt_tokens - entry.cached_tokens);
  entry.cost_usd =
    (uncached / 1e6) * entry.price_input_per_m +
    (entry.cached_tokens / 1e6) * entry.price_cached_per_m +
    (entry.completion_tokens / 1e6) * entry.price_output_per_m;
  entry.updated_at = now();
}

export function finish(
  key: string,
  finishReason?: string | null,
  errors?: string[],
): void {
  const entry = LIVE.get(key);
  if (!entry) return;
  entry.status = 'done';
  entry.finish_reason = finishReason ?? null;
  if (errors && errors.length) entry.errors = [...errors];
  entry.updated_at = now();
}

function meta(entry: LiveEntry): Record<string, unknown> {
  return {
    instance_id: entry.instance_id,
    provider_role: entry.provider_role,
    run_index: entry.run_index,
    model: entry.model,
    phase: entry.phase,
    status: entry.status,
    reasoning_chars: entry.reasoning.length,
    content_chars: entry.content.length,
    started_at: entry.started_at,
    updated_at: entry.updated_at,
    finish_reason: entry.finish_reason,
    prompt_tokens: entry.prompt_tokens,
    completion_tokens: entry.completion_tokens,
    cached_tokens: entry.cached_tokens,
    cost_usd: Math.round(entry.cost_usd * 1000000) / 1000000,
    decode_tps: entry.decode_tps != null ? Math.round(entry.decode_tps * 10) / 10 : null,
    elapsed_s: Math.round(entry.elapsed_s * 100) / 100,
  };
}

export function listEntries(runId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const entry of LIVE.values()) {
    if (entry.run_id === runId) out.push(meta(entry));
  }
  return out;
}

export function getDetail(
  runId: string,
  instanceId: string,
  role: string,
  runIndex: number,
  rOffset = 0,
  cOffset = 0,
): Record<string, unknown> | null {
  const key = keyFor(runId, instanceId, role, runIndex);
  const entry = LIVE.get(key);
  if (!entry) return null;
  return {
    ...meta(entry),
    r_offset: entry.reasoning.length,
    c_offset: entry.content.length,
    reasoning_part:
      rOffset >= 0 && rOffset <= entry.reasoning.length
        ? entry.reasoning.slice(rOffset)
        : '',
    content_part:
      cOffset >= 0 && cOffset <= entry.content.length
        ? entry.content.slice(cOffset)
        : '',
  };
}

export function summarizeRun(runId: string): Record<string, unknown> {
  let prompt_tokens = 0;
  let completion_tokens = 0;
  let cached_tokens = 0;
  let cost_usd = 0;
  let streaming = 0;
  let total_elapsed_s = 0;
  const decodeTpsValues: number[] = [];
  for (const entry of LIVE.values()) {
    if (entry.run_id !== runId) continue;
    prompt_tokens += entry.prompt_tokens;
    completion_tokens += entry.completion_tokens;
    cached_tokens += entry.cached_tokens;
    cost_usd += entry.cost_usd;
    total_elapsed_s += entry.elapsed_s;
    if (entry.status === 'streaming') streaming += 1;
    if (entry.decode_tps != null) decodeTpsValues.push(entry.decode_tps);
  }
  const avg_decode_tps = decodeTpsValues.length
    ? Math.round((decodeTpsValues.reduce((a, b) => a + b, 0) / decodeTpsValues.length) * 10) / 10
    : null;
  const overall_tps =
    completion_tokens > 0 && total_elapsed_s > 0
      ? Math.round((completion_tokens / total_elapsed_s) * 10) / 10
      : null;
  const cache_hit_rate =
    prompt_tokens > 0
      ? Math.min(100, Math.round((cached_tokens / prompt_tokens) * 1000) / 10)
      : 0;
  return {
    prompt_tokens,
    completion_tokens,
    cached_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    cost_usd: Math.round(cost_usd * 1000000) / 1000000,
    streaming_count: streaming,
    avg_decode_tps,
    overall_tps,
    total_elapsed_s: Math.round(total_elapsed_s * 100) / 100,
    cache_hit_rate,
  };
}

export function dropRun(runId: string): void {
  for (const [key, entry] of LIVE.entries()) {
    if (entry.run_id === runId) LIVE.delete(key);
  }
}
