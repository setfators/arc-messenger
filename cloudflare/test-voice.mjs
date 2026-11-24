// Голос (1.8.0): выход из канала обновляет состав у остальных, а после
// выхода из звонка можно сразу звонить другому человеку.
const B = process.env.BASE || 'http://127.0.0.1:8817';
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
function dmRoom(a, b) {
  const [first, second] = a.toLowerCase() <= b.toLowerCase() ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];
  return 'dm:' + first + '|' + second;
}

const an = 'vca' + stamp;
const bn = 'vcb' + stamp;
const cn = 'vcc' + stamp;
const owner = await api('/api/register', { name: an, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
await waitFor(ows, (m) => m.t === 'hello');
send(ows, { t: 'invite_create', max: 5 });
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const second = await api('/api/register', { name: bn, password: 'parol123', invite: inv.invite.code });
const third = await api('/api/register', { name: cn, password: 'parol123', invite: inv.invite.code });
const bws = await open(second.data.token);
const cws = await open(third.data.token);
await waitFor(bws, (m) => m.t === 'hello');
await waitFor(cws, (m) => m.t === 'hello');

// 1. Канал: оба в голосе, затем второй выходит — состав должен обновиться.
send(ows, { t: 'create', room: 'voice ' + stamp, title: 'voice ' + stamp });
const created = await waitFor(ows, (m) => m.t === 'channel_created');
const room = created && created.room;
send(ows, { t: 'channel_add', room, name: bn });
send(ows, { t: 'channel_add', room, name: cn });
await waitFor(bws, (m) => m.t === 'channels' && (m.channels || []).includes(room));
await waitFor(cws, (m) => m.t === 'channels' && (m.channels || []).includes(room));

send(ows, { t: 'voice_join', room });
const stateA = await waitFor(ows, (m) => m.t === 'voice_state' && m.room === room);
check('создатель вошёл в голосовой канал', !!(stateA && (stateA.users || []).some((u) => u.name === an)), JSON.stringify(stateA && stateA.users));
send(bws, { t: 'voice_join', room });
const stateA2 = await waitFor(ows, (m) => m.t === 'voice_state' && m.room === room && (m.users || []).length === 2);
check('второй участник появился в голосе', !!stateA2, JSON.stringify(stateA2 && stateA2.users));
send(bws, { t: 'voice_leave' });
const stateA3 = await waitFor(ows, (m) => m.t === 'voice_state' && m.room === room && (m.users || []).length === 1
  && !(m.users || []).some((u) => u.name === bn));
check('после выхода человек исчезает из голоса у остальных', !!stateA3, JSON.stringify(stateA3 && stateA3.users));
send(ows, { t: 'voice_leave' });
await waitFor(ows, (m) => m.t === 'voice_state' && m.room === room && (m.users || []).length === 0);

// 2. Звонок в личке: после него выходит один — второй получает call_ended.
const ab = dmRoom(an, bn);
send(bws, { t: 'call_start', room: ab });
const incomingA = await waitFor(ows, (m) => m.t === 'call_incoming' && m.room === ab);
check('после выхода из канала можно позвонить', !!incomingA, JSON.stringify(ows.got.filter((m) => m.t === 'error').map((m) => m.text)));
send(ows, { t: 'voice_join', room: ab });
send(ows, { t: 'call_accept', room: ab });
const acceptedB = await waitFor(bws, (m) => m.t === 'call_accepted' && m.room === ab);
check('звонок принимается', !!acceptedB, '');
send(bws, { t: 'voice_join', room: ab });
const bothAb = await waitFor(bws, (m) => m.t === 'voice_state' && m.room === ab && (m.users || []).length === 2);
check('в звонке двое', !!bothAb, JSON.stringify(bothAb && bothAb.users));
send(ows, { t: 'voice_leave' });
const endedB = await waitFor(bws, (m) => m.t === 'call_ended' && m.room === ab);
check('второй получает событие о завершении звонка', !!endedB, JSON.stringify(bws.got.filter((m) => m.t === 'call_ended')));
const leftStateB = await waitFor(bws, (m) => m.t === 'voice_state' && m.room === ab && !(m.users || []).some((u) => u.name === an));
check('в голосе остался только он сам', !!leftStateB, JSON.stringify(leftStateB && leftStateB.users));

// 3. Сразу после завершения звонка можно звонить другому человеку.
send(bws, { t: 'voice_leave' });
const bc = dmRoom(bn, cn);
send(bws, { t: 'call_start', room: bc });
const incomingC = await waitFor(cws, (m) => m.t === 'call_incoming' && m.room === bc);
check('после завершения звонка можно звонить снова', !!incomingC, JSON.stringify(bws.got.filter((m) => m.t === 'error').map((m) => m.text)));
const noBusy = bws.got.some((m) => m.t === 'error' && /уже в звонке/.test(m.text || ''));
check('ошибки «вы уже в звонке» нет', !noBusy, JSON.stringify(bws.got.filter((m) => m.t === 'error').map((m) => m.text)));

// 4. Зависший голос не блокирует звонок: создатель «один» в старом звонке.
send(ows, { t: 'voice_join', room: ab });
const abAlone = await waitFor(ows, (m) => m.t === 'voice_state' && m.room === ab);
check('создатель снова в звонке один', !!(abAlone && (abAlone.users || []).length === 1), JSON.stringify(abAlone && abAlone.users));
const ac = dmRoom(an, cn);
send(ows, { t: 'call_start', room: ac });
const incomingCA = await waitFor(cws, (m) => m.t === 'call_incoming' && m.room === ac);
check('из «пустого» звонка можно позвонить другому', !!incomingCA, JSON.stringify(ows.got.filter((m) => m.t === 'error').map((m) => m.text)));

// Уборка.
for (const [tok, pass] of [[owner.data.token, 'parol123'], [second.data.token, 'parol123'], [third.data.token, 'parol123']]) {
  const c = await open(tok);
  send(c, { t: 'account_delete', password: pass });
  await sleep(500);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); bws.ws.close(); cws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
