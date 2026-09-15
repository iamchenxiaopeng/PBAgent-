import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * 反爬指纹擦除（stealth）。
 *
 * 为什么需要：无头 Chromium 默认会暴露一串"我是机器人"的特征，
 * 大站点（百度/淘宝等）据此直接弹验证码。最致命的三个：
 *   1. navigator.webdriver === true          —— 无头/自动化的标准标记
 *   2. UA 里带 "HeadlessChrome"              —— 等于自报家门
 *   3. window.chrome 缺失                    —— 真实 Chrome 一定有
 *
 * 实测（2026-09-15，百度）：
 *   裸 headless 访问 /s?wd=xxx      → 跳 wappass 验证码
 *   加 stealth 后同样 URL          → 正常返回 9 条结果
 *
 * 注意：这层只降低被识别概率，不是免死金牌。
 * 实测百度首页新版 AI 输入框（#chat-textarea）即使加 stealth 仍会触发验证码——
 * 该入口风控更严，绕行策略见 loop.ts 的提示词。
 */

/** 真实 Chrome UA 模板；占位符 {V} 会在运行时替换成实际 Chromium 主版本号 */
const UA_TEMPLATE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{V}.0.0.0 Safari/537.36';

/** launch 参数：关掉自动化痕迹相关的 Blink 特性 */
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled', // 去掉 navigator.webdriver 的底层注入
  '--disable-infobars', // 去掉"Chrome 正在受到自动软件控制"提示条
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process', // 减少无头特有的进程模型差异
];

/**
 * 注入脚本：在页面任何脚本执行前补齐/抹平指纹。
 * 写成字符串常量（而不是函数）——addInitScript 会把它序列化到页面上下文里跑，
 * 不能引用模块作用域。
 */
const STEALTH_INIT = `
(() => {
  const patch = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); }
    catch (e) {}
  };

  // 1) 自动化标记
  patch(navigator, 'webdriver', undefined);

  // 2) 语言 / 地区：无头默认只有 en-US
  patch(navigator, 'languages', ['zh-CN', 'zh', 'en-US', 'en']);

  // 3) 插件：无头环境 plugins 为空数组，真实浏览器至少有 PDF Viewer
  patch(navigator, 'plugins', [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  ]);

  // 4) 硬件指纹：无头常见 1 核 / 无 deviceMemory
  patch(navigator, 'hardwareConcurrency', 8);
  patch(navigator, 'deviceMemory', 8);
  patch(navigator, 'maxTouchPoints', 0);
  patch(navigator, 'platform', 'Win32');

  // 5) window.chrome：真实 Chrome 必有，无头没有
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: function () {}, csi: function () {} };
  }

  // 6) Permissions 探测会被用来判断自动化
  const origQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (origQuery) {
    window.navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : origQuery(p);
  }

  // 7) WebGL：无头常暴露 SwiftShader / Google Inc.
  try {
    const gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return 'Intel Inc.';          // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return gp.call(this, param);
    };
  } catch (e) {}

  // 8) 清掉 Selenium/CDP 残留的全局变量
  ['cdc_adoQpoasnfa76pfcZLmcfl_Array', 'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
   '_selenium', 'callSelenium', '_Selenium_IDE_Recorder'].forEach((k) => {
    try { delete window[k]; } catch (e) {}
  });
})();
`;

/** 把 Chromium 版本号（如 129.0.6668.29）转成主版本号 */
function majorOf(version: string): string {
  const m = /^(\d+)/.exec(version);
  return m ? m[1] : '129';
}

/** 生成与当前内核匹配的真实 Chrome UA */
export function buildUserAgent(browser: Browser): string {
  return UA_TEMPLATE.replace('{V}', majorOf(browser.version()));
}

/** 统一的浏览器启动入口（带上 stealth 启动参数） */
export async function launchBrowser(
  opts: { headed?: boolean; slowMo?: number } = {},
): Promise<Browser> {
  return chromium.launch({
    headless: !opts.headed,
    args: STEALTH_LAUNCH_ARGS,
    ...(opts.slowMo ? { slowMo: opts.slowMo } : {}),
  });
}

/**
 * 创建带 stealth 的上下文 + 页面（CLI 场景：直接用 page）。
 * 返回 page，其 context 已注入指纹擦除脚本。
 */
export async function newStealthPage(
  browser: Browser,
  opts: StealthContextOptions = {},
): Promise<Page> {
  const context = await newStealthContext(browser, opts);
  return context.newPage();
}

export interface StealthContextOptions {
  /** 复用登录态（storageState）；Playbook 场景由上层传入 */
  storageState?: string;
  /** 有头模式（弹窗）下放宽一些伪装，避免干扰真人观看 */
  headed?: boolean;
}

/**
 * 创建带 stealth 的浏览器上下文。
 * 统一入口——三处 launch（server headless/headed、cli run、cli chat）都走这里，
 * 避免漏改导致行为不一致。
 */
export async function newStealthContext(
  browser: Browser,
  opts: StealthContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: buildUserAgent(browser),
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  });
  await context.addInitScript(STEALTH_INIT);
  return context;
}
