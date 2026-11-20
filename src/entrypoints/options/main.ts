import '../../assets/tokens.css';
import './style.css';
import { icon } from '@/lib/icons';
import { timerLabel } from '@/lib/format';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
$('mark').append(icon('hourglass', 18));

const OPTIONS: Record<'defaultMinutes' | 'maxSlots' | 'warnMinutes' | 'maxSnoozes', [number, string][]> = {
  defaultMinutes: [60, 120, 240, 480, 720, 1440].map((m) => [m, timerLabel(m, true)]),
  maxSlots: [3, 4, 5, 6, 8, 10].map((n) => [n, `${n} tabs`]),
  warnMinutes: [2, 5, 10, 15].map((n) => [n, `${n} minutes`]),
  maxSnoozes: [0, 1, 2, 3, 5].map((n) => [n, n === 0 ? 'None' : `${n}×`]),
};

async function settings(): Promise<Settings> {
  const r = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...((r.settings as Partial<Settings>) ?? {}) };
}

let savedTimer: number | undefined;
function flash(text: string) {
  const el = $('saved');
  el.textContent = text;
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (el.textContent = ''), 1800);
}

(async () => {
  const s = await settings();
  for (const key of Object.keys(OPTIONS) as (keyof typeof OPTIONS)[]) {
    const sel = $<HTMLSelectElement>(key);
    for (const [v, label] of OPTIONS[key]) sel.append(new Option(label, String(v), false, s[key] === v));
    if (![...sel.options].some((o) => o.selected)) sel.append(new Option(String(s[key]), String(s[key]), true, true));
    sel.onchange = async () => {
      const cur = await settings();
      await browser.storage.local.set({ settings: { ...cur, [key]: Number(sel.value) } });
      flash('Saved');
    };
  }

  const auto = $<HTMLButtonElement>('autoTrack');
  auto.setAttribute('aria-checked', String(s.autoTrack));
  auto.onclick = async () => {
    const on = auto.getAttribute('aria-checked') !== 'true';
    // Ask first, while the click still counts as a user gesture: the "list is full" card
    // needs access to the site of the new tab. Declining still turns auto-track on.
    const access = on ? await browser.permissions.request({ origins: ['<all_urls>'] }).catch(() => false) : true;
    const cur = await settings();
    await browser.storage.local.set({ settings: { ...cur, autoTrack: on } });
    auto.setAttribute('aria-checked', String(on));
    await sync();
    flash(!on ? 'Saved' : access ? `New tabs will be tracked, up to ${cur.maxSlots}` : 'On. Without site access, a full list shows a notification instead of a card');
  };

  const toggle = $<HTMLButtonElement>('allSites');
  const perm = { origins: ['<all_urls>'] };
  const sync = async () => toggle.setAttribute('aria-checked', String(await browser.permissions.contains(perm)));
  await sync();
  toggle.onclick = async () => {
    const on = toggle.getAttribute('aria-checked') === 'true';
    if (on) await browser.permissions.remove(perm);
    else await browser.permissions.request(perm).catch(() => false);
    await sync();
  };

  const cmds = await browser.commands.getAll().catch(() => []);
  const names: Record<string, string> = { 'track-tab': 'Track', 'mark-done': 'Done', _execute_action: 'Open' };
  const parts = cmds.filter((c) => names[c.name!]).map((c) => `${names[c.name!]}: ${c.shortcut || 'not set'}`);
  if (parts.length) $('shortcuts').textContent = parts.join(' · ');
  $('editShortcuts').onclick = () => {
    const firefox = navigator.userAgent.includes('Firefox');
    if (firefox) flash('In Firefox: Add-ons → ⚙ → Manage Extension Shortcuts');
    else browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
  };
})();
