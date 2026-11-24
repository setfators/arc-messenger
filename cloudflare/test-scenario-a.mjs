// Проверки сценария A: приглашения, права владельца, антифлуд, экспорт.
const B = process.env.BASE || 'http://127.0.0.1:8798';
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

async function api(path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-token'] = token;
  const res = await fetch(B + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function open(token) {
  const ws = new WebSocket(WSURL + '/ws?token=' + encodeURIComponent(token));
  const got = [];
  ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ ws, got }));
    ws.on('error', () => resolve({ ws, got }));
    setTimeout(() => resolve({ ws, got }), 5000);
  });
}
async function waitFor(client, pred, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = client.got.find(pred);
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}

// 1. Владелец и приглашения.
const ownerName = 'own' + stamp;
const owner = await api('/api/register', { name: ownerName, password: 'parol123' });
check('первый аккаунт — владелец', owner.status === 200 && owner.data.isOwner === true, JSON.stringify(owner.data));
if (!owner.data || !owner.data.token) {
  console.log('\nБаза не пустая: набор проверяет первого владельца, нужен свежий --persist-to.');
  process.exit(2);
}

const closed = await api('/api/register', { name: 'guest' + stamp, password: 'parol123' });
check('закрытая регистрация не пускает без кода', closed.status === 403 && closed.data.inviteRequired === true, JSON.stringify(closed.data));

const ows = await open(owner.data.token);
const hello = await waitFor(ows, (m) => m.t === 'hello');
check('hello сообщает права владельца', !!(hello && hello.isOwner === true), JSON.stringify(hello && hello.isOwner));
check('hello сообщает режим приглашений', !!(hello && hello.inviteOnly === true), JSON.stringify(hello && hello.inviteOnly));

ows.ws.send(JSON.stringify({ t: 'invite_create', max: 2 }));
const created = await waitFor(ows, (m) => m.t === 'invite_created');
const code = created && created.invite ? created.invite.code : '';
check('код приглашения создан', /^[A-Z0-9]{8}$/.test(code), String(code));

ows.ws.send(JSON.stringify({ t: 'invite_list' }));
const list = await waitFor(ows, (m) => m.t === 'invite_list');
check('список кодов приходит', !!(list && Array.isArray(list.invites) && list.invites.length >= 1), JSON.stringify(list && list.invites));

// 2. Второй участник по коду.
const guestName = 'guest' + stamp;
const guest = await api('/api/register', { name: guestName, password: 'parol123', invite: code });
check('участник заходит по коду', guest.status === 200 && !!guest.data.token, JSON.stringify(guest.data));
check('участник не владелец', guest.data.isOwner === false, JSON.stringify(guest.data.isOwner));
const gws = await open(guest.data.token);
await waitFor(gws, (m) => m.t === 'hello');

// 3. Модерация: каналы.
gws.ws.send(JSON.stringify({ t: 'create', room: 'room' + stamp }));
const createdRoom = await waitFor(gws, (m) => m.t === 'channel_created');
const roomName = createdRoom && createdRoom.room ? createdRoom.room : 'room' + stamp;
check('участник может создать канал', !!createdRoom, JSON.stringify(createdRoom));
gws.ws.send(JSON.stringify({ t: 'channel_delete', room: roomName }));
const denyDelete = await waitFor(gws, (m) => m.t === 'error' && /владелец/.test(m.text || ''));
check('участник не может удалить канал', !!denyDelete, JSON.stringify(gws.got.filter((m) => m.t === 'error').map((m) => m.text)));

// 4. Модерация: чужие сообщения.
gws.ws.send(JSON.stringify({ t: 'msg', room: 'obshiy', text: 'сообщение участника ' + stamp }));
const guestMsg = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'сообщение участника ' + stamp);
check('сообщение участника дошло до владельца', !!guestMsg, '');
if (guestMsg) {
  ows.ws.send(JSON.stringify({ t: 'msg_delete', room: 'obshiy', id: guestMsg.id }));
  const removed = await waitFor(gws, (m) => m.t === 'msg_delete' && m.id === guestMsg.id);
  check('владелец удаляет чужое сообщение', !!removed, JSON.stringify(gws.got.filter((m) => m.t === 'msg_delete')));
  await sleep(200);
  const told = gws.got.some((m) => m.t === 'notice' && /владелец удалил/i.test(m.text || ''));
  check('автору сообщают об удалении', told, JSON.stringify(gws.got.filter((m) => m.t === 'notice').map((m) => m.text)));
}

// 5. Антифлуд: 15 сообщений за 10 секунд — дальше отказ.
const before = gws.got.length;
for (let i = 0; i < 22; i += 1) {
  gws.ws.send(JSON.stringify({ t: 'msg', room: 'obshiy', text: 'флуд ' + i + ' ' + stamp }));
}
await sleep(1500);
const floodErrors = gws.got.slice(before).filter((m) => m.t === 'error' && /Слишком часто/.test(m.text || ''));
check('антифлуд срабатывает', floodErrors.length > 0, 'ошибок: ' + floodErrors.length);

// 6. Экспорт базы.
const expOwner = await fetch(B + '/api/export', { headers: { 'x-token': owner.data.token } });
const exportData = await expOwner.json().catch(() => null);
check('владелец получает экспорт', expOwner.status === 200 && !!exportData && Array.isArray(exportData.channels), String(expOwner.status));
check('в экспорте нет паролей и токенов', !!exportData && !JSON.stringify(exportData).includes('"pass"') && !JSON.stringify(exportData).includes('"salt"'), '');
const expGuest = await fetch(B + '/api/export', { headers: { 'x-token': guest.data.token } });
check('участнику экспорт запрещён', expGuest.status === 403, String(expGuest.status));
const expAnon = await fetch(B + '/api/export');
check('без токена экспорт запрещён', expAnon.status === 401, String(expAnon.status));

// 7. Отзыв кода.
ows.ws.send(JSON.stringify({ t: 'invite_revoke', code }));
const revoked = await waitFor(ows, (m) => m.t === 'invite_list' && !(m.invites || []).some((i) => i.code === code));
check('код можно отозвать', !!revoked, '');
const afterRevoke = await api('/api/register', { name: 'late' + stamp, password: 'parol123', invite: code });
check('отозванный код не работает', afterRevoke.status === 403, String(afterRevoke.status));

// Уборка: удаляем тестовых пользователей.
for (const [token, pass] of [[owner.data.token, 'parol123'], [guest.data.token, 'parol123']]) {
  const c = await open(token);
  c.ws.send(JSON.stringify({ t: 'account_delete', password: pass }));
  await sleep(700);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); gws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;

// Открытые WebSocket-соединения держат event loop — завершаемся принудительно.
setTimeout(() => process.exit(process.exitCode || 0), 300);