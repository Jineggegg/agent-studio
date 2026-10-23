/**
 * Lays the real captures out as product images: one hero and one card per idea.
 *
 *   node scripts/showcase/compose.mjs --lang en|zh-CN --raw <captures> --out <directory>
 *
 * Everything is local: no fonts, scripts or images are fetched.
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values: args } = parseArgs({
  options: {
    lang: { type: 'string', default: 'en' },
    raw: { type: 'string' },
    out: { type: 'string' },
  },
});
const lang = args.lang === 'zh-CN' ? 'zh-CN' : 'en';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const raw = path.resolve(args.raw ?? path.join(repo, 'docs/assets/showcase', lang, 'raw'));
const out = path.resolve(args.out ?? path.join(repo, 'docs/assets/showcase', lang));
await mkdir(out, { recursive: true });
await copyFile(new URL('poster.css', import.meta.url), path.join(raw, 'poster.css'));
await copyFile(path.join(repo, 'apps/web/public/icons/icon-192.png'), path.join(raw, 'brand.png'));

const copy = {
  en: {
    note: 'Real product UI · fictional demo data · scripted agent replies',
    hero: {
      title: 'Your coding agents,<br />anywhere you are.',
      lede: 'Run Claude Code, Codex and API models on your own server. Review every change, and approve the next step from your phone.',
      chips: ['Claude Code', 'Codex', 'API & local models', 'Self-hosted · MIT'],
      address: 'harness.example.com',
    },
    approval: [
      'Approvals',
      'Approve from your phone',
      'Risky steps wait for you. See the exact diff, then allow or deny from any screen.',
      [
        'The exact change, before it happens',
        'Allow once, or remember the rule',
        'Nobody answers? It is denied',
      ],
    ],
    changes: [
      'Transparency',
      'See what changed, and why',
      'Every file read, edit and command appears as it happens, with the diff and the test results.',
      ['Diffs for every edit', 'Commands with their output', 'Commit from the Git panel'],
    ],
    agents: [
      'Models',
      'Every agent, one place',
      'Claude Code and Codex with the sign-ins you already have, plus Anthropic, OpenAI-compatible and local models.',
      [
        'Switch agent or model per conversation',
        'Hand a conversation to another agent',
        'Keys stay encrypted on your server',
      ],
    ],
    review: [
      'Collaboration',
      'Two agents, one review',
      'Ask Claude Code and Codex the same question and compare their answers side by side.',
    ],
    memory: [
      'Memory',
      'Memory your agents share',
      'Decisions live in plain Markdown notes that you and every agent can read and edit.',
      [
        'Per project, plus global notes',
        'Searchable by you and your agents',
        'Plain files you can back up',
      ],
    ],
    running: [
      'Activity',
      'Know what is running',
      'See what is working and what waits for you, then pick it up on any device.',
    ],
    hosting: {
      kicker: 'Self-hosted',
      title: 'Your server.<br />Your keys.',
      points: [
        ['server', 'Runs on your machine', 'One-line install on Linux, macOS or WSL'],
        ['shield', 'Agents in a sandbox', 'Anything risky needs your approval'],
        ['lock', 'Passkeys and HTTPS', 'Reach it from anywhere on your own domain'],
        ['code', 'Open source', 'MIT licence: read, change and audit the code'],
      ],
      terminal: ['Cloud Harness 2.0 installed', 'Service started', 'Open http://127.0.0.1:7420'],
    },
  },
  'zh-CN': {
    note: '真实产品界面 · 虚构演示数据 · 智能体回复为预设脚本',
    hero: {
      title: '编程智能体，<br />随时随地掌控。',
      lede: '在自己的服务器上运行 Claude Code、Codex 和 API 模型。每处改动都看得清，下一步用手机就能批准。',
      chips: ['Claude Code', 'Codex', 'API 与本地模型', '自托管 · MIT 开源'],
      address: 'harness.example.com',
    },
    approval: [
      '审批',
      '用手机批准每一步',
      '有风险的操作都会等你确认。看清具体改动，在任何设备上允许或拒绝。',
      ['动手之前先看到具体改动', '允许一次，或记住这条规则', '没人回应就自动拒绝'],
    ],
    changes: [
      '过程透明',
      '改了什么，一目了然',
      '读了哪些文件、改了哪几行、跑了什么命令，连同测试结果都实时可见。',
      ['每次编辑都有 diff', '命令和输出一起显示', '在 Git 面板里直接提交'],
    ],
    agents: [
      '模型',
      '所有智能体，<br />一个入口',
      'Claude Code 和 Codex 沿用你已有的登录，也能接入 Anthropic、OpenAI 兼容和本地模型。',
      ['每个会话单独选智能体和模型', '把会话交给另一个智能体接着做', '密钥加密保存在你的服务器上'],
    ],
    review: [
      '协作',
      '两个智能体，一次对比',
      '把同一个问题交给 Claude Code 和 Codex，并排比较它们的回答。',
    ],
    memory: [
      '记忆',
      '共享的项目记忆',
      '决定写成普通的 Markdown 笔记，你和每个智能体都能读、能改。',
      ['按项目分，也有全局笔记', '你和智能体都能搜索', '普通文件，方便备份'],
    ],
    running: ['进度', '谁在干活，一眼看清', '哪些正在运行、哪些在等你，换一台设备也能接着做。'],
    hosting: {
      kicker: '自托管',
      title: '你的服务器，<br />你的密钥。',
      points: [
        ['server', '装在自己的机器上', 'Linux、macOS 或 WSL，一行命令安装'],
        ['shield', '智能体在沙箱里运行', '有风险的操作都要你批准'],
        ['lock', '通行密钥与 HTTPS', '用自己的域名在任何地方访问'],
        ['code', '开源', 'MIT 许可，代码可读、可改、可审计'],
      ],
      terminal: ['Cloud Harness 2.0 已安装', '服务已启动', '打开 http://127.0.0.1:7420'],
    },
  },
}[lang];

const icons = {
  server:
    '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
};

const page = (body, { width, height, accent, tint, tint2, note }) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8" /><link rel="stylesheet" href="poster.css" />
<style>:root{--accent:${accent};--tint:${tint};--tint-2:${tint2 ?? 'transparent'}}</style></head>
<body><main class="canvas" style="width:${width}px;height:${height}px">${body}
${note}</main></body></html>`;

const check = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
const words = ([kicker, title, lede, facts = []]) =>
  `<div class="copy"><span class="kicker">${kicker}</span><h2>${title}</h2><p class="lede">${lede}</p>${
    facts.length
      ? `<ul class="facts">${facts.map((fact) => `<li>${check}${fact}</li>`).join('')}</ul>`
      : ''
  }</div>`;
const shot = (image, style, extra = '', inset = 0) =>
  `<div class="shot ${extra}" style="${style}"><img src="${image}" alt="" style="${
    inset ? `width:calc(100% + ${inset * 2}px);margin:-${inset}px` : ''
  }" /></div>`;

const scenes = {
  hero: {
    size: [1600, 900],
    scale: 1.5,
    accent: '#3340d6',
    tint: 'rgba(92, 108, 255, 0.16)',
    tint2: 'rgba(255, 176, 92, 0.14)',
    body: `
      <div class="copy">
        <div class="brand"><img src="brand.png" alt="" />Cloud Harness</div>
        <h1>${copy.hero.title}</h1>
        <p class="lede">${copy.hero.lede}</p>
        <div class="chips">${copy.hero.chips.map((chip) => `<span class="chip">${chip}</span>`).join('')}</div>
      </div>
      <div class="window" style="left:720px;top:92px;width:980px">
        <div class="bar"><i></i><i></i><i></i><span>${copy.hero.address}</span></div>
        <img src="desktop.png" alt="" />
      </div>
      <div class="phone" style="left:640px;top:372px;width:228px"><img src="phone.png" alt="" /></div>`,
  },
  approval: {
    accent: '#c26a00',
    tint: 'rgba(255, 170, 60, 0.2)',
    body: `${words(copy.approval)}${shot('approval.png', 'left:640px;top:96px;width:470px;border:none;background:none;border-radius:20px', '')}`,
  },
  changes: {
    accent: '#1f8a4c',
    tint: 'rgba(60, 190, 110, 0.16)',
    body: `${words(copy.changes)}${shot('run.png', 'left:600px;top:64px;width:600px;height:720px;border-radius:22px 0 0 0;border-right:none')}`,
  },
  agents: {
    accent: '#3340d6',
    tint: 'rgba(92, 108, 255, 0.16)',
    body: `${words(copy.agents)}${shot('agents.png', 'left:660px;top:72px;width:440px;height:720px;border-radius:26px 26px 0 0')}`,
  },
  review: {
    accent: '#7a3fd1',
    tint: 'rgba(150, 100, 255, 0.16)',
    stack: true,
    body: `${words(copy.review)}${shot('task.png', 'left:76px;top:316px;width:1048px;height:480px;border-radius:22px 22px 0 0')}`,
  },
  memory: {
    accent: '#0f7c8c',
    tint: 'rgba(40, 180, 200, 0.16)',
    body: `${words(copy.memory)}${shot('memory.png', 'left:590px;top:96px;width:560px;border-radius:24px', '', 5)}`,
  },
  running: {
    accent: '#b4315a',
    tint: 'rgba(240, 90, 130, 0.14)',
    stack: true,
    body: `${words(copy.running)}${shot('running.png', 'left:76px;top:316px;width:1048px;height:480px;border-radius:22px 22px 0 0')}`,
  },
  hosting: {
    accent: '#3340d6',
    tint: 'rgba(92, 108, 255, 0.14)',
    body: `
      <div class="copy" style="width:520px">
        <span class="kicker">${copy.hosting.kicker}</span><h2>${copy.hosting.title}</h2>
        <ul class="points">${copy.hosting.points
          .map(
            ([icon, title, detail]) =>
              `<li><svg viewBox="0 0 24 24">${icons[icon]}</svg><div><b>${title}</b><span>${detail}</span></div></li>`,
          )
          .join('')}</ul>
      </div>
      <div class="terminal" style="left:650px;top:150px;width:480px">
        <div class="bar"><i></i><i></i><i></i></div>
        <pre><span class="dim">$</span> <span class="cmd">curl -fsSL …/install.sh | bash</span>

<span class="ok">✓</span> ${copy.hosting.terminal[0]}
<span class="ok">✓</span> ${copy.hosting.terminal[1]}

<span class="dim">→</span> ${copy.hosting.terminal[2]}</pre>
      </div>`,
  },
};

const browser = await chromium.launch();
try {
  for (const [name, scene] of Object.entries(scenes)) {
    const [width, height] = scene.size ?? [1200, 750];
    const html = path.join(raw, `poster-${name}.html`);
    await writeFile(
      html,
      page(
        `<div class="${scene.size ? 'hero' : `card${scene.stack ? ' stack' : ''}`}" style="position:absolute;inset:0">${scene.body}</div>`,
        {
          width,
          height,
          accent: scene.accent,
          tint: scene.tint,
          tint2: scene.tint2,
          note: scene.size ? `<p class="note">${copy.note}</p>` : '',
        },
      ),
    );
    const view = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: scene.scale ?? 2,
    });
    await view.route(/^https?:/, (route) => route.abort());
    await view.goto(pathToFileURL(html).href);
    await view.evaluate(async () => {
      /* global document */
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, (image) => image.decode()));
    });
    await view.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled' });
    await view.close();
    console.log(`Composed ${lang}/${name}.png`);
  }
} finally {
  await browser.close();
}
