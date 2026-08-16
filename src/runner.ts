import path from 'node:path';
import { RunStore, recordsToCsv } from './store';
import * as analyzer from './analyzer';
import * as livemod from './live';
import { AgentWorkspace, AGENT_TOOLS } from './workspace';
import { evaluateHeuristic } from './evaluator';
import {
  LiveProvider,
  CompletionResult,
  createCompletionResult,
  buildPrompt,
} from './provider';
import {
  Instance,
  ProviderConfig,
  RunRequest,
  toInstance,
} from './schemas';

export const SECRET_VAULT = new Map<string, Record<string, string>>();

const AGENT_SYSTEM_TMPL =
  'You are an autonomous software engineer agent solving a real task inside a ' +
  'dedicated workspace directory.\n' +
  '- Interact with the workspace ONLY through the provided tools ' +
  '(bash / view_file / edit_file / submit).\n' +
  '- Create or modify files so that the final workspace state resolves the task. ' +
  'The submission patch is computed automatically from your file changes ' +
  '(git diff) — do NOT print the diff yourself.\n' +
  '- You have a budget of at most {turns} turns. Call `submit` when the task is done.\n' +
  '- Be efficient: inspect first, implement, then verify; avoid repeating ' +
  'failed commands.';

const BAND_ORDER: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

function byDifficulty(instances: Array<Record<string, any>>): Array<Record<string, any>> {
  return [...instances].sort(
    (a, b) => (BAND_ORDER[a.difficulty] ?? 3) - (BAND_ORDER[b.difficulty] ?? 3),
  );
}

export function computeCost(
  pconf: ProviderConfig,
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number,
): number {
  const uncached = Math.max(0, promptTokens - cachedTokens);
  return (
    (uncached / 1e6) * pconf.price_input_per_m +
    (cachedTokens / 1e6) * pconf.price_cached_per_m +
    (completionTokens / 1e6) * pconf.price_output_per_m
  );
}

export class RunEngine {
  constructor(private readonly store: RunStore) {}

  async execute(runId: string, signal?: AbortSignal): Promise<void> {
    const state = this.store.loadState(runId);
    if (!state) return;
    const requestData = state.request as Record<string, any>;
    const req = restoreRequest(requestData, SECRET_VAULT.get(runId) || {});
    const suite = state.suite as Record<string, any>;
    const instances = byDifficulty(suite.instances as Array<Record<string, any>>);

    const providers: Record<string, ProviderConfig> = {};
    if (req.baseline_run_id) {
      providers.candidate = req.provider_b!;
    } else {
      providers.baseline = req.provider_a!;
      if (req.provider_b) providers.candidate = req.provider_b;
    }

    try {
      throwIfAborted(signal);
      this.store.updateState(runId, { status: 'running', phase: 'S1 主评测' });
      if (req.baseline_run_id) {
        const imported = this.store.importBaseline(runId, req.baseline_run_id);
        const st = this.store.loadState(runId)!;
        for (const rec of imported) {
          const istat = (st.instance_status[rec.instance_id] ||= {});
          const badge = rec.status !== 'ok' ? 'error' : rec.resolved ? 'pass' : 'fail';
          istat[`baseline_r${rec.run_index}`] = badge;
          if (rec.run_index === 0) istat.baseline = badge;
        }
        this.store.updateState(runId, { instance_status: st.instance_status });
      }

      for (const inst of instances) {
        for (const [role, pconf] of Object.entries(providers)) {
          await sleep(0);
          throwIfAborted(signal);
          await this.runOnce(runId, inst, pconf, role, 0, 'S1', req.scaffold, req.turn_limit, signal);
          const st = this.store.loadState(runId)!;
          st.counts.s1 = (st.counts.s1 ?? 0) + 1;
          st.progress.done = (st.counts.s1 ?? 0) + (st.counts.s2 ?? 0);
          st.progress.current = null;
          this.store.updateState(runId, { counts: st.counts, progress: st.progress });
        }
      }

      if (providers.candidate) {
        const records = this.store.loadRecords(runId);
        const disagreements = analyzer.disagreementIds(records);
        if (disagreements.length > 0 && req.repeat_disagreements > 0) {
          this.store.updateState(runId, { phase: 'S2 分歧复测', status: 'retesting' });
          const byId = new Map(instances.map((i) => [i.instance_id, i]));
          const rank = new Map(instances.map((i, n) => [i.instance_id, n]));
          disagreements.sort((a, b) => (rank.get(a) ?? rank.size) - (rank.get(b) ?? rank.size));
          const st = this.store.loadState(runId)!;
          st.progress.total =
            st.progress.done +
            disagreements.length * Object.keys(providers).length * req.repeat_disagreements;
          this.store.updateState(runId, { progress: st.progress });
          for (const iid of disagreements) {
            for (let runIndex = 1; runIndex <= req.repeat_disagreements; runIndex++) {
              for (const [role, pconf] of Object.entries(providers)) {
                await sleep(0);
                throwIfAborted(signal);
                await this.runOnce(
                  runId,
                  byId.get(iid)!,
                  pconf,
                  role,
                  runIndex,
                  'S2',
                  req.scaffold,
                  req.turn_limit,
                  signal,
                );
                const st2 = this.store.loadState(runId)!;
                st2.counts.s2 = (st2.counts.s2 ?? 0) + 1;
                st2.progress.done = (st2.counts.s1 ?? 0) + (st2.counts.s2 ?? 0);
                this.store.updateState(runId, { counts: st2.counts, progress: st2.progress });
              }
            }
          }
        }
      }

      this.store.updateState(runId, { status: 'analyzing', phase: '分析汇总' });
      const records = this.store.loadRecords(runId);
      const report = analyzer.buildReport(runId, records, suite, req);
      const csvText = recordsToCsv(records);
      const mdText = analyzer.renderMarkdown(report);
      this.store.writeReport(runId, report, csvText, mdText);
      const st = this.store.loadState(runId)!;
      st.progress.current = null;
      this.store.updateState(runId, {
        status: 'completed',
        phase: '完成',
        report_ready: true,
        progress: st.progress,
        error: null,
        ended_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      });
    } catch (err) {
      if (signal?.aborted || (err as Error).name === 'AbortError' || (err as any)?.__cancelled) {
        this.store.updateState(runId, {
          status: 'cancelled',
          phase: '已取消',
          ended_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        });
        throw err;
      }
      const message = err instanceof Error ? (err.stack || err.message).slice(-2000) : String(err);
      this.store.updateState(runId, {
        status: 'failed',
        phase: '失败',
        error: message,
        ended_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      });
    }
  }

  private async runOnce(
    runId: string,
    instDict: Record<string, any>,
    pconf: ProviderConfig,
    role: string,
    runIndex: number,
    phase: 'S1' | 'S2',
    scaffold: string,
    turnLimit: number,
    signal?: AbortSignal,
  ): Promise<Record<string, any>> {
    const inst = toInstance(instDict);
    const provider = new LiveProvider(pconf);
    const { system, user } = buildPrompt(inst);
    const started = new Date().toISOString();

    const st = this.store.loadState(runId)!;
    st.progress.current = { instance_id: inst.instance_id, role, phase };
    const istat = (st.instance_status[inst.instance_id] ||= {});
    istat[`${role}_r${runIndex}`] = 'running';
    this.store.updateState(runId, { progress: st.progress, instance_status: st.instance_status });

    const liveKey = livemod.register(
      runId,
      inst.instance_id,
      role,
      runIndex,
      pconf.model,
      phase,
      {
        price_input_per_m: pconf.price_input_per_m,
        price_cached_per_m: pconf.price_cached_per_m,
        price_output_per_m: pconf.price_output_per_m,
      },
    );
    const agentMeta: Record<string, any> = {};

    let completion: CompletionResult;
    if (scaffold === 'agent') {
      const [comp, meta] = await this.agentLoop(
        runId,
        inst,
        pconf,
        role,
        runIndex,
        liveKey,
        turnLimit,
        signal,
      );
      completion = comp;
      Object.assign(agentMeta, meta);
    } else {
      completion = await provider.complete(system, user, {
        onDelta: (kind, piece) => livemod.appendText(liveKey, kind, piece),
        onStats: (u) =>
          livemod.updateUsage(
            liveKey,
            {
              prompt_tokens: u.prompt_tokens,
              completion_tokens: u.completion_tokens,
              cached_tokens: u.cached_tokens,
            },
            { decode_tps: u.decode_tps, elapsed_s: u.elapsed_s },
          ),
        signal,
      });
    }
    // 确保最终 usage/速率/花费进入实时缓冲(流式未触发或最后一段被节流时兜底)
    livemod.updateUsage(
      liveKey,
      {
        prompt_tokens: completion.prompt_tokens,
        completion_tokens: completion.completion_tokens,
        cached_tokens: completion.cached_tokens,
      },
      {
        decode_tps: completion.decode_tps,
        elapsed_s: completion.wall_s,
      },
    );
    livemod.finish(liveKey, completion.finish_reason, completion.errors);
    const outcome = evaluateHeuristic(inst, completion);

    const cost = computeCost(
      pconf,
      completion.prompt_tokens,
      completion.cached_tokens,
      completion.completion_tokens,
    );
    const record: Record<string, any> = {
      run_index: runIndex,
      phase,
      scaffold,
      instance_id: inst.instance_id,
      provider_role: role,
      provider_name: pconf.name,
      model: pconf.model,
      status: completion.ok ? 'ok' : 'error',
      resolved: completion.ok ? Boolean(outcome.resolved) : null,
      f2p_passed: outcome.f2p_passed,
      f2p_total: outcome.f2p_total,
      p2p_passed: outcome.p2p_passed,
      p2p_total: outcome.p2p_total,
      usage: {
        prompt_tokens: completion.prompt_tokens,
        completion_tokens: completion.completion_tokens,
        cached_tokens: completion.cached_tokens,
      },
      ttft_s: completion.ttft_s,
      wall_s: Math.round(completion.wall_s * 1000) / 1000,
      decode_tps: completion.decode_tps,
      finish_reason: completion.finish_reason,
      truncated: completion.finish_reason === 'length',
      turns_used: agentMeta.turns ?? 0,
      tool_calls: agentMeta.tool_calls ?? 0,
      tool_errors:
        (completion.ok ? 0 : completion.errors.length) + (agentMeta.tool_errors ?? 0),
      errors: completion.errors,
      cost_usd: Math.round(cost * 1000000) / 1000000,
      eval_method: outcome.method,
      patch_excerpt: (completion.text || '').slice(0, 600),
      started_at: started,
      ended_at: new Date().toISOString(),
    };
    this.store.appendRecord(runId, record);

    const st2 = this.store.loadState(runId)!;
    const istat2 = (st2.instance_status[inst.instance_id] ||= {});
    const badge = completion.ok ? (outcome.resolved ? 'pass' : 'fail') : 'error';
    istat2[`${role}_r${runIndex}`] = badge;
    istat2[role] = runIndex === 0 ? badge : istat2[role] ?? badge;
    this.store.updateState(runId, { instance_status: st2.instance_status });

    if (badge === 'fail' || badge === 'error') {
      this.store.saveTrajectory(runId, inst.instance_id, role, runIndex, {
        instance_id: inst.instance_id,
        provider_role: role,
        model: pconf.model,
        run_index: runIndex,
        phase,
        scaffold,
        eval_detail: outcome.detail,
        prompt_system: system,
        prompt_user: user,
        response: completion.text,
        reasoning: completion.reasoning,
        agent: {
          turns: agentMeta.turns,
          tool_calls: agentMeta.tool_calls,
          tool_errors: agentMeta.tool_errors,
          submitted: agentMeta.submitted,
        },
        trajectory: agentMeta.transcript,
        record,
      });
    }
    return record;
  }

  private async agentLoop(
    runId: string,
    inst: Instance,
    pconf: ProviderConfig,
    role: string,
    runIndex: number,
    liveKey: string,
    turnLimit: number,
    signal?: AbortSignal,
  ): Promise<[CompletionResult, Record<string, any>]> {
    const safeId = inst.instance_id.replace(/[/:]/g, '_');
    const ws = new AgentWorkspace(
      path.join(this.store.runDir(runId), 'workspaces', safeId, `${role}_r${runIndex}`),
    );
    ws.seed(inst);
    const provider = new LiveProvider(pconf);
    const system = AGENT_SYSTEM_TMPL.replace('{turns}', String(turnLimit));
    const { user } = buildPrompt(inst);
    const fullUser =
      user +
      '\n\nThe full task specification is also available in TASK.md inside the workspace.';
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: system },
      { role: 'user', content: fullUser },
    ];

    const completion = createCompletionResult();
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let toolCallCount = 0;
    let toolErrors = 0;
    let turnsUsed = 0;
    let submitted = false;
    let truncated = false;
    let lastText = '';
    const reasoningParts: string[] = [];
    const transcript: Array<Record<string, unknown>> = [];
    const started = performance.now();

    for (let turn = 1; turn <= turnLimit; turn++) {
      await sleep(0);
      throwIfAborted(signal);
      const header = `\n\n──────── 轮次 ${turn}/${turnLimit} ────────\n`;
      livemod.appendText(liveKey, 'reasoning', header);
      livemod.appendText(liveKey, 'content', header);
      const stepBasePrompt = promptTokens;
      const stepBaseCompletion = completionTokens;
      const stepBaseCached = cachedTokens;
      const step = await provider.agentStep(messages, AGENT_TOOLS, {
        onDelta: (kind, piece) => livemod.appendText(liveKey, kind, piece),
        onStats: (u) =>
          livemod.updateUsage(
            liveKey,
            {
              prompt_tokens: stepBasePrompt + u.prompt_tokens,
              completion_tokens: stepBaseCompletion + u.completion_tokens,
              cached_tokens: stepBaseCached + u.cached_tokens,
            },
            {
              decode_tps: u.decode_tps,
              elapsed_s: (performance.now() - started) / 1000,
            },
          ),
        signal,
      });
      promptTokens += step.prompt_tokens;
      completionTokens += step.completion_tokens;
      cachedTokens += step.cached_tokens;
      livemod.updateUsage(
        liveKey,
        {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          cached_tokens: cachedTokens,
        },
        {
          decode_tps: step.decode_tps,
          elapsed_s: (performance.now() - started) / 1000,
        },
      );
      if (step.ttft_s != null && completion.ttft_s == null) completion.ttft_s = step.ttft_s;
      if (!step.ok) {
        completion.ok = false;
        completion.errors.push(...step.errors);
        transcript.push({ role: 'assistant', error: step.errors });
        break;
      }
      turnsUsed = turn;
      if (step.finish_reason === 'length') truncated = true;
      if (step.text) lastText = step.text;
      if (step.reasoning) reasoningParts.push(`〔Turn ${turn}〕\n${step.reasoning.slice(0, 4000)}`);
      messages.push(step.assistant_message!);
      transcript.push(step.assistant_message!);

      if (step.tool_calls.length > 0) {
        for (const call of step.tool_calls) {
          toolCallCount += 1;
          const [resultText, isErr] = await ws.executeTool(call.name, call.arguments, signal);
          if (isErr) toolErrors += 1;
          if (signal?.aborted) break;
          const toolMsg: Record<string, unknown> = {
            role: 'tool',
            tool_call_id: call.id,
            content: resultText,
          };
          messages.push(toolMsg);
          transcript.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: resultText.slice(0, 2000),
          });
          const brief = call.arguments.slice(0, 120).replace(/\n/g, ' ');
          livemod.appendText(
            liveKey,
            'content',
            `⚙ ${call.name}(${brief})${isErr ? ' ✗' : ''}\n${resultText.slice(0, 600)}\n`,
          );
          if (call.name === 'submit') {
            submitted = true;
            break;
          }
        }
        if (signal?.aborted || submitted) break;
      } else {
        const note =
          'You did not call any tool. Use the tools to work on the task, or call `submit` when you are done.';
        messages.push({ role: 'user', content: note });
        livemod.appendText(liveKey, 'content', '(未调用工具 — 已追加行动提醒)\n');
      }
    }
    if (signal?.aborted) {
      completion.ok = false;
      completion.errors.push('cancelled');
    }


    let patch = ws.finalPatch();
    if (!patch.trim() && lastText.trim()) patch = lastText;
    completion.text = patch;
    completion.reasoning = reasoningParts.join('\n\n');
    completion.prompt_tokens = promptTokens;
    completion.completion_tokens = completionTokens;
    completion.cached_tokens = cachedTokens;
    completion.wall_s = (performance.now() - started) / 1000;
    completion.finish_reason = truncated && !patch.trim() ? 'length' : 'stop';
    completion.decode_tps =
      completionTokens > 0 && completion.ttft_s != null && completion.wall_s > completion.ttft_s
        ? completionTokens / (completion.wall_s - completion.ttft_s)
        : null;

    const meta: Record<string, any> = {
      turns: turnsUsed,
      tool_calls: toolCallCount,
      tool_errors: toolErrors,
      submitted,
      transcript,
    };
    return [completion, meta];
  }
}

function restoreRequest(data: Record<string, any>, secrets: Record<string, string>): RunRequest {
  function fix(p: Record<string, any> | null | undefined, role: string): ProviderConfig | null {
    if (!p) return null;
    const copy = { ...p };
    const key = secrets[role];
    if (key) copy.api_key = key;
    return copy as ProviderConfig;
  }
  return {
    provider_a: fix(data.provider_a, 'baseline'),
    provider_b: fix(data.provider_b, 'candidate'),
    baseline_run_id: data.baseline_run_id ?? null,
    suite_level: data.suite_level ?? 'smoke6',
    suite_seed: data.suite_seed ?? 0,
    suite_id: data.suite_id ?? null,
    repeat_disagreements: data.repeat_disagreements ?? 2,
    scaffold: data.scaffold || 'single-turn',
    turn_limit: data.turn_limit ?? 50,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('run cancelled') as Error & { __cancelled?: boolean };
    (err as any).__cancelled = true;
    throw err;
  }
}
