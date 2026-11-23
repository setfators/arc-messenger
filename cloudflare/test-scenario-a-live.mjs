// Проверка живого сервера после внедрения сценария A.
const B = 'https://rust-messenger.sg530507.workers.dev';
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

const reg = await fetch(B + '/api/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'probe' + Date.now().toString(36), password: 'parol123' }),
});
const data = await reg.json().catch(() => null);
check('регистрация без кода закрыта', reg.status === 403 && data.inviteRequired === true, reg.status + ' ' + JSON.stringify(data));

const page = await (await fetch(B + '/', { headers: { 'cache-control': 'no-cache' } })).text();
check('в клиенте есть поле кода приглашения', page.includes('id="authInvite"'), '');
check('в клиенте есть вкладка «Управление»', page.includes('data-tab="manage"'), '');
check('в клиенте удаление канала только владельцу', page.includes("channel !== 'obshiy' && store.isOwner"), '');
check('версия клиента 1.4.2', page.includes("APP_VERSION = '1.4.2'"), '');
check('ссылка с приглашением работает', page.includes('inviteFromLink'), '');

const exp = await fetch(B + '/api/export');
check('экспорт без токена запрещён', exp.status === 401, String(exp.status));

const opt = await fetch(B + '/api/export', { method: 'OPTIONS', headers: { origin: 'https://localhost' } });
check('CORS для экспорта работает', opt.status === 204 && opt.headers.get('access-control-allow-origin') === 'https://localhost', String(opt.status));

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
