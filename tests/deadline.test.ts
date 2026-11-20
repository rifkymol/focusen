import { describe, expect, it } from 'vitest';
import { applyVideo, computeDeadline, DAY, defer, HOUR, keep, LATE_MS, MAX_DEFERRALS, MIN, SEC, step, validDuration } from '../src/lib/deadline';
import { DEFAULT_SETTINGS, type Tracked } from '../src/lib/types';

const S = DEFAULT_SETTINGS; // 1 day default, 5 min warning, 3 keeps
const T0 = 1_700_000_000_000;

const rec = (o: Partial<Tracked> = {}): Tracked => ({
  id: 'r1', tabId: 1, windowId: 1, index: 0, url: 'https://example.com/a', title: 'A',
  mode: 'auto', startedAt: T0, snoozes: 0, reopenCount: 0, deferrals: 0, state: 'active', ...o,
});
const yt = (o: Partial<Tracked> = {}) => rec({ url: 'https://www.youtube.com/watch?v=abc', ...o });

describe('computeDeadline', () => {
  it('auto on a normal page uses the default (1 day)', () => {
    expect(computeDeadline(rec(), S)).toBe(T0 + DAY);
  });
  it('auto on YouTube without a length yet uses the default', () => {
    expect(computeDeadline(yt(), S)).toBe(T0 + DAY);
  });
  it('auto on YouTube uses the video floor', () => {
    expect(computeDeadline(yt({ floor: T0 + 52 * MIN }), S)).toBe(T0 + 52 * MIN);
  });
  it('a >24h video is capped at start + 24h', () => {
    expect(computeDeadline(yt({ floor: T0 + 30 * HOUR }), S)).toBe(T0 + DAY);
  });
  it('explicit timer: video floor wins when longer (minimum, never closes early)', () => {
    expect(computeDeadline(yt({ mode: 30, floor: T0 + 52 * MIN }), S)).toBe(T0 + 52 * MIN);
    expect(computeDeadline(yt({ mode: 120, floor: T0 + 52 * MIN }), S)).toBe(T0 + 2 * HOUR);
  });
  it('keepUntil can extend past the 24h cap', () => {
    expect(computeDeadline(rec({ keepUntil: T0 + DAY + HOUR }), S)).toBe(T0 + DAY + HOUR);
  });
});

describe('step', () => {
  const r = rec({ mode: 60 }); // deadline T0 + 1h
  it('schedules the warning before the deadline', () => {
    const s = step(r, S, T0 + 10 * MIN);
    expect(s.action).toBe('none');
    expect(s.wakeAt).toBe(T0 + 55 * MIN);
  });
  it('enters warning 5 minutes before and closes at the deadline', () => {
    const s = step(r, S, T0 + 55 * MIN);
    expect(s.action).toBe('enterWarning');
    expect(s.t.closeAt).toBe(T0 + HOUR);
    expect(step(s.t, S, T0 + HOUR - SEC).action).toBe('none');
    expect(step(s.t, S, T0 + HOUR + 20 * SEC).action).toBe('close'); // alarm a bit late is fine
  });
  it('never closes straight from active, even long after the deadline (sleep/wake)', () => {
    const s = step(r, S, T0 + 5 * HOUR);
    expect(s.action).toBe('enterWarning');
    expect(s.t.closeAt).toBe(T0 + 5 * HOUR + 5 * MIN); // fresh full grace period
  });
  it('a short timer warns for half its length, not the full 5 minutes', () => {
    const short = yt({ floor: T0 + 2 * MIN });
    expect(step(short, S, T0 + 10 * SEC).action).toBe('none');
    expect(step(short, S, T0 + 10 * SEC).wakeAt).toBe(T0 + MIN);
    const w = step(short, S, T0 + MIN);
    expect(w.action).toBe('enterWarning');
    expect(w.t.closeAt).toBe(T0 + 2 * MIN);
  });
  it('always gives at least a minute of notice', () => {
    const s = step(r, S, T0 + HOUR - 10 * SEC);
    expect(s.t.closeAt).toBe(T0 + HOUR - 10 * SEC + MIN);
  });
  it('re-warns when it slept through the warning', () => {
    const w = step(r, S, T0 + 55 * MIN).t;
    const s = step(w, S, T0 + HOUR + LATE_MS + MIN);
    expect(s.action).toBe('rewarn');
    expect(s.t.closeAt).toBe(T0 + HOUR + LATE_MS + MIN + 5 * MIN);
  });
  it('leaves warning when the deadline moves later', () => {
    const w = step(r, S, T0 + 56 * MIN).t;
    const k = keep(w, S, T0 + 56 * MIN)!;
    expect(k.state).toBe('active');
    expect(computeDeadline(k, S)).toBe(T0 + 2 * HOUR);
    const longer = { ...w, mode: 240 };
    expect(step(longer, S, T0 + 56 * MIN).action).toBe('exitWarning');
  });
});

describe('keep / defer', () => {
  it('caps Keep +1h at maxSnoozes', () => {
    let t: Tracked | null = rec({ mode: 60 });
    for (let i = 0; i < S.maxSnoozes; i++) t = keep(t!, S, T0);
    expect(t!.snoozes).toBe(3);
    expect(computeDeadline(t!, S)).toBe(T0 + 4 * HOUR);
    expect(keep(t!, S, T0)).toBeNull();
  });
  it('keep after a missed deadline counts from now', () => {
    const k = keep(rec({ mode: 60 }), S, T0 + 5 * HOUR)!;
    expect(computeDeadline(k, S)).toBe(T0 + 6 * HOUR);
  });
  it('defers a playing tab a limited number of times', () => {
    let t: Tracked | null = rec({ state: 'warning', closeAt: T0 });
    for (let i = 0; i < MAX_DEFERRALS; i++) {
      t = defer(t!, S, T0);
      expect(t!.closeAt).toBe(T0 + 5 * MIN);
    }
    expect(defer(t!, S, T0)).toBeNull();
  });
});

describe('applyVideo', () => {
  it('sets the floor to now + remaining', () => {
    const t = applyVideo(yt(), { videoId: 'abc', duration: 3120, currentTime: 120 }, T0);
    expect(t.floor).toBe(T0 + 3000 * SEC);
  });
  it('never lowers the floor for the same video (seek forward)', () => {
    const a = applyVideo(yt(), { videoId: 'abc', duration: 3600, currentTime: 0 }, T0);
    const b = applyVideo(a, { videoId: 'abc', duration: 3600, currentTime: 3000 }, T0 + MIN);
    expect(b.floor).toBe(a.floor);
  });
  it('extends the floor while paused and reported later', () => {
    const a = applyVideo(yt(), { videoId: 'abc', duration: 600, currentTime: 300 }, T0);
    const b = applyVideo(a, { videoId: 'abc', duration: 600, currentTime: 300 }, T0 + 20 * MIN);
    expect(b.floor).toBe(T0 + 20 * MIN + 300 * SEC);
  });
  it('a new video (autoplay) recomputes the floor but keeps the 24h cap from the original start', () => {
    const a = applyVideo(yt(), { videoId: 'abc', duration: 600 }, T0);
    const b = applyVideo(a, { videoId: 'xyz', duration: 60 }, T0 + 23.5 * HOUR);
    expect(b.floor).toBe(T0 + 23.5 * HOUR + 60 * SEC);
    const c = applyVideo(b, { videoId: 'long', duration: 7200 }, T0 + 23.5 * HOUR);
    expect(computeDeadline(c, S)).toBe(T0 + DAY);
  });
  it('live / Shorts / unknown length clears the floor for a new video', () => {
    const a = applyVideo(yt(), { videoId: 'abc', duration: 600 }, T0);
    const b = applyVideo(a, { videoId: 'live1', unknown: true }, T0);
    expect(b.floor).toBeUndefined();
    expect(computeDeadline(b, S)).toBe(T0 + DAY);
  });
});

describe('validDuration', () => {
  it('rejects NaN, Infinity, 0, ads and live', () => {
    expect(validDuration(NaN, false, false)).toBeUndefined();
    expect(validDuration(Infinity, false, false)).toBeUndefined();
    expect(validDuration(0, false, false)).toBeUndefined();
    expect(validDuration(15, true, false)).toBeUndefined();
    expect(validDuration(3600, false, true)).toBeUndefined();
    expect(validDuration(3600, false, false)).toBe(3600);
  });
});
