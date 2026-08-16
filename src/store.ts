import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RUNS_DIR, SUITES_DIR, PROFILES_FILE } from './paths';
import {
  ProviderConfig,
  RunRequest,
  SuiteManifest,
  providerRoutingToRequestDict,
} from './schemas';
import { normalizeBaseUrl } from './provider';

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `run-${ymd}-${hms}-${crypto.randomBytes(2).toString('hex')}`;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export class RunStore {
  readonly root: string;
  readonly suitesDir: string;

  constructor(root: string = RUNS_DIR) {
    this.root = root;
    this.suitesDir = path.join(root, 'suites');
    fs.mkdirSync(this.suitesDir, { recursive: true });
  }

  // ---------- Provider profiles ----------

  private profilesPath(): string {
    return path.join(this.root, PROFILES_FILE);
  }

  private loadProfiles(): Record<string, any> {
    const p = this.profilesPath();
    if (!fs.existsSync(p)) return {};
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  private writeProfiles(profiles: Record<string, any>): void {
    fs.writeFileSync(this.profilesPath(), JSON.stringify(profiles, null, 2), 'utf-8');
  }

  listProfiles(): Array<Record<string, any>> {
    const out: Array<Record<string, any>> = [];
    for (const [pid, p] of Object.entries(this.loadProfiles())) {
      out.push({
        id: pid,
        name: p?.name ?? '',
        model: p?.config?.model ?? '',
        updated_at: p?.updated_at ?? '',
        config: p?.config ?? {},
      });
    }
    out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return out;
  }

  saveProfile(name: string, config: ProviderConfig): { id: string; name: string } {
    const profiles = this.loadProfiles();
    const existing = Object.entries(profiles).find(([, p]) => p?.name === name);
    const pid = existing ? existing[0] : crypto.randomBytes(4).toString('hex');
    profiles[pid] = {
      name,
      updated_at: now(),
      config: jsonClone(config),
    };
    this.writeProfiles(profiles);
    return { id: pid, name };
  }

  deleteProfile(pid: string): boolean {
    const profiles = this.loadProfiles();
    if (!(pid in profiles)) return false;
    delete profiles[pid];
    this.writeProfiles(profiles);
    return true;
  }

  // ---------- Suites ----------

  saveSuite(manifest: SuiteManifest): void {
    const p = path.join(this.suitesDir, `${manifest.suite_id}.json`);
    fs.writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  loadSuite(suiteId: string): SuiteManifest | null {
    const p = path.join(this.suitesDir, `${suiteId}.json`);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as SuiteManifest;
    } catch {
      return null;
    }
  }

  listSuites(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    if (!fs.existsSync(this.suitesDir)) return out;
    const names = fs
      .readdirSync(this.suitesDir)
      .filter((n) => n.startsWith('suite-') && n.endsWith('.json'))
      .sort()
      .reverse();
    for (const name of names) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.suitesDir, name), 'utf-8')) as SuiteManifest;
        out.push({
          suite_id: m.suite_id,
          suite_version: m.suite_version,
          level: m.level,
          seed: m.seed,
          created_at: m.created_at,
          instance_count: m.instances.length,
          dataset_revision: m.dataset_revision,
          evaluator_revision: m.evaluator_revision,
        });
      } catch {
        // skip corrupt files
      }
    }
    return out;
  }

  // ---------- Runs ----------

  createRun(request: RunRequest, suite: SuiteManifest): Record<string, any> {
    const runId = newRunId();
    const runDir = path.join(this.root, runId);
    fs.mkdirSync(path.join(runDir, 'trajectories'), { recursive: true });

    const state: Record<string, any> = {
      run_id: runId,
      status: 'queued',
      phase: '-',
      created_at: now(),
      ended_at: null,
      error: null,
      request: this.sanitizeRequest(request),
      suite: jsonClone(suite),
      progress: {
        done: 0,
        total: suite.instances.length,
        current: null,
      },
      instance_status: Object.fromEntries(
        suite.instances.map((i) => [i.instance_id, {}]),
      ),
      counts: { runs: 0 },
      report_ready: false,
    };
    this.writeState(runId, state);
    this.writeRunManifest(runId, request, suite);
    fs.writeFileSync(path.join(runDir, 'per_run.jsonl'), '', 'utf-8');
    return state;
  }

  static sanitizeRequest(request: RunRequest): Record<string, any> {
    const data = jsonClone(request) as Record<string, any>;
    if (data.provider) {
      data.provider.api_key = data.provider.api_key ? '***' : '';
    }
    return data;
  }

  sanitizeRequest(request: RunRequest): Record<string, any> {
    return RunStore.sanitizeRequest(request);
  }

  private writeRunManifest(runId: string, request: RunRequest, suite: SuiteManifest): void {
    const providerBlock = (p: ProviderConfig | null): Record<string, any> | null => {
      if (!p) return null;
      const base = normalizeBaseUrl(p.base_url, p.auto_append_v1);
      return {
        role: p.role,
        name: p.name,
        base_url: base,
        endpoint_hash: crypto.createHash('sha256').update(base).digest('hex').slice(0, 12),
        model: p.model,
        temperature: p.temperature,
        top_p: p.top_p,
        max_tokens: p.max_tokens,
        reasoning_effort: p.reasoning_effort,
        provider_routing: p.provider && !isProviderRoutingEmpty(p.provider)
          ? providerRoutingToRequestDict(p.provider)
          : null,
      };
    };

    const providerBlockOut = providerBlock(request.provider);
    const manifest: Record<string, any> = {
      run_id: runId,
      created_at: now(),
      suite_id: suite.suite_id,
      suite_version: suite.suite_version,
      turn_limit: request.turn_limit,
      scaffold: 'agent-scaffold-v1',
      providers: {
        ...(providerBlockOut ? { provider: providerBlockOut } : {}),
      },
    };
    const runDir = this.runDir(runId);
    fs.writeFileSync(
      path.join(runDir, 'suite_manifest.json'),
      JSON.stringify(jsonClone(suite), null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(runDir, 'run_manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }

  runDir(runId: string): string {
    return path.join(this.root, runId);
  }

  private statePath(runId: string): string {
    return path.join(this.root, runId, 'run_state.json');
  }

  writeState(runId: string, state: Record<string, any>): void {
    fs.writeFileSync(this.statePath(runId), JSON.stringify(state, null, 2), 'utf-8');
  }

  loadState(runId: string): Record<string, any> | null {
    const p = this.statePath(runId);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, any>;
    } catch {
      return null;
    }
  }

  updateState(runId: string, fields: Record<string, any>): Record<string, any> {
    const state = this.loadState(runId);
    if (!state) throw new Error(`unknown run: ${runId}`);
    Object.assign(state, fields);
    this.writeState(runId, state);
    return state;
  }

  appendRecord(runId: string, record: Record<string, any>): void {
    const p = path.join(this.root, runId, 'per_run.jsonl');
    fs.appendFileSync(p, JSON.stringify(record) + '\n', 'utf-8');
  }

  loadRecords(runId: string): Array<Record<string, any>> {
    const p = path.join(this.root, runId, 'per_run.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  saveTrajectory(
    runId: string,
    instanceId: string,
    role: string,
    runIndex: number,
    payload: Record<string, any>,
  ): void {
    const safe = instanceId.replace(/[/:]/g, '_');
    const p = path.join(this.root, runId, 'trajectories', `${safe}__${role}__r${runIndex}.json`);
    fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf-8');
  }

  loadTrajectory(runId: string, name: string): Record<string, any> | null {
    const p = path.join(this.root, runId, 'trajectories', name);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  listTrajectories(runId: string): string[] {
    const d = path.join(this.root, runId, 'trajectories');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort();
  }

  writeReport(runId: string, report: Record<string, any>, csvText: string, mdText: string): void {
    const runDir = this.runDir(runId);
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
    fs.writeFileSync(path.join(runDir, 'eval_results.csv'), '\uFEFF' + csvText, 'utf-8');
    fs.writeFileSync(path.join(runDir, 'report.md'), mdText, 'utf-8');
  }

  loadReport(runId: string): Record<string, any> | null {
    const p = path.join(this.root, runId, 'report.json');
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  listRuns(): Array<Record<string, any>> {
    const out: Array<Record<string, any>> = [];
    if (!fs.existsSync(this.root)) return out;
    const entries = fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(this.root, e.name, 'run_state.json')))
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const name of entries) {
      try {
        const state = JSON.parse(
          fs.readFileSync(path.join(this.root, name, 'run_state.json'), 'utf-8'),
        ) as Record<string, any>;
        const req = state.request || {};
        const p = req.provider || {};
        out.push({
          run_id: state.run_id,
          status: state.status,
          phase: state.phase ?? '-',
          created_at: state.created_at,
          suite_level: state.suite?.level,
          provider_name: p.name,
          model: p.model,
          base_url: p.base_url,
          dataset_source: req.dataset_source ?? 'official',
          docker_enabled: Boolean(req.docker_enabled ?? false),
          evaluator: req.evaluator ?? 'official',
          progress: state.progress || {},
          report_ready: state.report_ready ?? false,
        });
      } catch {
        // skip corrupt state
      }
    }
    return out;
  }

  readArtifact(runId: string, name: string): string | null {
    const allowed = new Set([
      'report.json',
      'report.md',
      'paired_report.md',
      'run_manifest.json',
      'suite_manifest.json',
      'per_run.jsonl',
      'eval_results.csv',
    ]);
    if (!allowed.has(name)) return null;
    const p = path.join(this.root, runId, name);
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, 'utf-8');
    return name === 'eval_results.csv' ? text.replace(/^\uFEFF/, '') : text;
  }
}

function isProviderRoutingEmpty(r: { order?: unknown; only?: unknown; ignore?: unknown; quantizations?: unknown; allow_fallbacks?: unknown; sort?: unknown; require_parameters?: unknown; data_policy?: unknown }): boolean {
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

export function recordsToCsv(records: Array<Record<string, any>>): string {
  const columns = [
    'instance_id', 'provider_role', 'model', 'phase', 'run_index',
    'status', 'resolved', 'f2p_passed', 'f2p_total',
    'p2p_passed', 'p2p_total', 'prompt_tokens', 'completion_tokens',
    'cached_tokens', 'ttft_s', 'wall_s', 'decode_tps',
    'finish_reason', 'truncated', 'turns_used', 'tool_calls',
    'tool_errors', 'cost_usd', 'eval_method',
  ];
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [columns.map(escape).join(',')];
  for (const rec of records) {
    const usage = rec.usage || {};
    const row: Record<string, unknown> = { ...rec };
    row.prompt_tokens = usage.prompt_tokens ?? 0;
    row.completion_tokens = usage.completion_tokens ?? 0;
    row.cached_tokens = usage.cached_tokens ?? 0;
    row.resolved = rec.resolved == null ? '' : rec.resolved ? '1' : '0';
    lines.push(columns.map((c) => escape(row[c])).join(','));
  }
  return lines.join('\n');
}
