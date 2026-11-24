// Счётчики в «Управлении» (1.6.0): владелец получает статистику,
// остальные — нет; цифры сходятся с тем, что реально произошло.
const B = process.env.BASE || 'http://127.0.0.1:8815';
import WebSocket from 'ws';
const WSURL = B.replace('http', 'ws');
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

async function api(path, body) {
  const res = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
function send(c, obj) { c.ws.send(JSON.stringify(obj)); }

const owner = await api('/api/register', { name: 'stt' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
await waitFor(ows, (m) => m.t === 'hello');
send(ows, { t: 'invite_create', max: 5 });
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const member = await api('/api/register', { name: 'stm' + stamp, password: 'parol123', invite: inv.invite.code });
const mws = await open(member.data.token);
await waitFor(mws, (m) => m.t === 'hello');

// 1. Обычный участник статистики не видит.
send(mws, { t: 'stats_get' });
const denied = await waitFor(mws, (m) => m.t === 'error' && /владельцу/.test(m.text || ''));
check('участнику статистика закрыта', !!denied, JSON.stringify(mws.got.filter((m) => m.t === 'error').map((m) => m.text)));

// 2. Владелец получает цифры.
send(ows, { t: 'stats_get' });
const reply = await waitFor(ows, (m) => m.t === 'stats');
check('владелец получает статистику', !!reply, '');
const s = (reply && reply.stats) || {};
check('версия и время в статистике', !!(s.version && s.generatedAt > 0), JSON.stringify({ v: s.version }));
check('пользователей посчитано', !!(s.users && s.users.total >= 2 && s.users.online >= 2),
  JSON.stringify(s.users));
check('сообщения посчитаны (демо-каналы)', !!(s.messages && s.messages.total > 0), JSON.stringify(s.messages));
check('каналы и участия посчитаны', !!(s.channels && s.channels.total >= 2 && s.channels.demo >= 2),
  JSON.stringify(s.channels));
check('личных чатов пока нет', !!(s.dms && s.dms.rooms === 0), JSON.stringify(s.dms));
check('коды приглашений посчитаны', !!(s.invites && s.invites.codes >= 1 && s.invites.uses >= 1), JSON.stringify(s.invites));
check('новые за неделю посчитаны', !!(s.users.newWeek >= 2 && s.users.newToday >= 2), JSON.stringify({ w: s.users.newWeek, t: s.users.newToday }));
check('график за 7 дней на месте', !!(Array.isArray(s.signups) && s.signups.length === 7), JSON.stringify(s.signups && s.signups.length));

// 3. Канал и сообщение меняют цифры.
send(ows, { t: 'create', room: 'stats ' + stamp, title: 'stats ' + stamp });
const created = await waitFor(ows, (m) => m.t === 'channel_created');
const room = created && created.room;
send(ows, { t: 'channel_add', room, name: 'stm' + stamp });
const beforeMsgs = s.messages.total;
send(ows, { t: 'msg', room, text: 'сообщение для счётчиков' });
const msg = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'сообщение для счётчиков');
check('сообщение отправлено', !!msg, '');
send(ows, { t: 'stats_get' });
const reply2 = await waitFor(ows, (m) => m.t === 'stats' && m.stats.messages.total > beforeMsgs);
check('счётчик сообщений вырос', !!reply2, '');
const s2 = (reply2 && reply2.stats) || {};
check('счётчик каналов вырос', !!(s2.channels && s2.channels.total >= 3), JSON.stringify(s2.channels));
check('личный чат появился после переписки в личке', !!s2.dms, '');

// 4. Вложение попадает в счётчик.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const up = await fetch(B + '/api/media', {
  method: 'POST',
  headers: { 'content-type': 'image/png', 'x-token': owner.data.token },
  body: png,
});
const media = await up.json().catch(() => null);
send(ows, { t: 'msg', room, text: '', mediaId: media && media.id });
await waitFor(ows, (m) => m.t === 'msg' && m.media && m.media.id === (media && media.id));
send(ows, { t: 'stats_get' });
const reply3 = await waitFor(ows, (m) => m.t === 'stats' && m.stats.media.count > 0);
check('вложения посчитаны', !!(reply3 && reply3.stats.media.bytes > 0), JSON.stringify(reply3 && reply3.stats.media));

// Уборка.
for (const [tok, pass] of [[owner.data.token, 'parol123'], [member.data.token, 'parol123']]) {
  const c = await open(tok);
  send(c, { t: 'account_delete', password: pass });
  await sleep(500);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); mws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
