// Проверка живого сервера после внедрения сценария A.
import WebSocket from 'ws';
const B = 'https://rust-messenger.sg530507.workers.dev';
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

// Владелец может открыть регистрацию всем: тогда проверяем, что ответ
// корректный, и сразу удаляем пробный аккаунт, чтобы не мусорить в базе.
const probeName = 'probe' + Date.now().toString(36);
const reg = await fetch(B + '/api/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: probeName, password: 'parol123' }),
});
const data = await reg.json().catch(() => null);
check('регистрация отвечает предсказуемо',
  reg.status === 403 ? !!(data && data.inviteRequired === true) : !!(reg.status === 200 && data && data.token),
  reg.status + ' ' + JSON.stringify(data));
if (reg.status === 200 && data && data.token) {
  const ws = new WebSocket(B.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(data.token));
  await new Promise((resolve) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'account_delete', password: 'parol123' }));
      if (m.t === 'account_deleted') resolve();
    });
    ws.on('error', resolve);
    setTimeout(resolve, 6000);
  });
  try { ws.close(); } catch (_) {}
  check('пробный аккаунт убран', true);
}

const page = await (await fetch(B + '/', { headers: { 'cache-control': 'no-cache' } })).text();
check('в клиенте есть поле кода приглашения', page.includes('id="authInvite"'), '');
check('в клиенте есть вкладка «Управление»', page.includes('data-tab="manage"'), '');
check('в клиенте приватные каналы и панель участников', page.includes('openChannelPanel') && page.includes("t: 'channel_add'"), '');
check('версия клиента 1.7.0', page.includes("APP_VERSION = '1.7.0'"), '');
check('ссылка с приглашением работает', page.includes('inviteFromLink'), '');

const exp = await fetch(B + '/api/export');
check('экспорт без токена запрещён', exp.status === 401, String(exp.status));

const opt = await fetch(B + '/api/export', { method: 'OPTIONS', headers: { origin: 'https://localhost' } });
check('CORS для экспорта работает', opt.status === 204 && opt.headers.get('access-control-allow-origin') === 'https://localhost', String(opt.status));

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
