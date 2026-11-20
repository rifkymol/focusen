/** Timer choice: 'auto' (YouTube = video length, others = 1 day) or a number of minutes. */
export type TimerMode = 'auto' | number;

export type SiteKind = 'video' | 'article' | 'feed' | 'news' | 'other';

export interface VideoInfo {
  videoId: string;
  /** Seconds. Only set when finite and > 0, no ad showing, not live/Shorts. */
  duration?: number;
  /** Last reported playback position, seconds. Used to resume on reopen. */
  currentTime?: number;
  /** Live stream, premiere or Shorts: length unknown, default timer applies. */
  unknown?: boolean;
}

export type TrackedState = 'active' | 'warning';

export interface Tracked {
  /** Stable record id (tab ids only survive one browser session). */
  id: string;
  tabId: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  mode: TimerMode;
  startedAt: number;
  /** Minimum deadline derived from content (video end). Never lowered by reports. */
  floor?: number;
  /** Set by "Keep +1h": the deadline is at least this. */
  keepUntil?: number;
  /** Number of "Keep +1h" used. */
  snoozes: number;
  /** How many times this item has been reopened from Expired (0 or 1). */
  reopenCount: number;
  /** Close deferrals because the tab was playing audio / fullscreen. */
  deferrals: number;
  state: TrackedState;
  /** Set while in warning: when the tab will close. */
  closeAt?: number;
  /** Set when the tab id no longer resolves (e.g. after restart) until re-matched. */
  orphanSince?: number;
  video?: VideoInfo;
}

export type LogKind = 'done' | 'expired';

export interface LogEntry {
  id: string;
  kind: LogKind;
  url: string;
  title: string;
  mode: TimerMode;
  startedAt: number;
  /** When finished (done) or closed (expired). */
  at: number;
  /** done: ms that were left before the deadline. */
  leftMs?: number;
  reopenCount: number;
  /** Total times this item expired (1 or 2). */
  expireCount?: number;
  /** expired: why — the timer ran out, or the tab was lost on restart. */
  reason?: 'timer' | 'lost';
  videoTime?: number;
  /** The record, so Undo can restore it exactly. */
  snapshot?: Tracked;
}

export interface Settings {
  /** Default timer for "Auto" on non-YouTube pages, minutes. */
  defaultMinutes: number;
  maxSlots: number;
  /** Warning lead / grace period, minutes. */
  warnMinutes: number;
  maxSnoozes: number;
  /** Last timer chosen in the popup. */
  lastMode: TimerMode;
  /** Expired entries are deleted after this many days. */
  expiredKeepDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultMinutes: 24 * 60,
  maxSlots: 6,
  warnMinutes: 5,
  maxSnoozes: 3,
  lastMode: 'auto',
  expiredKeepDays: 7,
};

/** Messages between popup / content scripts / overlay and the background. */
export type Msg =
  | { type: 'state' }
  | { type: 'track'; tabId: number; mode: TimerMode; replace?: { id: string; action: 'done' | 'drop' } }
  | { type: 'done'; id?: string; tabId?: number }
  | { type: 'keep'; id?: string; tabId?: number }
  | { type: 'reopen'; logId: string }
  | { type: 'openUrl'; url: string }
  | { type: 'clearLog'; kind: 'done' | 'expired' }
  | { type: 'dismissOverlay'; tabId?: number }
  | { type: 'video'; video: VideoInfo; playing: boolean }
  | { type: 'setMode'; mode: TimerMode };

export interface PopupState {
  now: number;
  settings: Settings;
  tracked: Tracked[];
  log: LogEntry[];
  /** Deadline per tracked id, computed in the background. */
  deadlines: Record<string, number>;
  current?: { tabId: number; url: string; title: string; trackable: boolean; trackedId?: string };
}

export type TrackResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'full' | 'untrackable' | 'missing' };
