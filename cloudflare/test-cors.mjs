// Проверяем, что мобильное приложение сможет ходить в API: CORS и preflight.
const B = 'https://rust-messenger.sg530507.workers.dev';
const ORIGIN = 'https://localhost';
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

// 1. Предварительный запрос браузера.
const pre = await fetch(B + '/api/login', {
  method: 'OPTIONS',
  headers: {
    origin: ORIGIN,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
  },
});
check('OPTIONS /api/login отвечает 204', pre.status === 204, String(pre.status));
check('  разрешает origin приложения', pre.headers.get('access-control-allow-origin') === ORIGIN, pre.headers.get('access-control-allow-origin'));
check('  разрешает POST', (pre.headers.get('access-control-allow-methods') || '').includes('POST'), pre.headers.get('access-control-allow-methods'));
check('  разрешает content-type', (pre.headers.get('access-control-allow-headers') || '').includes('content-type'), pre.headers.get('access-control-allow-headers'));

// 2. Реальный POST с origin приложения.
const reg = await fetch(B + '/api/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ name: 'cors' + Date.now().toString(36), password: 'parol123' }),
});
check('POST /api/register принимается', reg.status === 200, String(reg.status));
check('  ответ содержит allow-origin', reg.headers.get('access-control-allow-origin') === ORIGIN, reg.headers.get('access-control-allow-origin'));

// 3. Загрузка картинки из приложения.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
const regData = await reg.json();
const media = await fetch(B + '/api/media', {
  method: 'POST',
  headers: { 'content-type': 'image/png', 'x-token': regData.token, origin: ORIGIN },
  body: png,
});
check('POST /api/media принимается', media.status === 200, String(media.status));
check('  ответ содержит allow-origin', media.headers.get('access-control-allow-origin') === ORIGIN, media.headers.get('access-control-allow-origin'));

// 4. Чужой origin не должен получать разрешение.
const enemy = await fetch(B + '/api/login', {
  method: 'OPTIONS',
  headers: { origin: 'https://evil.example' },
});
check('чужой origin не получает доступ', !enemy.headers.get('access-control-allow-origin'), enemy.headers.get('access-control-allow-origin'));

// 5. Картинки и аватары доступны приложению (для <img> CORS не нужен, но проверим тип).
const icon = await fetch(B + '/icon-192.png', { headers: { origin: ORIGIN } });
check('иконки отдаются', icon.status === 200, String(icon.status));

// Убираем тестовый аккаунт.
const WebSocket = (await import('file:///C:/Users/setfators/Desktop/rust-messenger/cloudflare/node_modules/ws/index.js')).default;
const ws = new WebSocket(B.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(regData.token));
await new Promise((resolve) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'hello') ws.send(JSON.stringify({ t: 'account_delete', password: 'parol123' }));
    if (m.t === 'account_deleted') resolve();
  });
  ws.on('error', resolve);
  setTimeout(resolve, 4000);
});
try { ws.close(); } catch (_) {}
console.log('тестовый аккаунт удалён');

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
