import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3456;

app.use(express.urlencoded({ extended: true }));

/** 简单 session：登录成功后 set-cookie */
const sessions = new Map<string, { user: string; at: number }>();
const newSession = (user: string): string => {
  const token = `tok_${Math.random().toString(36).slice(2)}`;
  sessions.set(token, { user, at: Date.now() });
  return token;
};

/** 登录校验中间件：未登录访问受保护页 → 302 到 /login（E2 检测测试点） */
const requireAuth: express.RequestHandler = (req, res, next) => {
  const cookie = req.headers.cookie ?? '';
  const token = /session=([^;]+)/.exec(cookie)?.[1];
  if (!token || !sessions.has(token)) {
    res.redirect(302, '/login');
    return;
  }
  next();
};

const page = (title: string, body: string): string => `
<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#222}
input,select,button{font-size:14px;padding:6px 12px;margin:4px 0}
label{display:block;margin-top:12px}
.btn-primary{background:#185FA5;color:#fff;border:none;border-radius:4px;cursor:pointer}
.toast{position:fixed;top:16px;right:16px;background:#27500A;color:#fff;padding:8px 16px;border-radius:4px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;text-align:left}
nav a{margin-right:16px}
</style></head><body>${body}</body></html>`;

app.get('/', (_req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
  const failed = req.query.failed === '1';
  res.send(page('登录', `
    <h1>演示后台登录</h1>
    ${failed ? '<p style="color:#A32D2D">用户名或密码错误</p>' : ''}
    <form method="post" action="/login">
      <label>用户名 <input id="username" name="username"></label>
      <label>密码 <input id="password" name="password" type="password"></label>
      <button class="btn-primary" type="submit">登录</button>
    </form>`));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  // 演示凭证：demo / demo123
  if (username === 'demo' && password === 'demo123') {
    res.setHeader('set-cookie', `session=${newSession(username)}; Path=/`);
    res.redirect(302, '/dashboard');
  } else {
    res.redirect(302, '/login?failed=1');
  }
});

app.get('/dashboard', requireAuth, (_req, res) => {
  res.send(page('工作台', `
    <h1>工作台</h1>
    <nav><a href="/sku/list">SKU 列表</a><a href="/report">报表导出</a></nav>
    <p id="welcome">欢迎回来，demo</p>`));
});

/** 50 个 SKU：压测用（S001-S050），前 3 个带友好名称 */
const SKUS = Array.from({ length: 50 }, (_, i) => ({
  id: `S${String(i + 1).padStart(3, '0')}`,
  name: i < 3 ? ['机械键盘 87 键', '无线鼠标', 'USB-C 扩展坞'][i] : `压测商品 ${i + 1}`,
  price: 100 + i,
}));

/**
 * SKU 编辑页 —— 改版模拟核心：
 * variant=b 时：保存按钮改文本 + 类名重命名 + 弹确认对话框（E1/E2 测试点）
 */
app.get('/sku/:id/edit', requireAuth, (req, res) => {
  const sku = SKUS.find((s) => s.id === req.params.id);
  if (!sku) { res.status(404).send(page('404', '<h1>404 SKU 不存在</h1>')); return; }
  const variant = req.query.variant === 'b';
  const saveBtn = variant
    ? `<button class="btn-save-v2" type="button" onclick="confirmSave()">确认下单</button>
       <script>
       function confirmSave(){
         if(confirm('确认修改该 SKU 的价格？')){
           document.getElementById('priceForm').submit();
         }
       }
       </script>`
    : `<button class="btn-primary" type="submit">保存</button>`;
  const saveApi = variant ? '/api/sku/save?variant=b' : '/api/sku/save';
  res.send(page(`编辑 ${sku.id}`, `
    <h1>编辑 SKU：${sku.name}</h1>
    <form id="priceForm" method="post" action="${saveApi}">
      <input type="hidden" name="id" value="${sku.id}">
      <label>价格 <input id="price" name="price" value="${sku.price}"></label>
      ${saveBtn}
    </form>
    <p id="save-result" data-saved="no"></p>`));
});

app.post('/api/sku/save', requireAuth, (req, res) => {
  const { id, price } = req.body;
  const sku = SKUS.find((s) => s.id === id);
  if (!sku || Number.isNaN(Number(price))) {
    res.status(400).send(page('错误', '<h1>参数错误</h1>'));
    return;
  }
  sku.price = Number(price);
  const base = req.query.variant === 'b' ? '/sku/list?variant=b' : '/sku/list';
  const sep = base.includes('?') ? '&' : '?';
  res.redirect(302, `${base}${sep}saved=${id}`);
});

app.get('/sku/list', requireAuth, (req, res) => {
  const saved = req.query.saved ? `<div class="toast">保存成功：${req.query.saved}</div>` : '';
  const rows = SKUS.map((s) => `
    <tr><td>${s.id}</td><td>${s.name}</td><td>${s.price}</td>
    <td><a href="/sku/${s.id}/edit">编辑</a></td></tr>`).join('');
  res.send(page('SKU 列表', `
    ${saved}
    <h1>SKU 列表</h1>
    <table><tr><th>ID</th><th>名称</th><th>价格</th><th>操作</th></tr>${rows}</table>
    <p class="result-count">共 ${SKUS.length} 个 SKU</p>`));
});

/** 报表导出：E3 超时测试点（?delay=ms） */
app.get('/report', requireAuth, (_req, res) => {
  res.send(page('报表', `
    <h1>库存报表</h1>
    <a id="export-link" href="/report/export">导出 Excel</a>`));
});

app.get('/report/export', requireAuth, (req, res) => {
  const delay = Number(req.query.delay ?? 0);
  setTimeout(() => {
    res.setHeader('content-type', 'application/vnd.ms-excel');
    res.setHeader('content-disposition', 'attachment; filename=inventory.csv');
    res.send('id,name,price\n' + SKUS.map((s) => `${s.id},${s.name},${s.price}`).join('\n'));
  }, delay);
});

/** 踢下线接口：模拟服务端 session 失效（自动重登测试点） */
app.post('/api/kick', (req, res) => {
  const token = /session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const kicked = token ? sessions.delete(token) : false;
  res.send(page('下线', `<h1>已强制下线（token ${kicked ? '已清除' : '不存在'}）</h1>`));
});

/** 404 兜底（E2 测试点：跳转异常页面） */
app.use((_req, res) => {
  res.status(404).send(page('404', '<h1>404 页面不存在</h1>'));
});

app.listen(PORT, () => {
  console.log(`test-site running at http://localhost:${PORT}`);
});
