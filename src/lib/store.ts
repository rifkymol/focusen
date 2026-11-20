import { DAY } from './deadline';
import { DEFAULT_SETTINGS, type LogEntry, type Settings, type Tracked } from './types';

export interface Db {
  tracked: Record<string, Tracked>;
  log: LogEntry[];
  settings: Settings;
}

const KEYS = ['tracked', 'log', 'settings'] as const;
const LOG_KEEP_DAYS = 60;

export async function load(): Promise<Db> {
  const r = await browser.storage.local.get([...KEYS]);
  return {
    tracked: (r.tracked as Db['tracked']) ?? {},
    log: (r.log as LogEntry[]) ?? [],
    settings: { ...DEFAULT_SETTINGS, ...((r.settings as Partial<Settings>) ?? {}) },
  };
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Serialised read-modify-write. All background mutations go through here so two
 * events arriving together (alarm + tab update) can't overwrite each other.
 */
export function mutate<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const db = await load();
    const before = { tracked: JSON.stringify(db.tracked), log: JSON.stringify(db.log), settings: JSON.stringify(db.settings) };
    const out = await fn(db);
    prune(db, Date.now());
    // Only write what changed, so a concurrent write from the options page (settings) isn't clobbered.
    const patch: Partial<Db> = {};
    for (const k of KEYS) if (JSON.stringify(db[k]) !== before[k]) (patch as Record<string, unknown>)[k] = db[k];
    if (Object.keys(patch).length) await browser.storage.local.set(patch);
    return out;
  });
  chain = run.catch(() => undefined);
  return run;
}

export function prune(db: Db, now: number) {
  db.log = db.log.filter((e) =>
    e.kind === 'expired'
      ? now - e.at < db.settings.expiredKeepDays * DAY
      : now - e.at < LOG_KEEP_DAYS * DAY,
  );
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
