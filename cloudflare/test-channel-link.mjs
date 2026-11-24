// Ссылка-приглашение в канал (1.6.0): создатель получает код, по нему можно
// войти в приватный канал; старая ссылка отменяется новой или отключением.
const B = process.env.BASE || 'http://127.0.0.1:8816';
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
function itemOf(client, room) {
  const msg = client.got.filter((m) => m.t === 'channels').at(-1);
  return msg && (msg.items || []).find((i) => i.room === room);
}

const owner = await api('/api/register', { name: 'lnk' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
const oHello = await waitFor(ows, (m) => m.t === 'hello');
const demo = oHello && (oHello.channelItems || []).find((i) => i.demo);
check('у демо-канала сразу есть ссылка', !!(demo && typeof demo.invite === 'string' && demo.invite.length === 10),
  JSON.stringify(demo && demo.invite));

// 1. Свой канал: код виден только создателю.
send(ows, { t: 'create', room: 'link ' + stamp, title: 'link ' + stamp });
const created = await waitFor(ows, (m) => m.t === 'channel_created');
const room = created && created.room;
check('канал создан', !!room, JSON.stringify(created));
const oItem = itemOf(ows, room);
check('создатель видит код ссылки', !!(oItem && typeof oItem.invite === 'string' && oItem.invite.length === 10),
  JSON.stringify(oItem && oItem.invite));
check('приглашений по ссылке пока ноль', !!(oItem && oItem.inviteUses === 0), JSON.stringify(oItem && oItem.inviteUses));
const code = (oItem && oItem.invite) || '';

// 2. Второй аккаунт: ссылки не видит, пока не вошёл.
send(ows, { t: 'invite_create', max: 5 });
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const member = await api('/api/register', { name: 'lnm' + stamp, password: 'parol123', invite: inv.invite.code });
const mws = await open(member.data.token);
const mHello = await waitFor(mws, (m) => m.t === 'hello');
check('посторонний канал не видит', !!(mHello && !(mHello.channels || []).includes(room)), JSON.stringify(mHello && mHello.channels));

// 3. Кривой код не пускает.
send(mws, { t: 'channel_join', code: 'BADCODE000' });
const bad = await waitFor(mws, (m) => m.t === 'invite_join_failed');
check('неверная ссылка не пускает', !!bad, JSON.stringify(mws.got.filter((m) => m.t === 'invite_join_failed').map((m) => m.text)));

// 4. Правильный код добавляет в канал.
send(mws, { t: 'channel_join', code });
const joined = await waitFor(mws, (m) => m.t === 'channels' && (m.channels || []).includes(room));
check('по ссылке человек входит в канал', !!joined, JSON.stringify(joined && joined.channels));
const mItem = itemOf(mws, room);
check('новый участник видит канал и состав', !!(mItem && mItem.count === 2 && mItem.mine === false), JSON.stringify(mItem));
check('участнику код ссылки не показывается', !!(mItem && !mItem.invite), JSON.stringify(mItem && mItem.invite));
const hist = await waitFor(mws, (m) => m.t === 'history' && m.room === room);
check('после входа приходит история', !!hist, '');
const ownerNotified = await waitFor(ows, (m) => m.t === 'notice' && /присоединился/.test(m.text || ''));
check('создатель видит, что кто-то присоединился', !!ownerNotified, JSON.stringify(ows.got.filter((m) => m.t === 'notice').map((m) => m.text)));

// 5. Повторный вход по той же ссылке не плодит участников.
send(mws, { t: 'channel_join', code });
const again = await waitFor(mws, (m) => m.t === 'notice' && /уже в канале/.test(m.text || ''));
check('повторный вход не дублирует', !!again, '');
const afterRepeat = itemOf(ows, room);
check('участников по-прежнему двое', !!(afterRepeat && afterRepeat.count === 2), JSON.stringify(afterRepeat && afterRepeat.count));

// 6. Участник не может менять ссылку.
send(mws, { t: 'channel_invite_reset', room });
const denyReset = await waitFor(mws, (m) => m.t === 'error' && /создатель/.test(m.text || ''));
check('участник не меняет ссылку', !!denyReset, '');
send(mws, { t: 'channel_invite_off', room });
const denyOff = await waitFor(mws, (m) => m.t === 'error' && /создатель/.test(m.text || ''));
check('участник не отключает ссылку', !!denyOff, '');

// 7. Новая ссылка отменяет старую.
send(ows, { t: 'channel_invite_reset', room });
const refreshed = await waitFor(ows, (m) => m.t === 'channels'
  && (m.items || []).some((i) => i.room === room && i.invite && i.invite !== code));
check('ссылка обновляется', !!refreshed, '');
const newCode = ((refreshed && (refreshed.items || []).find((i) => i.room === room)) || {}).invite || '';
check('новый код отличается от старого', !!(newCode && newCode !== code), JSON.stringify({ old: code, fresh: newCode }));
send(ows, { t: 'invite_create', max: 5 });
const inv2 = await waitFor(ows, (m) => m.t === 'invite_created' && m.invite && m.invite.code !== (inv.invite && inv.invite.code));
const guest = await api('/api/register', { name: 'lng' + stamp, password: 'parol123', invite: inv2.invite.code });
const gws = await open(guest.data.token);
await waitFor(gws, (m) => m.t === 'hello');
send(gws, { t: 'channel_join', code });
const oldDead = await waitFor(gws, (m) => m.t === 'invite_join_failed');
check('старая ссылка больше не работает', !!oldDead, '');
send(gws, { t: 'channel_join', code: newCode });
const newWorks = await waitFor(gws, (m) => m.t === 'channels' && (m.channels || []).includes(room));
check('новая ссылка работает', !!newWorks, '');

// 8. Отключение ссылки: войти нельзя, пока не создадут новую.
send(ows, { t: 'channel_invite_off', room });
const offState = await waitFor(ows, (m) => m.t === 'channels'
  && (m.items || []).some((i) => i.room === room && !i.invite));
check('ссылка отключается', !!offState, '');
send(gws, { t: 'channel_leave', room });
await waitFor(gws, (m) => m.t === 'channels' && !(m.channels || []).includes(room));
send(gws, { t: 'channel_join', code: newCode });
const offDead = await waitFor(gws, (m) => m.t === 'invite_join_failed');
check('отключённая ссылка не пускает', !!offDead, '');
send(ows, { t: 'channel_invite_reset', room });
const backAgain = await waitFor(ows, (m) => m.t === 'channels'
  && (m.items || []).some((i) => i.room === room && i.invite));
check('ссылку можно создать заново', !!backAgain, '');

// Уборка.
for (const [tok, pass] of [[owner.data.token, 'parol123'], [member.data.token, 'parol123'], [guest.data.token, 'parol123']]) {
  const c = await open(tok);
  send(c, { t: 'account_delete', password: pass });
  await sleep(500);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); mws.ws.close(); gws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
