// Проверки бэкапов и сброса пароля.
const B = process.env.BASE || 'http://127.0.0.1:8811';
const WSURL = B.replace('http', 'ws');
import WebSocket from 'ws';
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

async function api(path, body) {
  const res = await fetch(B + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
function open(token) {
  const ws = new WebSocket(WSURL + '/ws?token=' + encodeURIComponent(token));
  const got = [];
  ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ ws, got })); ws.on('error', () => resolve({ ws, got }));
    setTimeout(() => resolve({ ws, got }), 5000);
  });
}
async function waitFor(client, pred, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const hit = client.got.find(pred); if (hit) return hit; await sleep(25); }
  return null;
}

// Владелец + участник.
const owner = await api('/api/register', { name: 'bko' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
await waitFor(ows, (m) => m.t === 'hello');
ows.ws.send(JSON.stringify({ t: 'invite_create', max: 5 }));
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const code = inv.invite.code;
const memberName = 'bkm' + stamp;
const member = await api('/api/register', { name: memberName, password: 'parol123', invite: code });
const mws = await open(member.data.token);
await waitFor(mws, (m) => m.t === 'hello');

// 1. Копия создаётся вручную.
ows.ws.send(JSON.stringify({ t: 'backup_now' }));
const made = await waitFor(ows, (m) => m.t === 'notice' && /Копия за/.test(m.text || ''));
check('копия создаётся по кнопке', !!made, JSON.stringify(ows.got.filter((m) => m.t === 'notice').map((m) => m.text)));
const state = await waitFor(ows, (m) => m.t === 'backup_state' && (m.items || []).length > 0);
check('список копий приходит', !!(state && state.items.length >= 1), JSON.stringify(state && state.items));
const date = state && state.items[0] ? state.items[0].date : '';
check('в снимке есть дата и размеры', !!(state && state.items[0] && state.items[0].bytes > 0), JSON.stringify(state && state.items[0]));

// 2. Участник не может ни смотреть, ни восстановить.
mws.ws.send(JSON.stringify({ t: 'backup_list' }));
const denyList = await waitFor(mws, (m) => m.t === 'error' && /владельцу/.test(m.text || ''));
check('участнику список копий закрыт', !!denyList, '');
mws.ws.send(JSON.stringify({ t: 'backup_restore', date }));
const denyRestore = await waitFor(mws, (m) => m.t === 'error' && /владельцу/.test(m.text || ''));
check('участнику восстановление закрыто', !!denyRestore, '');

// 3. Скачивание снимка.
const dl = await fetch(B + '/api/backup?date=' + encodeURIComponent(date), { headers: { 'x-token': owner.data.token } });
const text = await dl.text();
let parsed = null;
try { parsed = JSON.parse(text); } catch (_) {}
check('снимок скачивается', dl.status === 200 && !!parsed, String(dl.status));
check('в скачанном файле нет хэшей паролей', !!parsed && !text.includes('"pass"') && !text.includes('"salt"'), '');
check('в скачанном файле нет токенов', !text.includes('"tokens"'), '');
check('в снимке есть пользователи', !!(parsed && parsed.users && Object.keys(parsed.users).length >= 2), '');
const dlFull = await fetch(B + '/api/backup?date=' + encodeURIComponent(date) + '&full=1', { headers: { 'x-token': owner.data.token } });
const fullText = await dlFull.text();
check('полный снимок (?full=1) содержит хэши для восстановления', dlFull.status === 200 && fullText.includes('"pass"'), String(dlFull.status));
const dlGuest = await fetch(B + '/api/backup?date=' + date, { headers: { 'x-token': member.data.token } });
check('участнику скачивание закрыто', dlGuest.status === 403, String(dlGuest.status));
const dlAnon = await fetch(B + '/api/backup?date=' + date);
check('без токена скачивание закрыто', dlAnon.status === 401, String(dlAnon.status));

// 4. Восстановление: сначала ломаем состояние (создаём канал), потом откатываем.
ows.ws.send(JSON.stringify({ t: 'create', room: 'tmp' + stamp }));
await waitFor(ows, (m) => m.t === 'channel_created');
ows.ws.send(JSON.stringify({ t: 'backup_restore', date }));
const restored = await waitFor(ows, (m) => m.t === 'notice' && /восстановлено/.test(m.text || ''));
check('восстановление выполняется', !!restored, JSON.stringify(ows.got.filter((m) => m.t === 'notice').map((m) => m.text)));
const chans = await waitFor(ows, (m) => m.t === 'channels' && !(m.channels || []).some((c) => c.startsWith('tmp')));
check('канал, созданный после снимка, исчез', !!chans, JSON.stringify(chans && chans.channels));
const afterState = await waitFor(ows, (m) => m.t === 'backup_state' && (m.items || []).some((i) => i.date.startsWith('before-restore')));
check('перед восстановлением сохранена страховочная копия', !!afterState, JSON.stringify(afterState && (afterState.items || []).map((i) => i.date)));

// 5. Сброс пароля.
ows.ws.send(JSON.stringify({ t: 'password_reset', name: memberName }));
const reset = await waitFor(ows, (m) => m.t === 'password_reset_done');
check('владелец получает временный пароль', !!(reset && reset.password && reset.password.length >= 8), JSON.stringify(reset && { n: reset.name, len: reset.password && reset.password.length }));
const tempPassword = reset ? reset.password : '';
await sleep(400);
const oldLogin = await api('/api/login', { name: memberName, password: 'parol123' });
check('старый пароль больше не работает', oldLogin.status === 400, String(oldLogin.status));
const newLogin = await api('/api/login', { name: memberName, password: tempPassword });
check('временный пароль работает', newLogin.status === 200 && !!newLogin.data.token, String(newLogin.status));
mws.ws.send(JSON.stringify({ t: 'password_reset', name: memberName }));
const denyReset = await waitFor(mws, (m) => m.t === 'error' && /владельц/.test(m.text || ''));
check('участник не может сбрасывать пароли', !!denyReset, '');

// Уборка.
for (const token of [owner.data.token, newLogin.data.token]) {
  const c = await open(token);
  c.ws.send(JSON.stringify({ t: 'account_delete', password: token === owner.data.token ? 'parol123' : tempPassword }));
  await sleep(600);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); mws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
