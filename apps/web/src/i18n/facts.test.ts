import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhCN } from './zh-CN';

/**
 * Sentences that state how the server behaves. A review found four of them
 * contradicting the server; these tests pin what each must say (and must not
 * say again), in both languages, so the words cannot drift from the facts.
 */
describe('what the interface says about the server', () => {
  it('Auto mode: dangerous requests are not put to a person; only deny rules and the built-in deny list stop one', () => {
    for (const key of ['workbench.mode.auto.warning', 'workbench.mode.auto.hint', 'projects.feature.autoMode.riskMessage', 'projects.feature.autoMode.text'] as const) {
      expect(en[key], key).toMatch(/deny rules/);
      expect(en[key], key).toMatch(/built-in deny list/);
      expect(en[key], key).not.toMatch(/still put to a person|still asks? (?:a|for) person/i);
      expect(zhCN[key], key).toMatch(/拒绝规则/);
      expect(zhCN[key], key).toMatch(/内置的拒绝清单/);
      expect(zhCN[key], key).not.toMatch(/仍会交给人/);
    }
    for (const key of ['workbench.mode.auto.warning', 'workbench.mode.auto.hint', 'projects.feature.autoMode.riskMessage'] as const) {
      expect(en[key], key).toMatch(/dangerous/);
      expect(zhCN[key], key).toMatch(/危险/);
    }
  });

  it('the terminal is the owner’s alone', () => {
    expect(en['about.terminal.on']).toMatch(/Only the owner/);
    expect(en['about.terminal.on']).not.toMatch(/write access to a project can open/);
    expect(zhCN['about.terminal.on']).toMatch(/只有.*所有者/);
  });

  it('members see only the conversations they started', () => {
    expect(en['projects.sharing.footer']).toMatch(/only the conversations they started/);
    expect(en['projects.sharing.footer']).not.toMatch(/reads conversations/);
    expect(en['projects.sharing.readHint']).not.toMatch(/everything/);
    expect(en['projects.yourAccess.readText']).not.toMatch(/^Read its conversations/);
    expect(en['projects.yourAccess.readText']).toMatch(/only by whoever started them/);
    expect(zhCN['projects.sharing.footer']).toMatch(/只能看到自己发起的对话/);
    expect(zhCN['projects.yourAccess.readText']).toMatch(/只有发起人和所有者/);
  });

  it('deleting a person keeps the memory notes they wrote', () => {
    expect(en['people.delete.message']).toMatch(/notes they wrote are kept/);
    expect(en['people.delete.message']).not.toMatch(/notes are deleted/);
    expect(zhCN['people.delete.message']).toMatch(/笔记会保留/);
    expect(zhCN['people.delete.message']).not.toMatch(/笔记会被删除/);
  });
});
