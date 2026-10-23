/**
 * Everything the showcase pictures, in English and Chinese. All of it is
 * fictional: the project, people, mail and every agent reply are written here.
 */

export const files = {
  'package.json': `{
  "name": "lumen-shop",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "lint": "eslint ." }
}
`,
  'src/cart/total.ts': `export interface CartLine {
  price: number;
  quantity: number;
}

export function cartTotal(lines: CartLine[], discount = 0): number {
  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  return Number((subtotal * (1 - discount)).toFixed(2));
}
`,
  'src/cart/total.test.ts': `import { expect, it } from 'vitest';
import { cartTotal } from './total';

it('adds up a basket', () => {
  expect(cartTotal([{ price: 3.2, quantity: 3 }])).toBe(9.6);
});
`,
  'src/refunds/total.ts': `export interface RefundItem { amount: number }

export function refundTotal(items: RefundItem[]): number {
  const sum = items.reduce((total, item) => total + item.amount, 0);
  return Number(sum.toFixed(2));
}
`,
};

/** The fix the agent "made", written to disk after the first commit so the Git panel shows a real diff. */
export const fixedTotal = `export interface CartLine {
  price: number;
  quantity: number;
}

export function cartTotal(lines: CartLine[], discount = 0): number {
  // Work in whole pence: adding decimals drifts (0.1 + 0.2 !== 0.3).
  const pence = lines.reduce((sum, line) => sum + Math.round(line.price * 100) * line.quantity, 0);
  return Math.round(pence * (1 - discount)) / 100;
}
`;

export const fixedTest = `import { expect, it } from 'vitest';
import { cartTotal } from './total';

it('adds up a basket', () => {
  expect(cartTotal([{ price: 3.2, quantity: 3 }])).toBe(9.6);
});

it('never drifts by a penny', () => {
  expect(cartTotal([{ price: 0.1, quantity: 1 }, { price: 0.2, quantity: 1 }])).toBe(0.3);
});
`;

const en = {
  ui: {
    conversation: 'Conversation',
    showTools: 'Show project tools',
    hideTools: 'Hide project tools',
    projectTools: 'Project tools',
    agentPicker: /^Agent and model:/,
    git: 'Git',
    domain: 'Your domain',
  },
  demoAccount: 'demo@example.invalid',
  defaultModel: 'Default model',
  runTests: 'Run the test suite',
  user: 'Alex',
  project: 'lumen-shop',
  otherProjects: ['docs-site', 'mobile-app'],
  group: 'Checkout',
  prompts: {
    fix: 'Customers say checkout totals are sometimes a penny off. Find the cause and fix it.',
    refund: 'Apply the same fix to refunds',
    review: 'Review the checkout rounding fix',
    upgrade: 'Upgrade the storefront to React 19',
    notes: 'Draft the release notes',
  },
  titles: {
    fix: 'Fix checkout rounding',
    refund: 'Same fix for refunds',
    task: 'Review the checkout fix',
    upgrade: 'Upgrade to React 19',
    notes: 'Release notes for 2.4',
  },
  fixAnswer:
    '## Fixed: checkout totals are exact again\n\n`cartTotal` added prices as decimals and rounded once at the end, so some baskets drifted by a penny.\n\n- **Cause**: floating-point sums such as `0.1 + 0.2`\n- **Fix**: add whole pence, round once\n- **Tests**: 18 passed, including a new rounding case\n\n`src/refunds/total.ts` has the same pattern. Want me to fix it too?',
  refundIntro:
    'Refunds add up decimals the same way. Here is the change; approve it and I will run the tests.',
  refundTitle: 'Edit src/refunds/total.ts',
  refundDone: 'Done. Refund totals now use whole pence as well.',
  reviewClaude:
    '## The fix is sound\n\nWhole pence remove the drift, and rounding happens once.\n\n- The new test covers `0.1 + 0.2`\n- Discounts still round half up\n\nReady to merge.',
  reviewCodex:
    '## Approve, with one more test\n\nThe arithmetic is right. One gap:\n\n1. Add a case for a **100% discount** (total should be 0)\n2. `refundTotal` still uses `toFixed`\n\nOtherwise good to go.',
  upgradeTodos: [
    'Update react and react-dom',
    'Fix type errors in 6 components',
    'Run the browser tests',
  ],
  upgradeProgress: 'Fixing the remaining type errors in the product page components.',
  notesProgress: 'Collecting the merged pull requests since 2.3.',
  memory: [
    {
      title: 'Money is stored in pence',
      body: '## Prices and totals\n\nStore and add money as **whole pence** (integers). Convert to pounds only for display.\n\n- Never add prices as decimals\n- Round once, at the end\n- Every money function has a rounding test',
      tags: ['decision', 'checkout'],
      keywords: ['money', 'pence', 'rounding'],
    },
    {
      title: 'Before you commit',
      body: 'Run `npm test` and `npm run lint`. Keep commits small and explain *why* in the message.',
      tags: ['workflow'],
      keywords: ['tests', 'lint', 'commit'],
    },
    {
      title: 'Checkout architecture',
      body: 'The cart, discounts and refunds live in `src/cart` and `src/refunds`. Payment goes through the provider SDK only.',
      tags: ['architecture'],
      keywords: ['checkout', 'cart', 'refunds'],
    },
  ],
  globalMemory: {
    title: 'How we work',
    body: 'Search existing notes before starting. Write down decisions the next agent will need. Never put credentials in notes.',
    tags: ['workflow'],
    keywords: ['memory', 'decisions'],
  },
  tools: [
    {
      kind: 'skill',
      name: 'code-review',
      description: 'Review a change for bugs, tests and readability.',
      content: 'Review $ARGUMENTS for correctness, missing tests and unclear code.',
    },
    {
      kind: 'command',
      name: 'fix-issue',
      description: 'Reproduce an issue, fix it and add a test.',
      content: 'Reproduce $ARGUMENTS with a failing test, fix it, and explain the cause.',
    },
    {
      kind: 'skill',
      name: 'release-notes',
      description: 'Summarise merged changes for users.',
      content: 'Write release notes for $ARGUMENTS in plain language.',
    },
  ],
  mail: [
    {
      id: 'penny',
      subject: 'Checkout total is off by a penny',
      from: 'support@example.invalid',
      preview: 'Two customers reported a £0.01 difference at checkout.',
      text: 'Hi Alex,\n\nTwo customers reported that the checkout total was £0.01 higher than the sum of their basket.\n\nBoth used the SPRING10 discount.\n\nThanks,\nSupport (fictional)',
    },
    {
      id: 'release',
      subject: 'Release 2.4 checklist',
      from: 'team@example.invalid',
      preview: 'What is left before Friday.',
      text: 'The fictional release checklist.',
    },
  ],
  mailbox: 'Demo mailbox',
  providers: {
    anthropic: 'Anthropic',
    compatible: 'OpenAI compatible',
    local: 'Local models',
    reasoning: 'Reasoning model',
    fast: 'Fast model',
    code: 'Coding model',
    localModel: 'Local model',
  },
};

const zh = {
  ...en,
  ui: {
    conversation: '会话内容',
    showTools: '显示项目工具',
    hideTools: '隐藏项目工具',
    projectTools: '项目工具',
    agentPicker: /^智能体与模型：/,
    git: 'Git 仓库',
    domain: '你的域名',
  },
  user: 'Alex',
  defaultModel: '默认模型',
  runTests: '运行测试',
  group: '结账',
  prompts: {
    fix: '有顾客反馈结账金额偶尔差一分钱，找出原因并修好。',
    refund: '退款也按同样的方法修一下',
    review: '审查结账金额的修复',
    upgrade: '把商城升级到 React 19',
    notes: '起草发布说明',
  },
  titles: {
    fix: '修复结账金额误差',
    refund: '退款金额同样修复',
    task: '审查结账修复',
    upgrade: '升级到 React 19',
    notes: '2.4 版发布说明',
  },
  fixAnswer:
    '## 已修复：结账金额恢复精确\n\n`cartTotal` 用小数直接相加、最后才四舍五入，所以有些订单会差一分钱。\n\n- **原因**：浮点数相加的误差，例如 `0.1 + 0.2`\n- **修复**：先换算成整数“便士”相加，只取整一次\n- **测试**：18 项全部通过，新增一项取整测试\n\n`src/refunds/total.ts` 也有同样的写法，要一起修吗？',
  refundIntro: '退款金额也是小数直接相加。改动如下，批准后我来跑测试。',
  refundTitle: '编辑 src/refunds/total.ts',
  refundDone: '完成。退款金额也改为按整数便士计算。',
  reviewClaude:
    '## 修复没有问题\n\n按整数便士计算消除了误差，并且只取整一次。\n\n- 新测试覆盖了 `0.1 + 0.2`\n- 折扣仍然四舍五入\n\n可以合并。',
  reviewCodex:
    '## 同意，再补一个测试\n\n计算是对的，还有一处遗漏：\n\n1. 补一个 **100% 折扣**的用例（总额应为 0）\n2. `refundTotal` 仍在用 `toFixed`\n\n其余都没问题。',
  upgradeTodos: ['升级 react 和 react-dom', '修复 6 个组件的类型错误', '运行浏览器测试'],
  upgradeProgress: '正在修复商品页组件里剩下的类型错误。',
  notesProgress: '正在整理 2.3 之后合并的改动。',
  memory: [
    {
      title: '金额统一按便士存储',
      body: '## 价格与合计\n\n金额一律按**整数便士**存储和相加，只在显示时换算成英镑。\n\n- 不要用小数直接相加\n- 只在最后取整一次\n- 每个金额函数都要有取整测试',
      tags: ['决定', '结账'],
      keywords: ['金额', '便士', '取整'],
    },
    {
      title: '提交前要做的事',
      body: '运行 `npm test` 和 `npm run lint`。提交要小，提交说明写清楚*为什么*。',
      tags: ['流程'],
      keywords: ['测试', '提交'],
    },
    {
      title: '结账模块结构',
      body: '购物车、折扣和退款在 `src/cart` 与 `src/refunds`。支付只通过服务商 SDK。',
      tags: ['架构'],
      keywords: ['结账', '购物车', '退款'],
    },
  ],
  globalMemory: {
    title: '协作约定',
    body: '开始前先搜索已有笔记。把下一个助手需要知道的决定记下来。笔记里绝不放凭据。',
    tags: ['流程'],
    keywords: ['记忆', '决定'],
  },
  tools: [
    {
      kind: 'skill',
      name: 'code-review',
      description: '检查改动里的错误、测试和可读性。',
      content: '审查 $ARGUMENTS 的正确性、缺失的测试和不清楚的代码。',
    },
    {
      kind: 'command',
      name: 'fix-issue',
      description: '复现问题、修复并补测试。',
      content: '先用失败的测试复现 $ARGUMENTS，再修复并说明原因。',
    },
    {
      kind: 'skill',
      name: 'release-notes',
      description: '为用户整理已合并的改动。',
      content: '用平实的语言为 $ARGUMENTS 写发布说明。',
    },
  ],
  mail: [
    {
      id: 'penny',
      subject: '结账金额差了一分钱',
      from: 'support@example.invalid',
      preview: '两位顾客反馈结账时多了 0.01 英镑。',
      text: 'Alex 你好，\n\n两位顾客反馈，结账金额比购物车合计多了 0.01 英镑。\n\n两人都用了 SPRING10 折扣码。\n\n谢谢，\n客服（虚构）',
    },
    {
      id: 'release',
      subject: '2.4 版发布清单',
      from: 'team@example.invalid',
      preview: '周五之前还剩的事项。',
      text: '虚构的发布清单。',
    },
  ],
  mailbox: '演示邮箱',
  providers: {
    anthropic: 'Anthropic',
    compatible: 'OpenAI 兼容',
    local: '本地模型',
    reasoning: '推理模型',
    fast: '快速模型',
    code: '编程模型',
    localModel: '本地模型',
  },
};

export function content(lang) {
  return lang === 'zh-CN' ? zh : en;
}
