// Store screenshots: loads the built extension with realistic tabs and history,
// captures the popup and the in-page warning, then composes 1280×800 listing images
// and a 440×280 promo tile into store/.
// Usage: npm run store   (builds first; set CHROMIUM to use a different Chromium build)
import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ext = path.join(root, '.output/chrome-mv3');
const out = path.join(root, 'store');
const shots = path.join(mkdtempSync(path.join(tmpdir(), 'focusen-store-')), 'raw');
mkdirSync(out, { recursive: true });
mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A 2-minute silent WAV stands in for the video; its length is patched afterwards.
function wav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const media = wav(120);

const VIDEO = { url: 'https://www.youtube.com/watch?v=cabin', title: 'How to build a timber-frame cabin, start to finish' };
// [url, title, timer minutes, minutes since tracking started]
const ARTICLES = [
  ['https://fieldnotes.blog/too-many-tabs', 'Why we keep too many tabs open', 120, 46],
  ['https://devjournal.io/ownership-and-borrowing', 'A gentle guide to ownership and borrowing', 240, 40],
  ['https://citydesk.news/cycling-lanes-one-year-on', 'The new cycling lanes, one year on', 60, 52],
  ['https://kitchenshelf.co/lemon-chickpea-pasta', 'Weeknight lemon chickpea pasta', 480, 60],
];
const CURRENT = 'fieldnotes.blog';

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;font-family:system-ui,sans-serif;background:#f6f6f4;color:#1d2321">${body}</body>`;
const videoPage = page(VIDEO.title + ' - YouTube', `
  <div style="max-width:880px;margin:28px auto;padding:0 24px">
    <div id="movie_player" style="position:relative;border-radius:14px;overflow:hidden;background:linear-gradient(135deg,#2c3a33,#14201b)">
      <video class="html5-main-video" src="/a.wav" preload="metadata" muted style="display:block;width:100%;aspect-ratio:16/9"></video>
    </div>
    <h1 style="font-size:22px;margin:18px 0 6px">${VIDEO.title}</h1>
    <p style="margin:0;color:#6b746f">Cabin Notes · 412K views · 3 weeks ago</p>
  </div>`);
const articlePage = (title) => page(title, `<article style="max-width:680px;margin:48px auto;padding:0 24px;line-height:1.6">
  <h1>${title}</h1><p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(8)}</p></article>`);

const exe = process.env.CHROMIUM ?? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1248/chrome-win64/chrome.exe');
const ctx = await chromium.launchPersistentContext(path.join(shots, '..', 'profile'), {
  executablePath: existsSync(exe) ? exe : undefined,
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1000, height: 700 },
  deviceScaleFactor: 2,
});
const hosts = new Set(['www.youtube.com', ...ARTICLES.map(([u]) => new URL(u).hostname)]);
await ctx.route((u) => hosts.has(u.hostname), (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/a.wav') return route.fulfill({ contentType: 'audio/wav', body: media });
  if (u.pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: videoPage });
  const a = ARTICLES.find(([url]) => url.endsWith(u.hostname + u.pathname));
  return route.fulfill({ contentType: 'text/html', body: articlePage(a?.[1] ?? 'Article') });
});

const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
const ctl = await ctx.newPage();
await ctl.goto(`chrome-extension://${extId}/options.html`);
const msg = (m) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), m);
const tabIdOf = (part) => ctl.evaluate(async (p) => (await chrome.tabs.query({})).find((t) => t.url.includes(p))?.id, part);
const patch = (part, fields) => ctl.evaluate(async ([part, fields]) => {
  const d = await chrome.storage.local.get('tracked');
  for (const t of Object.values(d.tracked)) {
    if (!t.url.includes(part)) continue;
    for (const [k, v] of Object.entries(fields)) t[k] = v && typeof v === 'object' && 'rel' in v ? Date.now() + v.rel : v;
  }
  await chrome.storage.local.set({ tracked: d.tracked });
}, [part, fields]);

// Tracked tabs.
const yt = await ctx.newPage();
await yt.goto(VIDEO.url);
await yt.waitForFunction(() => document.querySelector('video')?.duration > 0);
await msg({ type: 'track', tabId: await tabIdOf('watch?v=cabin'), mode: 'auto' });
for (const [url, , mode] of ARTICLES) {
  const p = await ctx.newPage();
  await p.goto(url);
  await msg({ type: 'track', tabId: await tabIdOf(url), mode });
}
await sleep(1000);
await patch('watch?v=cabin', { startedAt: { rel: -6 * MIN }, floor: { rel: 38 * MIN }, video: { videoId: 'cabin', duration: 2640, currentTime: 360 } });
for (const [url, , , ago] of ARTICLES) await patch(url, { startedAt: { rel: -ago * MIN } });

// History: Done and Expired.
const now = Date.now();
const entry = (kind, url, title, mode, at, extra = {}) => ({
  id: Math.random().toString(36).slice(2), kind, url, title, mode, startedAt: at - 50 * MIN, at, reopenCount: 0, ...extra,
});
const log = [
  entry('done', 'https://uxjournal.blog/designing-calm-interfaces', 'Designing calm interfaces', 120, now - 35 * MIN, { leftMs: 72 * MIN }),
  entry('done', 'https://www.youtube.com/watch?v=sourdough', 'Sourdough starter, day three', 'auto', now - 2.2 * HOUR, { leftMs: 4 * MIN }),
  entry('done', 'https://writewell.page/notes-on-clear-writing', 'Notes on writing clearly', 60, now - 3.5 * HOUR, { leftMs: 21 * MIN }),
  entry('done', 'https://trailmap.site/lakeside-loop', 'The lakeside loop: a 12 km day hike', 240, now - DAY - 2 * HOUR, { leftMs: 2 * HOUR }),
  entry('done', 'https://devjournal.io/testing-without-mocks', 'Testing without mocks', 120, now - DAY - 5 * HOUR, { leftMs: 38 * MIN }),
  entry('expired', 'https://sheetcraft.io/faster-spreadsheets', 'Ten tips for faster spreadsheets', 60, now - 3 * HOUR, { reason: 'timer', expireCount: 1 }),
  entry('expired', 'https://homelab.wiki/backup-strategy', 'A sensible backup strategy for home', 1440, now - DAY - 3 * HOUR, { reason: 'lost', expireCount: 1 }),
  entry('expired', 'https://www.youtube.com/watch?v=planning', 'Quarterly planning, walked through', 'auto', now - DAY - 6 * HOUR, { reason: 'timer', reopenCount: 1, expireCount: 2 }),
];
await ctl.evaluate((log) => chrome.storage.local.set({ log }), log);
await msg({ type: 'state' });

// Popup captures. The popup reads "the current tab" with tabs.query({active}); point it at one article.
await ctx.addInitScript((mark) => {
  if (!location.pathname.endsWith('popup.html')) return;
  const q = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = (o) => (o && o.active ? q({}).then((ts) => ts.filter((t) => t.url.includes(mark))) : q(o));
}, CURRENT);
async function popup(view, scheme, file) {
  const p = await ctx.newPage();
  await p.emulateMedia({ colorScheme: scheme });
  await p.setViewportSize({ width: 360, height: 600 });
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.evaluate((v) => localStorage.setItem('focusen:view', v), view);
  await p.reload();
  await p.waitForSelector('.seg');
  await sleep(400);
  await p.screenshot({ path: path.join(shots, file) });
  await p.close();
}
await popup('active', 'light', 'active-light.png');
await popup('active', 'dark', 'active-dark.png');
await popup('done', 'light', 'done-light.png');
await popup('expired', 'dark', 'expired-dark.png');

// In-page warning on the video tab.
await patch('watch?v=cabin', { floor: { rel: 4 * MIN } });
await msg({ type: 'state' });
await yt.bringToFront();
await ctl.evaluate(async (id) => chrome.tabs.update(id, { active: true }), await tabIdOf('watch?v=cabin'));
await yt.waitForSelector('focusen-warning', { state: 'attached', timeout: 8000 });
await sleep(700);
await yt.screenshot({ path: path.join(shots, 'warning.png') });
await ctx.close();

// Compose the listing images.
const b64 = (f) => readFileSync(f).toString('base64');
const fontFile = readdirSync(path.join(ext, 'assets')).find((f) => /^manrope-latin-wght/.test(f));
const font = `@font-face{font-family:Manrope;src:url(data:font/woff2;base64,${b64(path.join(ext, 'assets', fontFile))}) format('woff2');font-weight:200 800}`;
const logo = `data:image/png;base64,${b64(path.join(root, 'public/icon/128.png'))}`;
const img = (f) => `data:image/png;base64,${b64(path.join(shots, f))}`;

const theme = {
  light: { bg: '#EEF3F0', ink: '#16201C', sub: '#56625C', glow: 'rgba(62,140,118,.18)' },
  dark: { bg: '#121816', ink: '#F1F5F3', sub: '#9AA8A1', glow: 'rgba(62,140,118,.28)' },
};
const listing = (t, title, body, visual) => `<!doctype html><meta charset="utf-8"><style>${font}
  *{box-sizing:border-box;margin:0}
  body{width:1280px;height:800px;overflow:hidden;font-family:Manrope,sans-serif;background:${t.bg};
    background-image:radial-gradient(900px 600px at 82% 50%,${t.glow},transparent 70%);display:flex;align-items:center;padding:0 88px;gap:72px}
  .copy{flex:0 0 430px;color:${t.ink}}
  .brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:20px;margin-bottom:40px}
  .brand img{width:36px;height:36px}
  h1{font-size:50px;line-height:1.08;letter-spacing:-.02em;font-weight:800;margin-bottom:22px}
  p{font-size:21px;line-height:1.5;color:${t.sub};font-weight:500}
  .visual{flex:1;display:flex;justify-content:center}
  .shot{border-radius:18px;box-shadow:0 30px 70px rgba(10,30,20,.22),0 4px 14px rgba(10,30,20,.12)}
</style><body><div class="copy"><div class="brand"><img src="${logo}">Focusen</div><h1>${title}</h1><p>${body}</p></div>
<div class="visual">${visual}</div></body>`;
const popupShot = (f) => `<img class="shot" src="${img(f)}" style="width:400px;height:667px">`;
// Crop the warning card with some of the page around it (screenshot is 2000×1400 at 2×).
const warningShot = `<div class="shot" style="width:640px;height:360px;background:url(${img('warning.png')}) no-repeat;background-size:1067px 747px;background-position:-213px -185px"></div>`;

const pages = [
  ['1-deadline.png', theme.light, 'Give every tab a deadline.', 'Track up to six tabs you mean to finish. A YouTube video gets its own length; everything else gets a day.', popupShot('active-light.png')],
  ['2-warning.png', theme.light, 'A heads-up before anything closes.', 'A few minutes before time runs out, a small card offers Done or Keep +1h. A tab that’s still playing is never cut off.', warningShot],
  ['3-done.png', theme.light, 'Finishing feels good.', 'Every tab you finish is logged, with a count for today and your best day this week.', popupShot('done-light.png')],
  ['4-expired.png', theme.dark, 'Changed your mind? Bring it back once.', 'Closed tabs wait in Expired for a week. Reopen one with a fresh timer, and a video picks up where you left off.', popupShot('expired-dark.png')],
  ['5-dark.png', theme.dark, 'Light or dark. No account. No tracking.', 'Everything stays in your browser. Focusen has no servers and sends nothing anywhere.', popupShot('active-dark.png')],
];
const browser = await chromium.launch({ executablePath: existsSync(exe) ? exe : undefined });
const bp = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
for (const [file, t, title, body, visual] of pages) {
  await bp.setContent(listing(t, title, body, visual), { waitUntil: 'load' });
  await bp.evaluate(() => document.fonts.ready);
  await bp.screenshot({ path: path.join(out, `screenshot-${file}`) });
}

// Small promo tile, 440×280.
await bp.setViewportSize({ width: 440, height: 280 });
await bp.setContent(`<!doctype html><style>${font}*{margin:0}
  body{width:440px;height:280px;overflow:hidden;font-family:Manrope,sans-serif;background:#3E8C76;color:#fff;
    display:flex;flex-direction:column;justify-content:center;padding:0 40px;box-sizing:border-box;
    background-image:radial-gradient(320px 220px at 100% 0%,rgba(255,255,255,.18),transparent 70%)}
  .b{display:flex;align-items:center;gap:14px;font-size:34px;font-weight:800;letter-spacing:-.02em;margin-bottom:14px}
  .b span{display:flex;background:#fff;border-radius:18px;padding:4px}.b img{width:56px;height:56px;display:block}
  p{font-size:19px;line-height:1.4;font-weight:600;opacity:.92}</style>
  <div class="b"><span><img src="${logo}"></span>Focusen</div><p>Give every tab a deadline.<br>Finish it, or let it close.</p>`, { waitUntil: 'load' });
await bp.evaluate(() => document.fonts.ready);
await bp.screenshot({ path: path.join(out, 'promo-440x280.png') });
await browser.close();
console.log(`Store images written to ${path.relative(root, out)}/`);
