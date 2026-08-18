import express, { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { WEB_DIR } from './paths';
import { RunStore } from './store';
import { RunEngine, SECRET_VAULT } from './runner';
import * as dataset from './dataset';
import * as difficulty from './difficulty';
import * as analyzer from './analyzer';
import * as sampler from './sampler';
import { getFixedSuite, listFixedSuites } from './sampler';
import * as live from './live';
import { LiveProvider } from './provider';
import {
  RunRequest,
  SuiteManifest,
  artifactQuerySchema,
  compareBodySchema,
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



function startRun(runId: string): void {
  const abort = new AbortController();
  const task = engine.execute(runId, abort.signal);
  activeTasks.set(runId, { task, abort });
  task.finally(() => {
    if (activeTasks.get(runId)?.task === task) activeTasks.delete(runId);
  }).catch(() => undefined);
}

// ---------------- API ----------------

app.get('/api/meta', (req, res) => {
  try {
    const instances = dataset.loadSuiteInstances();
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
      dataset_meta: dataset.OFFICIAL_META,
      instance_count: rows.length,
      by_language: byLang,
      by_task_type: byType,
      by_repo: byRepo,
      by_difficulty: byBand,
    });
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/api/instances', (req, res) => {
  try {
    const instances = dataset.loadSuiteInstances();
    const rows = difficulty.annotate(instances);
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
  } catch (err) {
    handleError(err, res);
  }
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
  res.json(listFixedSuites());
});

app.get('/api/suites/:suiteId', (req, res) => {
  try {
    const suite = getFixedSuite(req.params.suiteId as string);
    res.json(jsonable(suite));
  } catch (err) {
    handleError(err, res);
  }
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

app.post('/api/runs', (req, res) => {
  try {
    const request = parseOr422(runRequestSchema, req.body) as RunRequest;
    if (!request.provider) {
      throw new HttpError(422, '缺少推理端:请填写 provider 配置');
    }
    const p = request.provider;
    if (!p.base_url.trim() || !p.model.trim()) {
      throw new HttpError(422, 'Provider: 必须填写 base_url 与 model');
    }
    if (request.docker_enabled && request.dataset_source !== 'official') {
      throw new HttpError(422, 'Docker 模式仅支持官方数据集;请先切换到“官方数据集”');
    }
    if (request.evaluator === 'official' && request.dataset_source !== 'official') {
      throw new HttpError(422, 'official evaluator 需要 official 数据集;请先切换到“官方数据集”');
    }

    let suite: SuiteManifest;
    if (request.suite_id) {
      const fixed = listFixedSuites().some((s) => s.suite_id === request.suite_id);
      if (fixed) {
        suite = getFixedSuite(request.suite_id);
      } else {
        const loaded = store.loadSuite(request.suite_id);
        if (!loaded) throw new HttpError(404, `suite not found: ${request.suite_id}`);
        suite = loaded;
      }
    } else {
      suite = sampler.generateSuite(request.suite_level, request.suite_seed);
      store.saveSuite(suite);
    }

    const state = store.createRun(request, suite);
    const runId = state.run_id as string;
    if (request.provider.api_key) {
      SECRET_VAULT.set(runId, { provider: request.provider.api_key });
    }
    startRun(runId);
    res.json({
      run_id: runId,
      suite_id: suite.suite_id,
      status: state.status,
    });
  } catch (err) {
    handleError(err, res);
  }
});

app.get('/api/runs', (_req, res) => {
  res.json(store.listRuns());
});

app.post('/api/compare', (req, res) => {
  try {
    const body = parseOr422(compareBodySchema, req.body);
    if (body.run_a === body.run_b) {
      throw new HttpError(422, '请选择两个不同的运行进行对比');
    }
    const reportA = store.loadReport(body.run_a);
    const reportB = store.loadReport(body.run_b);
    if (!reportA) throw new HttpError(404, `报告未找到或未完成: ${body.run_a}`);
    if (!reportB) throw new HttpError(404, `报告未找到或未完成: ${body.run_b}`);
    if (reportA.suite?.suite_id !== reportB.suite?.suite_id) {
      throw new HttpError(422, '仅支持对比同一套件的两次独立运行');
    }
    const comparison = analyzer.buildComparison(reportA, reportB);
    res.json(comparison);
  } catch (err) {
    handleError(err, res);
  }
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
      query.turn,
      query.r_offset,
      query.c_offset,
      query.t_offset,
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

// 前端无构建步骤，禁用强缓存确保改动即时生效
app.use('/static', (_req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
}, express.static(WEB_DIR));
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
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
