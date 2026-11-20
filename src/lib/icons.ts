import {
  BookOpen, Check, ChevronDown, ClockPlus, Ellipsis, Hourglass, Info, Layers, Leaf, Lock,
  Newspaper, Plus, RotateCcw, Rss, Settings2, Timer, TimerOff, Trash2, X, Globe,
} from 'lucide';
import type { SiteKind } from './types';

type IconNode = [string, Record<string, string | number>][];

// Lucide removed brand marks; this is the classic ISC-licensed video glyph.
const Video: IconNode = [
  ['path', { d: 'M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17' }],
  ['path', { d: 'm10 15 5-3-5-3z' }],
];

export const ICONS = {
  video: Video, book: BookOpen, check: Check, chevron: ChevronDown, clockPlus: ClockPlus,
  more: Ellipsis, hourglass: Hourglass, info: Info, layers: Layers, leaf: Leaf, lock: Lock,
  news: Newspaper, plus: Plus, reopen: RotateCcw, rss: Rss, settings: Settings2, timer: Timer,
  timerOff: TimerOff, trash: Trash2, x: X, globe: Globe,
} as unknown as Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

const NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName | string, size = 16, strokeWidth = 2): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, String(v));
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

export function kindIcon(k: SiteKind): IconName {
  return ({ video: 'video', article: 'book', feed: 'rss', news: 'news', other: 'globe' } as const)[k];
}
