// Проверка 1.4.1: иконки, favicon, фид обновлений, версия в hello.
const B = process.env.BASE || 'http://127.0.0.1:8793';
const WebSocket = (await import('file:///C:/Users/setfators/Desktop/rust-messenger/cloudflare/node_modules/ws/index.js')).default;
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name); return true; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name + (extra ? ': ' + extra : ''));
  return false;
}

// Иконки
const icons = [
  ['/icon-192.png', 'image/png'],
  ['/icon-512.png', 'image/png'],
  ['/icon-180.png', 'image/png'],
  ['/icon-512-maskable.png', 'image/png'],
  ['/apple-touch-icon.png', 'image/png'],
  ['/favicon.ico', 'image/x-icon'],
];
for (const [path, type] of icons) {
  const res = await fetch(B + path);
  const buf = await res.arrayBuffer();
  const ct = res.headers.get('content-type') || '';
  check(`иконка ${path} отдаётся`, res.status === 200 && buf.byteLength > 1000, res.status + ' ' + buf.byteLength + 'б');
  check(`  тип ${path}`, ct.includes(type.split('/')[1]) || ct.includes('icon'), ct);
}

// Страница ссылается на новые иконки
const page = await fetch(B + '/');
const html = await page.text();
check('страница ссылается на favicon.ico', html.includes('/favicon.ico'), '');
check('страница ссылается на apple-touch-icon.png', html.includes('/apple-touch-icon.png'), '');
check('страница знает версию 1.4.1', html.includes("APP_VERSION = '1.4.1'"), html.includes('1.4.1'));
const head = await fetch(B + '/', { method: 'HEAD' });
check('заголовки безопасности на месте', head.headers.get('x-frame-options') === 'DENY', head.headers.get('x-frame-options'));

// Service worker
const sw = await fetch(B + '/sw.js');
const swText = await sw.text();
check('sw кэш v3', swText.includes("messenger-shell-v3"), swText.slice(0, 60));
check('sw кэширует favicon', swText.includes("'/favicon.ico'"), '');
check('sw кэширует apple-touch-icon', swText.includes("'/apple-touch-icon.png'"), '');

// Фид обновлений
const yml = await (await fetch(B + '/updates/latest.yml')).text();
check('latest.yml = 1.4.1', yml.includes('version: 1.4.1'), yml.split('\n')[0]);
check('latest.yml указывает на 1.4.1.exe', yml.includes('Messenger-Setup-1.4.1.exe'), '');
const man = await (await fetch(B + '/updates/parts/manifest.json')).json();
check('manifest = 1.4.1', man.file === 'Messenger-Setup-1.4.1.exe', man.file);
const sum = man.parts.reduce((a, p) => a + Number(p.len || 0), 0);
check('сумма частей = размер', sum === man.size, sum + ' vs ' + man.size);
const exeHead = await fetch(B + '/updates/Messenger-Setup-1.4.1.exe', { method: 'HEAD' });
check('HEAD установщика', exeHead.status === 200 && Number(exeHead.headers.get('content-length')) === man.size,
  exeHead.status + ' ' + exeHead.headers.get('content-length'));
const tail = await fetch(B + '/updates/Messenger-Setup-1.4.1.exe', { headers: { range: `bytes=${man.size - 100}-` } });
check('хвост установщика склеивается', tail.status === 206 && (await tail.arrayBuffer()).byteLength === 100,
  tail.status + ' ' + tail.headers.get('content-range'));
const oldExe = await fetch(B + '/updates/Messenger-Setup-1.4.0.exe', { method: 'HEAD' });
check('старый установщик 1.4.0 больше не отдаётся', oldExe.status === 404, String(oldExe.status));

// Версия в hello
const stamp = Date.now().toString(36);
const reg = await fetch(B + '/api/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'v141' + stamp, password: 'parol123' }),
}).then((r) => r.json());
const ws = new WebSocket(B.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(reg.token));
const got = [];
ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
await new Promise((r) => { ws.on('open', r); ws.on('error', r); setTimeout(r, 4000); });
await sleep(600);
const hello = got.find((m) => m.t === 'hello');
check('hello сообщает версию 1.4.1', !!(hello && hello.version === '1.4.1'), hello && hello.version);
ws.send(JSON.stringify({ t: 'account_delete', password: 'parol123' }));
await sleep(800);
try { ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) {
  for (const p of problems) console.log(' - ' + p);
  process.exitCode = 1;
}
