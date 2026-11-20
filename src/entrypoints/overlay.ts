/**
 * In-page warning, injected only into the tracked tab and only while it is visible.
 * Lives in a closed Shadow DOM so the page's CSS can't touch it (and it can't touch the page).
 */
interface ShowMsg {
  type: 'overlay:show';
  title: string;
  closeAt: number;
  timer: string;
  endsAt: string;
  canKeep: boolean;
  keepsLeft: number;
  /** Length of the warning window in ms, so the ring shows how much of it is used up. */
  total?: number;
}

const CSS = `
:host { all: initial; }
.root {
  --bg:#F6F5F0; --surface:#FFFFFF; --surface-2:#EFEEE7; --border:#E3E1D8; --text-1:#1F2A28; --text-2:#5D6A66; --text-3:#8C9692;
  --accent:#3E8C76; --on-accent:#FFFFFF; --warn:#B7791F; --warn-soft:#FBF0DC; --scrim:#1F2A2873;
  position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
  background: var(--scrim); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  font-family: Manrope, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased; animation: fade .18s ease-out;
}
@media (prefers-color-scheme: dark) {
  .root { --bg:#15191A; --surface:#1D2224; --surface-2:#252B2D; --border:#2F3638; --text-1:#ECEFEC; --text-2:#A3AEAA; --text-3:#717C78;
    --accent:#6CC2A8; --on-accent:#0F1F1A; --warn:#E8B25C; --warn-soft:#3A2E1A; --scrim:#0000008C; }
}
@keyframes fade { from { opacity: 0 } }
@keyframes rise { from { transform: translateY(8px); opacity: 0 } }
.card { box-sizing: border-box; width: min(400px, calc(100vw - 32px)); padding: 22px; display: flex; flex-direction: column; gap: 16px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 20px 50px #00000040; animation: rise .22s ease-out; }
.top { display: flex; gap: 12px; align-items: flex-start; }
.ring { flex: none; width: 40px; height: 40px; position: relative; color: var(--warn); }
.ring svg.r { position: absolute; inset: 0; transform: rotate(-90deg); }
.ring .glyph { position: absolute; inset: 12px; }
.text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
h2 { margin: 0; font-size: 17px; font-weight: 800; color: var(--text-1); line-height: 1.3; letter-spacing: -.01em; }
p { margin: 0; font-size: 11.5px; line-height: 1.45; color: var(--text-2); overflow-wrap: anywhere; }
.x { flex: none; all: unset; cursor: pointer; color: var(--text-3); width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; margin: -3px -4px 0 0; }
.x:hover { background: var(--surface-2); color: var(--text-1); }
.actions { display: flex; gap: 8px; }
button.b { all: unset; box-sizing: border-box; flex: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 0; border-radius: 9px; font-size: 12.5px; font-weight: 700; transition: filter .12s, background .12s; }
.b.done { background: var(--accent); color: var(--on-accent); }
.b.done:hover { filter: brightness(1.06); }
.b.keep { background: var(--surface); color: var(--text-1); box-shadow: inset 0 0 0 1px var(--border); }
.b.keep:hover { background: var(--surface-2); }
button:focus-visible, .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hint { font-size: 10.5px; color: var(--text-3); text-align: center; margin-top: -6px; }
`;

const svg = (paths: string, size: number) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const HOURGLASS = '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>';
const CHECK = '<path d="M20 6 9 17l-5-5"/>';
const CLOCK_PLUS = '<path d="M12 6v6l3.644 1.822"/><path d="M16 19h6"/><path d="M19 16v6"/><path d="M21.92 13.267a10 10 0 1 0-8.653 8.653"/>';
const X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';

export default defineUnlistedScript(() => {
  const w = window as unknown as { __focusenOverlay?: boolean };
  if (w.__focusenOverlay) return;
  w.__focusenOverlay = true;

  let host: HTMLElement | null = null;
  let timer: number | undefined;
  let prevFocus: Element | null = null;
  let total = 5 * 60_000;

  const hide = () => {
    clearInterval(timer);
    host?.remove();
    host = null;
    document.removeEventListener('keydown', onKey, true);
    (prevFocus as HTMLElement | null)?.focus?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && host) {
      e.stopPropagation();
      hide();
    }
  };

  const show = (m: ShowMsg) => {
    hide();
    prevFocus = document.activeElement;
    total = Math.max(m.total ?? 0, m.closeAt - Date.now(), 60_000);
    host = document.createElement('focusen-warning');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="root">
        <div class="card" role="alertdialog" aria-modal="true" aria-labelledby="h" aria-describedby="d">
          <div class="top">
            <div class="ring">
              <svg class="r" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
                <circle cx="20" cy="20" r="17" fill="none" stroke="var(--warn-soft)" stroke-width="4"/>
                <circle class="arc" cx="20" cy="20" r="17" fill="none" stroke="var(--warn)" stroke-width="4" stroke-linecap="round" stroke-dasharray="106.8" stroke-dashoffset="0"/>
              </svg>
              <span class="glyph">${svg(HOURGLASS, 16)}</span>
            </div>
            <div class="text">
              <h2 id="h"></h2>
              <p id="d"></p>
            </div>
            <button class="x" aria-label="Dismiss warning">${svg(X, 14)}</button>
          </div>
          <div class="actions">
            <button class="b done">${svg(CHECK, 13)}<span>Done</span></button>
            ${m.canKeep ? `<button class="b keep">${svg(CLOCK_PLUS, 13)}<span>Keep +1h</span></button>` : ''}
          </div>
          ${m.canKeep ? `<div class="hint">${m.keepsLeft} extension${m.keepsLeft === 1 ? '' : 's'} left · Esc to dismiss</div>` : `<div class="hint">No extensions left · Esc to dismiss</div>`}
        </div>
      </div>`;
    const $ = <T extends Element>(s: string) => shadow.querySelector(s) as T;
    $<HTMLParagraphElement>('#d').textContent = `“${m.title}” · ${m.timer} timer ends at ${m.endsAt}`;
    const h = $<HTMLHeadingElement>('#h');
    const arc = $<SVGCircleElement>('.arc');
    const render = () => {
      const left = m.closeAt - Date.now();
      if (left <= 0) {
        h.textContent = 'This tab is closing…';
      } else if (left < 60_000) {
        h.textContent = `This tab closes in ${Math.ceil(left / 1000)} seconds`;
      } else {
        const mins = Math.ceil(left / 60_000);
        h.textContent = `This tab closes in ${mins} minute${mins === 1 ? '' : 's'}`;
      }
      arc.setAttribute('stroke-dashoffset', String(106.8 * (1 - Math.max(0, left) / total)));
    };
    render();
    timer = window.setInterval(render, 1000);

    $<HTMLButtonElement>('.done').onclick = () => {
      browser.runtime.sendMessage({ type: 'done' }).catch(() => undefined);
      hide();
    };
    const keepBtn = shadow.querySelector<HTMLButtonElement>('.keep');
    if (keepBtn)
      keepBtn.onclick = () => {
        browser.runtime.sendMessage({ type: 'keep' }).catch(() => undefined);
        hide();
      };
    $<HTMLButtonElement>('.x').onclick = hide;
    $<HTMLDivElement>('.root').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) hide();
    });
    // Trap Tab inside the dialog.
    shadow.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'Tab') return;
      const items = [...shadow.querySelectorAll<HTMLElement>('button')];
      const i = items.indexOf(shadow.activeElement as HTMLElement);
      ke.preventDefault();
      items[(i + (ke.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    });
    document.addEventListener('keydown', onKey, true);

    (document.fullscreenElement ?? document.documentElement).appendChild(host);
    (keepBtn ?? $<HTMLButtonElement>('.done')).focus();
  };

  browser.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'overlay:show') show(msg as ShowMsg);
    if (msg?.type === 'overlay:hide') hide();
  });
});
