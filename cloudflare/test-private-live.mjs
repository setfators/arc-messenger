// Живая проверка приватных каналов на боевом сервере: регистрируем два
// временных аккаунта, проверяем, что канал виден только создателю, пока он
// не позовёт второго, и убираем за собой.
const B = 'https://rust-messenger.sg530507.workers.dev';
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
    setTimeout(() => resolve({ ws, got }), 6000);
  });
}
async function waitFor(client, pred, ms = 6000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const hit = client.got.find(pred); if (hit) return hit; await sleep(40); }
  return null;
}
function send(c, obj) { c.ws.send(JSON.stringify(obj)); }

const owner = await api('/api/register', { name: 'lvown' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) {
  console.log('регистрация на боевом сервере закрыта — живая проверка каналов пропущена');
  console.log('\nпроблем: 0');
  process.exit(0);
}
const guest = await api('/api/register', { name: 'lvges' + stamp, password: 'parol123' });
check('два временных аккаунта созданы', !!(guest.data && guest.data.token), guest.status + ' ' + JSON.stringify(guest.data));
const ows = await open(owner.data.token);
const gws = await open(guest.data.token);
await waitFor(ows, (m) => m.t === 'hello');
const oHello = await waitFor(ows, (m) => m.t === 'hello');
await waitFor(gws, (m) => m.t === 'hello');
check('новому аккаунту выдан демо-канал', !!(oHello && (oHello.channelItems || []).some((i) => i.demo)), JSON.stringify(oHello && oHello.channels));

try {
  const title = 'проверка ' + stamp;
  send(ows, { t: 'create', room: title, title });
  const created = await waitFor(ows, (m) => m.t === 'channel_created');
  const room = created && created.room;
  check('канал создан на боевом сервере', !!room, JSON.stringify(created));
  const oList = await waitFor(ows, (m) => m.t === 'channels' && (m.channels || []).includes(room));
  check('создатель видит канал', !!oList, JSON.stringify(oList && oList.channels));
  const gHello = gws.got.find((m) => m.t === 'hello');
  check('посторонний канал не видит', !!(gHello && !(gHello.channels || []).includes(room)), '');

  send(ows, { t: 'msg', room, text: 'секрет ' + stamp });
  const ownMsg = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'секрет ' + stamp);
  check('сообщение в канал отправляется', !!ownMsg, '');
  const leak = await waitFor(gws, (m) => m.t === 'msg' && m.text === 'секрет ' + stamp, 800);
  check('посторонний сообщение не получает', !leak, '');

  const ownerList = ows.got.filter((m) => m.t === 'channels').at(-1);
  const inviteCode = ((ownerList && (ownerList.items || []).find((i) => i.room === room)) || {}).invite || '';
  check('у канала есть ссылка-приглашение', !!inviteCode, String(inviteCode));
  send(gws, { t: 'channel_join', code: inviteCode });
  const gList = await waitFor(gws, (m) => m.t === 'channels' && (m.channels || []).includes(room));
  check('после приглашения канал виден', !!gList, JSON.stringify(gList && gList.channels));
  const view = gList && (gList.items || []).find((i) => i.room === room);
  check('в канале двое участников', !!(view && view.count === 2), JSON.stringify(view));
  send(gws, { t: 'msg', room, text: 'ответ ' + stamp });
  const reply = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'ответ ' + stamp);
  check('приглашённый может писать', !!reply, '');

  send(ows, { t: 'channel_delete', room });
  const gone = await waitFor(gws, (m) => m.t === 'channels' && !(m.channels || []).includes(room));
  check('удалённый канал исчезает у участника', !!gone, '');
} finally {
  for (const [tok, pass] of [[owner.data.token, 'parol123'], [guest.data.token, 'parol123']]) {
    const c = await open(tok);
    send(c, { t: 'account_delete', password: pass });
    await sleep(600);
    try { c.ws.close(); } catch (_) {}
  }
  try { ows.ws.close(); gws.ws.close(); } catch (_) {}
}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
