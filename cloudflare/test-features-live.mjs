// Проверка новых возможностей на живом сервере (без изменения данных).
const B = 'https://rust-messenger.sg530507.workers.dev';
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

const page = await (await fetch(B + '/', { headers: { 'cache-control': 'no-cache' } })).text();
check('в клиенте есть раздел «Резервные копии»', page.includes('Резервные копии'), '');
check('в клиенте есть «Сброс пароля»', page.includes('Сброс пароля'), '');
check('клиент знает backup_state', page.includes("case 'backup_state'"), '');
check('клиент знает password_reset_done', page.includes("case 'password_reset_done'"), '');

// Маршруты защиты: без токена и с чужим токеном.
const anon = await fetch(B + '/api/backup?date=2026-01-01');
check('скачивание снимка без токена → 401', anon.status === 401, String(anon.status));

const opt = await fetch(B + '/api/backup', { method: 'OPTIONS', headers: { origin: 'https://localhost' } });
check('CORS для снимков работает', opt.status === 204 && opt.headers.get('access-control-allow-origin') === 'https://localhost', String(opt.status));

const post = await fetch(B + '/api/backup?date=x', { method: 'POST' });
check('POST на снимки → 405', post.status === 405, String(post.status));

// Приложение живо.
const health = await fetch(B + '/health');
check('health отвечает', health.status === 200, String(health.status));
const apk = await fetch(B + '/download/Arc.apk', { method: 'GET' });
const apkBuf = await apk.arrayBuffer();
check('APK отдаётся', apk.status === 200 && apkBuf.byteLength > 3_000_000, apk.status + ' ' + (apkBuf.byteLength / 1048576).toFixed(2) + ' МБ');

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
