// يولّد أيقونات PNG من SVG باستخدام Chromium (Playwright المثبت مسبقًا).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const icon = (pad, bg = '#0f766e') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 112}" fill="${bg}"/>
  <g transform="translate(256 262) scale(${pad ? 0.72 : 0.9}) translate(-256 -262)">
    <rect x="136" y="96" width="240" height="312" rx="28" fill="#fff"/>
    <rect x="196" y="72" width="120" height="56" rx="18" fill="#cdeee9" stroke="#fff" stroke-width="12"/>
    <path d="M186 266l46 46 96-104" fill="none" stroke="${bg}" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="186" y="342" width="140" height="18" rx="9" fill="#9fd8cf"/>
  </g></svg>`;
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><path d="M18 38l12 12 24-28" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const out = [
  ['public/icons/icon-192.png', icon(false), 192],
  ['public/icons/icon-512.png', icon(false), 512],
  ['public/icons/icon-maskable-512.png', icon(true), 512],
  ['public/icons/apple-touch-icon.png', icon(true), 180],
  ['public/icons/badge-72.png', badge, 72],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, svg, size] of out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  fs.writeFileSync(file, await page.screenshot({ omitBackground: true }));
  console.log(file);
}
await browser.close();
