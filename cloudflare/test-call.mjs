// Проверки звонка в личке: приглашение, принять, отклонить, занято, отмена.
const B = process.env.BASE || 'http://127.0.0.1:8881';
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

const owner = await api('/api/register', { name: 'cdo' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
await waitFor(ows, (m) => m.t === 'hello');
ows.ws.send(JSON.stringify({ t: 'invite_create', max: 5 }));
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const aName = 'cda' + stamp;
const bName = 'cdb' + stamp;
const cName = 'cdc' + stamp;
const dName = 'cdd' + stamp;
const a = await api('/api/register', { name: aName, password: 'parol123', invite: inv.invite.code });
const b = await api('/api/register', { name: bName, password: 'parol123', invite: inv.invite.code });
const c = await api('/api/register', { name: cName, password: 'parol123', invite: inv.invite.code });
const d = await api('/api/register', { name: dName, password: 'parol123', invite: inv.invite.code });
const aws = await open(a.data.token);
const bws = await open(b.data.token);
const cws = await open(c.data.token);
const dws = await open(d.data.token);
await waitFor(aws, (m) => m.t === 'hello');
await waitFor(bws, (m) => m.t === 'hello');
await waitFor(cws, (m) => m.t === 'hello');
await waitFor(dws, (m) => m.t === 'hello');

const dm = (x, y) => { const f = x.toLowerCase(); const s = y.toLowerCase(); return f <= s ? 'dm:' + f + '|' + s : 'dm:' + s + '|' + f; };
const roomAB = dm(aName, bName);
const roomAC = dm(aName, cName);
const roomBC = dm(bName, cName);
const roomAD = dm(aName, dName);

// 1. A звонит B.
aws.ws.send(JSON.stringify({ t: 'call_start', room: roomAB }));
const incoming = await waitFor(bws, (m) => m.t === 'call_incoming' && m.room === roomAB);
check('B получает входящий звонок', !!(incoming && incoming.from === aName), JSON.stringify(incoming));
const ringing = await waitFor(aws, (m) => m.t === 'call_ringing' && m.room === roomAB);
check('A видит «звоним…»', !!ringing, JSON.stringify(ringing));

// 2. Принимает именно B (тот, кому звонят).
bws.ws.send(JSON.stringify({ t: 'call_accept', room: roomAB }));
const aAccepted = await waitFor(aws, (m) => m.t === 'call_accepted' && m.room === roomAB);
check('A получает call_accepted', !!(aAccepted && aAccepted.by === bName), JSON.stringify(aAccepted));
const bAnswered = await waitFor(bws, (m) => m.t === 'call_answered' && m.room === roomAB);
check('B получает call_answered', !!bAnswered, JSON.stringify(bAnswered));

// 3. Оба входят в голос в личку — разрешено.
aws.ws.send(JSON.stringify({ t: 'voice_join', room: roomAB }));
await waitFor(aws, (m) => m.t === 'voice_state' && m.room === roomAB && (m.users || []).length === 1);
bws.ws.send(JSON.stringify({ t: 'voice_join', room: roomAB }));
const vsAB = await waitFor(bws, (m) => m.t === 'voice_state' && m.room === roomAB && (m.users || []).length === 2);
check('голос в личке разрешён (двое)', !!(vsAB && vsAB.users.some((u) => u.name === aName) && vsAB.users.some((u) => u.name === bName)), JSON.stringify(vsAB && vsAB.users.map((u) => u.name)));

// А и B выходят из голоса, чтобы дальше тестировать новые звонки.
aws.ws.send(JSON.stringify({ t: 'voice_leave' }));
bws.ws.send(JSON.stringify({ t: 'voice_leave' }));
await sleep(400);

// 4. Отклонённый звонок: A звонит C, C отклоняет.
aws.ws.send(JSON.stringify({ t: 'call_start', room: roomAC }));
await waitFor(cws, (m) => m.t === 'call_incoming' && m.room === roomAC);
cws.ws.send(JSON.stringify({ t: 'call_decline', room: roomAC }));
const declined = await waitFor(aws, (m) => m.t === 'call_declined' && m.room === roomAC);
check('отклонение доходит до звонившего', !!declined, JSON.stringify(declined));

// 5. Занято: сначала B уходит, затем C - занят (в голосе в другой личке).
bws.ws.send(JSON.stringify({ t: 'call_start', room: roomBC }));
await waitFor(cws, (m) => m.t === 'call_incoming' && m.room === roomBC);
cws.ws.send(JSON.stringify({ t: 'call_accept', room: roomBC }));
await waitFor(bws, (m) => m.t === 'call_accepted' && m.room === roomBC);
cws.ws.send(JSON.stringify({ t: 'voice_join', room: roomBC }));
bws.ws.send(JSON.stringify({ t: 'voice_join', room: roomBC }));
await sleep(300);
// Теперь C занят голосом с B. A звонит C -> C занят.
aws.ws.send(JSON.stringify({ t: 'call_start', room: roomAC }));
const busy = await waitFor(aws, (m) => m.t === 'call_busy' && m.room === roomAC);
check('звонить занятому — call_busy', !!busy, JSON.stringify(busy));
// B и C выходят из голоса.
bws.ws.send(JSON.stringify({ t: 'voice_leave' }));
cws.ws.send(JSON.stringify({ t: 'voice_leave' }));
await sleep(350);

// 6. Отмена звонка: A звонит D, D видит входящий, A отменяет.
aws.ws.send(JSON.stringify({ t: 'call_start', room: roomAD }));
const incD = await waitFor(dws, (m) => m.t === 'call_incoming' && m.room === roomAD);
check('D получает входящий', !!incD, '');
aws.ws.send(JSON.stringify({ t: 'call_cancel', room: roomAD }));
const cancelled = await waitFor(dws, (m) => m.t === 'call_cancelled' && m.room === roomAD);
check('отмена доходит до получателя', !!cancelled, JSON.stringify(cancelled));

// 7. Приватность: третьему не видно чужое голосовое состояние лички.
aws.ws.send(JSON.stringify({ t: 'call_start', room: roomAB }));
await waitFor(bws, (m) => m.t === 'call_incoming' && m.room === roomAB);
bws.ws.send(JSON.stringify({ t: 'call_accept', room: roomAB }));
await waitFor(aws, (m) => m.t === 'call_accepted');
aws.ws.send(JSON.stringify({ t: 'voice_join', room: roomAB }));
bws.ws.send(JSON.stringify({ t: 'voice_join', room: roomAB }));
await sleep(400);
ows.ws.send(JSON.stringify({ t: 'join', room: 'obshiy' }));
const ownerSaw = await waitFor(ows, (m) => m.t === 'voice_state' && m.room === roomAB, 700);
check('чужую личку третьему не видно', !ownerSaw, '');

// Уборка.
for (const [tok, pass] of [[owner.data.token, 'parol123'], [a.data.token, 'parol123'], [b.data.token, 'parol123'], [c.data.token, 'parol123'], [d.data.token, 'parol123']]) {
  const cl = await open(tok);
  cl.ws.send(JSON.stringify({ t: 'account_delete', password: pass }));
  await sleep(450);
  try { cl.ws.close(); } catch (_) {}
}
try { ows.ws.close(); aws.ws.close(); bws.ws.close(); cws.ws.close(); dws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);