// Renders the toolbar/store icons (accent tile + hourglass) to public/icon/*.png.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync } from 'node:fs';

const svg = (size) => {
  const pad = size <= 16 ? 0 : size * 0.06;
  const s = size - pad * 2;
  const r = s * 0.27;
  const g = s * 0.56;
  const o = pad + (s - g) / 2;
  const sw = size <= 16 ? 2.6 : size <= 32 ? 2.4 : 2.1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${pad}" y="${pad}" width="${s}" height="${s}" rx="${r}" fill="#3E8C76"/>
  <g transform="translate(${o} ${o}) scale(${g / 24})" fill="none" stroke="#FFFFFF" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 22h14"/><path d="M5 2h14"/>
    <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/>
    <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>
  </g></svg>`;
};

mkdirSync('public/icon', { recursive: true });
for (const size of [16, 32, 48, 96, 128]) {
  const png = new Resvg(svg(size), { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(`public/icon/${size}.png`, png);
}
// Edge Add-ons store logo.
mkdirSync('store', { recursive: true });
writeFileSync('store/logo-300.png', new Resvg(svg(300), { fitTo: { mode: 'width', value: 300 } }).render().asPng());
console.log('icons written');
