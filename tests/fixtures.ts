import type { Playbook } from '../src/playbook/schema.js';

/** 覆盖全部 12+1 种步骤类型的合法 Playbook */
export const validPlaybook = {
  version: 1,
  name: 'all-steps',
  description: '覆盖全部步骤类型',
  vars: { host: 'https://demo.local' },
  meta: { baseUrl: 'https://demo.local', allowDomains: ['demo.local'], sensitive: ['password'] },
  steps: [
    { action: 'goto', name: '打开', url: '${vars.host}/home' },
    { action: 'click', name: '点按钮', selector: { css: '#btn', text: '按钮' } },
    { action: 'fill', name: '填输入框', selector: { css: '#input' }, value: '${params.text}' },
    { action: 'select', name: '选下拉', selector: { css: 'select' }, value: 'a' },
    { action: 'check', name: '勾选', selector: { role: 'checkbox', label: '同意' }, checked: true },
    { action: 'hover', name: '悬停', selector: { xpath: '//div[@id="x"]' } },
    { action: 'press', name: '回车', key: 'Enter' },
    { action: 'wait', name: '等元素', selector: { css: '.loaded' }, timeout: 3000 },
    { action: 'extract', name: '提取', selector: { css: '.val' }, attr: 'text' as const, into: 'result' },
    { action: 'scroll', name: '滚到底', to: 'bottom' as const },
    { action: 'download', name: '下载', urlPattern: '/export', saveTo: './out.xlsx' },
    { action: 'screenshot', name: '截图', fullPage: true },
    { action: 'assert', name: '断言', textContains: '成功' },
    {
      action: 'loop', name: '循环', over: '${params.items}', var: 'item',
      steps: [{ action: 'fill', name: '填值', selector: { css: '#v' }, value: '${item.v}' }],
    },
  ],
} satisfies Playbook;
