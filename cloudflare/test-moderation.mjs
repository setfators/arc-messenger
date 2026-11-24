// Проверки ролей и модерации: сотрудники, мьют, бан.
const B = process.env.BASE || 'http://127.0.0.1:8791';
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
async function waitFor(client, pred, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const hit = client.got.find(pred); if (hit) return hit; await sleep(25); }
  return null;
}

// 1. Владелец + два участника по коду.
const owner = await api('/api/register', { name: 'own' + stamp, password: 'parol123' });
check('владелец создан', owner.status === 200 && owner.data.isOwner === true, JSON.stringify(owner.data));

const ows = await open(owner.data.token);
const hello = await waitFor(ows, (m) => m.t === 'hello');
check('hello даёт роль owner', hello && hello.role === 'owner' && hello.isStaff === true, JSON.stringify(hello && { r: hello.role, s: hello.isStaff }));

ows.ws.send(JSON.stringify({ t: 'invite_create', max: 5 }));
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const code = inv.invite.code;

const staffUser = 'stf' + stamp;
const memberUser = 'mbr' + stamp;
const staff = await api('/api/register', { name: staffUser, password: 'parol123', invite: code });
const member = await api('/api/register', { name: memberUser, password: 'parol123', invite: code });
check('сотрудник и участник зарегистрированы', !!staff.data.token && !!member.data.token);

const sws = await open(staff.data.token);
const mws = await open(member.data.token);
await waitFor(sws, (m) => m.t === 'hello');
await waitFor(mws, (m) => m.t === 'hello');

// Приватный канал для проверок: создаёт владелец, зовёт сотрудника и участника.
ows.ws.send(JSON.stringify({ t: 'create', room: 'модерация ' + stamp, title: 'модерация ' + stamp }));
const chCreated = await waitFor(ows, (m) => m.t === 'channel_created');
const room = chCreated && chCreated.room;
check('канал для модерации создан', !!room, JSON.stringify(chCreated));
ows.ws.send(JSON.stringify({ t: 'channel_add', room, name: staffUser }));
ows.ws.send(JSON.stringify({ t: 'channel_add', room, name: memberUser }));
await waitFor(sws, (m) => m.t === 'channels' && (m.channels || []).includes(room));
await waitFor(mws, (m) => m.t === 'channels' && (m.channels || []).includes(room));

// 2. Назначение сотрудником.
ows.ws.send(JSON.stringify({ t: 'staff_add', name: staffUser }));
const roleChanged = await waitFor(sws, (m) => m.t === 'role_changed');
check('назначение сотрудником доходит', !!(roleChanged && roleChanged.role === 'staff'), JSON.stringify(roleChanged));
check('сотрудник получает isStaff', !!(roleChanged && roleChanged.isStaff === true), '');

ows.ws.send(JSON.stringify({ t: 'staff_list' }));
const list = await waitFor(ows, (m) => m.t === 'staff_list' && (m.staff || []).length > 0);
check('список команды содержит сотрудника', !!(list && list.staff.some((p) => p.name === staffUser)), JSON.stringify(list && list.staff.map((p) => p.name)));
check('в списке есть владелец', !!(list && list.owner), '');

// 3. Сотрудник удаляет чужое сообщение.
mws.ws.send(JSON.stringify({ t: 'msg', room, text: 'сообщение участника ' + stamp }));
const memberMsg = await waitFor(sws, (m) => m.t === 'msg' && m.text === 'сообщение участника ' + stamp);
check('сообщение участника видно', !!memberMsg, '');
if (memberMsg) {
  sws.ws.send(JSON.stringify({ t: 'msg_delete', room, id: memberMsg.id }));
  const removed = await waitFor(mws, (m) => m.t === 'msg_delete' && m.id === memberMsg.id);
  check('сотрудник удаляет чужое сообщение', !!removed, '');
}

// 4. Мьют.
sws.ws.send(JSON.stringify({ t: 'user_mute', name: memberUser, minutes: 10 }));
const muted = await waitFor(mws, (m) => m.t === 'notice' && /запрещено писать/.test(m.text || ''));
check('мьют доходит до участника', !!muted, JSON.stringify(mws.got.filter((m) => m.t === 'notice').map((m) => m.text)));

mws.ws.send(JSON.stringify({ t: 'msg', room, text: 'после мьюта ' + stamp }));
const blocked = await waitFor(mws, (m) => m.t === 'error' && /запрещено писать/.test(m.text || ''));
check('замьюченный не может писать', !!blocked, JSON.stringify(mws.got.filter((m) => m.t === 'error').map((m) => m.text)));

sws.ws.send(JSON.stringify({ t: 'user_unmute', name: memberUser }));
await sleep(400);
mws.ws.send(JSON.stringify({ t: 'msg', room, text: 'после снятия ' + stamp }));
const afterUnmute = await waitFor(sws, (m) => m.t === 'msg' && m.text === 'после снятия ' + stamp);
check('после снятия мьюта можно писать', !!afterUnmute, '');

// 5. Сотрудник не может банить и назначать сотрудников.
sws.ws.send(JSON.stringify({ t: 'user_ban', name: memberUser }));
const staffBan = await waitFor(sws, (m) => m.t === 'error' && /только владелец/.test(m.text || ''));
check('сотрудник не может банить', !!staffBan, '');

sws.ws.send(JSON.stringify({ t: 'staff_add', name: memberUser }));
const staffAdd = await waitFor(sws, (m) => m.t === 'error' && /владелец/.test(m.text || ''));
check('сотрудник не может назначать сотрудников', !!staffAdd, '');

// 6. Бан владельцем.
ows.ws.send(JSON.stringify({ t: 'user_ban', name: memberUser }));
await sleep(800);
const relogin = await api('/api/login', { name: memberUser, password: 'parol123' });
check('забаненный не может войти', relogin.status === 403, String(relogin.status));
const wsTry = await new Promise((resolve) => {
  const ws = new WebSocket(WSURL + '/ws?token=' + encodeURIComponent(member.data.token));
  ws.on('open', () => { resolve('open'); ws.close(); });
  ws.on('unexpected-response', (_q, res) => resolve(String(res.statusCode)));
  ws.on('error', () => resolve('error'));
  setTimeout(() => resolve('timeout'), 3000);
});
// При бане все токены гасятся, поэтому старый токен получает 401 (либо 403,
// если успел обновиться) — в любом случае подключиться нельзя.
check('сокет забаненного не пускают', wsTry === '401' || wsTry === '403', wsTry);

// 7. Разбан.
ows.ws.send(JSON.stringify({ t: 'user_unban', name: memberUser }));
await sleep(600);
const back = await api('/api/login', { name: memberUser, password: 'parol123' });
check('после разбана вход работает', back.status === 200, String(back.status));

// 8. Снятие сотрудника.
ows.ws.send(JSON.stringify({ t: 'staff_remove', name: staffUser }));
const demoted = await waitFor(sws, (m) => m.t === 'role_changed' && m.role === 'member');
check('сотрудника можно снять', !!demoted, JSON.stringify(demoted));

// Уборка.
for (const token of [owner.data.token, staff.data.token]) {
  const c = await open(token);
  c.ws.send(JSON.stringify({ t: 'account_delete', password: 'parol123' }));
  await sleep(600);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); sws.ws.close(); mws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;

// Открытые WebSocket-соединения держат event loop — завершаемся принудительно,
// иначе тест «висит» после последней строки.
setTimeout(() => process.exit(process.exitCode || 0), 300);
