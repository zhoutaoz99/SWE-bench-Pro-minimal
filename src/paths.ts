import path from 'node:path';

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const WEB_DIR = path.join(PROJECT_ROOT, 'web');
export const RUNS_DIR = path.join(PROJECT_ROOT, 'runs');
export const SUITES_DIR = path.join(RUNS_DIR, 'suites');
export const PROFILES_FILE = 'provider_profiles.json';
export const SEED_PATH = path.join(PROJECT_ROOT, 'src', 'data', 'seed_instances.json');
