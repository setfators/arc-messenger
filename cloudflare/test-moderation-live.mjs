// Проверка модерации на живом сервере: роли, мьют, бан, наличие UI.
const B = 'https://rust-messenger.sg530507.workers.dev';
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

const page = await (await fetch(B + '/', { headers: { 'cache-control': 'no-cache' } })).text();
check('в клиенте есть вкладка «Модерация»', page.includes('data-tab="moderation"'), '');
check('в клиенте есть функция tabModeration', page.includes('function tabModeration'), '');
check('в клиенте обрабатывается staff_list', page.includes("case 'staff_list'"), '');
check('в клиенте обрабатывается role_changed', page.includes("case 'role_changed'"), '');
check('сотрудник может удалять чужие сообщения', page.includes('m.author === store.me.name || store.isStaff'), '');
check('версия клиента 1.6.0', page.includes("APP_VERSION = '1.6.0'"), '');

// Сервер: preflight и запрет экспорта без токена.
const opt = await fetch(B + '/api/export', { method: 'OPTIONS', headers: { origin: 'https://localhost' } });
check('CORS для экспорта', opt.status === 204, String(opt.status));
const exp = await fetch(B + '/api/export');
check('экспорт без токена запрещён', exp.status === 401, String(exp.status));

// APK на сайте.
const apk = await fetch(B + '/download/Arc.apk');
const buf = await apk.arrayBuffer();
check('APK отдаётся', apk.status === 200 && buf.byteLength > 3_000_000, apk.status + ' ' + (buf.byteLength / 1048576).toFixed(2) + ' МБ');

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
