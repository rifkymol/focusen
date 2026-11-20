/**
 * Reads the playing video's length from the standard <video> element (isolated world,
 * no network, no player API) and reports it to the background. The background only uses
 * it as a *minimum* deadline, so a wrong reading during an ad just falls back to the default.
 */
import { validDuration } from '@/lib/deadline';
import type { VideoInfo } from '@/lib/types';

const TIMEUPDATE_EVERY = 45_000;

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const w = window as unknown as { __focusenYT?: boolean };
    if (w.__focusenYT) return; // injected twice (on-demand after install + manifest)
    w.__focusenYT = true;

    let lastSent = '';
    let lastTimeupdate = 0;
    let token = 0;

    const videoIdFromUrl = (): string | null => {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
      return m ? m[2] : null;
    };

    const findVideo = (): HTMLVideoElement | null =>
      document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video') ??
      document.querySelector<HTMLVideoElement>('#movie_player video') ??
      document.querySelector<HTMLVideoElement>('ytd-reel-video-renderer[is-active] video') ??
      document.querySelector<HTMLVideoElement>('video');

    const isLive = (): boolean => {
      const badge = document.querySelector<HTMLElement>('#movie_player .ytp-live-badge');
      return !!badge && badge.offsetParent !== null && !badge.hasAttribute('disabled') && getComputedStyle(badge).display !== 'none';
    };

    const adShowing = (): boolean => {
      const p = document.querySelector('#movie_player');
      return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
    };

    const read = (): { info: VideoInfo; playing: boolean } | null => {
      const id = videoIdFromUrl();
      const v = findVideo();
      if (!id || !v) return null;
      const shorts = location.pathname.startsWith('/shorts/');
      const live = isLive() || v.duration === Infinity;
      if (adShowing()) return null; // the reported duration belongs to the ad
      const duration = shorts ? undefined : validDuration(v.duration, false, live);
      const unknown = shorts || live;
      if (!unknown && duration === undefined) return null; // metadata not loaded yet
      return {
        info: { videoId: id, duration, unknown, currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0 },
        playing: !v.paused && !v.ended,
      };
    };

    const send = (force = false) => {
      if (ctx.isInvalid) return;
      const r = read();
      if (!r) return;
      const key = `${r.info.videoId}|${r.info.duration}|${r.info.unknown}|${Math.round((r.info.currentTime ?? 0) / 30)}|${r.playing}`;
      if (!force && key === lastSent) return;
      lastSent = key;
      browser.runtime.sendMessage({ type: 'video', video: r.info, playing: r.playing }).catch(() => undefined);
    };

    // Media events don't bubble, but capture on the document catches them for any <video>,
    // including one YouTube swaps in after an SPA navigation.
    for (const ev of ['loadedmetadata', 'durationchange', 'play', 'pause', 'ratechange', 'seeked', 'ended']) {
      document.addEventListener(ev, () => send(ev === 'durationchange' || ev === 'ended'), true);
    }
    document.addEventListener(
      'timeupdate',
      () => {
        const now = Date.now();
        if (now - lastTimeupdate < TIMEUPDATE_EVERY) return;
        lastTimeupdate = now;
        send();
      },
      true,
    );

    // SPA navigation: re-detect with a cancellation token, since <video> can briefly be stale or null.
    const onNavigate = () => {
      const mine = ++token;
      let tries = 0;
      const tick = () => {
        if (mine !== token || ctx.isInvalid) return;
        const r = read();
        if (r) send(true);
        else if (++tries < 20) setTimeout(tick, 500);
      };
      setTimeout(tick, 300);
    };
    window.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('popstate', onNavigate);
    (window as unknown as { navigation?: EventTarget }).navigation?.addEventListener('navigatesuccess', onNavigate);

    // The ad class goes away without a media event when YouTube resumes the main stream.
    const player = document.querySelector('#movie_player');
    if (player) new MutationObserver(() => !adShowing() && send()).observe(player, { attributes: true, attributeFilter: ['class'] });

    browser.runtime.onMessage.addListener((msg: { type?: string }) => {
      if (msg?.type === 'report') send(true);
    });

    onNavigate();
  },
});
