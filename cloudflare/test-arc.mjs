// Проверка переименования в Arc (1.4.2).
const B = process.env.BASE || 'http://127.0.0.1:8794';
const WebSocket = (await import('file:///C:/Users/setfators/Desktop/rust-messenger/cloudflare/node_modules/ws/index.js')).default;
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name); return true; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name + (extra ? ': ' + extra : ''));
  return false;
}

// Страница и заголовки
const page = await fetch(B + '/');
const html = await page.text();
check('заголовок страницы Arc', html.includes('<title>Arc</title>'), (html.match(/<title>[^<]*<\/title>/) || [''])[0]);
check('версия 1.4.2 в клиенте', html.includes("APP_VERSION = '1.4.2'"), '');
check('на экране входа «Arc»', html.includes('<h1>Arc</h1>'), '');
check('заголовок вкладки обновляется на Arc', html.includes("+ 'Arc'"), '');
check('старое имя как бренд не осталось в шапке', !/<title>Мессенджер/.test(html), '');

// Манифест
const man = await (await fetch(B + '/manifest.webmanifest')).json();
check('manifest name = Arc', man.name === 'Arc', man.name);
check('manifest short_name = Arc', man.short_name === 'Arc', man.short_name);
check('manifest описание обновлено', man.description.includes('Arc'), man.description);
check('иконки в манифесте на месте', man.icons.length === 3, String(man.icons.length));

// Service worker
const sw = await (await fetch(B + '/sw.js')).text();
check('sw кэш arc-shell-v4', sw.includes('arc-shell-v4'), (sw.match(/const CACHE = '[^']*'/) || [''])[0]);
check('уведомление подписано Arc', sw.includes("showNotification('Arc'"), '');

// Версия сервера
const stamp = Date.now().toString(36);
const reg = await fetch(B + '/api/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'arc' + stamp, password: 'parol123' }),
}).then((r) => r.json());
const ws = new WebSocket(B.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(reg.token));
const got = [];
ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
await new Promise((r) => { ws.on('open', r); ws.on('error', r); setTimeout(r, 4000); });
await sleep(600);
const hello = got.find((m) => m.t === 'hello');
check('hello отдаёт версию 1.4.2', hello && hello.version === '1.4.2', hello && hello.version);
ws.send(JSON.stringify({ t: 'account_delete', password: 'parol123' }));
await sleep(800);
try { ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) { for (const p of problems) console.log(' - ' + p); process.exitCode = 1; }
