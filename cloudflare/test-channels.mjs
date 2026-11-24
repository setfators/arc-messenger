// Приватные каналы (1.5.0): канал создаётся для себя, живёт в базе,
// переименовывается и удаляется создателем. Общих каналов больше нет.
const B = process.env.BASE || 'http://127.0.0.1:8811';
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
  while (Date.now() < until) { const hit = client.got.find((m) => pred(m)); if (hit) return hit; await sleep(25); }
  return null;
}

const owner = await api('/api/register', { name: 'chm' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
const hello = await waitFor(ows, (m) => m.t === 'hello');
check('новому человеку создаётся демо-канал',
  !!(hello && (hello.channels || []).length === 1
    && (hello.channelItems || []).some((i) => i.demo && i.title === 'Добро пожаловать')),
  JSON.stringify(hello && { c: hello.channels, items: hello.channelItems }));
check('общих каналов нет: демо-канал принадлежит только создателю',
  !!(hello && (hello.channelItems || []).length === 1 && (hello.channelItems[0] || {}).mine === true),
  JSON.stringify(hello && hello.channelItems));

// 1. Свой канал создаётся и сразу виден только создателю.
const title = 'мои дела ' + stamp;
ows.ws.send(JSON.stringify({ t: 'create', room: title, title }));
const created = await waitFor(ows, (m) => m.t === 'channel_created' && m.room);
const room = created && created.room;
check('канал создаётся', !!room, JSON.stringify(created));
const list1 = await waitFor(ows, (m) => m.t === 'channels' && (m.channels || []).includes(room));
check('канал попал в свой список', !!list1, JSON.stringify(list1 && list1.channels));
const view = list1 && (list1.items || []).find((i) => i.room === room);
check('у канала есть владелец и название', !!(view && view.mine && view.title === title && view.count === 1),
  JSON.stringify(view));

// 2. Пишем в канал.
ows.ws.send(JSON.stringify({ t: 'msg', room, text: 'привет' }));
const msg = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'привет');
check('в свой канал можно писать', !!msg, '');

// 3. Переименование: адрес не меняется, меняется название.
const renamed = 'дела ' + stamp;
ows.ws.send(JSON.stringify({ t: 'channel_rename', room, title: renamed }));
const list2 = await waitFor(ows, (m) => m.t === 'channels'
  && (m.items || []).some((i) => i.room === room && i.title === renamed));
check('канал переименовывается', !!list2, JSON.stringify(list2 && list2.items));

// 4. Канал переживает переподключение (лежит в базе).
const again = await open(owner.data.token);
const hello2 = await waitFor(again, (m) => m.t === 'hello');
check('после переподключения канал на месте', !!(hello2 && (hello2.channels || []).includes(room)),
  JSON.stringify(hello2 && hello2.channels));
const view2 = hello2 && (hello2.channelItems || []).find((i) => i.room === room);
check('название сохранилось', !!(view2 && view2.title === renamed), JSON.stringify(view2 && view2.title));
try { again.ws.close(); } catch (_) {}

// 5. Удаление: только создатель (он же единственный участник).
ows.ws.send(JSON.stringify({ t: 'channel_delete', room }));
const list3 = await waitFor(ows, (m) => m.t === 'channels' && !(m.channels || []).includes(room));
check('канал удаляется', !!list3, JSON.stringify(list3 && list3.channels));
// Демо-канал, выданный при регистрации, остаётся: удаляли только свой.
check('демо-канал после удаления остался',
  !!(list3 && (list3.channels || []).length === 1 && (list3.items || []).some((i) => i.demo)),
  JSON.stringify(list3 && list3.items));

// 6. В удалённый канал писать нельзя.
ows.ws.send(JSON.stringify({ t: 'msg', room, text: 'в никуда' }));
const ghost = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'в никуда', 700);
check('в удалённый канал не отправить', !ghost, '');

// 7. Чужой канал не виден и его нельзя удалить.
const invite = await (async () => {
  ows.ws.send(JSON.stringify({ t: 'invite_create', max: 5 }));
  return waitFor(ows, (m) => m.t === 'invite_created');
})();
const member = await api('/api/register', { name: 'chp' + stamp, password: 'parol123', invite: invite.invite.code });
const mws = await open(member.data.token);
const mHello = await waitFor(mws, (m) => m.t === 'hello');
check('другой аккаунт не видит чужой канал',
  !!(mHello && !(mHello.channels || []).includes(room) && (mHello.channels || []).length === 1),
  JSON.stringify(mHello && mHello.channels));
ows.ws.send(JSON.stringify({ t: 'create', room: 'main' + stamp, title: 'main' + stamp }));
const created2 = await waitFor(ows, (m) => m.t === 'channel_created' && m.room && m.room !== room);
const room2 = created2 && created2.room;
check('второй канал создан', !!room2, JSON.stringify(created2));
mws.ws.send(JSON.stringify({ t: 'channel_delete', room: room2 }));
const deny = await waitFor(mws, (m) => m.t === 'error' && /создатель/.test(m.text || ''));
check('чужой канал нельзя удалить', !!deny, '');
mws.ws.send(JSON.stringify({ t: 'msg', room: room2, text: 'тайком' }));
const secret = await waitFor(mws, (m) => m.t === 'msg' && m.text === 'тайком', 700);
check('в чужой канал нельзя писать', !secret, '');

// Уборка.
for (const [tok, pass] of [[owner.data.token, 'parol123'], [member.data.token, 'parol123']]) {
  const c = await open(tok);
  c.ws.send(JSON.stringify({ t: 'account_delete', password: pass }));
  await sleep(500);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); mws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
