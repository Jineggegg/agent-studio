#!/usr/bin/env node
/* global document */
/** Render original HTML/CSS device frames around the real, synthetic-data captures. */
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'docs/assets/screenshots');
const temporary = await mkdtemp(path.join(tmpdir(), 'cloud-harness-poster-'));
let browser;
try {
  for (const file of ['devices.html', 'devices.css']) {
    await copyFile(new URL(file, import.meta.url), path.join(temporary, file));
  }
  for (const file of ['desktop.png', 'tablet.png', 'phone.png']) {
    await copyFile(path.join(output, file), path.join(temporary, file));
  }
  await copyFile(
    path.join(root, 'apps/web/public/icons/icon-96.png'),
    path.join(temporary, 'brand.png'),
  );
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1120 },
    deviceScaleFactor: 1.5,
  });
  // The composition is entirely local. No fonts, trackers or other remote assets.
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(path.join(temporary, 'devices.html')).href);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => image.decode()));
  });
  await page.screenshot({ path: path.join(output, 'devices.png'), animations: 'disabled' });
  const chinese = {
    edition: '自主托管 · 开源',
    title: ['你的 AI 团队，', '一个工作空间。'],
    eyebrow: '让工作跟着你走',
    description: ['电脑上开始，', '随时随地接着做。'],
    capabilities: ['多模型 · 共享记忆', '代理协作 · 自定义域名'],
    tablet: 'iPad / 平板',
    desktop: '电脑',
    phone: '手机',
    footer: '自己的服务器，自己的项目，自己的节奏。',
    disclosure: ['实际界面 · 虚构演示数据', '浏览器视口截图，设备边框为示意'],
  };
  await page.evaluate((copy) => {
    document.documentElement.lang = 'zh-CN';
    for (const [key, value] of Object.entries(copy)) {
      const target = document.querySelector(`[data-copy="${key}"]`);
      if (!target) throw new Error(`Missing copy target: ${key}`);
      target.replaceChildren();
      (Array.isArray(value) ? value : [value]).forEach((line, index) => {
        if (index > 0) target.append(document.createElement('br'));
        target.append(document.createTextNode(line));
      });
    }
    return document.fonts.ready.then(() => undefined);
  }, chinese);
  await page.screenshot({ path: path.join(output, 'devices.zh-CN.png'), animations: 'disabled' });
  for (const name of ['devices.png', 'devices.zh-CN.png']) {
    console.log(`${name}: ${(await readFile(path.join(output, name))).byteLength} bytes`);
  }
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
