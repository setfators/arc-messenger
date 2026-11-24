// Проверки того, что общий канал стал обычным: его можно удалить,
// он не воскресает, а сервер не падает на пустом списке каналов.
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
check('новый сервер получает общий канал', !!(hello && (hello.channels || []).includes('obshiy')), JSON.stringify(hello && hello.channels));

// 1. Общий канал можно удалить.
ows.ws.send(JSON.stringify({ t: 'channel_delete', room: 'obshiy' }));
const chans = await waitFor(ows, (m) => m.t === 'channels' && !(m.channels || []).includes('obshiy'));
check('общий канал удаляется', !!chans, JSON.stringify(chans && chans.channels));

// 2. Не воскресает: перечитываем состояние новым подключением.
const again = await open(owner.data.token);
const hello2 = await waitFor(again, (m) => m.t === 'hello');
check('после переподключения не вернулся', !!(hello2 && !(hello2.channels || []).includes('obshiy')), JSON.stringify(hello2 && hello2.channels));
try { again.ws.close(); } catch (_) {}

// 3. Список каналов пуст, но сервер работает и не падает.
check('каналов не осталось', !!(chans && chans.channels.length === 0), JSON.stringify(chans && chans.channels));

// 4. Можно создать свой канал и писать в него.
ows.ws.send(JSON.stringify({ t: 'create', room: 'main' + stamp }));
const created = await waitFor(ows, (m) => m.t === 'channel_created' && m.room === 'main' + stamp);
check('свой канал создаётся', !!created, JSON.stringify(created));
ows.ws.send(JSON.stringify({ t: 'msg', room: 'main' + stamp, text: 'привет' }));
const msg = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'привет');
check('в новый канал можно писать', !!msg, '');

// 5. В удалённый общий канал писать нельзя.
ows.ws.send(JSON.stringify({ t: 'msg', room: 'obshiy', text: 'в никуда' }));
const ghost = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'в никуда', 700);
check('в удалённый канал не отправить', !ghost, '');

// 6. Участник не может удалять каналы.
ows.ws.send(JSON.stringify({ t: 'invite_create', max: 5 }));
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const member = await api('/api/register', { name: 'chp' + stamp, password: 'parol123', invite: inv.invite.code });
const mws = await open(member.data.token);
await waitFor(mws, (m) => m.t === 'hello');
mws.ws.send(JSON.stringify({ t: 'channel_delete', room: 'main' + stamp }));
const deny = await waitFor(mws, (m) => m.t === 'error' && /владелец/.test(m.text || ''));
check('участнику удалять каналы нельзя', !!deny, '');

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
