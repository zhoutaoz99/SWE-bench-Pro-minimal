import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { WEB_DIR } from './paths';
import { RunStore } from './store';
import { RunEngine, SECRET_VAULT } from './runner';
import * as dataset from './dataset';
import * as difficulty from './difficulty';
import * as sampler from './sampler';
import * as live from './live';
import { LiveProvider } from './provider';
import {
  RunRequest,
  SuiteManifest,
  artifactQuerySchema,
  generateSuiteBodySchema,
  liveDetailQuerySchema,
  providerRoutingToRequestDict,
  runRequestSchema,
  saveProfileBodySchema,
  testProviderBodySchema,
} from './schemas';

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const app = express();
app.use(express.json());

const store = new RunStore();
const engine = new RunEngine(store);
const activeTasks = new Map<string, { task: Promise<void>; abort: AbortController }>();

// ---------------- Helpers ----------------

function recoverOrphans(): void {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const summary of store.listRuns()) {
    if (['queued', 'running', 'retesting', 'analyzing'].includes(summary.status as string)) {
      const state = store.loadState(summary.run_id as string);
      if (state) {
        state.status = 'failed';
        state.error = '服务重启导致运行中断';
        state.ended_at = now;
        store.writeState(summary.run_id as string, state);
      }
    }
  }
}

function jsonable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function handleError(err: unknown, res: Response): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ detail: err.message });
    return;
  }
  if (err instanceof Error) {
    res.status(422).json({ detail: err.message });
    return;
  }
  res.status(500).json({ detail: String(err) });
}

function parseOr422(schema: { safeParse(data: unknown): { success: boolean; data?: unknown; error?: unknown } }, body: unknown): any {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(422, JSON.stringify(result.error));
  }
  return result.data;
}

function resolveReusedBaseline(request: RunRequest): { suite: SuiteManifest; breq: Record<string, any> } {
  const bstate = store.loadState(request.baseline_run_id!);
  if (!bstate) throw new HttpError(404, `baseline run not found: ${request.baseline_run_id}`);
  if (bstate.status !== 'completed' || !bstate.report_ready) {
    throw new HttpError(422, `基线运行 ${request.baseline_run_id} 尚未完成,无法复用`);
  }
  const breq = bstate.request || {};
  if (breq.provider_b) {
    throw new HttpError(422, `运行 ${request.baseline_run_id} 是 A/B 双端运行,不能作为基线复用源`);
  }
  if (breq.baseline_run_id) {
    throw new HttpError(422, `运行 ${request.baseline_run_id} 自身复用了基线,不含实跑基线记录`);
  }
  const suite = bstate.suite as SuiteManifest;
  if (request.suite_id && request.suite_id !== suite.suite_id) {
    throw new HttpError(
      422,
      `套件不一致:基线运行使用 ${suite.suite_id},本次选择了 ${request.suite_id};复用基线时必须使用同一套件`,
    );
  }
  const bScaffold = breq.scaffold || 'single-turn';
  if (bScaffold !== request.scaffold) {
    throw new HttpError(
      422,
      `scaffold 不一致:基线运行是 ${bScaffold},本次是 ${request.scaffold};复用基线时两端必须用同一 scaffold 才可比(旧基线为单轮模式,请在评测设置中切换)`,
    );
  }
  store.saveSuite(suite);
  const bpa = breq.provider_a || {};
  request.provider_a = {
    name: bpa.name || 'Baseline',
    base_url: bpa.base_url || '',
    model: bpa.model || '',
    api_key: '',
    role: 'baseline',
    temperature: bpa.temperature ?? 0.0,
    top_p: bpa.top_p ?? 1.0,
    max_tokens: bpa.max_tokens ?? 8192,
    reasoning_effort: bpa.reasoning_effort ?? null,
    price_input_per_m: bpa.price_input_per_m ?? 0.0,
    price_cached_per_m: bpa.price_cached_per_m ?? 0.0,
    price_output_per_m: bpa.price_output_per_m ?? 0.0,
    auto_append_v1: bpa.auto_append_v1 ?? true,
    provider: bpa.provider ?? null,
  };
  return { suite, breq };
}

function startRun(runId: string): void {
  const abort = new AbortController();
  const task = engine.execute(runId, abort.signal);
  activeTasks.set(runId, { task, abort });
  task.finally(() => {
    if (activeTasks.get(runId)?.task === task) activeTasks.delete(runId);
  }).catch(() => undefined);
}

// ---------------- API ----------------

app.get('/api/meta', (_req, res) => {
  const instances = dataset.loadSeedInstances();
  const rows = difficulty.annotate(instances);
  const byLang: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byRepo: Record<string, number> = {};
  const byBand: Record<string, number> = {};
  for (const r of rows) {
    byLang[String(r.language_family)] = (byLang[String(r.language_family)] ?? 0) + 1;
    byType[String(r.task_type)] = (byType[String(r.task_type)] ?? 0) + 1;
    byRepo[String(r.repo)] = (byRepo[String(r.repo)] ?? 0) + 1;
    byBand[String(r.difficulty)] = (byBand[String(r.difficulty)] ?? 0) + 1;
  }
  res.json({
    framework: 'SWE-bench Pro 分层最小集评测框架',
    dataset_meta: dataset.SEED_META,
    instance_count: rows.length,
    by_language: byLang,
    by_task_type: byType,
    by_repo: byRepo,
    by_difficulty: byBand,
    suites: store.listSuites(),
  });
});

app.get('/api/instances', (req, res) => {
  const rows = difficulty.annotate(dataset.loadSeedInstances());
  const language = req.query.language as string | undefined;
  const taskType = req.query.task_type as string | undefined;
  const difficultyBand = req.query.difficulty_band as string | undefined;
  const repo = req.query.repo as string | undefined;
  const q = req.query.q as string | undefined;
  const out = rows.filter((r) => {
    if (language && r.language_family !== language) return false;
    if (taskType && r.task_type !== taskType) return false;
    if (difficultyBand && r.difficulty !== difficultyBand) return false;
    if (repo && r.repo !== repo) return false;
    if (q) {
      const haystack = `${r.instance_id}${r.repo}${r.knowledge_domain ?? ''}`.toLowerCase();
      if (!haystack.includes(q.toLowerCase())) return false;
    }
    return true;
  });
  res.json(out);
});

app.post('/api/suites', (req, res) => {
  try {
    const body = parseOr422(generateSuiteBodySchema, req.body);
    const manifest = sampler.generateSuite(body.level, body.seed);
    store.saveSuite(manifest);
    res.json(jsonable(manifest));
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/api/suites', (_req, res) => {
  res.json(store.listSuites());
});

app.get('/api/suites/:suiteId', (req, res) => {
  const manifest = store.loadSuite(req.params.suiteId as string);
  if (!manifest) {
    res.status(404).json({ detail: `suite not found: ${req.params.suiteId}` });
    return;
  }
  res.json(jsonable(manifest));
});

app.get('/api/provider-profiles', (_req, res) => {
  res.json(store.listProfiles());
});

app.post('/api/provider-profiles', (req, res) => {
  try {
    const body = parseOr422(saveProfileBodySchema, req.body);
    const name = body.name.trim();
    if (!name) throw new HttpError(422, '配置名称不能为空');
    if (!body.config.base_url.trim() || !body.config.model.trim()) {
      throw new HttpError(422, '必须填写 base_url 与 model 才能保存');
    }
    res.json(store.saveProfile(name, body.config));
  } catch (err) {
    handleError(err, res);
  }
});

app.delete('/api/provider-profiles/:pid', (req, res) => {
  if (!store.deleteProfile(req.params.pid as string)) {
    res.status(404).json({ detail: `provider profile not found: ${req.params.pid}` });
    return;
  }
  res.json({ deleted: req.params.pid });
});

app.post('/api/test-provider', async (req, res) => {
  try {
    const body = parseOr422(testProviderBodySchema, req.body);
    const p = body.provider;
    if (!p.base_url.trim() || !p.model.trim()) {
      throw new HttpError(422, '请先填写 Base URL 与 Model ID 再测试连通');
    }
    const cfg = { ...p, max_tokens: Math.min(p.max_tokens, 16) };
    const result = await new LiveProvider(cfg).complete(
      'You are a connectivity test.',
      'Reply with exactly: ok',
      { retries: 0, timeout: 30.0 },
    );
    res.json({
      ok: result.ok,
      wall_s: Math.round(result.wall_s * 1000) / 1000,
      ttft_s: result.ttft_s != null ? Math.round(result.ttft_s * 1000) / 1000 : null,
      finish_reason: result.finish_reason,
      completion_tokens: result.completion_tokens,
      reasoning_chars: result.reasoning.length,
      errors: result.errors,
      model: cfg.model,
      provider_routing:
        cfg.provider && !isRoutingEmpty(cfg.provider)
          ? providerRoutingToRequestDict(cfg.provider)
          : {},
    });
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/api/baselines', (_req, res) => {
  res.json(store.listBaselines());
});

app.post('/api/runs', (req, res) => {
  try {
    const request = parseOr422(runRequestSchema, req.body) as RunRequest;
    if (request.baseline_run_id && request.provider_a) {
      throw new HttpError(422, 'baseline_run_id 与 provider_a 只能二选一:复用基线时不必填写基线端配置');
    }
    if (!request.baseline_run_id && !request.provider_a) {
      throw new HttpError(422, '缺少推理端:请填写 provider_a,或提供 baseline_run_id 复用已完成基线');
    }
    if (request.baseline_run_id && !request.provider_b) {
      throw new HttpError(422, '复用基线时必须提供 provider_b(候选端):本次运行只实跑候选端');
    }

    let reuseSuite: SuiteManifest | null = null;
    if (request.baseline_run_id) {
      const resolved = resolveReusedBaseline(request);
      reuseSuite = resolved.suite;
      request.suite_id = reuseSuite.suite_id;
    }

    const problems: string[] = [];
    for (const [p, label] of [
      [request.provider_a, 'Provider A'],
      [request.provider_b, 'Provider B'],
    ] as const) {
      if (p && (!p.base_url.trim() || !p.model.trim())) {
        problems.push(`${label}: 必须填写 base_url 与 model`);
      }
    }
    if (problems.length) throw new HttpError(422, problems.join(';'));

    let suite: SuiteManifest;
    if (reuseSuite) suite = reuseSuite;
    else if (request.suite_id) {
      const loaded = store.loadSuite(request.suite_id);
      if (!loaded) throw new HttpError(404, `suite not found: ${request.suite_id}`);
      suite = loaded;
    } else {
      suite = sampler.generateSuite(request.suite_level, request.suite_seed);
      store.saveSuite(suite);
    }

    const state = store.createRun(request, suite);
    const runId = state.run_id as string;
    if (request.provider_a?.api_key) {
      SECRET_VAULT.set(runId, { baseline: request.provider_a.api_key });
    }
    if (request.provider_b?.api_key) {
      SECRET_VAULT.set(runId, { ...(SECRET_VAULT.get(runId) || {}), candidate: request.provider_b.api_key });
    }
    startRun(runId);
    res.json({
      run_id: runId,
      suite_id: suite.suite_id,
      status: state.status,
      baseline_run_id: request.baseline_run_id,
    });
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/api/runs', (_req, res) => {
  res.json(store.listRuns());
});

app.get('/api/runs/:runId/state', (req, res) => {
  const state = store.loadState(req.params.runId as string);
  if (!state) {
    res.status(404).json({ detail: `run not found: ${req.params.runId}` });
    return;
  }
  res.json(state);
});

app.get('/api/runs/:runId/live', (req, res) => {
  const state = store.loadState(req.params.runId as string);
  if (!state) {
    res.status(404).json({ detail: `run not found: ${req.params.runId}` });
    return;
  }
  res.json({
    status: state.status,
    current: state.progress?.current ?? null,
    entries: live.listEntries(req.params.runId as string),
    summary: live.summarizeRun(req.params.runId as string),
  });
});

app.get('/api/runs/:runId/live-detail', (req, res) => {
  try {
    const state = store.loadState(req.params.runId as string);
    if (!state) {
      res.status(404).json({ detail: `run not found: ${req.params.runId}` });
      return;
    }
    const query = parseOr422(liveDetailQuerySchema, req.query);
    const detail = live.getDetail(
      req.params.runId as string,
      query.instance_id,
      query.role,
      query.run_index,
      query.r_offset,
      query.c_offset,
    );
    if (!detail) {
      res.status(404).json({ detail: 'live entry not found (尚未开始或缓冲已失效)' });
      return;
    }
    res.json(detail);
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/api/runs/:runId/report', (req, res) => {
  const state = store.loadState(req.params.runId as string);
  if (!state) {
    res.status(404).json({ detail: `run not found: ${req.params.runId}` });
    return;
  }
  const report = store.loadReport(req.params.runId as string);
  if (!report) {
    res.status(409).json({ detail: '报告尚未生成(运行未完成)' });
    return;
  }
  report.artifacts = store.listTrajectories(req.params.runId as string);
  res.json(report);
});

app.post('/api/runs/:runId/cancel', async (req, res) => {
  const entry = activeTasks.get(req.params.runId as string);
  if (!entry) {
    res.status(409).json({ detail: '运行不存在或已结束' });
    return;
  }
  entry.abort.abort();
  // 不阻塞等待任务结束:让前端通过轮询 /state 看到 cancelled,避免按钮“点了没反应”
  res.json({ run_id: req.params.runId, status: 'cancelling' });
});

app.post('/api/runs/:runId/artifact', (req, res) => {
  try {
    const state = store.loadState(req.params.runId as string);
    if (!state) {
      res.status(404).json({ detail: `run not found: ${req.params.runId}` });
      return;
    }
    const body = parseOr422(artifactQuerySchema, req.body);
    if (body.name.endsWith('.json') && !body.name.includes('/')) {
      const traj = store.loadTrajectory(req.params.runId as string, body.name);
      if (!traj) {
        res.status(404).json({ detail: `artifact not found: ${body.name}` });
        return;
      }
      res.json(traj);
      return;
    }
    const text = store.readArtifact(req.params.runId as string, body.name);
    if (text == null) {
      res.status(404).json({ detail: `artifact not found: ${body.name}` });
      return;
    }
    res.json({ name: body.name, content: text });
  } catch (err) {
    handleError(err, res);
  }
});

app.delete('/api/runs/:runId', (req, res) => {
  const entry = activeTasks.get(req.params.runId as string);
  if (entry) {
    res.status(409).json({ detail: '运行进行中,请先取消' });
    return;
  }
  if (!store.loadState(req.params.runId as string)) {
    res.status(404).json({ detail: `run not found: ${req.params.runId}` });
    return;
  }
  fs.rmSync(store.runDir(req.params.runId as string), { recursive: true, force: true });
  SECRET_VAULT.delete(req.params.runId as string);
  live.dropRun(req.params.runId as string);
  res.json({ deleted: req.params.runId });
});

// ---------------- Frontend ----------------

app.use('/static', express.static(WEB_DIR));
app.get('/', (_req, res) => {
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

// ---------------- Startup / Shutdown ----------------

recoverOrphans();

const port = Number(process.env.PORT || process.argv[2] || 8765);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`SWE-bench Pro 最小集评测框架(TS 后端)启动中: http://127.0.0.1:${port}`);
});

function shutdown(): void {
  for (const entry of activeTasks.values()) entry.abort.abort();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function isRoutingEmpty(r: { order?: unknown; only?: unknown; ignore?: unknown; quantizations?: unknown; allow_fallbacks?: unknown; sort?: unknown; require_parameters?: unknown; data_policy?: unknown }): boolean {
  return !(
    (r.order as unknown[])?.length ||
    (r.only as unknown[])?.length ||
    (r.ignore as unknown[])?.length ||
    (r.quantizations as unknown[])?.length ||
    r.allow_fallbacks != null ||
    r.sort != null ||
    r.require_parameters != null ||
    r.data_policy != null
  );
}
