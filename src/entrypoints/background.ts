import { computeDeadline, defer, keep as keepRecord, applyVideo, step, isYouTubeUrl, MIN, HOUR } from '@/lib/deadline';
import { badgeText, cleanTitle, formatLeft, hostOf, isTrackableUrl, timerLabel, clock } from '@/lib/format';
import { load, mutate, uid, type Db } from '@/lib/store';
import type { LogEntry, Msg, PopupState, TimerMode, Tracked, TrackResult } from '@/lib/types';

const TICK = 'tick';
const ORPHAN_GRACE = 2 * MIN;
const ICON = '/icon/128.png';
const COLORS = { accent: '#3E8C76', warn: '#B7791F', danger: '#B5534A' };

export default defineBackground({
  type: 'module',
  main() {
    // ── Listeners must be registered synchronously on every worker start ──
    browser.runtime.onInstalled.addListener(() => {
      setupMenus();
      void boot();
    });
    browser.runtime.onStartup.addListener(() => void boot());

    browser.alarms.onAlarm.addListener(() => void reconcile());

    browser.tabs.onCreated.addListener((tab) => void onTabCreated(tab));
    browser.tabs.onRemoved.addListener((tabId, info) => void onTabRemoved(tabId, info.isWindowClosing));
    browser.tabs.onReplaced.addListener((added, removed) =>
      void mutate((db) => {
        for (const t of Object.values(db.tracked)) if (t.tabId === removed) t.tabId = added;
      }),
    );
    browser.tabs.onUpdated.addListener((tabId, change, tab) => {
      if (change.url) void maybeAutoTrack(tabId);
      if (change.url || change.title || change.status === 'complete') void onTabUpdated(tabId, tab);
    });
    browser.tabs.onActivated.addListener(({ tabId }) => void maybeShowOverlay(tabId));
    browser.windows.onFocusChanged.addListener(async (windowId) => {
      if (windowId === browser.windows.WINDOW_ID_NONE) return;
      const [tab] = await browser.tabs.query({ active: true, windowId });
      if (tab?.id !== undefined) void maybeShowOverlay(tab.id);
    });

    browser.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
      handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;
    });

    browser.notifications.onButtonClicked.addListener((nid, idx) => void onNotificationButton(nid, idx));
    browser.notifications.onClicked.addListener((nid) => void onNotificationClick(nid));

    browser.contextMenus.onClicked.addListener((info, tab) => void onMenu(String(info.menuItemId), info, tab));
    browser.commands.onCommand.addListener((cmd, tab) => void onCommand(cmd, tab));

    // Every wake: storage is the source of truth, alarms are just a nudge.
    void boot();
  },
});

// ─────────────────────────── lifecycle ───────────────────────────

async function boot() {
  const a = await browser.alarms.get(TICK);
  if (!a) await browser.alarms.create(TICK, { periodInMinutes: 1 });
  // storage.session is wiped when the browser restarts (and on extension update):
  // tab ids from before can't be trusted, so every record must be re-matched by URL.
  const s = await browser.storage.session.get('booted');
  if (!s.booted) {
    await browser.storage.session.set({ booted: Date.now() });
    await mutate((db) => {
      for (const t of Object.values(db.tracked)) t.orphanSince ??= Date.now();
    });
  }
  await reconcile();
}

function setupMenus() {
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({ id: 'track-page', title: 'Track this tab', contexts: ['page'] });
    browser.contextMenus.create({ id: 'done-page', title: 'Mark this tab done', contexts: ['page'] });
    browser.contextMenus.create({ id: 'untrack-page', title: 'Stop tracking this tab', contexts: ['page'] });
    browser.contextMenus.create({ id: 'track-link', title: 'Open link as a tracked tab', contexts: ['link'] });
  });
}

// ─────────────────────────── auto-track ───────────────────────────

/** Tabs the browser restores right after it starts are old tabs, not new ones. */
const STARTUP_QUIET = 15_000;
/** Let tabs.create() calls of our own resolve before deciding a new tab is the user's. */
const SETTLE = 1_000;
/** Tabs Focusen opened itself (Undo, Reopen, link menu): they are tracked, or not, on purpose. */
const ownCreates = new Set<number>();
let lastFullNotice = 0;

async function createTab(props: Browser.tabs.CreateProperties) {
  const tab = await browser.tabs.create(props);
  if (tab.id !== undefined) ownCreates.add(tab.id);
  return tab;
}

async function pending(): Promise<number[]> {
  return ((await browser.storage.session.get('autoPending')).autoPending as number[] | undefined) ?? [];
}
let pendingChain: Promise<unknown> = Promise.resolve();
/** Serialised, so opening several links at once can't lose one. */
function setPending(fn: (ids: number[]) => number[]): Promise<void> {
  const run = pendingChain.then(async () => browser.storage.session.set({ autoPending: fn(await pending()) }));
  pendingChain = run.catch(() => undefined);
  return run;
}

/** A new tab waits here until it reaches a real page (a new tab page is not trackable yet). */
async function onTabCreated(tab: Browser.tabs.Tab) {
  if (tab.id === undefined || tab.incognito) return;
  const db = await load();
  if (!db.settings.autoTrack) return;
  const { booted } = await browser.storage.session.get('booted');
  if (typeof booted !== 'number' || Date.now() - booted < STARTUP_QUIET) return;
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  if (win?.type !== 'normal') return; // sign-in popups, app windows
  const id = tab.id;
  await setPending((ids) => [...ids.filter((x) => x !== id), id].slice(-50));
  await maybeAutoTrack(id);
}

async function maybeAutoTrack(tabId: number) {
  if (!(await pending()).includes(tabId)) return;
  await new Promise((r) => setTimeout(r, SETTLE));
  if (ownCreates.has(tabId)) return void setPending((ids) => ids.filter((x) => x !== tabId));
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return void setPending((ids) => ids.filter((x) => x !== tabId));
  if (!isTrackableUrl(tab.url || tab.pendingUrl)) return; // still on the new tab page: keep waiting
  if (!(await pending()).includes(tabId)) return; // another event got here first
  await setPending((ids) => ids.filter((x) => x !== tabId));
  const db = await load();
  if (!db.settings.autoTrack || (await findRecord(undefined, tabId))) return;
  const r = await track(tabId, db.settings.lastMode);
  if (!r.ok && r.reason === 'full') await refusedFull(tabId, db.settings.maxSlots);
}

/**
 * The list is full, so a new tab couldn't be tracked. Make that impossible to miss:
 * a "full" badge on the tab, and the popup's "Your list is full" picker (Mark done /
 * Drop it / Leave it untracked). A notification only if the popup can't be opened.
 */
async function refusedFull(tabId: number, max: number) {
  await setFull((ids) => [...ids.filter((x) => x !== tabId), tabId].slice(-50));
  await browser.action.setBadgeText({ tabId, text: 'full' }).catch(() => undefined);
  await browser.action.setBadgeBackgroundColor({ tabId, color: COLORS.danger }).catch(() => undefined);
  await browser.action.setTitle({ tabId, title: `Focusen — not tracked: your list is full (${max}/${max}). Click to make room.` }).catch(() => undefined);
  if (await showFullCard(tabId)) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab?.active) {
    await browser.storage.session.set({ pendingTrack: tabId });
    try {
      await browser.action.openPopup();
      return;
    } catch {
      await browser.storage.session.remove('pendingTrack');
    }
  }
  if (Date.now() - lastFullNotice < MIN) return;
  lastFullNotice = Date.now();
  await notify(`info:${uid()}`, {
    title: `Not tracked: your list is full (${max}/${max})`,
    message: 'Click Focusen on that tab to finish or drop one and make room.',
  });
}

/** The in-page "Your list is full" card, once the page has loaded. False if this site can't show it. */
async function showFullCard(tabId: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || !isTrackableUrl(tab.url)) return false;
  const db = await load();
  const now = Date.now();
  const left = (t: Tracked) => (t.state === 'warning' ? t.closeAt! : computeDeadline(t, db.settings)) - now;
  const items = Object.values(db.tracked).filter((t) => !t.orphanSince).sort((a, b) => left(a) - left(b));
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['/overlay.js'] });
    await browser.tabs.sendMessage(tabId, {
      type: 'overlay:full',
      title: (tab.title && cleanTitle(tab.title)) || hostOf(tab.url!),
      max: db.settings.maxSlots,
      items: items.slice(0, 4).map((t) => ({ id: t.id, title: t.title, host: hostOf(t.url), left: formatLeft(Math.max(0, left(t))) })),
      more: Math.max(0, items.length - 4),
    });
    return true;
  } catch {
    return false; // no access to this site (in-page cards on every site are opt-in)
  }
}

/** Back on a tab that was turned away: show the card again, or track it if there's room now. */
async function revisitFull(tabId: number) {
  const ids = ((await browser.storage.session.get('autoFull')).autoFull as number[] | undefined) ?? [];
  if (!ids.includes(tabId)) return;
  const db = await load();
  if (await findRecord(undefined, tabId)) return void setFull((x) => x.filter((y) => y !== tabId));
  if (db.settings.autoTrack && Object.keys(db.tracked).length < db.settings.maxSlots) {
    await track(tabId, db.settings.lastMode);
    return;
  }
  await showFullCard(tabId);
}

async function leaveUntracked(tabId: number) {
  await setFull((ids) => ids.filter((x) => x !== tabId));
  await browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
  await browser.action.setTitle({ tabId, title: 'Focusen' }).catch(() => undefined);
}

/** Tabs auto-track turned away because the list was full; the popup offers the picker for them. */
async function setFull(fn: (ids: number[]) => number[]) {
  const cur = ((await browser.storage.session.get('autoFull')).autoFull as number[] | undefined) ?? [];
  const next = fn(cur);
  if (next.length !== cur.length || next.some((x, i) => x !== cur[i])) await browser.storage.session.set({ autoFull: next });
}

// ─────────────────────────── reconcile ───────────────────────────

let reconciling: Promise<void> | null = null;
let again = false;

/** Re-read storage, re-match tabs, advance every record's phase, re-create alarms and badges. */
function reconcile(): Promise<void> {
  if (reconciling) {
    again = true;
    return reconciling;
  }
  reconciling = (async () => {
    do {
      again = false;
      await reconcileOnce();
    } while (again);
  })().finally(() => (reconciling = null));
  return reconciling;
}

type Effect = () => Promise<unknown>;

async function reconcileOnce() {
  const now = Date.now();
  const effects: Effect[] = [];
  await mutate(async (db) => {
    const tabs = await browser.tabs.query({});
    const byId = new Map(tabs.map((t) => [t.id!, t]));
    const claimed = new Set<number>();
    for (const t of Object.values(db.tracked)) if (!t.orphanSince && byId.has(t.tabId)) claimed.add(t.tabId);

    for (const rec of Object.values(db.tracked)) {
      let t = rec;
      // 1. Make sure the record still points at a real tab.
      if (t.orphanSince || !byId.has(t.tabId)) {
        const m = rematch(t, tabs, claimed);
        if (m) {
          claimed.add(m.id!);
          t = { ...t, tabId: m.id!, windowId: m.windowId!, index: m.index, orphanSince: undefined };
        } else {
          t = { ...t, orphanSince: t.orphanSince ?? now };
          if (now - t.orphanSince! > ORPHAN_GRACE) {
            // Never just vanish: a lost tab goes to Expired, where it can be reopened.
            db.log.unshift(toLog(t, db, 'expired', now, 'lost'));
            delete db.tracked[t.id];
            effects.push(() => browser.alarms.clear(`f:${t.id}`));
            continue;
          }
          db.tracked[t.id] = t;
          continue;
        }
      }
      // Keep URL and title fresh (a tab created then tracked before it loaded, missed events).
      const live = byId.get(t.tabId);
      if (live?.url && isTrackableUrl(live.url) && live.url !== t.url) t = { ...t, url: live.url };
      const liveTitle = live?.title && !/^https?:\/\//.test(live.title) ? cleanTitle(live.title) : '';
      if (liveTitle && liveTitle !== t.title) t = { ...t, title: liveTitle };
      // 2. Advance the phase.
      const r = step(t, db.settings, now);
      t = r.t;
      if (r.action === 'close') {
        const closed = await tryClose(t, db, now, byId, effects);
        if (closed) continue;
        t = db.tracked[t.id];
      } else {
        db.tracked[t.id] = t;
        if (r.action === 'enterWarning' || r.action === 'rewarn') effects.push(() => showWarning(t.id));
        if (r.action === 'exitWarning') effects.push(() => clearWarning(t));
      }
      const wakeAt = db.tracked[t.id]?.state === 'warning' ? db.tracked[t.id].closeAt! : r.wakeAt;
      effects.push(() => browser.alarms.create(`f:${t.id}`, { when: Math.max(wakeAt, Date.now() + 1000) }));
    }

    // Clear alarms that point at records that no longer exist.
    const alarms = await browser.alarms.getAll();
    for (const a of alarms) if (a.name.startsWith('f:') && !db.tracked[a.name.slice(2)]) effects.push(() => browser.alarms.clear(a.name));

    effects.push(() => updateBadges(db, now));
  });
  for (const e of effects) await e().catch((err) => console.warn('[focusen]', err));
}

function normUrl(u: string) {
  return u.split('#')[0];
}

function rematch(t: Tracked, tabs: Browser.tabs.Tab[], claimed: Set<number>) {
  const free = tabs.filter((x) => x.id !== undefined && !claimed.has(x.id) && x.url);
  const url = normUrl(t.url);
  return (
    free.find((x) => x.id === t.tabId && normUrl(x.url!) === url) ??
    free.find((x) => normUrl(x.url!) === url) ??
    free.find((x) => x.title === t.title && hostOf(x.url!) === hostOf(t.url)) ??
    null
  );
}

function toLog(t: Tracked, db: Db, kind: LogEntry['kind'], now: number, reason?: LogEntry['reason']): LogEntry {
  const deadline = computeDeadline(t, db.settings);
  return {
    id: uid(),
    kind,
    url: t.url,
    title: t.title,
    mode: t.mode,
    startedAt: t.startedAt,
    at: now,
    leftMs: kind === 'done' ? Math.max(0, deadline - now) : undefined,
    reopenCount: t.reopenCount,
    expireCount: kind === 'expired' ? t.reopenCount + 1 : undefined,
    reason,
    videoTime: t.video?.currentTime,
    snapshot: t,
  };
}

/** Close at the deadline — unless the tab is playing or fullscreen, then run another warning cycle. */
async function tryClose(t: Tracked, db: Db, now: number, byId: Map<number, Browser.tabs.Tab>, effects: Effect[]) {
  const tab = byId.get(t.tabId);
  let busy = !!tab?.audible;
  if (tab && !busy) {
    const win = await browser.windows.get(tab.windowId).catch(() => null);
    busy = win?.state === 'fullscreen';
  }
  if (busy) {
    const d = defer(t, db.settings, now);
    if (d) {
      db.tracked[t.id] = d;
      effects.push(() => showWarning(t.id, true));
      return false;
    }
  }
  const entry = toLog(t, db, 'expired', now, 'timer');
  db.log.unshift(entry);
  delete db.tracked[t.id];
  effects.push(() => browser.notifications.clear(`warn:${t.id}`));
  effects.push(() => removeTab(t.tabId));
  effects.push(() =>
    notify(`closed:${entry.id}`, {
      title: 'Tab closed — time ran out',
      message: t.title,
      buttons: t.reopenCount < 1 ? [{ title: 'Reopen with new timer' }] : undefined,
    }),
  );
  return true;
}

/** Closing the last tab of the last window would quit the browser; open a blank tab first. */
async function removeTab(tabId: number) {
  ownCloses.add(tabId);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const wins = await browser.windows.getAll({ populate: true, windowTypes: ['normal'] });
  if (wins.length === 1 && (wins[0].tabs?.length ?? 0) === 1) await browser.tabs.create({ windowId: tab.windowId });
  await browser.tabs.remove(tabId).catch(() => undefined);
}

const ownCloses = new Set<number>();

async function onTabRemoved(tabId: number, isWindowClosing: boolean) {
  ownCreates.delete(tabId);
  if ((await pending()).includes(tabId)) await setPending((ids) => ids.filter((x) => x !== tabId));
  await setFull((ids) => ids.filter((x) => x !== tabId));
  if (ownCloses.delete(tabId)) return;
  // Window closing may be the browser quitting: keep the record so it can be re-matched on restart.
  if (isWindowClosing) return;
  await mutate((db) => {
    for (const t of Object.values(db.tracked)) {
      if (t.tabId === tabId && !t.orphanSince) {
        delete db.tracked[t.id];
        void browser.alarms.clear(`f:${t.id}`);
        void browser.notifications.clear(`warn:${t.id}`);
      }
    }
  });
}

async function onTabUpdated(tabId: number, tab: Browser.tabs.Tab) {
  const db = await load();
  const hasOrphans = Object.values(db.tracked).some((t) => t.orphanSince);
  const rec = Object.values(db.tracked).find((t) => t.tabId === tabId && !t.orphanSince);
  if (rec && tab.url && isTrackableUrl(tab.url) && (rec.url !== tab.url || (tab.title && rec.title !== cleanTitle(tab.title)))) {
    await mutate((d) => {
      const t = d.tracked[rec.id];
      if (!t) return;
      if (tab.url) t.url = tab.url;
      if (tab.title && !/^https?:\/\//.test(tab.title)) t.title = cleanTitle(tab.title);
    });
  }
  if (rec || hasOrphans) await reconcile();
  else if (tab.status === 'complete') await updateBadges(db, Date.now());
}

// ─────────────────────────── badges ───────────────────────────

async function updateBadges(db: Db, now: number) {
  const action = browser.action;
  await action.setBadgeText({ text: '' });
  for (const t of Object.values(db.tracked)) {
    if (t.orphanSince) continue;
    const deadline = computeDeadline(t, db.settings);
    const warning = t.state === 'warning';
    const left = (warning ? t.closeAt! : deadline) - now;
    const color = warning ? COLORS.danger : left < HOUR ? COLORS.warn : COLORS.accent;
    await action.setBadgeText({ tabId: t.tabId, text: warning && left < MIN ? '!' : badgeText(Math.max(0, left)) }).catch(() => undefined);
    await action.setBadgeBackgroundColor({ tabId: t.tabId, color }).catch(() => undefined);
    await action.setBadgeTextColor?.({ tabId: t.tabId, color: '#FFFFFF' })?.catch(() => undefined);
    await action.setTitle({ tabId: t.tabId, title: `Focusen — ${warning ? 'closing at' : 'due'} ${clock(warning ? t.closeAt! : deadline)}` }).catch(() => undefined);
  }
}

// ─────────────────────────── warnings ───────────────────────────

const warnTitle = (ms: number) => {
  const m = Math.max(1, Math.round(ms / MIN));
  return `This tab closes in ${m} minute${m === 1 ? '' : 's'}`;
};

/** Visible tab → in-page overlay. Otherwise (other tab, other app, restricted page) → notification. */
async function showWarning(id: string, deferred = false) {
  const db = await load();
  const t = db.tracked[id];
  if (!t || t.state !== 'warning') return;
  const tab = await browser.tabs.get(t.tabId).catch(() => null);
  if (!tab) return;
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  const visible = tab.active && !!win?.focused;
  if (visible && (await showOverlay(t, db))) return;
  const canKeep = t.snoozes < db.settings.maxSnoozes;
  await notify(`warn:${t.id}`, {
    title: deferred ? `Still playing — ${warnTitle(t.closeAt! - Date.now()).toLowerCase()}` : warnTitle(t.closeAt! - Date.now()),
    message: t.title,
    buttons: [{ title: 'Done' }, ...(canKeep ? [{ title: 'Keep +1h' }] : [])],
    requireInteraction: true,
  });
}

async function showOverlay(t: Tracked, db: Db): Promise<boolean> {
  try {
    await browser.scripting.executeScript({ target: { tabId: t.tabId }, files: ['/overlay.js'] });
    await browser.tabs.sendMessage(t.tabId, {
      type: 'overlay:show',
      title: t.title,
      closeAt: t.closeAt,
      timer: timerLabel(t.mode === 'auto' && t.floor !== undefined && isYouTubeUrl(t.url) ? 'auto' : t.mode, true),
      endsAt: clock(t.closeAt!),
      canKeep: t.snoozes < db.settings.maxSnoozes,
      keepsLeft: db.settings.maxSnoozes - t.snoozes,
      total: db.settings.warnMinutes * MIN,
    });
    await browser.notifications.clear(`warn:${t.id}`);
    return true;
  } catch {
    return false; // chrome://, Web Store, PDF viewer, no host permission, discarded tab…
  }
}

async function maybeShowOverlay(tabId: number) {
  await revisitFull(tabId);
  const db = await load();
  const t = Object.values(db.tracked).find((x) => x.tabId === tabId && x.state === 'warning' && !x.orphanSince);
  if (t) await showOverlay(t, db);
}

async function clearWarning(t: Tracked) {
  await browser.notifications.clear(`warn:${t.id}`);
  await browser.tabs.sendMessage(t.tabId, { type: 'overlay:hide' }).catch(() => undefined);
}

async function notify(
  id: string,
  o: { title: string; message: string; buttons?: { title: string }[]; requireInteraction?: boolean },
) {
  const base = { type: 'basic' as const, iconUrl: browser.runtime.getURL(ICON as '/icon/128.png'), title: o.title, message: o.message, priority: 2 };
  try {
    await browser.notifications.create(id, {
      ...base,
      ...(o.buttons?.length ? { buttons: o.buttons } : {}),
      ...(o.requireInteraction ? { requireInteraction: true } : {}),
    });
  } catch {
    // Firefox has no buttons / requireInteraction; clicking the notification focuses the tab instead.
    await browser.notifications.create(id, base).catch(() => undefined);
  }
}

async function onNotificationButton(nid: string, idx: number) {
  await browser.notifications.clear(nid);
  const [kind, id] = nid.split(/:(.+)/);
  if (kind === 'warn') {
    if (idx === 0) await markDone(id);
    else await keepOpen(id);
  } else if (kind === 'closed' || kind === 'undo') {
    await undoOrReopen(id);
  } else if (kind === 'dropped') {
    await undoDrop(id);
  }
}

async function onNotificationClick(nid: string) {
  const [kind, id] = nid.split(/:(.+)/);
  if (kind === 'warn') {
    const db = await load();
    const t = db.tracked[id];
    if (!t) return;
    await browser.tabs.update(t.tabId, { active: true }).catch(() => undefined);
    await browser.windows.update(t.windowId, { focused: true }).catch(() => undefined);
  }
  await browser.notifications.clear(nid);
}

// ─────────────────────────── actions ───────────────────────────

async function track(
  tabId: number,
  mode: TimerMode,
  replace?: { id: string; action: 'done' | 'drop' },
  reopenCount = 0,
  /** For tabs we just created: their url/pendingUrl can still be empty. */
  knownUrl?: string,
): Promise<TrackResult> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, reason: 'missing' };
  const url = tab.url || tab.pendingUrl || knownUrl;
  if (!isTrackableUrl(url)) return { ok: false, reason: 'untrackable' };
  if (replace) {
    if (replace.action === 'done') await markDone(replace.id);
    else await drop(replace.id);
  }
  const res = await mutate<TrackResult>((db) => {
    db.settings.lastMode = mode;
    const existing = Object.values(db.tracked).find((t) => t.tabId === tabId && !t.orphanSince);
    if (existing) {
      existing.mode = mode;
      existing.state = 'active';
      existing.closeAt = undefined;
      return { ok: true, id: existing.id };
    }
    if (Object.keys(db.tracked).length >= db.settings.maxSlots) return { ok: false, reason: 'full' };
    const t: Tracked = {
      id: uid(),
      tabId,
      windowId: tab.windowId,
      index: tab.index,
      url: url!,
      title: (tab.title && !/^https?:\/\//.test(tab.title) && cleanTitle(tab.title)) || hostOf(url!),
      mode,
      startedAt: Date.now(),
      snoozes: 0,
      reopenCount,
      deferrals: 0,
      state: 'active',
    };
    db.tracked[t.id] = t;
    return { ok: true, id: t.id };
  });
  if (res.ok && (((await browser.storage.session.get('autoFull')).autoFull as number[] | undefined) ?? []).includes(tabId)) {
    await setFull((ids) => ids.filter((x) => x !== tabId));
    await browser.tabs.sendMessage(tabId, { type: 'overlay:hide' }).catch(() => undefined);
  }
  if (res.ok && isYouTubeUrl(url!)) void askForVideo(tabId);
  await reconcile();
  return res;
}

/** Ask the YouTube content script for the current video; inject it if the tab predates the install. */
async function askForVideo(tabId: number) {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'report' });
  } catch {
    await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/youtube.js'] }).catch(() => undefined);
  }
}

async function findRecord(id?: string, tabId?: number): Promise<Tracked | undefined> {
  const db = await load();
  if (id) return db.tracked[id];
  return Object.values(db.tracked).find((t) => t.tabId === tabId && !t.orphanSince);
}

/** Done = recorded as finished, then the tab closes (with an Undo). */
async function markDone(id: string) {
  const entry = await mutate((db) => {
    const t = db.tracked[id];
    if (!t) return null;
    const e = toLog(t, db, 'done', Date.now());
    db.log.unshift(e);
    delete db.tracked[id];
    return e;
  });
  if (!entry) return;
  const t = entry.snapshot!;
  await browser.alarms.clear(`f:${id}`);
  await browser.notifications.clear(`warn:${id}`);
  await browser.tabs.sendMessage(t.tabId, { type: 'overlay:hide' }).catch(() => undefined);
  await removeTab(t.tabId);
  await notify(`undo:${entry.id}`, { title: 'Done — nice.', message: t.title, buttons: [{ title: 'Undo' }] });
  await reconcile();
}

async function drop(id: string) {
  const t = await mutate((db) => {
    const t = db.tracked[id];
    delete db.tracked[id];
    return t;
  });
  if (!t) return;
  await browser.storage.session.set({ [`dropped:${t.id}`]: t });
  await browser.alarms.clear(`f:${id}`);
  await removeTab(t.tabId);
  await notify(`dropped:${t.id}`, { title: 'Dropped', message: t.title, buttons: [{ title: 'Undo' }] });
  await reconcile();
}

/** Stop tracking without closing: no timer, no log entry, the tab stays open. */
async function untrack(id: string): Promise<boolean> {
  const t = await mutate((db) => {
    const t = db.tracked[id];
    delete db.tracked[id];
    return t;
  });
  if (!t) return false;
  await browser.alarms.clear(`f:${id}`);
  await browser.notifications.clear(`warn:${id}`);
  await browser.tabs.sendMessage(t.tabId, { type: 'overlay:hide' }).catch(() => undefined);
  await browser.action.setBadgeText({ tabId: t.tabId, text: '' }).catch(() => undefined);
  await browser.action.setTitle({ tabId: t.tabId, title: 'Focusen' }).catch(() => undefined);
  await reconcile();
  return true;
}

async function undoDrop(id: string) {
  const key = `dropped:${id}`;
  const t = (await browser.storage.session.get(key))[key] as Tracked | undefined;
  if (!t) return;
  await browser.storage.session.remove(key);
  const tab = await createTab({ url: t.url });
  await mutate((db) => {
    db.tracked[t.id] = { ...t, tabId: tab.id!, windowId: tab.windowId!, index: tab.index, orphanSince: undefined };
  });
  await reconcile();
}

async function keepOpen(id: string) {
  const t = await mutate((db) => {
    const t = db.tracked[id];
    if (!t) return null;
    const k = keepRecord(t, db.settings, Date.now());
    if (!k) return null;
    db.tracked[id] = k;
    return k;
  });
  if (t) await clearWarning(t);
  await reconcile();
}

/**
 * Undo for Done restores the exact timer. Reopen for an expired tab starts a new timer
 * and uses its one second chance.
 */
async function undoOrReopen(logId: string): Promise<boolean> {
  const db = await load();
  const e = db.log.find((x) => x.id === logId);
  if (!e) return false;
  if (e.kind === 'done' && e.snapshot) {
    const tab = await createTab({ url: e.url });
    await mutate((d) => {
      d.log = d.log.filter((x) => x.id !== logId);
      const s = e.snapshot!;
      d.tracked[s.id] = { ...s, tabId: tab.id!, windowId: tab.windowId!, index: tab.index, orphanSince: undefined, state: 'active', closeAt: undefined };
    });
    await reconcile();
    return true;
  }
  if (e.kind === 'expired' && e.reopenCount < 1) {
    const url = resumeUrl(e);
    const tab = await createTab({ url });
    const r = await track(tab.id!, e.mode, undefined, 1, url);
    if (!r.ok && r.reason !== 'full') return false; // keep the entry: nothing was lost
    // The tab is open again either way, so the Expired entry has done its job.
    await mutate((d) => {
      d.log = d.log.filter((x) => x.id !== logId);
    });
    if (!r.ok) await notify(`full:${uid()}`, { title: 'Your list is full', message: 'Reopened without a timer. Finish or drop a tab to track it.' });
    return true;
  }
  return false;
}

/** Resume a YouTube video where it was left (Ovsiankina: people want to pick it back up). */
function resumeUrl(e: LogEntry): string {
  if (!e.videoTime || !isYouTubeUrl(e.url) || e.videoTime < 5) return e.url;
  try {
    const u = new URL(e.url);
    u.searchParams.set('t', `${Math.floor(e.videoTime)}s`);
    return u.toString();
  } catch {
    return e.url;
  }
}

async function onMenu(id: string, info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab) {
  const db = await load();
  if (id === 'track-page' && tab?.id !== undefined) {
    const r = await track(tab.id, db.settings.lastMode);
    if (!r.ok) await explainFailure(r.reason, tab.id);
  } else if (id === 'done-page' && tab?.id !== undefined) {
    const t = await findRecord(undefined, tab.id);
    if (t) await markDone(t.id);
    else await notify(`info:${uid()}`, { title: 'This tab isn’t tracked', message: 'Track it first to give it a deadline.' });
  } else if (id === 'untrack-page' && tab?.id !== undefined) {
    const t = await findRecord(undefined, tab.id);
    if (t) await untrack(t.id);
  } else if (id === 'track-link' && info.linkUrl) {
    const nt = await createTab({ url: info.linkUrl, active: false, index: tab ? tab.index + 1 : undefined });
    const r = await track(nt.id!, db.settings.lastMode, undefined, 0, info.linkUrl);
    if (!r.ok && r.reason === 'full')
      await notify(`info:${uid()}`, { title: 'Your list is full', message: 'Opened without tracking. Finish or drop a tab to make room.' });
  }
}

async function onCommand(cmd: string, tab?: Browser.tabs.Tab) {
  const active = tab ?? (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!active?.id) return;
  const db = await load();
  if (cmd === 'track-tab') {
    const r = await track(active.id, db.settings.lastMode);
    if (!r.ok) await explainFailure(r.reason, active.id);
  } else if (cmd === 'mark-done') {
    const t = await findRecord(undefined, active.id);
    if (t) await markDone(t.id);
  }
}

async function explainFailure(reason: string, tabId: number) {
  if (reason === 'full') {
    // Let the popup show the "Your list is full" picker if we can open it.
    await browser.storage.session.set({ pendingTrack: tabId });
    try {
      await browser.action.openPopup();
      return;
    } catch {
      /* needs a focused window on some versions */
    }
    await notify(`info:${uid()}`, { title: 'Your list is full', message: 'Finish or drop a tracked tab before adding another. Open Focusen to choose.' });
  } else if (reason === 'untrackable') {
    await notify(`info:${uid()}`, { title: 'Can’t track this page', message: 'Browser pages and the extension store can’t be tracked.' });
  }
}

// ─────────────────────────── messages ───────────────────────────

async function handle(msg: Msg, sender: Browser.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'state': {
      await reconcile();
      const db = await load();
      const deadlines: Record<string, number> = {};
      for (const t of Object.values(db.tracked)) deadlines[t.id] = t.state === 'warning' ? t.closeAt! : computeDeadline(t, db.settings);
      const st: PopupState = { now: Date.now(), settings: db.settings, tracked: Object.values(db.tracked), log: db.log, deadlines };
      return st;
    }
    case 'track':
      return track(msg.tabId, msg.mode, msg.replace);
    case 'done': {
      const t = await findRecord(msg.id, msg.tabId ?? sender.tab?.id);
      if (t) await markDone(t.id);
      return { ok: !!t };
    }
    case 'keep': {
      const t = await findRecord(msg.id, msg.tabId ?? sender.tab?.id);
      if (t) await keepOpen(t.id);
      return { ok: !!t };
    }
    case 'untrack': {
      const t = await findRecord(msg.id, msg.tabId ?? sender.tab?.id);
      return { ok: !!t && (await untrack(t.id)) };
    }
    case 'fullChoice': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false };
      if (!msg.replace) {
        await leaveUntracked(tabId);
        return { ok: true };
      }
      const db = await load();
      return track(tabId, db.settings.lastMode, msg.replace);
    }
    case 'reopen':
      return { ok: await undoOrReopen(msg.logId) };
    case 'openUrl':
      await browser.tabs.create({ url: msg.url });
      return { ok: true };
    case 'clearLog':
      await mutate((db) => {
        db.log = db.log.filter((e) => e.kind !== msg.kind);
      });
      return { ok: true };
    case 'setMode':
      await mutate((db) => {
        db.settings.lastMode = msg.mode;
      });
      return { ok: true };
    case 'dismissOverlay':
      return { ok: true };
    case 'video': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false };
      const changed = await mutate((db) => {
        const t = Object.values(db.tracked).find((x) => x.tabId === tabId && !x.orphanSince);
        if (!t) return false;
        const before = computeDeadline(t, db.settings);
        db.tracked[t.id] = applyVideo(t, msg.video, Date.now());
        return computeDeadline(db.tracked[t.id], db.settings) !== before;
      });
      if (changed) await reconcile();
      return { ok: true };
    }
  }
}
