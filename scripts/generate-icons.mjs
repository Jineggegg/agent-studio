#!/usr/bin/env node
/**
 * Rasterises the Agent Studio mark into every PNG the web client needs:
 * manifest icons (72–512), maskable icons, Apple touch icons, the favicon
 * fallback and the monochrome notification badge.
 *
 *   node scripts/generate-icons.mjs
 *
 * The generated files in apps/web/public/icons are committed, so a normal
 * build needs neither this script nor a browser. Re-run it only when the mark
 * changes (and bump the `?v=` stamp in manifest.webmanifest so installed apps
 * pick the new icon up). Needs Playwright's Chromium: `npx playwright install chromium`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const OUT = fileURLToPath(new URL('../apps/web/public/icons/', import.meta.url));

const PLATE = '#2a37b8';
const RING = '#ffffff';
const SPARK = '#ffc24a';

/** The mark on a 512 grid: an open ring and the spark that closes it. */
const mark = (ring, spark) => `
  <path d="M374.18 235.16A120 120 0 1 1 276.84 137.82" fill="none" stroke="${ring}" stroke-width="44" stroke-linecap="round"/>
  <circle cx="340.85" cy="171.15" r="31" fill="${spark}"/>`;

const scaled = (factor, content) => `<g transform="translate(256 256) scale(${factor}) translate(-256 -256)">${content}</g>`;

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>`;

const designs = {
  /** Rounded plate with transparent corners: browsers and launchers that do not mask. */
  standard: svg(`<rect width="512" height="512" rx="118" fill="${PLATE}"/>${scaled(0.82, mark(RING, SPARK))}`),
  /** Full-bleed plate with the mark inside the central safe zone: the platform cuts its own shape. */
  maskable: svg(`<rect width="512" height="512" fill="${PLATE}"/>${scaled(0.62, mark(RING, SPARK))}`),
  /** Full-bleed, opaque: iOS rounds the corners itself and shows black where there is transparency. */
  apple: svg(`<rect width="512" height="512" fill="${PLATE}"/>${scaled(0.74, mark(RING, SPARK))}`),
  /** White on transparent: Android tints the notification badge itself. */
  badge: svg(scaled(1.25, mark('#ffffff', '#ffffff'))),
};

const targets = [
  ...[32, 72, 96, 128, 144, 152, 192, 384, 512].map((size) => ({ file: `icon-${size}.png`, size, design: 'standard' })),
  ...[192, 512].map((size) => ({ file: `maskable-${size}.png`, size, design: 'maskable' })),
  ...[152, 167, 180].map((size) => ({ file: `apple-touch-${size}.png`, size, design: 'apple' })),
  { file: 'badge-96.png', size: 96, design: 'badge' },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const target of targets) {
    const page = await browser.newPage({ viewport: { width: target.size, height: target.size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${target.size}px;height:${target.size}px}</style>${designs[target.design]}`,
    );
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: target.size, height: target.size } });
    await writeFile(`${OUT}${target.file}`, png);
    await page.close();
    console.log(`${target.file}  ${target.size}×${target.size}  ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
