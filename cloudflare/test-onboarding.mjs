// Знакомство (1.6.0): новому человеку создаётся демо-канал, он приватный,
// открывается по кнопке и не дублируется.
const B = process.env.BASE || 'http://127.0.0.1:8814';
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

const owner = await api('/api/register', { name: 'tut' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
const hello = await waitFor(ows, (m) => m.t === 'hello');
const demoItem = (hello && (hello.channelItems || []).find((i) => i.demo)) || null;
check('при регистрации создан демо-канал', !!demoItem, JSON.stringify(hello && hello.channelItems));
check('демо-канал называется «Добро пожаловать»', !!(demoItem && demoItem.title === 'Добро пожаловать'), JSON.stringify(demoItem && demoItem.title));
check('демо-канал принадлежит своему создателю', !!(demoItem && demoItem.mine === true && demoItem.count === 1), '');
const demoRoom = demoItem && demoItem.room;

// 1. В демо-канале есть экскурсия.
send(ows, { t: 'join', room: demoRoom });
const hist = await waitFor(ows, (m) => m.t === 'history' && m.room === demoRoom);
check('в демо-канале есть сообщения', !!(hist && (hist.messages || []).length >= 5), String(hist && (hist.messages || []).length));
check('экскурсию написал Arc', !!(hist && (hist.messages || []).every((m) => m.author === 'Arc')), '');
check('сообщения экскурсии помечены внешними', !!(hist && (hist.messages || []).every((m) => !!m.external)), '');

// 2. Повторное открытие не плодит каналы.
send(ows, { t: 'demo_open' });
const again = await waitFor(ows, (m) => m.t === 'channel_created' && m.room === demoRoom);
check('demo_open возвращает тот же канал', !!again, '');
const list = await waitFor(ows, (m) => m.t === 'channels');
check('демо-каналов ровно один', !!(list && (list.items || []).filter((i) => i.demo).length === 1),
  JSON.stringify(list && list.items.filter((i) => i.demo).map((i) => i.room)));

// 3. Чужой человек демо-канал не видит.
send(ows, { t: 'invite_create', max: 5 });
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const guest = await api('/api/register', { name: 'tug' + stamp, password: 'parol123', invite: inv.invite.code });
const gws = await open(guest.data.token);
const gHello = await waitFor(gws, (m) => m.t === 'hello');
check('у второго человека свой демо-канал', !!(gHello && (gHello.channelItems || []).some((i) => i.demo)), '');
check('чужой демо-канал не виден', !!(gHello && !(gHello.channels || []).includes(demoRoom)),
  JSON.stringify(gHello && gHello.channels));

// 4. Демо-канал можно удалить, и он создастся заново по кнопке.
send(ows, { t: 'channel_delete', room: demoRoom });
const gone = await waitFor(ows, (m) => m.t === 'channels' && !(m.channels || []).includes(demoRoom));
check('демо-канал удаляется', !!gone, '');
send(ows, { t: 'demo_open' });
const recreated = await waitFor(ows, (m) => m.t === 'channel_created' && m.room);
check('по кнопке демо-канал создаётся заново', !!(recreated && recreated.room), JSON.stringify(recreated));
const list2 = await waitFor(ows, (m) => m.t === 'channels' && (m.items || []).some((i) => i.demo));
check('заново создан один демо-канал', !!(list2 && (list2.items || []).filter((i) => i.demo).length === 1), '');

// Уборка.
for (const [tok, pass] of [[owner.data.token, 'parol123'], [guest.data.token, 'parol123']]) {
  const c = await open(tok);
  send(c, { t: 'account_delete', password: pass });
  await sleep(500);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); gws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
