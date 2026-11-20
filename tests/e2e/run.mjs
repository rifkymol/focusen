// End-to-end check: real Chromium + built extension + local fixture served as www.youtube.com.
// Usage: npm run build && npm run e2e   (set CHROMIUM=path to a Chromium build if needed)
import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const ext = path.join(root, '.output/chrome-mv3');
const out = path.join(root, 'test-results');
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(path.join(tmpdir(), 'focusen-e2e-'));

// 120 s silent WAV: a <video> element reports its duration like any media file.
function wav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const media = wav(120);
const html = (title, body) => `<!doctype html><title>${title}</title><body style="font-family:sans-serif;background:#f3f3f3;margin:24px">${body}</body>`;
// Pages are served from inside the browser (Playwright routing): no network, no TLS interception.
async function serve(ctx) {
  await ctx.route((url) => /(^|\.)(youtube\.com|site\.test)$/.test(url.hostname), (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/a.wav') return route.fulfill({ status: 200, contentType: 'audio/wav', body: media });
    if (u.pathname === '/watch')
      return route.fulfill({ contentType: 'text/html', body: html('How to build a cabin in the woods - YouTube', '<div id="movie_player"><video class="html5-main-video" src="/a.wav" preload="metadata" muted width="640" height="360" style="background:#1e2422"></video></div><h1>How to build a cabin in the woods</h1>') });
    return route.fulfill({ contentType: 'text/html', body: html('Article ' + u.pathname.slice(1), '<h1>Article ' + u.pathname + '</h1><p>Lorem ipsum dolor sit amet.</p>') });
  });
  return ctx;
}

const exe = process.env.CHROMIUM ?? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1248/chrome-win64/chrome.exe');
const profile = path.join(tmp, 'profile');
const launch = async () => serve(await chromium.launchPersistentContext(profile, {
  executablePath: existsSync(exe) ? exe : undefined,
  headless: true,
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
  ],
  viewport: { width: 1000, height: 700 },
}));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx = await launch();
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
const optUrl = `chrome-extension://${extId}/options.html`;
const errs = [];

const ctl = await ctx.newPage();
ctl.on('pageerror', (e) => errs.push(String(e)));
await ctl.goto(optUrl);
const msg = (m) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), m);
const db = () => ctl.evaluate(() => chrome.storage.local.get(null));
const tabIdOf = (part) => ctl.evaluate(async (p) => (await chrome.tabs.query({})).find((t) => t.url.includes(p))?.id, part);
// Patch tracked records whose URL contains `part`. Values like {rel: -1000} are relative to the browser's now.
const patch = (part, fields) => ctl.evaluate(async ([part, fields]) => {
  const d = await chrome.storage.local.get('tracked');
  for (const t of Object.values(d.tracked)) {
    if (!t.url.includes(part)) continue;
    for (const [k, v] of Object.entries(fields)) t[k] = v && typeof v === 'object' && 'rel' in v ? Date.now() + v.rel : v;
  }
  await chrome.storage.local.set({ tracked: d.tracked });
}, [part, fields]);

// 1. YouTube: Auto timer becomes the video length + 10 minutes.
const yt = await ctx.newPage();
await yt.goto('https://www.youtube.com/watch?v=cabin1');
await yt.waitForFunction(() => document.querySelector('video')?.duration > 0);
const ytTab = await tabIdOf('watch?v=cabin1');
let r = await msg({ type: 'track', tabId: ytTab, mode: 'auto' });
check('track YouTube tab', r.ok, JSON.stringify(r));
await sleep(1500);
let s = await msg({ type: 'state' });
let ytRec = s.tracked.find((t) => t.tabId === ytTab);
const left = s.deadlines[ytRec.id] - s.now;
check('Auto deadline = video length + 10 min (720 s), not in warning yet', Math.abs(left - 720_000) < 5000 && ytRec.state === 'active', `left ${Math.round(left / 1000)} s, duration ${ytRec.video?.duration}`);

// 2. Articles with explicit timers, then fill the list.
const modes = [15, 60, 240, 1440, 30];
for (let i = 1; i <= 5; i++) {
  const p = await ctx.newPage();
  await p.goto(`https://www${i}.site.test/post-${i}`);
  r = await msg({ type: 'track', tabId: await tabIdOf(`post-${i}`), mode: modes[i - 1] });
  check(`track article ${i}`, r.ok);
}
const extra = await ctx.newPage();
await extra.goto('https://extra.site.test/rust-ownership');
r = await msg({ type: 'track', tabId: await tabIdOf('rust-ownership'), mode: 60 });
check('7th tab is refused: list full', !r.ok && r.reason === 'full');
r = await msg({ type: 'track', tabId: await tabIdOf('chrome-extension://'), mode: 60 });
check('extension page is untrackable', !r.ok && r.reason === 'untrackable');

// 3. Badge on a tracked tab.
const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), ytTab);
check('per-tab badge shows countdown', /^\d+[mhd]$|^<1m$/.test(badge), `"${badge}"`);

// 4. Warning → in-page overlay on the visible YouTube tab.
await patch('cabin1', { startedAt: { rel: -60 * 60e3 }, floor: { rel: 4 * 60e3 } });
s = await msg({ type: 'state' });
ytRec = s.tracked.find((t) => t.tabId === ytTab);
check('enters warning 5 min before', ytRec.state === 'warning', ytRec.state);
await yt.bringToFront();
await ctl.evaluate((id) => chrome.tabs.update(id, { active: true }), ytTab);
await yt.waitForSelector('focusen-warning', { state: 'attached', timeout: 5000 }).then(
  () => check('overlay injected', true),
  () => check('overlay injected', false),
);
await sleep(500);
await yt.screenshot({ path: path.join(out, 'overlay.png') });

// 5. Keep +1h from the overlay (keyboard: focus starts on Keep).
await yt.keyboard.press('Enter');
await sleep(800);
s = await msg({ type: 'state' });
ytRec = s.tracked.find((t) => t.tabId === ytTab);
check('Keep +1h extends and exits warning', ytRec.state === 'active' && ytRec.snoozes === 1, `${ytRec.state} snoozes=${ytRec.snoozes}`);
check('overlay removed', (await yt.$('focusen-warning')) === null);

// 6. Close at deadline → Expired, then reopen once.
const p1 = await tabIdOf('post-1');
await patch('post-1', { startedAt: { rel: -15 * 60e3 - 1000 }, state: 'warning', closeAt: { rel: -1000 } });
await msg({ type: 'state' });
await sleep(800);
check('tab closed at deadline', p1 !== undefined && (await tabIdOf('post-1')) === undefined);
let d = await db();
const exp = d.log.find((e) => e.kind === 'expired' && e.url.includes('post-1'));
check('closed tab is in Expired', !!exp && exp.reason === 'timer');
r = await msg({ type: 'reopen', logId: exp.id });
await sleep(1500);
d = await db();
const re = Object.values(d.tracked).find((t) => t.url.includes('post-1'));
check('reopen with new timer (second chance)', r.ok && re?.reopenCount === 1, JSON.stringify(r));
r = await msg({ type: 'reopen', logId: exp.id });
check('cannot reopen the same entry twice', !r.ok);

// 7. Slept through the warning: no instant close.
await patch('post-2', { startedAt: { rel: -90 * 60e3 }, state: 'warning', closeAt: { rel: -30 * 60e3 } });
await msg({ type: 'state' });
d = await db();
const p2 = Object.values(d.tracked).find((t) => t.url.includes('post-2'));
check('wake long after deadline → fresh warning, tab kept', p2?.state === 'warning' && p2.closeAt > Date.now() + 4 * 60e3 && (await tabIdOf('post-2')) !== undefined);

// 8. Done closes the tab and records it.
await msg({ type: 'done', id: p2.id });
await sleep(600);
d = await db();
check('Done → closed and logged as done', (await tabIdOf('post-2')) === undefined && d.log.some((e) => e.kind === 'done' && e.url.includes('post-2')));

// 9. Fill again, then "drop one" to make room for the waiting tab.
const p9 = await ctx.newPage();
await p9.goto('https://www9.site.test/post-9');
await msg({ type: 'track', tabId: await tabIdOf('post-9'), mode: 60 });
s = await msg({ type: 'state' });
check('list is full again', s.tracked.length === 6, String(s.tracked.length));
const victim = s.tracked.find((t) => t.url.includes('post-3'));
r = await msg({ type: 'track', tabId: await tabIdOf('rust-ownership'), mode: 60, replace: { id: victim.id, action: 'drop' } });
s = await msg({ type: 'state' });
check('drop one to make room, new tab tracked', r.ok && s.tracked.some((t) => t.url.includes('rust-ownership')) && !s.tracked.some((t) => t.url.includes('post-3')));

// 9b. Auto-track: new tabs are tracked up to the limit; Stop tracking keeps the tab open.
const setSettings = (fields) => ctl.evaluate(async (f) => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, ...f } });
}, fields);
const tracked = async () => (await msg({ type: 'state' })).tracked;
// Tabs restored in the first 15 s of a browser session are not "new": wait that out.
const booted = await ctl.evaluate(async () => (await chrome.storage.session.get('booted')).booted);
await sleep(Math.max(0, booted + 15_500 - (await ctl.evaluate(() => Date.now()))));
await setSettings({ autoTrack: true, maxSlots: 7 });
const a1 = await ctx.newPage();
await a1.goto('https://auto.site.test/first');
await sleep(2500);
let autoRec = (await tracked()).find((t) => t.url.includes('auto.site.test/first'));
check('auto-track: a new tab is tracked', !!autoRec, String((await tracked()).length));
const a2 = await ctx.newPage();
// YouTube: Focusen has access there, so the in-page card can show (other sites need the opt-in).
await a2.goto('https://www.youtube.com/watch?v=full2');
await sleep(2500);
check('auto-track: list full, next new tab is not tracked', !(await tracked()).some((t) => t.url.includes('v=full2')));
const a2Tab = await tabIdOf('v=full2');
const cardOn = async (p) => (await p.$('focusen-warning')) !== null;
check('list full: the new tab shows the "Your list is full" card', await a2.waitForSelector('focusen-warning', { state: 'attached', timeout: 6000 }).then(() => true, () => false));
await sleep(400);
await a2.screenshot({ path: path.join(out, 'overlay-full.png') });
check('list full: the refused tab gets a "full" badge', (await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), a2Tab)) === 'full');
// Opening Focusen on that tab shows the "Your list is full" picker (current tab = the refused one).
await ctx.addInitScript((mark) => {
  if (!location.pathname.endsWith('popup.html')) return;
  const q = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = (o) => (o && o.active ? q({}).then((ts) => ts.filter((t) => t.url.includes(mark))) : q(o));
}, 'v=full2');
const fullPop = await ctx.newPage();
fullPop.on('pageerror', (e) => errs.push(String(e)));
await fullPop.setViewportSize({ width: 360, height: 600 });
await fullPop.goto(`chrome-extension://${extId}/popup.html`);
const picker = await fullPop.waitForSelector('.full-header', { timeout: 4000 }).then(() => true, () => false);
check('list full: Focusen on that tab shows the "Your list is full" picker', picker);
await fullPop.screenshot({ path: path.join(out, 'popup-full.png') });
if (picker) await fullPop.getByText('Leave it untracked').click();
await sleep(500);
check('Leave it untracked: badge and card cleared, picker not offered again',
  (await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), a2Tab)) !== 'full' && !(await cardOn(a2)) &&
  !((await ctl.evaluate(async () => (await chrome.storage.session.get('autoFull')).autoFull)) ?? []).includes(a2Tab));
await fullPop.close();
r = await msg({ type: 'untrack', id: autoRec.id });
await sleep(500);
d = await db();
check('Stop tracking: record removed, tab still open, nothing logged',
  r.ok && !d.tracked[autoRec.id] && (await tabIdOf('auto.site.test/first')) !== undefined && !d.log.some((e) => e.url.includes('auto.site.test/first')));
await a1.goto('https://auto.site.test/first-next');
await sleep(2500);
check('Stop tracking: navigating that tab does not re-track it', !(await tracked()).some((t) => t.url.includes('auto.site.test/first')));
// The card's own buttons: pick the first tab, Mark done → this new tab takes its place.
await setSettings({ maxSlots: 6 });
const doneBefore = (await db()).log.filter((e) => e.kind === 'done').length;
const a3 = await ctx.newPage();
await a3.goto('https://www.youtube.com/watch?v=full3');
await a3.waitForSelector('focusen-warning', { state: 'attached', timeout: 8000 }).catch(() => undefined);
await sleep(400);
const shown = Math.min(4, (await tracked()).length);
for (let i = 0; i < shown; i++) await a3.keyboard.press('Tab'); // focus starts on the first pick; next stops: other picks, then Mark done
await a3.keyboard.press('Enter');
await sleep(2500);
d = await db();
check('card: Mark done frees a slot and tracks the new tab',
  (await tracked()).some((t) => t.url.includes('v=full3')) && d.log.filter((e) => e.kind === 'done').length === doneBefore + 1 && !(await cardOn(a3)));
await msg({ type: 'untrack', id: (await tracked()).find((t) => t.url.includes('v=full3')).id });
await a3.close();
await setSettings({ maxSlots: 7 });
const own = await ctl.evaluate(async () => (await chrome.tabs.query({})).length);
const e2 = d.log.find((e) => e.kind === 'done');
r = await msg({ type: 'reopen', logId: e2.id }); // Undo of a Done: restores its own record, must not double-track
await sleep(2500);
const dupes = (await tracked()).filter((t) => t.url === e2.url).length;
check('tabs Focusen opens itself are not auto-tracked twice', r.ok && dupes === 1 && (await ctl.evaluate(async () => (await chrome.tabs.query({})).length)) === own + 1, `copies ${dupes}`);
await msg({ type: 'untrack', id: (await tracked()).find((t) => t.url === e2.url).id });
await setSettings({ autoTrack: false, maxSlots: 6 });
await a1.close();
await a2.close();
for (const p of ctx.pages()) if (p.url() === e2.url) await p.close();

// 10. Popup screenshots (light + dark).
for (const scheme of ['light', 'dark']) {
  const pop = await ctx.newPage();
  pop.on('pageerror', (e) => errs.push(String(e)));
  await pop.emulateMedia({ colorScheme: scheme });
  await pop.setViewportSize({ width: 360, height: 600 });
  for (const v of ['active', 'done', 'expired']) {
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.evaluate((v) => localStorage.setItem('focusen:view', v), v);
    await pop.reload();
    await pop.waitForSelector('.seg');
    await sleep(300);
    await pop.screenshot({ path: path.join(out, `popup-${v}-${scheme}.png`) });
  }
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.evaluate(() => localStorage.setItem('focusen:view', 'active'));
  await pop.close();
}
const opt = await ctx.newPage();
await opt.setViewportSize({ width: 800, height: 900 });
await opt.goto(optUrl);
await sleep(300);
await opt.screenshot({ path: path.join(out, 'options.png') });

// 11. Restart: tab ids change; records are re-matched by URL.
const urlsBefore = (await msg({ type: 'state' })).tracked.map((t) => t.url);
await ctx.close();
ctx = await launch();
sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const ctl2 = await ctx.newPage();
ctl2.on('pageerror', (e) => errs.push(String(e)));
await ctl2.goto(optUrl);
for (const u of urlsBefore) {
  const p = await ctx.newPage();
  await p.goto(u);
}
await sleep(2000);
s = await ctl2.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }));
check('after restart every record re-matched to its new tab', s.tracked.length === urlsBefore.length && s.tracked.every((t) => !t.orphanSince), s.tracked.map((t) => (t.orphanSince ? 'orphan' : 'ok')).join(','));
check('no page errors', errs.length === 0, errs.join(' | '));

await ctx.close();
console.log(`\n${pass} passed, ${fail} failed. Screenshots in test-results/`);
process.exit(fail ? 1 : 0);
