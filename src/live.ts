interface LiveTurn {
  label: string;
  reasoning: string;
  content: string;
  tool: string;
}

interface LiveEntry {
  run_id: string;
  instance_id: string;
  provider_role: string;
  run_index: number;
  model: string;
  phase: string;
  status: 'streaming' | 'done';
  turns: LiveTurn[];
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
    turns: [],
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

/** 开始新的一轮(一次模型调用)，后续 appendText/writeText 均落入该轮 */
export function beginTurn(key: string, label = ''): number {
  const entry = LIVE.get(key);
  if (!entry) return -1;
  entry.turns.push({ label, reasoning: '', content: '', tool: '' });
  entry.updated_at = now();
  return entry.turns.length - 1;
}

function currentTurn(entry: LiveEntry): LiveTurn {
  if (!entry.turns.length) entry.turns.push({ label: '', reasoning: '', content: '', tool: '' });
  return entry.turns[entry.turns.length - 1];
}

export function appendText(
  key: string,
  kind: 'reasoning' | 'content' | 'tool',
  piece: string,
): void {
  const entry = LIVE.get(key);
  if (!entry || (kind !== 'reasoning' && kind !== 'content' && kind !== 'tool')) return;
  currentTurn(entry)[kind] += piece;
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

function reasoningChars(entry: LiveEntry): number {
  return entry.turns.reduce((n, t) => n + t.reasoning.length, 0);
}

function contentChars(entry: LiveEntry): number {
  return entry.turns.reduce((n, t) => n + t.content.length, 0);
}

function meta(entry: LiveEntry): Record<string, unknown> {
  return {
    instance_id: entry.instance_id,
    provider_role: entry.provider_role,
    run_index: entry.run_index,
    model: entry.model,
    phase: entry.phase,
    status: entry.status,
    turns_total: entry.turns.length,
    reasoning_chars: reasoningChars(entry),
    content_chars: contentChars(entry),
    tool_chars: entry.turns.reduce((n, t) => n + t.tool.length, 0),
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

/**
 * 按轮次的增量拉取。
 * 客户端上报当前所在轮 turn 及该轮内的 r/c 偏移；
 * 返回 turns 中从该轮起的所有增量/全文，客户端据此追加或新建轮次块，
 * 并用 r_offset/c_offset(最后一轮的长度)更新游标。
 */
export function getDetail(
  runId: string,
  instanceId: string,
  role: string,
  runIndex: number,
  turn = 0,
  rOffset = 0,
  cOffset = 0,
  tOffset = 0,
): Record<string, unknown> | null {
  const key = keyFor(runId, instanceId, role, runIndex);
  const entry = LIVE.get(key);
  if (!entry) return null;
  const last = entry.turns.length - 1;
  const t = Math.min(Math.max(turn, 0), Math.max(last, 0));
  const parts: Array<Record<string, unknown>> = [];
  if (entry.turns.length) {
    for (let i = t; i <= last; i++) {
      const tk = entry.turns[i];
      parts.push({
        turn: i,
        label: tk.label,
        reasoning: i === t ? sliceFrom(tk.reasoning, rOffset) : tk.reasoning,
        content: i === t ? sliceFrom(tk.content, cOffset) : tk.content,
        tool: i === t ? sliceFrom(tk.tool, tOffset) : tk.tool,
      });
    }
  }
  const finalTurn = entry.turns[last];
  return {
    ...meta(entry),
    // 客户端下一次轮询应使用的轮次游标(最新一轮)
    turn: Math.max(last, 0),
    parts,
    r_offset: finalTurn ? finalTurn.reasoning.length : 0,
    c_offset: finalTurn ? finalTurn.content.length : 0,
    t_offset: finalTurn ? finalTurn.tool.length : 0,
  };
}

function sliceFrom(text: string, offset: number): string {
  return offset >= 0 && offset <= text.length ? text.slice(offset) : '';
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
