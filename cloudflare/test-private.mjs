// Приватность каналов (1.5.0): канал виден только создателю и приглашённым.
// Проверяем список, историю, сообщения, поиск, голос, файлы и управление.
const B = process.env.BASE || 'http://127.0.0.1:8812';
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
function send(c, obj) { c.ws.send(JSON.stringify(obj)); }

const owner = await api('/api/register', { name: 'privo' + stamp, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
await waitFor(ows, (m) => m.t === 'hello');
send(ows, { t: 'invite_create', max: 5 });
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const friend = await api('/api/register', { name: 'privf' + stamp, password: 'parol123', invite: inv.invite.code });
const stranger = await api('/api/register', { name: 'privs' + stamp, password: 'parol123', invite: inv.invite.code });
const fws = await open(friend.data.token);
const sws = await open(stranger.data.token);
await waitFor(fws, (m) => m.t === 'hello');
await waitFor(sws, (m) => m.t === 'hello');

// 1. Создатель заводит канал и приглашает друга.
send(ows, { t: 'create', room: 'тайная комната ' + stamp, title: 'тайная комната ' + stamp });
const created = await waitFor(ows, (m) => m.t === 'channel_created');
const room = created && created.room;
check('канал создан', !!room, JSON.stringify(created));
send(ows, { t: 'channel_add', room, name: 'privf' + stamp });
const fList = await waitFor(fws, (m) => m.t === 'channels' && (m.channels || []).includes(room));
check('друг видит канал после приглашения', !!fList, JSON.stringify(fList && fList.channels));
const fView = fList && (fList.items || []).find((i) => i.room === room);
check('друг видит состав канала', !!(fView && fView.count === 2 && fView.mine === false), JSON.stringify(fView));
const sHello = sws.got.find((m) => m.t === 'hello');
check('посторонний не видит канал в hello', !!(sHello && !(sHello.channels || []).includes(room)),
  JSON.stringify(sHello && sHello.channels));
check('постороннему не приходит обновление списка с чужим каналом',
  !sws.got.some((m) => m.t === 'channels' && (m.channels || []).includes(room)), '');

// 2. Переписка: друг и создатель видят, посторонний — нет.
send(ows, { t: 'msg', room, text: 'секрет ' + stamp });
const fMsg = await waitFor(fws, (m) => m.t === 'msg' && m.text === 'секрет ' + stamp);
check('сообщение канала получает участник', !!fMsg, '');
const sMsg = await waitFor(sws, (m) => m.t === 'msg' && m.text === 'секрет ' + stamp, 700);
check('посторонний сообщение не получает', !sMsg, '');
send(fws, { t: 'msg', room, text: 'ответ друга' });
const oMsg = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'ответ друга');
check('создатель получает ответ участника', !!oMsg, '');
send(sws, { t: 'msg', room, text: 'чужое сообщение' });
const sOwn = await waitFor(sws, (m) => m.t === 'msg' && m.text === 'чужое сообщение', 700);
check('посторонний не может писать', !sOwn, '');
const oBad = await waitFor(ows, (m) => m.t === 'msg' && m.text === 'чужое сообщение', 300);
check('чужое сообщение не дошло до канала', !oBad, '');

// 3. История и поиск закрыты для постороннего.
send(sws, { t: 'join', room });
const sHist = await waitFor(sws, (m) => m.t === 'history' && m.room === room, 700);
check('посторонний не получает историю', !sHist, '');
send(sws, { t: 'search_messages', q: 'секрет' });
const sSearch = await waitFor(sws, (m) => m.t === 'search_results');
check('поиск не показывает чужой канал', !!(sSearch && (sSearch.hits || []).length === 0),
  JSON.stringify(sSearch && sSearch.hits));
send(fws, { t: 'search_messages', q: 'секрет' });
const fSearch = await waitFor(fws, (m) => m.t === 'search_results' && (m.hits || []).length > 0);
check('участник находит сообщения поиском', !!fSearch, '');

// 4. Голос: посторонний не входит и не видит состав.
send(sws, { t: 'voice_join', room });
const sVoice = await waitFor(sws, (m) => m.t === 'voice_state' && m.room === room, 700);
check('постороннего не пускают в голос', !sVoice, '');
send(ows, { t: 'voice_join', room });
const fVoice = await waitFor(fws, (m) => m.t === 'voice_state' && m.room === room
  && (m.users || []).some((u) => u.name === 'privo' + stamp));
check('участник видит голосовое состояние', !!fVoice, JSON.stringify(fVoice && fVoice.users));
const sVoice2 = await waitFor(sws, (m) => m.t === 'voice_state' && m.room === room, 500);
check('посторонний не видит голосовое состояние', !sVoice2, '');
send(ows, { t: 'voice_leave' });

// 5. Файлы: ссылка без токена не работает, участнику — работает.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
const upRes = await fetch(B + '/api/media', { method: 'POST', headers: { 'content-type': 'image/png', 'x-token': owner.data.token }, body: png });
const up = await upRes.json().catch(() => null);
check('файл загружен', upRes.status === 200 && !!(up && up.id), upRes.status + ' ' + JSON.stringify(up));
if (up) {
  send(ows, { t: 'msg', room, text: '', mediaId: up.id });
  await waitFor(fws, (m) => m.t === 'msg' && m.media && m.media.id === up.id);
  const noTok = await fetch(B + up.url);
  check('файл без токена не отдаётся', noTok.status === 403 || noTok.status === 404, String(noTok.status));
  const sTok = await fetch(B + up.url + '?t=' + encodeURIComponent(stranger.data.token));
  check('постороннему файл не отдаётся', sTok.status === 403 || sTok.status === 404, String(sTok.status));
  const fTok = await fetch(B + up.url + '?t=' + encodeURIComponent(friend.data.token));
  const bytes = await fTok.arrayBuffer();
  check('участник получает файл с токеном', fTok.status === 200 && Buffer.from(bytes).equals(png), String(fTok.status));
}

// 6. Управление: участник не может переименовать/выгнать, создатель может.
send(fws, { t: 'channel_rename', room, title: 'взлом' });
const renameDeny = await waitFor(fws, (m) => m.t === 'error' && /создатель/.test(m.text || ''));
check('участник не переименовывает канал', !!renameDeny, '');
send(fws, { t: 'channel_kick', room, name: 'privo' + stamp });
const kickDeny = await waitFor(fws, (m) => m.t === 'error' && /создатель/.test(m.text || ''));
check('участник не выгоняет людей', !!kickDeny, '');

send(ows, { t: 'channel_kick', room, name: 'privf' + stamp });
const fLost = await waitFor(fws, (m) => m.t === 'channels' && !(m.channels || []).includes(room));
check('создатель убирает участника', !!fLost, '');
const fLostMsg = await waitFor(fws, (m) => m.t === 'channel_removed' && m.room === room);
check('участник получает событие об удалении из канала', !!fLostMsg, '');
send(fws, { t: 'msg', room, text: 'после исключения' });
const fAfter = await waitFor(fws, (m) => m.t === 'msg' && m.text === 'после исключения', 700);
check('исключённый не может писать', !fAfter, '');
send(fws, { t: 'join', room });
const fHist = await waitFor(fws, (m) => m.t === 'history' && m.room === room, 700);
check('исключённый не получает историю', !fHist, '');

// 7. Удаление канала создателем: канал пропадает у всех.
send(ows, { t: 'channel_add', room, name: 'privf' + stamp });
await waitFor(fws, (m) => m.t === 'channels' && (m.channels || []).includes(room));
send(ows, { t: 'channel_delete', room });
const fGone = await waitFor(fws, (m) => m.t === 'channels' && !(m.channels || []).includes(room));
check('удалённый канал исчезает у участника', !!fGone, '');
const oGone = await waitFor(ows, (m) => m.t === 'channels' && !(m.channels || []).includes(room));
check('удалённый канал исчезает у создателя', !!oGone, '');

// Уборка.
for (const [tok, pass] of [[owner.data.token, 'parol123'], [friend.data.token, 'parol123'], [stranger.data.token, 'parol123']]) {
  const c = await open(tok);
  send(c, { t: 'account_delete', password: pass });
  await sleep(500);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); fws.ws.close(); sws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
