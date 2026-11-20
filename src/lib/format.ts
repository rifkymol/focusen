import { DAY, HOUR, MIN } from './deadline';
import type { SiteKind, TimerMode } from './types';

export const TIMER_CHOICES: TimerMode[] = ['auto', 15, 30, 60, 120, 240, 480, 1440];

export function timerLabel(m: TimerMode, long = false): string {
  if (m === 'auto') return 'Auto';
  if (m < 60) return `${m} min`;
  if (m % 1440 === 0) return m === 1440 ? '1 day' : `${m / 1440} days`;
  const h = m / 60;
  return long ? `${h} hour${h === 1 ? '' : 's'}` : `${h}h`;
}

/** "2h 14m", "38m", "<1m" */
export function formatLeft(ms: number): string {
  if (ms < MIN) return '<1m';
  const totalMin = Math.floor(ms / MIN);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Four characters max for the toolbar badge. */
export function badgeText(ms: number): string {
  if (ms < MIN) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

export function formatDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(t: number, now: number): string {
  const diff = Math.round((startOfDay(now) - startOfDay(t)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function relDay(t: number, now: number): string {
  const l = dayLabel(t, now);
  return l === 'Today' || l === 'Yesterday' ? l.toLowerCase() : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/^m\./, '');
  } catch {
    return '';
  }
}

export function isTrackableUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^(https?|file):/.test(url);
}

const PALETTE = ['#2F6FEB', '#7A5AF8', '#E8590C', '#0E9F6E', '#0B7285', '#C2255C'];

export function siteKind(url: string): SiteKind {
  const h = hostOf(url);
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$|vimeo\.com$|twitch\.tv$/.test(h)) return 'video';
  if (/\/(feed|rss)(\/|$)|\.xml$/.test(url) || /substack|medium\.com|feedly/.test(h)) return 'feed';
  if (/news|times|post|guardian|bbc|cnn|reuters|bloomberg|journal|herald|tribune/.test(h)) return 'news';
  if (h) return 'article';
  return 'other';
}

/** Tile colour for a site: YouTube is red, everything else a stable colour per domain. */
export function siteColor(url: string): string {
  const h = hostOf(url);
  if (/youtube\.com$|youtu\.be$/.test(h)) return '#FF4E45';
  let n = 0;
  for (const c of h) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length];
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "How to build a cabin - YouTube" → "How to build a cabin"; also drops YouTube's "(3) " unread counter. */
export function cleanTitle(t: string): string {
  return t.replace(/^\(\d+\)\s+/, '').replace(/\s+[-–|]\s+YouTube$/, '').trim();
}
