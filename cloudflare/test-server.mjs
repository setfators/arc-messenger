// Протокольный тест Cloudflare-версии: поднимаем два-три «браузера» и
// прогоняем регистрацию, друзей, личку, приватность, typing, ping/pong,
// удаление сообщений и выход.

import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const problems = [];
const log = [];
const stamp = Date.now().toString(36);

function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name); return true; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name + (extra ? ': ' + extra : ''));
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  return { status: res.status, data, headers: res.headers };
}

class Client {
  constructor(label) {
    this.label = label;
    this.got = [];
    this.ws = null;
  }
  open(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`);
      this.ws = ws;
      ws.on('message', (raw) => {
        let msg = null;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
        this.got.push(msg);
      });
      ws.on('open', () => resolve(this));
      ws.on('error', (e) => reject(new Error(this.label + ': ' + e.message)));
      ws.on('unexpected-response', (_req, res) => reject(new Error(this.label + ' http ' + res.statusCode)));
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  async wait(pred, ms = 2500, what = '') {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = this.got.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    log.push(this.label + ': не дождался ' + (what || pred.toString()) + '; было ' + this.got.map((m) => m.t).join(','));
    return null;
  }
  async waitFresh(pred, ms = 2500, what = '') {
    const from = this.got.length;
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = this.got.slice(from).find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    log.push(this.label + ': не дождался нового ' + (what || pred.toString()) + '; было ' + this.got.slice(from).map((m) => m.t).join(','));
    return null;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

// --- HTTP --------------------------------------------------------------------
const health = await fetch(BASE + '/health').then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));
check('GET /health отвечает 200', health.status === 200, String(health.status));
check('/health кэш выключен', String(health.headers.get('cache-control') || '').includes('no-store'), health.headers.get('cache-control'));

const page = await fetch(BASE + '/').then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));
check('страница отдаётся', page.status === 200 && page.text.includes('<title>'), String(page.status));
const pageCache = String(page.headers.get('cache-control') || '');
check('HTML не кэшируется надолго', /no-cache|must-revalidate|max-age=0/.test(pageCache), pageCache);
check('есть x-content-type-options', (page.headers.get('x-content-type-options') || '') === 'nosniff', page.headers.get('x-content-type-options'));
check('есть x-frame-options', (page.headers.get('x-frame-options') || '') === 'DENY', page.headers.get('x-frame-options'));

const getAuth = await fetch(BASE + '/api/login', { method: 'GET' });
check('GET на вход не работает', getAuth.status === 405, String(getAuth.status));
check('405 подсказывает метод', (getAuth.headers.get('allow') || '').includes('POST'), getAuth.headers.get('allow'));

// --- регистрация и вход ------------------------------------------------------
const userA = 'anna' + stamp;
const userB = 'boris' + stamp;
const userC = 'vera' + stamp;
const regA = await api('/api/register', { name: userA, password: 'parolA1' });
check('регистрация первого', regA.status === 200 && !!regA.data.token, JSON.stringify(regA.data));
if (!regA.data || !regA.data.token) {
  // Тест рассчитан на пустую базу: он проверяет, что первый аккаунт — владелец.
  // На занятой базе регистрация требует код, и дальше проверять нечего.
  console.log('\nБаза не пустая: этот набор нужно запускать на свежем хранилище.');
  console.log('Останови сервер, удали каталог --persist-to и запусти снова.');
  process.exit(2);
}
check('первый аккаунт становится владельцем', !!regA.data?.isOwner, JSON.stringify(regA.data));

// Без кода приглашения дальше не пускают.
const noInvite = await api('/api/register', { name: userB, password: 'parolB1' });
check('без кода регистрация закрыта', noInvite.status === 403 && !!noInvite.data?.inviteRequired, JSON.stringify(noInvite.data));

// Владелец создаёт код через WebSocket.
const ownerSocket = await new Client('owner').open(regA.data.token);
await ownerSocket.wait((m) => m.t === 'hello', 3000, 'hello владельца');
ownerSocket.send({ t: 'invite_create', max: 5 });
const created = await ownerSocket.wait((m) => m.t === 'invite_created', 3000, 'invite_created');
const inviteCode = created && created.invite ? created.invite.code : '';
check('владелец создаёт код приглашения', /^[A-Z0-9]{8}$/.test(inviteCode), String(inviteCode));

const regB = await api('/api/register', { name: userB, password: 'parolB1', invite: inviteCode });
const regC = await api('/api/register', { name: userC, password: 'parolC1', invite: inviteCode });
check('регистрация по коду', !!regB.data?.token && !!regC.data?.token, JSON.stringify([regB.status, regC.status]));
check('второй аккаунт уже не владелец', regB.data?.isOwner === false, JSON.stringify(regB.data?.isOwner));
const wrongInvite = await api('/api/register', { name: 'gleb' + stamp, password: 'parolG1', invite: 'ZZZZZZZZ' });
check('неверный код не пускает', wrongInvite.status === 403, String(wrongInvite.status));
const dup = await api('/api/register', { name: userA.toUpperCase(), password: 'parolA1' });
check('повторное имя (регистр) занято', dup.status === 400, JSON.stringify(dup.data));
const badLogin = await api('/api/login', { name: userA, password: 'wrong' });
check('неверный пароль отклонён', badLogin.status === 400, JSON.stringify(badLogin.data));
check('ошибка входа не подсказывает, что имя есть', (badLogin.data?.error || '') === 'Неверное имя или пароль', badLogin.data?.error);
const login = await api('/api/login', { name: userA, password: 'parolA1' });
check('вход работает', login.status === 200 && !!login.data.token, JSON.stringify(login.data));
check('второй вход выдал другой токен', login.data?.token !== regA.data.token);

const anon = await new Promise((resolve) => {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=deadbeef`);
  ws.on('open', () => { resolve('open'); ws.close(); });
  ws.on('unexpected-response', (_q, res) => resolve(String(res.statusCode)));
  ws.on('error', () => resolve('error'));
});
check('сокет без токена не пускают', anon === '401', anon);

// --- подключение -------------------------------------------------------------
const A = await new Client('A').open(login.data.token);
const B = await new Client('B').open(regB.data.token);
const C = await new Client('C').open(regC.data.token);

const helloA = await A.wait((m) => m.t === 'hello', 3000, 'hello');
check('hello пришёл', !!helloA);
check('hello знает имя и каналы', !!helloA && helloA.me.name === userA && helloA.channels.includes('obshiy'),
  helloA && JSON.stringify({ n: helloA.me.name, c: helloA.channels }));
check('профиль в hello', !!(helloA && helloA.me.profile && helloA.me.profile.displayName), JSON.stringify(helloA && helloA.me.profile));
check('настройки в hello', !!(helloA && helloA.me.settings && helloA.me.settings.notifyDesktop === true),
  JSON.stringify(helloA && helloA.me.settings && helloA.me.settings.notifyDesktop));
await A.wait((m) => m.t === 'dm_list', 2000, 'dm_list');
await A.wait((m) => m.t === 'sticker_pack', 2000, 'sticker_pack');
const friendsA0 = await A.wait((m) => m.t === 'friends', 2000, 'friends');
check('friends — массивы объектов', !!friendsA0 && Array.isArray(friendsA0.friends) && Array.isArray(friendsA0.incoming)
  && Array.isArray(friendsA0.outgoing), JSON.stringify(friendsA0));
const presence0 = await A.wait((m) => m.t === 'presence' && m.online.includes(userB) && m.online.includes(userC), 3000, 'presence со всеми');
check('presence со статусами', !!presence0 && Array.isArray(presence0.online) && presence0.online.includes(userA),
  presence0 && JSON.stringify(presence0.online));
check('в presence есть статус каждого', !!(presence0 && presence0.statuses && presence0.statuses[userB.toLowerCase()] === 'online'),
  presence0 && JSON.stringify(presence0.statuses));

// --- сообщение в канал -------------------------------------------------------
A.send({ t: 'join', room: 'obshiy' });
const hist0 = await A.wait((m) => m.t === 'history' && m.room === 'obshiy', 2500, 'history');
check('история канала приходит', !!hist0 && Array.isArray(hist0.messages), JSON.stringify(hist0 && hist0.messages.length));
A.send({ t: 'msg', room: 'obshiy', text: 'привет из теста ' + stamp });
const gotB = await B.waitFresh((m) => m.t === 'msg' && m.text === 'привет из теста ' + stamp, 3000, 'msg');
check('сообщение дошло до другого клиента', !!gotB, JSON.stringify(B.got.map((m) => m.t)));
check('у сообщения есть id, автор и профиль', !!(gotB && gotB.id && gotB.author === userA && gotB.authorProfile),
  JSON.stringify(gotB && { id: gotB.id, a: gotB.author, p: !!gotB.authorProfile }));

// --- ping/pong ---------------------------------------------------------------
A.send({ t: 'ping' });
const pong = await A.waitFresh((m) => m.t === 'pong', 2000, 'pong');
check('ping получает pong', !!pong);

// --- друзья ------------------------------------------------------------------
A.send({ t: 'friend_add', name: userB });
const reqB = await B.waitFresh((m) => m.t === 'friends' && (m.incoming || []).some((p) => p.name === userA), 3000, 'входящая заявка');
check('заявка пришла другу', !!reqB, JSON.stringify(B.got.filter((m) => m.t === 'friends').map((m) => m.incoming)));
const noticeB = await B.wait((m) => m.t === 'notice' && m.text.includes(userA), 2000, 'notice о заявке');
check('друг получил уведомление о заявке', !!noticeB);
const outA = await A.wait((m) => m.t === 'friends' && (m.outgoing || []).some((p) => p.name === userB), 3000, 'исходящая заявка');
check('у автора видна исходящая заявка', !!outA);
A.send({ t: 'friend_add', name: userB });
const already = await A.waitFresh((m) => m.t === 'error', 2000, 'ошибка повторной заявки');
check('повторная заявка не дублируется', !!already && already.text.includes('уже отправлена'), already && already.text);

C.send({ t: 'friend_accept', name: userA });
const noReq = await C.waitFresh((m) => m.t === 'error', 2000, 'ошибка принятия без заявки');
check('нельзя принять несуществующую заявку', !!noReq && noReq.text.includes('Заявки'), noReq && noReq.text);
const friendsC = C.got.filter((m) => m.t === 'friends').at(-1);
check('после неудачного accept в друзьях пусто', !!friendsC && friendsC.friends.length === 0,
  JSON.stringify(friendsC && friendsC.friends));

B.send({ t: 'friend_accept', name: userA });
const accA = await A.waitFresh((m) => m.t === 'friends' && (m.friends || []).some((p) => p.name === userB), 3000, 'дружба');
check('после принятия есть в друзьях', !!accA);
const friendB = accA && accA.friends.find((p) => p.name === userB);
check('у друга в списке есть статус и онлайн', !!(friendB && friendB.status && typeof friendB.online === 'boolean'),
  JSON.stringify(friendB));
check('в списке друзей есть displayName', !!(friendB && friendB.displayName), JSON.stringify(friendB && friendB.displayName));

// --- личные сообщения --------------------------------------------------------
A.send({ t: 'dm_open', name: userB });
const dmHist = await A.waitFresh((m) => m.t === 'history' && String(m.room).startsWith('dm:'), 3000, 'история лички');
check('личный чат открывается', !!dmHist, JSON.stringify(A.got.filter((m) => m.t === 'history').map((m) => m.room)));
const dmRoom = dmHist && dmHist.room;
check('комната лички строится как dm:логин|логин', !!dmRoom && dmRoom.includes(userA.toLowerCase()) && dmRoom.includes(userB.toLowerCase()),
  dmRoom);
A.send({ t: 'msg', room: dmRoom, text: 'лично ' + stamp });
const dmB = await B.waitFresh((m) => m.t === 'msg' && m.text === 'лично ' + stamp, 3000, 'личное сообщение');
check('личное сообщение дошло только адресату', !!dmB);
check('чужой не получил личное сообщение', !C.got.some((m) => m.t === 'msg' && m.text === 'лично ' + stamp),
  JSON.stringify(C.got.filter((m) => m.t === 'msg').map((m) => m.text)));
const dmListB = await B.wait((m) => m.t === 'dm_list' && (m.items || []).some((i) => i.room === dmRoom), 2500, 'dm_list');
check('личный чат появился в списке', !!dmListB);

// --- typing ------------------------------------------------------------------
A.send({ t: 'typing', room: 'obshiy' });
const typed = await B.waitFresh((m) => m.t === 'typing' && m.name === userA && !m.stopped, 2500, 'typing');
check('typing доходит до других', !!typed);
check('typing содержит displayName', !!(typed && typed.displayName), typed && typed.displayName);
A.send({ t: 'typing', room: 'obshiy', stopped: true });
const typedStop = await B.waitFresh((m) => m.t === 'typing' && m.stopped, 2500, 'typing stop');
check('остановка typing доходит', !!typedStop);

// --- приватность лички -------------------------------------------------------
C.send({ t: 'settings_update', settings: { dmPrivacy: 'friends' } });
await C.waitFresh((m) => m.t === 'settings', 2000, 'settings');
A.send({ t: 'dm_open', name: userC });
const privErr = await A.waitFresh((m) => m.t === 'error' && m.text.includes('только от друзей'), 2500, 'приватность');
check('незнакомцу в личку не пускают', !!privErr, JSON.stringify(A.got.filter((m) => m.t === 'error').map((m) => m.text)));

// --- статус «невидимка» ------------------------------------------------------
C.send({ t: 'settings_update', settings: { status: 'invisible' } });
const presHide = await A.waitFresh((m) => m.t === 'presence' && !m.online.includes(userC), 3000, 'presence без невидимки');
check('невидимка исчезает из списка онлайн', !!presHide, JSON.stringify(presHide && presHide.online));
C.send({ t: 'settings_update', settings: { status: 'online' } });
await A.waitFresh((m) => m.t === 'presence' && m.online.includes(userC), 3000, 'presence снова');

// --- удаление сообщения ------------------------------------------------------
A.send({ t: 'msg', room: 'obshiy', text: 'удалить меня ' + stamp });
const toDelete = await A.waitFresh((m) => m.t === 'msg' && m.text === 'удалить меня ' + stamp, 3000, 'своё сообщение');
check('сообщение для удаления есть', !!toDelete);
if (toDelete) {
  B.send({ t: 'msg_delete', room: 'obshiy', id: toDelete.id });
  const notMine = await B.waitFresh((m) => m.t === 'error' && m.text.includes('только свои'), 2500, 'запрет удаления чужого');
  check('чужое сообщение удалить нельзя', !!notMine, JSON.stringify(B.got.filter((m) => m.t === 'error').map((m) => m.text)));
  A.send({ t: 'msg_delete', room: 'obshiy', id: toDelete.id });
  const del = await B.waitFresh((m) => m.t === 'msg_delete' && m.id === toDelete.id, 3000, 'msg_delete');
  check('своё сообщение удаляется у всех', !!del);
}

// --- версия 1.4.0: реакции, ответы, картинки, поиск, push --------------------
check('hello знает версию 1.4.x', !!(helloA && /^1\.4\.\d+$/.test(String(helloA.version))), helloA && helloA.version);
check('hello отдаёт VAPID-ключ', !!(helloA && typeof helloA.pushKey === 'string' && helloA.pushKey.length > 40),
  helloA && String(helloA.pushKey).slice(0, 20));

// Ответ на сообщение.
A.send({ t: 'msg', room: 'obshiy', text: 'оригинал ' + stamp });
const original = await B.waitFresh((m) => m.t === 'msg' && m.text === 'оригинал ' + stamp, 3000, 'оригинал');
check('оригинал для ответа есть', !!original);
if (original) {
  B.send({ t: 'msg', room: 'obshiy', text: 'это ответ', replyTo: original.id });
  const replyMsg = await A.waitFresh((m) => m.t === 'msg' && m.text === 'это ответ', 3000, 'сообщение с ответом');
  check('ответ приходит с цитатой', !!(replyMsg && replyMsg.reply && replyMsg.reply.id === original.id && replyMsg.reply.author === userA),
    JSON.stringify(replyMsg && replyMsg.reply));
  B.send({ t: 'msg', room: 'obshiy', text: 'цитата из другой комнаты', replyTo: 999999 });
  const stale = await A.waitFresh((m) => m.t === 'msg' && m.text === 'цитата из другой комнаты', 3000, 'сообщение без цитаты');
  check('несуществующий оригинал не даёт цитаты', !!(stale && !stale.reply), JSON.stringify(stale && stale.reply));

  // Реакции.
  B.send({ t: 'msg_react', room: 'obshiy', id: original.id, emoji: '🔥' });
  const react = await A.waitFresh((m) => m.t === 'msg_reaction' && m.id === original.id, 3000, 'реакция');
  check('реакция доходит до других', !!(react && react.reactions && Array.isArray(react.reactions['🔥']) && react.reactions['🔥'].includes(userB)),
    JSON.stringify(react && react.reactions));
  B.send({ t: 'msg_react', room: 'obshiy', id: original.id, emoji: '🔥' });
  const unreact = await A.waitFresh((m) => m.t === 'msg_reaction' && m.id === original.id && !(m.reactions && m.reactions['🔥']), 3000, 'снятие реакции');
  check('повторный клик снимает реакцию', !!unreact, JSON.stringify(unreact && unreact.reactions));
  B.send({ t: 'msg_react', room: 'obshiy', id: 999999, emoji: '🔥' });
  await sleep(300);
  check('реакция на несуществующее сообщение молчит', !B.got.some((m) => m.t === 'error' && m.id === 999999));
}

// Картинки-вложения.
const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const mediaRes = await fetch(BASE + '/api/media', {
  method: 'POST',
  headers: { 'content-type': 'image/png', 'x-token': login.data.token },
  body: png1x1,
});
let media = null;
try { media = await mediaRes.json(); } catch (_) {}
check('картинка загружается', mediaRes.status === 200 && !!media.id && media.url === '/media/' + media.id,
  mediaRes.status + ' ' + JSON.stringify(media));
if (media) {
  const got = await fetch(BASE + media.url);
  const bytes = Buffer.from(await got.arrayBuffer());
  check('картинка отдаётся теми же байтами', got.status === 200 && bytes.equals(png1x1),
    got.status + ' ' + bytes.length + '/' + png1x1.length);
  check('у картинки правильный тип', (got.headers.get('content-type') || '').includes('image/png'), got.headers.get('content-type'));
  check('картинка кэшируется надолго', (got.headers.get('cache-control') || '').includes('immutable'), got.headers.get('cache-control'));
  A.send({ t: 'msg', room: 'obshiy', text: '', mediaId: media.id });
  const withMedia = await B.waitFresh((m) => m.t === 'msg' && m.media && m.media.id === media.id, 3000, 'сообщение с картинкой');
  check('сообщение с картинкой доходит', !!withMedia, JSON.stringify(withMedia && withMedia.media));
}
const garbage = await fetch(BASE + '/api/media', {
  method: 'POST',
  headers: { 'content-type': 'image/png', 'x-token': login.data.token },
  body: Buffer.from('это не картинка, а текст'),
});
check('мусор вместо картинки отклонён', garbage.status === 400, String(garbage.status));
const noToken = await fetch(BASE + '/api/media', {
  method: 'POST',
  headers: { 'content-type': 'image/png' },
  body: png1x1,
});
check('загрузка без токена запрещена', noToken.status === 401, String(noToken.status));

// Поиск по истории.
const secretWord = 'иголка' + stamp;
A.send({ t: 'msg', room: 'obshiy', text: 'тут ' + secretWord + ' в тексте' });
await B.waitFresh((m) => m.t === 'msg' && m.text.includes(secretWord), 3000, 'сообщение для поиска');
A.send({ t: 'search_messages', q: secretWord });
const found = await A.waitFresh((m) => m.t === 'search_results' && m.q === secretWord, 3000, 'результаты поиска');
check('поиск находит своё сообщение', !!(found && (found.hits || []).some((h) => h.text.includes(secretWord))),
  JSON.stringify(found && found.hits && found.hits.length));
A.send({ t: 'search_messages', q: 'а' });
const tooShort = await A.waitFresh((m) => m.t === 'search_results' && m.q === 'а', 1500, 'короткий запрос');
check('слишком короткий запрос не ищет', !tooShort || !(tooShort.hits || []).length, JSON.stringify(tooShort && tooShort.hits));
// Чужая личка не должна попадать в поиск: C ищет слово из переписки A и B.
C.send({ t: 'search_messages', q: 'лично ' + stamp });
const foreign = await C.waitFresh((m) => m.t === 'search_results' && m.q === 'лично ' + stamp, 2500, 'чужой поиск');
check('чужая личка в поиск не попадает', !!(foreign && !(foreign.hits || []).length), JSON.stringify(foreign && foreign.hits));

// Push-подписка: сервер принимает и не падает от нерабочего endpoint.
A.send({
  t: 'push_subscribe',
  subscription: {
    endpoint: 'https://127.0.0.1:9/push/' + stamp,
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
  },
});
const pushReply = await A.waitFresh((m) => (m.t === 'notice' || m.t === 'error') && /[Уу]ведомлен/.test(m.text || ''), 3000, 'ответ на подписку');
check('подписка на push принимается', !!pushReply, JSON.stringify(A.got.filter((m) => m.t === 'notice' || m.t === 'error').slice(-2)));
A.send({ t: 'ping' });
const alive = await A.waitFresh((m) => m.t === 'pong', 2000, 'pong после push');
check('сервер жив после попытки push', !!alive);

// --- выход -------------------------------------------------------------------
A.send({ t: 'logout' });
const loggedOut = await A.waitFresh((m) => m.t === 'logged_out', 2500, 'logged_out');
check('logout подтверждается', !!loggedOut);
await sleep(150);
const reuse = await new Promise((resolve) => {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${encodeURIComponent(login.data.token)}`);
  ws.on('open', () => { resolve('open'); ws.close(); });
  ws.on('unexpected-response', (_q, res) => resolve(String(res.statusCode)));
  ws.on('error', () => resolve('error'));
});
check('после logout старый токен не работает', reuse === '401', reuse);
const relogin = await api('/api/login', { name: userA, password: 'parolA1' });
check('повторный вход после logout работает', relogin.status === 200 && !!relogin.data.token);

// --- перебор пароля ----------------------------------------------------------
// Свой адрес в заголовке, чтобы не блокировать остальные проверки:
// Cloudflare на бою подставляет cf-connecting-ip сам, локально его можно задать.
const probeIp = '203.0.113.' + (1 + Math.floor(Math.random() * 250));
let limited = false;
for (let i = 0; i < 14; i += 1) {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': probeIp },
    body: JSON.stringify({ name: userB, password: 'nope' + i }),
  });
  if (res.status === 429) { limited = true; break; }
}
check('перебор пароля упирается в 429', limited);
const afterLimit = await api('/api/login', { name: userA, password: 'parolA1' });
check('блокировка не задевает другие адреса', afterLimit.status === 200, String(afterLimit.status));

A.close(); B.close(); C.close();
await sleep(200);

if (log.length) {
  console.log('\n--- журнал ожиданий ---');
  for (const line of log) console.log(' * ' + line);
}
console.log('\nпроблем: ' + problems.length);
if (problems.length) {
  for (const p of problems) console.log(' - ' + p);
  process.exitCode = 1;
}

// Открытые WebSocket-соединения держат event loop — завершаемся принудительно.
setTimeout(() => process.exit(process.exitCode || 0), 300);