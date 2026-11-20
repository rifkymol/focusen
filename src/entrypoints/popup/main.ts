import './style.css';
import { icon, kindIcon } from '@/lib/icons';
import {
  TIMER_CHOICES, clock, dayLabel, formatDuration, formatLeft, hostOf, isTrackableUrl, plural, relDay,
  siteColor, siteKind, startOfDay, timerLabel,
} from '@/lib/format';
import { DAY, HOUR, isYouTubeUrl } from '@/lib/deadline';
import type { LogEntry, Msg, PopupState, TimerMode, Tracked, TrackResult } from '@/lib/types';

type View = 'active' | 'done' | 'expired';

const app = document.getElementById('app')!;
let st: PopupState | null = null;
let current: { tabId: number; url: string; title: string } | null = null;
let view: View = (safeGet('focusen:view') as View) || 'active';
let menuOpen = false;
let full: { tabId: number; title: string } | null = null;
let pick: string | null = null;
let showAllPicks = false;
let confirmClear = false;
let busy = false;

function safeGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}

const send = <T = unknown>(m: Msg) => browser.runtime.sendMessage(m) as Promise<T>;

// ───────── tiny DOM helper ─────────
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

function fav(url: string, size: 34 | 28 | 24, dim = '') {
  const glyph = size === 34 ? 18 : size === 28 ? 14 : 12;
  return h('span', { class: `fav s${size} ${dim}`, style: `background:${siteColor(url)}` }, icon(kindIcon(siteKind(url)), glyph));
}

// ───────── data ─────────
async function refresh() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  current = tab?.id !== undefined ? { tabId: tab.id, url: tab.url ?? '', title: tab.title ?? '' } : null;
  st = await send<PopupState>({ type: 'state' });
  render();
}

function trackedSorted(): Tracked[] {
  if (!st) return [];
  return [...st.tracked].sort((a, b) => (st!.deadlines[a.id] ?? 0) - (st!.deadlines[b.id] ?? 0));
}

function stats(now: number) {
  const log = st?.log ?? [];
  const today = startOfDay(now);
  const done = log.filter((e) => e.kind === 'done');
  const finishedToday = done.filter((e) => e.at >= today).length;
  let best = 0;
  for (let i = 0; i < 7; i++) {
    const from = today - i * DAY;
    best = Math.max(best, done.filter((e) => e.at >= from && e.at < from + DAY).length);
  }
  const weekFrom = today - 6 * DAY;
  return {
    finishedToday,
    best,
    weekDone: done.filter((e) => e.at >= weekFrom).length,
    weekExpired: log.filter((e) => e.kind === 'expired' && e.at >= weekFrom).length,
  };
}

// ───────── render ─────────
function render() {
  if (!st) return;
  const focused = document.activeElement?.getAttribute('data-key');
  app.replaceChildren(...(full ? renderFull() : [renderHeader(), renderSegmented(), ...renderView()]));
  if (focused) (app.querySelector(`[data-key="${focused}"]`) as HTMLElement | null)?.focus();
}

function renderHeader() {
  const now = Date.now();
  const s = stats(now);
  const used = st!.tracked.length;
  const max = st!.settings.maxSlots;
  return h('header', { class: 'header' },
    h('div', { class: 'brand-row' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }, icon('hourglass', 13)), h('span', { class: 'app-name' }, 'Focusen')),
      h('button', { class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', onclick: () => browser.runtime.openOptionsPage() }, icon('settings', 16)),
    ),
    h('div', { class: 'today' },
      h('div', { class: 'stat' },
        h('div', { class: 'stat-line' }, h('span', { class: 'count' }, String(s.finishedToday)), h('span', { class: 'count-label' }, 'finished today')),
        h('span', { class: 'streak' }, s.best > 0 ? `Best this week: ${s.best} · Keep the list short.` : 'Pick a tab. Give it a deadline. Finish it.'),
      ),
      h('div', { class: 'slots', title: `${used} of ${max} tabs tracked` },
        h('span', { class: 'slots-label' }, `${used} / ${max} slots`),
        h('div', { class: 'dots', 'aria-hidden': 'true' },
          Array.from({ length: max }, (_, i) => h('span', { class: `dot ${i < used ? (used >= max ? 'full' : 'on') : ''}` })),
        ),
      ),
    ),
  );
}

function renderSegmented() {
  const log = st!.log;
  const counts: Record<View, number> = {
    active: st!.tracked.length,
    done: log.filter((e) => e.kind === 'done' && e.at >= startOfDay(Date.now()) - 6 * DAY).length,
    expired: log.filter((e) => e.kind === 'expired').length,
  };
  const label: Record<View, string> = { active: 'Active', done: 'Done', expired: 'Expired' };
  return h('div', { class: 'segmented' },
    h('div', { class: 'seg-track', role: 'tablist', 'aria-label': 'Lists' },
      (['active', 'done', 'expired'] as View[]).map((v) =>
        h('button', {
          class: 'seg', role: 'tab', 'aria-selected': String(view === v), 'data-key': `seg-${v}`,
          onclick: () => { view = v; confirmClear = false; menuOpen = false; safeSet('focusen:view', v); render(); },
        }, `${label[v]} · ${counts[v]}`),
      ),
    ),
  );
}

function renderView(): HTMLElement[] {
  if (view === 'done') return renderDone();
  if (view === 'expired') return renderExpired();
  return renderActive();
}

function tone(t: Tracked, left: number) {
  if (t.state === 'warning') return 't-danger';
  return left < HOUR ? 't-warn' : '';
}

function renderActive(): HTMLElement[] {
  const now = Date.now();
  const items = trackedSorted();
  const list = h('div', { class: 'list' });
  if (!items.length) {
    list.append(h('div', { class: 'empty' },
      h('span', { class: 'badge' }, icon('hourglass', 19)),
      h('h3', {}, 'No tabs on the clock'),
      h('p', {}, 'Track a tab you mean to finish. If you don’t get to it in time, it closes — and waits in Expired.'),
    ));
  }
  for (const t of items) {
    const deadline = st!.deadlines[t.id];
    const left = Math.max(0, deadline - now);
    const span = Math.max(1, (t.state === 'warning' ? deadline : deadline) - t.startedAt);
    const pct = Math.max(2, Math.min(100, (left / span) * 100));
    const tn = tone(t, left);
    const isCurrent = current?.tabId === t.tabId && !t.orphanSince;
    const extra = t.video?.duration && isYouTubeUrl(t.url) ? ` · ${formatDuration(t.video.duration)}` : '';
    const leftText = t.orphanSince ? 'Reconnecting…' : t.state === 'warning' ? `Closing in ${formatLeft(left)}` : `${formatLeft(left)} left`;
    list.append(h('div', { class: `row ${isCurrent ? 'current' : ''} ${t.state === 'warning' ? 'warning' : ''}` },
      fav(t.url, 34),
      h('div', { class: 'info' },
        h('button', { class: 'title', title: t.title, 'data-key': `go-${t.id}`, onclick: () => focusTab(t) }, t.title),
        h('div', { class: `meta ${tn}` },
          icon('timer', 12),
          h('span', { class: 'left', title: `Due ${clock(deadline)}` }, leftText),
          h('span', { class: 'domain' }, `· ${hostOf(t.url)}${extra}`),
          isCurrent && h('span', { class: 'chip' }, 'This tab'),
        ),
        h('div', { class: 'bar-track' }, h('div', { class: `bar ${tn}`, style: `width:${pct}%` })),
      ),
      h('div', { class: 'acts' },
        h('button', { class: 'done-btn', 'data-key': `done-${t.id}`, 'aria-label': `Mark “${t.title}” done`, onclick: () => act({ type: 'done', id: t.id }) },
          icon('check', 13), 'Done'),
        h('button', { class: 'untrack-btn', 'data-key': `untrack-${t.id}`, 'aria-label': `Stop tracking “${t.title}”`, title: 'Stop tracking (the tab stays open)', onclick: () => act({ type: 'untrack', id: t.id }) },
          icon('x', 14)),
      ),
    ));
  }
  return [list, renderFooter(), renderHint()];
}

function renderFooter() {
  const mode = st!.settings.lastMode;
  const rec = current ? st!.tracked.find((t) => t.tabId === current!.tabId && !t.orphanSince) : undefined;
  const trackable = !!current && isTrackableUrl(current.url);
  const currentMode = rec ? rec.mode : mode;
  let primary: HTMLElement;
  if (rec) {
    primary = h('button', { class: 'primary', 'data-key': 'primary', onclick: () => act({ type: 'done', id: rec.id }) }, icon('check', 15), 'Done with this tab');
  } else if (!trackable) {
    primary = h('button', { class: 'primary', disabled: true, title: 'Browser pages can’t be tracked' }, 'Can’t track this page');
  } else {
    primary = h('button', { class: 'primary', 'data-key': 'primary', onclick: () => trackCurrent(currentMode) }, icon('plus', 15), 'Track this tab');
  }
  const footer = h('div', { class: 'footer' },
    primary,
    h('button', {
      class: 'picker', 'aria-haspopup': 'menu', 'aria-expanded': String(menuOpen), 'aria-label': `Timer: ${timerLabel(currentMode, true)}`,
      'data-key': 'picker', disabled: !trackable && !rec ? true : undefined,
      onclick: () => { menuOpen = !menuOpen; render(); if (menuOpen) (app.querySelector('.menu button[aria-checked="true"]') as HTMLElement)?.focus(); },
    }, timerLabel(currentMode), icon('chevron', 14)),
  );
  if (menuOpen) {
    const def = timerLabel(st!.settings.defaultMinutes, true);
    footer.append(h('ul', { class: 'menu', role: 'menu', onkeydown: menuKeys },
      TIMER_CHOICES.map((m) => h('li', { role: 'none' },
        h('button', {
          role: 'menuitemradio', 'aria-checked': String(m === currentMode),
          onclick: async () => {
            menuOpen = false;
            if (rec) await act({ type: 'track', tabId: rec.tabId, mode: m });
            else { await send({ type: 'setMode', mode: m }); await refresh(); }
            (app.querySelector('[data-key="picker"]') as HTMLElement)?.focus();
          },
        }, timerLabel(m, true), m === 'auto' ? h('span', { class: 'sub' }, `video · else ${def}`) : null),
      )),
    ));
  }
  return footer;
}

function menuKeys(e: KeyboardEvent) {
  const items = [...app.querySelectorAll<HTMLElement>('.menu button')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'Escape') { e.preventDefault(); menuOpen = false; render(); (app.querySelector('[data-key="picker"]') as HTMLElement)?.focus(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
}

function renderHint() {
  const def = timerLabel(st!.settings.defaultMinutes, true);
  return h('div', { class: 'hint' }, icon('info', 12),
    h('span', {}, st!.settings.autoTrack
      ? `New tabs are tracked automatically. Auto: YouTube gets the video length + 10 min, others ${def}.`
      : `Auto: YouTube gets the video length + 10 min (max 1 day). Others get ${def}.`));
}

function groupByDay(entries: LogEntry[], now: number) {
  const groups = new Map<string, LogEntry[]>();
  for (const e of entries) {
    const k = dayLabel(e.at, now);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  return groups;
}

function renderDone(): HTMLElement[] {
  const now = Date.now();
  const done = st!.log.filter((e) => e.kind === 'done').sort((a, b) => b.at - a.at);
  const list = h('div', { class: 'list' });
  if (!done.length) {
    list.append(h('div', { class: 'empty' },
      h('span', { class: 'badge' }, icon('check', 19)),
      h('h3', {}, 'Nothing finished yet'),
      h('p', {}, 'Hit Done when you’ve read it or watched it. Finished tabs land here.'),
    ));
  }
  for (const [label, items] of groupByDay(done, now)) {
    list.append(h('div', { class: 'day-label' }, label));
    for (const e of items) {
      const early = e.leftMs && e.leftMs >= 60_000 ? ` · ${formatLeft(e.leftMs)} before close` : '';
      list.append(h('button', { class: 'done-item', title: `Open ${e.url}`, onclick: () => send({ type: 'openUrl', url: e.url }) },
        fav(e.url, 28, 'dim'),
        h('div', { class: 'info' }, h('span', { class: 't' }, e.title), h('span', { class: 'm' }, `Finished ${clock(e.at)}${early}`)),
        h('span', { class: 'done-check', 'aria-label': 'Done' }, icon('check', 12)),
      ));
    }
  }
  const s = stats(now);
  return [list, renderSummary(`This week: ${s.weekDone} finished · ${s.weekExpired} expired`, 'done', done.length > 0)];
}

function renderExpired(): HTMLElement[] {
  const now = Date.now();
  const exp = st!.log.filter((e) => e.kind === 'expired').sort((a, b) => b.at - a.at);
  const list = h('div', { class: 'list' });
  if (!exp.length) {
    list.append(h('div', { class: 'empty' },
      h('span', { class: 'badge' }, icon('timerOff', 19)),
      h('h3', {}, 'Nothing expired'),
      h('p', {}, 'Tabs that run out of time close here, so you can bring one back if it still matters.'),
    ));
  }
  for (const e of exp) {
    const used = e.reopenCount >= 1;
    const when = `${relDay(e.at, now)} ${clock(e.at)}`;
    const meta = used
      ? 'Expired twice · reopened once'
      : e.reason === 'lost'
        ? `Lost after a restart · ${when}`
        : `Expired ${when} · ${timerLabel(e.mode, true)}`;
    list.append(h('div', { class: `exp-item ${used ? 'used' : ''}` },
      h('div', { class: 'top' },
        fav(e.url, 28, used ? 'dimmer' : ''),
        h('div', { class: 'info' },
          h('button', { class: 'title', title: `Open ${e.url} without a timer`, onclick: () => send({ type: 'openUrl', url: e.url }) }, e.title),
          h('div', { class: 'm' }, icon('timerOff', 11), h('span', {}, meta)),
        ),
      ),
      used
        ? h('div', { class: 'used-note' }, icon('lock', 12), h('span', {}, 'Second chance used. Let this one go.'))
        : h('button', { class: 'reopen', 'data-key': `reopen-${e.id}`, onclick: () => act({ type: 'reopen', logId: e.id }) },
            icon('reopen', 13), 'Reopen with new timer', h('span', { class: 'once' }, '1× only')),
    ));
  }
  if (exp.length) list.append(h('div', { class: 'tip' }, 'Each tab gets one second chance. If it expires again, it probably wasn’t that important.'));
  return [list, renderSummary(`Expired tabs close for good after ${plural(st!.settings.expiredKeepDays, 'day')}`, 'expired', exp.length > 0)];
}

function renderSummary(text: string, kind: 'done' | 'expired', canClear: boolean) {
  return h('div', { class: 'summary' }, h('span', {}, text),
    canClear && h('button', {
      class: `link ${confirmClear ? 'confirm' : ''}`, 'data-key': 'clear',
      onclick: async () => {
        if (!confirmClear) {
          confirmClear = true;
          render();
          setTimeout(() => { confirmClear = false; render(); }, 3000);
          return;
        }
        confirmClear = false;
        await act({ type: 'clearLog', kind });
      },
    }, confirmClear ? 'Clear for good?' : 'Clear log'));
}

// ───────── tab limit prompt ─────────
function renderFull(): HTMLElement[] {
  const items = trackedSorted();
  const max = st!.settings.maxSlots;
  if (!pick || !items.some((t) => t.id === pick)) pick = items[0]?.id ?? null;
  const shown = showAllPicks ? items : items.slice(0, 3);
  const now = Date.now();
  const leftShort = (t: Tracked) => {
    const l = Math.max(0, st!.deadlines[t.id] - now);
    return l < HOUR ? `${Math.max(1, Math.floor(l / 60_000))}m` : `${Math.floor(l / HOUR)}h`;
  };
  return [
    h('div', { class: 'full-header' },
      h('span', { class: 'icon-badge' }, icon('layers', 19)),
      h('h1', {}, 'Your list is full'),
      h('p', {}, `You’re tracking ${items.length} of ${max} tabs. Finish or drop one before adding “${full!.title}”.`),
      h('div', { class: 'dots big', 'aria-hidden': 'true' }, Array.from({ length: max }, () => h('span', { class: 'dot full' }))),
    ),
    h('div', { class: 'pick-list', role: 'radiogroup', 'aria-label': 'Choose a tab to free up' },
      shown.map((t) => h('label', { class: `pick ${pick === t.id ? 'sel' : ''}` },
        h('input', { type: 'radio', name: 'pick', value: t.id, checked: pick === t.id, onchange: () => { pick = t.id; render(); }, 'data-key': `pick-${t.id}` }),
        fav(t.url, 24),
        h('span', { class: 't', title: t.title }, t.title),
        h('span', { class: 'l' }, leftShort(t)),
      )),
      items.length > 3 && !showAllPicks && h('button', { class: 'more', onclick: () => { showAllPicks = true; render(); } }, `+ ${plural(items.length - 3, 'more tracked tab')}`),
    ),
    h('div', { class: 'full-actions' },
      h('div', { class: 'row2' },
        h('button', { class: 'primary', 'data-key': 'full-done', onclick: () => replaceAndTrack('done') }, icon('check', 14), 'Mark done'),
        h('button', { class: 'drop', onclick: () => replaceAndTrack('drop') }, icon('trash', 14), 'Drop it'),
      ),
      h('button', { class: 'cancel', onclick: () => void leaveUntracked() }, 'Leave it untracked'),
    ),
  ];
}

// ───────── actions ─────────
async function act(m: Msg) {
  if (busy) return;
  busy = true;
  try {
    await send(m);
  } finally {
    busy = false;
  }
  await refresh();
}

async function trackCurrent(mode: TimerMode) {
  if (!current) return;
  const r = await send<TrackResult>({ type: 'track', tabId: current.tabId, mode });
  if (!r.ok && r.reason === 'full') {
    full = { tabId: current.tabId, title: current.title || hostOf(current.url) };
    pick = null;
    showAllPicks = false;
  }
  await refresh();
}

async function replaceAndTrack(action: 'done' | 'drop') {
  if (!full || !pick) return;
  const target = full;
  full = null;
  await send<TrackResult>({ type: 'track', tabId: target.tabId, mode: st!.settings.lastMode, replace: { id: pick, action } });
  view = 'active';
  await refresh();
}

/** Close the picker; an auto-track refusal is answered, so drop its badge and stop asking. */
async function leaveUntracked() {
  const tabId = full?.tabId;
  full = null;
  render();
  if (tabId === undefined) return;
  const s = await browser.storage.session.get('autoFull').catch(() => ({} as Record<string, unknown>));
  const ids = (s.autoFull as number[] | undefined) ?? [];
  if (ids.includes(tabId)) {
    await browser.storage.session.set({ autoFull: ids.filter((x) => x !== tabId) });
    await browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
    await browser.action.setTitle({ tabId, title: 'Focusen' }).catch(() => undefined);
    await browser.tabs.sendMessage(tabId, { type: 'overlay:hide' }).catch(() => undefined);
  }
}

async function focusTab(t: Tracked) {
  await browser.tabs.update(t.tabId, { active: true }).catch(() => undefined);
  await browser.windows.update(t.windowId, { focused: true }).catch(() => undefined);
  window.close();
}

// ───────── boot ─────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && full) void leaveUntracked();
});
browser.storage.onChanged.addListener((_c, area) => { if (area === 'local') void refresh(); });
setInterval(render, 15_000);

(async () => {
  const s = await browser.storage.session.get(['pendingTrack', 'autoFull']).catch(() => ({} as Record<string, unknown>));
  let pending = s.pendingTrack as number | undefined;
  if (pending !== undefined) await browser.storage.session.remove('pendingTrack');
  await refresh();
  // A tab auto-track turned away (list full): opening Focusen on it brings the picker back.
  // refresh() sets these; TypeScript can't see that through the await.
  const cur = current as { tabId: number } | null;
  const state = st as PopupState | null;
  if (pending === undefined && cur && ((s.autoFull as number[] | undefined) ?? []).includes(cur.tabId)) pending = cur.tabId;
  if (pending !== undefined && !state?.tracked.some((t) => t.tabId === pending && !t.orphanSince)) {
    const tab = await browser.tabs.get(pending).catch(() => null);
    if (tab) {
      full = { tabId: pending, title: tab.title || hostOf(tab.url ?? '') };
      render();
    }
  }
})();
