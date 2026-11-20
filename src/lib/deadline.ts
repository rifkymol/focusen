/**
 * Pure deadline logic. Everything here is a function of (record, settings, now)
 * so it can be unit-tested without a browser. Storage is the source of truth;
 * alarms only wake the worker, which then calls `step()` for every record.
 */
import type { Settings, Tracked, VideoInfo } from './types';

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** A close this much later than planned means we slept through the warning. */
export const LATE_MS = 3 * MIN;
/** At most this many "it's playing / fullscreen" deferrals before closing anyway. */
export const MAX_DEFERRALS = 6;
/** Extra time after a video's end, for pauses, comments and finishing up. */
export const VIDEO_BUFFER = 10 * MIN;

export function isYouTubeUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'youtube.com' || h.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

/**
 * deadline = min(startedAt + 24h, max(userDeadline, videoFloor)), then any "Keep +1h".
 * Auto mode: YouTube with a known length gets the video length + 10 min; everything else gets the default.
 */
export function computeDeadline(t: Tracked, s: Settings): number {
  const cap = t.startedAt + DAY;
  let base: number;
  if (t.mode === 'auto') {
    base = t.floor !== undefined && isYouTubeUrl(t.url) ? t.floor : t.startedAt + s.defaultMinutes * MIN;
  } else {
    base = Math.max(t.startedAt + t.mode * MIN, t.floor ?? 0);
  }
  const d = Math.min(cap, base);
  return Math.max(d, t.keepUntil ?? 0);
}

export type StepAction = 'none' | 'enterWarning' | 'rewarn' | 'exitWarning' | 'close';

/** Shortest warning we ever give before closing (WCAG 2.2.1 asks for at least 20 s). */
export const MIN_NOTICE = MIN;

/**
 * How long before the deadline the warning starts. Normally `warnMinutes`, but a
 * 2-minute video shouldn't spend its whole life in the warning state: short timers
 * warn for half their length (at least MIN_NOTICE).
 */
export function warnLead(t: Tracked, deadline: number, warnMs: number): number {
  const span = deadline - t.startedAt;
  return Math.max(MIN_NOTICE, Math.min(warnMs, span / 2));
}

export interface StepResult {
  t: Tracked;
  action: StepAction;
  /** Next time the worker must look at this record. */
  wakeAt: number;
}

/** Advance one record's phase given the current time. Never closes without a warning cycle first. */
export function step(t0: Tracked, s: Settings, now: number): StepResult {
  const t = { ...t0 };
  const warnMs = s.warnMinutes * MIN;
  const deadline = computeDeadline(t, s);
  const warnAt = deadline - warnLead(t, deadline, warnMs);

  if (t.state === 'active') {
    if (now < warnAt) return { t, action: 'none', wakeAt: warnAt };
    t.state = 'warning';
    // Woke after the deadline (sleep, browser closed): a fresh, full grace period
    // instead of closing on wake. Otherwise close at the deadline, never with < 1 min notice.
    t.closeAt = now >= deadline ? now + warnMs : Math.max(deadline, now + MIN_NOTICE);
    return { t, action: 'enterWarning', wakeAt: t.closeAt };
  }

  // warning
  if (now < warnAt) {
    // Deadline moved later (Keep +1h, longer video): back to normal.
    t.state = 'active';
    t.closeAt = undefined;
    return { t, action: 'exitWarning', wakeAt: warnAt };
  }
  const closeAt = t.closeAt ?? Math.max(deadline, now + MIN_NOTICE);
  t.closeAt = closeAt;
  if (now < closeAt) return { t, action: 'none', wakeAt: closeAt };
  if (now - closeAt > LATE_MS) {
    t.closeAt = now + warnMs;
    return { t, action: 'rewarn', wakeAt: t.closeAt };
  }
  return { t, action: 'close', wakeAt: now };
}

/** Called at close time when the tab is playing audio or fullscreen: run one more warning cycle. */
export function defer(t0: Tracked, s: Settings, now: number): Tracked | null {
  if (t0.deferrals >= MAX_DEFERRALS) return null;
  return { ...t0, deferrals: t0.deferrals + 1, state: 'warning', closeAt: now + s.warnMinutes * MIN };
}

/** "Keep +1h": one more hour past the current deadline (or now, if that is later). */
export function keep(t0: Tracked, s: Settings, now: number): Tracked | null {
  if (t0.snoozes >= s.maxSnoozes) return null;
  const d = computeDeadline(t0, s);
  return {
    ...t0,
    snoozes: t0.snoozes + 1,
    keepUntil: Math.max(d, now) + HOUR,
    state: 'active',
    closeAt: undefined,
    deferrals: 0,
  };
}

/**
 * Fold a YouTube report into the record. The floor is the video's end plus VIDEO_BUFFER.
 * It only moves later for the same
 * video (pausing or seeking back never shortens it); a new video (autoplay, playlist)
 * recomputes it, while the 24h cap stays anchored to the tab's original start.
 */
export function applyVideo(t0: Tracked, v: VideoInfo, now: number): Tracked {
  const t = { ...t0 };
  const sameVideo = t.video?.videoId === v.videoId;
  t.video = { ...v };
  if (v.unknown || v.duration === undefined) {
    if (!sameVideo) t.floor = undefined;
    return t;
  }
  const remaining = Math.max(0, v.duration - (v.currentTime ?? 0)) * SEC;
  const candidate = now + remaining + VIDEO_BUFFER;
  t.floor = sameVideo && t.floor !== undefined ? Math.max(t.floor, candidate) : candidate;
  return t;
}

/** Duration value from a <video> element, or undefined if it can't be trusted. */
export function validDuration(d: number, adShowing: boolean, live: boolean): number | undefined {
  if (adShowing || live) return undefined;
  return Number.isFinite(d) && d > 0 ? d : undefined;
}
