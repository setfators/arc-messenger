// Проверяем автоматический бэкап: таймер взводится при первом запросе
// и через минуту должен сам создать снимок за сегодня.
const B = process.env.BASE || 'http://127.0.0.1:8813';
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
  while (Date.now() < until) { const hit = client.got.find(pred); if (hit) return hit; await sleep(50); }
  return null;
}

const owner = await api('/api/register', { name: 'alm' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
await waitFor(ows, (m) => m.t === 'hello');

ows.ws.send(JSON.stringify({ t: 'backup_list' }));
const before = await waitFor(ows, (m) => m.t === 'backup_state');
check('сразу после старта снимков нет', !!(before && before.items.length === 0), JSON.stringify(before && before.items.map((i) => i.date)));

console.log('ждём срабатывания таймера (до 100 секунд)…');
let after = null;
for (let i = 0; i < 20; i += 1) {
  await sleep(5000);
  ows.got.length = 0;
  ows.ws.send(JSON.stringify({ t: 'backup_list' }));
  after = await waitFor(ows, (m) => m.t === 'backup_state', 3000);
  if (after && after.items.length > 0) break;
}
check('таймер сам создал снимок', !!(after && after.items.length >= 1), JSON.stringify(after && after.items.map((i) => i.date)));
const today = new Date();
const pad = (n) => String(n).padStart(2, '0');
const expected = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
check('снимок за сегодняшнюю дату', !!(after && after.items.some((i) => i.date === expected)), expected);

// Уборка.
ows.ws.send(JSON.stringify({ t: 'account_delete', password: 'parol123' }));
await sleep(700);
try { ows.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
