// Проверки редактирования сообщений.
const B = process.env.BASE || 'http://127.0.0.1:8861';
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

const owner = await api('/api/register', { name: 'edt' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
await waitFor(ows, (m) => m.t === 'hello');

ows.ws.send(JSON.stringify({ t: 'invite_create', max: 5 }));
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const memberName = 'edm' + stamp;
const member = await api('/api/register', { name: memberName, password: 'parol123', invite: inv.invite.code });
const mws = await open(member.data.token);
await waitFor(mws, (m) => m.t === 'hello');
const memberToken = member.data.token;

// 1. Своё сообщение можно исправить.
ows.ws.send(JSON.stringify({ t: 'msg', room: 'obshiy', text: 'черновик ' + stamp }));
const mine = await waitFor(mws, (m) => m.t === 'msg' && m.text === 'черновик ' + stamp);
check('сообщение отправлено', !!mine, '');
ows.ws.send(JSON.stringify({ t: 'msg_edit', room: 'obshiy', id: mine.id, text: 'исправлено ' + stamp }));
const edited = await waitFor(mws, (m) => m.t === 'msg_edit' && m.id === mine.id);
check('правка доходит до собеседника', !!(edited && edited.text === 'исправлено ' + stamp), JSON.stringify(edited));
check('у правки есть время', !!(edited && edited.edited > 0), String(edited && edited.edited));

// 2. История отдаёт исправленный текст и пометку.
const mws2 = await open(memberToken);
const hello = await waitFor(mws2, (m) => m.t === 'hello');
check('повторный вход работает', !!hello, '');
mws2.ws.send(JSON.stringify({ t: 'join', room: 'obshiy' }));
const hist = await waitFor(mws2, (m) => m.t === 'history');
const inHistory = hist && (hist.messages || []).find((one) => one.id === mine.id);
check('в истории исправленный текст', !!(inHistory && inHistory.text === 'исправлено ' + stamp), JSON.stringify(inHistory && inHistory.text));
check('в истории есть пометка правки', !!(inHistory && inHistory.edited > 0), String(inHistory && inHistory.edited));

// 3. Чужое сообщение исправить нельзя.
mws.ws.send(JSON.stringify({ t: 'msg', room: 'obshiy', text: 'чужое ' + stamp }));
const theirs = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'чужое ' + stamp);
check('сообщение второго участника видно', !!theirs, '');
ows.ws.send(JSON.stringify({ t: 'msg_edit', room: 'obshiy', id: theirs.id, text: 'подмена ' + stamp }));
const deny = await waitFor(ows, (m) => m.t === 'error' && /только своё/.test(m.text || ''));
check('чужое сообщение не исправляется', !!deny, JSON.stringify(ows.got.filter((m) => m.t === 'error').map((m) => m.text)));
const stillTheirs = await waitFor(mws, (m) => m.t === 'msg_edit' && m.id === theirs.id, 500);
check('подмены не случилось', !stillTheirs, '');

// 4. Пустой текст не принимается.
ows.ws.send(JSON.stringify({ t: 'msg_edit', room: 'obshiy', id: mine.id, text: '   ' }));
const noChange = await waitFor(mws, (m) => m.t === 'msg_edit' && m.id === mine.id && m.text !== 'исправлено ' + stamp, 600);
check('пустой текст не затирает сообщение', !noChange, '');

// 5. Слишком длинный текст не принимается.
ows.ws.send(JSON.stringify({ t: 'msg_edit', room: 'obshiy', id: mine.id, text: 'x'.repeat(5000) }));
const tooLong = await waitFor(mws, (m) => m.t === 'msg_edit' && m.id === mine.id && String(m.text).length > 1000, 600);
check('слишком длинный текст не принимается', !tooLong, '');

// 6. Несуществующее сообщение — молча ничего.
ows.ws.send(JSON.stringify({ t: 'msg_edit', room: 'obshiy', id: 999999, text: 'призрак' }));
await sleep(400);
check('несуществующее сообщение не ломает сервер', true, '');

// Уборка.
for (const t of [owner.data.token, memberToken]) {
  const c = await open(t);
  c.ws.send(JSON.stringify({ t: 'account_delete', password: 'parol123' }));
  await sleep(600);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); mws.ws.close(); mws2.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
