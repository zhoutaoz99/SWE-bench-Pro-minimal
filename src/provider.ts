import { Instance, ProviderConfig, providerRoutingToRequestDict } from './schemas';

export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
export const MAX_RETRIES = 2;
export const REQUEST_TIMEOUT = 300.0;

export interface CompletionResult {
  text: string;
  reasoning: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  ttft_s: number | null;
  wall_s: number;
  decode_tps: number | null;
  finish_reason: string | null;
  errors: string[];
  ok: boolean;
  tool_calls: Array<{ id: string; name: string; arguments: string }>;
  assistant_message: Record<string, unknown> | null;
}

export function createCompletionResult(): CompletionResult {
  return {
    text: '',
    reasoning: '',
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    ttft_s: null,
    wall_s: 0,
    decode_tps: null,
    finish_reason: null,
    errors: [],
    ok: true,
    tool_calls: [],
    assistant_message: null,
  };
}

export function normalizeBaseUrl(baseUrl: string, autoAppendV1 = true): string {
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (!autoAppendV1) return url;
  if (
    url.endsWith('/v1') ||
    url.endsWith('/v2') ||
    url.includes('/v1/') ||
    url.includes('/compatible-mode')
  ) {
    return url;
  }
  return url + '/v1';
}

export function buildPrompt(inst: Instance): { system: string; user: string } {
  const system =
    'You are an expert software engineer working on a real repository. ' +
    'Solve the task and output ONLY a unified diff patch (git diff format) ' +
    'that resolves the problem statement.';
  const user = `## Problem Statement
${inst.problem_statement}

## Requirements
${inst.requirements || '(none)'}

## Interface
${inst.interface || '(none)'}

## Output Format
Output a single unified diff patch. Do not include explanations outside the diff.`;
  return { system, user };
}

export type DeltaKind = 'reasoning' | 'content';
export type OnDelta = (kind: DeltaKind, piece: string) => void;

export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  decode_tps: number | null;
  elapsed_s: number;
}

export type OnStats = (usage: StreamUsage) => void;

function createFetchSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup(): void } {
  if (typeof AbortSignal.any === 'function') {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return {
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      cleanup: () => undefined,
    };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(onAbort, timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export class LiveProvider {
  private readonly config: ProviderConfig;
  private readonly endpoint: string;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.endpoint = normalizeBaseUrl(config.base_url, config.auto_append_v1) + '/chat/completions';
  }

  async complete(
    system: string,
    user: string,
    opts: { retries?: number; timeout?: number; onDelta?: OnDelta; onStats?: OnStats; signal?: AbortSignal } = {},
  ): Promise<CompletionResult> {
    const body = this.buildBody({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const result = createCompletionResult();
    await this.doStream(body, result, opts);
    return result;
  }

  async agentStep(
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>>,
    opts: { retries?: number; timeout?: number; onDelta?: OnDelta; onStats?: OnStats; signal?: AbortSignal } = {},
  ): Promise<CompletionResult> {
    const body = this.buildBody({ messages, tools, tool_choice: 'auto' });
    const result = createCompletionResult();
    await this.doStream(body, result, opts);
    const calls = result.tool_calls.map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      arguments: c.arguments,
    }));
    result.tool_calls = calls;
    const msg: Record<string, unknown> = { role: 'assistant', content: result.text || '' };
    if (calls.length > 0) {
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
      msg.content = result.text;
    }
    result.assistant_message = msg;
    return result;
  }

  private buildBody(extra: Record<string, unknown>): Record<string, unknown> {
    const cfg = this.config;
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: extra.messages,
      temperature: cfg.temperature,
      top_p: cfg.top_p,
      max_tokens: cfg.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (extra.tools) body.tools = extra.tools;
    if (extra.tool_choice) body.tool_choice = extra.tool_choice;
    if (cfg.reasoning_effort) body.reasoning_effort = cfg.reasoning_effort;
    if (cfg.provider) {
      const routing = providerRoutingToRequestDict(cfg.provider);
      if (Object.keys(routing).length > 0) body.provider = routing;
    }
    return body;
  }

  private async doStream(
    body: Record<string, unknown>,
    result: CompletionResult,
    opts: { retries?: number; timeout?: number; onDelta?: OnDelta; onStats?: OnStats; signal?: AbortSignal },
  ): Promise<void> {
    const retries = opts.retries ?? MAX_RETRIES;
    const timeout = opts.timeout ?? REQUEST_TIMEOUT;
    const onDelta = opts.onDelta;
    const onStats = opts.onStats;
    const signal = opts.signal;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.api_key) headers['Authorization'] = `Bearer ${this.config.api_key}`;

    const start = performance.now();
    const chunks: string[] = [];
    const reasoningChunks: string[] = [];
    let contentChars = 0;
    let reasoningChars = 0;
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: Record<string, unknown> = {};
    let finishReason: string | null = null;
    let firstTokenAt: number | null = null;
    let lastStatsAt = 0;
    const promptProbe = ((body.messages as Array<Record<string, unknown>>) || [])
      .map((m) => String(m.content ?? ''))
      .join('');

    const emitStats = (force = false): void => {
      if (!onStats) return;
      const nowPerf = performance.now();
      if (!force && nowPerf - lastStatsAt < 100) return;
      lastStatsAt = nowPerf;
      const wall = (nowPerf - start) / 1000;
      const ttft = firstTokenAt != null ? (firstTokenAt - start) / 1000 : null;
      const promptTokens = Number(usage.prompt_tokens) || estimateTokens(promptProbe);
      const completionTokens =
        Number(usage.completion_tokens) || estimateTokens(contentChars + reasoningChars);
      const details = (usage.prompt_tokens_details as Record<string, unknown>) || {};
      const cachedTokens = Number(details.cached_tokens) || 0;
      onStats({
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cached_tokens: cachedTokens,
        decode_tps:
          completionTokens > 0 && ttft != null && wall > ttft
            ? completionTokens / (wall - ttft)
            : null,
        elapsed_s: wall,
      });
    };

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const merged = createFetchSignal(signal, timeout * 1000);
        try {
          const response = await fetch(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: merged.signal,
          });

          if (RETRYABLE_STATUS.has(response.status)) {
            throw new HttpStatusError(`HTTP ${response.status}`, response.status);
          }
          if (response.status >= 400) {
            const detail = (await response.text()).slice(0, 400);
            result.ok = false;
            result.errors.push(`HTTP ${response.status}: ${detail}`);
            return;
          }
          if (!response.body) {
            result.ok = false;
            result.errors.push('HTTP response has no body');
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          let doneFlag = false;

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newlineIndex).trim();
              buffer = buffer.slice(newlineIndex + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') {
                doneFlag = true;
                break;
              }
              let obj: Record<string, any>;
              try {
                obj = JSON.parse(payload);
              } catch {
                continue;
              }
              if (firstTokenAt == null) firstTokenAt = performance.now();
              const choices: Array<Record<string, any>> = obj.choices || [];
              if (choices.length > 0) {
                const delta = choices[0]?.delta || {};
                const piece = delta.content;
                if (piece) {
                  chunks.push(piece);
                  contentChars += piece.length;
                  if (onDelta) onDelta('content', piece);
                }
                const rPiece = delta.reasoning_content || delta.reasoning;
                if (rPiece) {
                  reasoningChunks.push(rPiece);
                  reasoningChars += rPiece.length;
                  if (onDelta) onDelta('reasoning', rPiece);
                }
                for (const tc of delta.tool_calls || []) {
                  const idx: number = tc.index || 0;
                  const slot = toolAcc.get(idx) || { id: '', name: '', arguments: '' };
                  if (tc.id) slot.id = tc.id;
                  const fn = tc.function || {};
                  if (fn.name) slot.name = fn.name;
                  if (fn.arguments) slot.arguments += fn.arguments;
                  toolAcc.set(idx, slot);
                }
                const fr = choices[0]?.finish_reason;
                if (fr) finishReason = fr;
              }
              if (obj.usage) usage = obj.usage;
              emitStats();
            }
            if (doneFlag) break;
          }
          break;
        } finally {
          merged.cleanup();
        }
      } catch (err) {
        const name = err instanceof Error ? err.name : 'UnknownError';
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`attempt ${attempt + 1}: ${name}: ${message}`);
        if (signal?.aborted) {
          result.ok = false;
          result.errors.push('cancelled');
          result.wall_s = (performance.now() - start) / 1000;
          return;
        }
        if (attempt < retries) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        result.ok = false;
        result.wall_s = (performance.now() - start) / 1000;
        return;
      }
    }

    emitStats(true);

    const wall = (performance.now() - start) / 1000;
    const ttft = firstTokenAt != null ? (firstTokenAt - start) / 1000 : null;
    const text = chunks.join('');
    const reasoning = reasoningChunks.join('');
    const promptTokens = Number(usage.prompt_tokens) || estimateTokens(promptProbe);
    const completionTokens =
      Number(usage.completion_tokens) || estimateTokens(text + reasoning);
    const details = (usage.prompt_tokens_details as Record<string, unknown>) || {};
    result.text = text;
    result.reasoning = reasoning;
    result.tool_calls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ ...v }));
    result.prompt_tokens = promptTokens;
    result.completion_tokens = completionTokens;
    result.cached_tokens = Number(details.cached_tokens) || 0;
    result.ttft_s = ttft;
    result.wall_s = wall;
    result.decode_tps =
      completionTokens > 0 && ttft != null && wall > ttft
        ? completionTokens / (wall - ttft)
        : null;
    result.finish_reason = finishReason || 'stop';
  }
}

class HttpStatusError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export function estimateTokens(text: string | number): number {
  const len = typeof text === 'number' ? text : text.length;
  return Math.max(1, Math.floor(len / 4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
