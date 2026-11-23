// Проверка клиента: грузим index.html в jsdom и гоняем сценарии протокола.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL('C:/Users/setfators/Desktop/rust-messenger/cloudflare/test-client.mjs'));
const jsdomPath = process.env.JSDOM_DIR || 'C:/Users/setfators/AppData/Local/Temp/jsdomtest/node_modules/jsdom';
const { JSDOM, VirtualConsole } = require(jsdomPath);

const html = readFileSync('C:/Users/setfators/Desktop/rust-messenger/cloudflare/public/index.html', 'utf8');

const problems = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push('jsdomError: ' + (e && e.message)));
vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));

const sockets = [];
class FakeWS {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
  open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  push(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}

const notifications = [];

const dom = new JSDOM(html, {
  url: 'https://example.test/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.WebSocket = FakeWS;
    window.localStorage.setItem('token', 'tok123');
    window.Notification = class {
      constructor(title, opts) { notifications.push({ title, body: (opts && opts.body) || '' }); }
      static permission = 'granted';
      static requestPermission() { return Promise.resolve('granted'); }
    };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    window.confirm = () => true;
    window.prompt = () => null;
    window.alert = () => {};
    window.fetch = async () => ({ ok: true, json: async () => ({}) });
    window.RTCPeerConnection = class {
      constructor() { this.connectionState = 'new'; }
      addTrack() {}
      createDataChannel() { return {}; }
      createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
      createAnswer() { return Promise.resolve({ type: 'answer', sdp: '' }); }
      setLocalDescription() { return Promise.resolve(); }
      setRemoteDescription() { return Promise.resolve(); }
      addIceCandidate() { return Promise.resolve(); }
      close() {}
    };
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ stop() {} }] }),
        getDisplayMedia: async () => ({ getTracks: () => [{ stop() {} }], getVideoTracks: () => [{ stop() {} }] }),
        enumerateDevices: async () => [],
      },
    });
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    // jsdom не умеет играть звук — глушим.
    window.Audio = class { play() { return Promise.resolve(); } pause() {} };
  },
});

const { window } = dom;
const doc = window.document;
const $ = (sel) => doc.querySelector(sel);
const texts = (sel) => [...doc.querySelectorAll(sel)].map((n) => n.textContent.trim());

function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name); return true; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name + (extra ? ': ' + extra : ''));
  return false;
}

await new Promise((r) => setTimeout(r, 120));

const ws = sockets[0];
check('сокет создан при наличии токена', !!ws, 'sockets=' + sockets.length);
check('токен ушёл в URL', !!ws && ws.url.includes('token=tok123'), ws && ws.url);
check('экран входа скрыт', $('#auth').classList.contains('hidden'));
ws.open();

// --- hello + первичные списки -------------------------------------------------
ws.push({
  t: 'hello',
  me: { name: 'anna', color: '#5865f2', profile: { displayName: 'Анна', avatarUrl: '' }, status: 'online', settings: { status: 'online' } },
  channels: ['obshiy', 'games'],
});
ws.push({ t: 'dm_list', items: [{ room: 'dm:anna|boris', name: 'boris', displayName: 'Борис', avatarUrl: '', last_ts: 1 }] });
ws.push({
  t: 'friends',
  friends: [
    { name: 'boris', displayName: 'Борис', status: 'online', online: true, avatarUrl: '' },
    { name: 'vera', displayName: 'Вера', status: 'offline', online: false, avatarUrl: '' },
  ],
  incoming: [{ name: 'gleb', displayName: 'Глеб', status: 'online', online: true }],
  outgoing: [],
});
ws.push({ t: 'presence', online: ['anna', 'boris'], statuses: { boris: 'dnd' } });
ws.push({ t: 'history', room: 'obshiy', messages: [
  { id: 1, room: 'obshiy', author: 'boris', text: 'привет', ts: Date.now() - 5000, authorProfile: { displayName: 'Борис' } },
  { id: 2, room: 'obshiy', author: 'anna', text: 'хай', ts: Date.now() - 4000, authorProfile: { displayName: 'Анна' } },
] });
await new Promise((r) => setTimeout(r, 60));

check('каналы отрисованы', texts('#channels .nm').join(',') === '# obshiy,# games', texts('#channels .nm').join(','));
check('друзья отрисованы (объекты из протокола)', texts('#friendList .nm').join('|').includes('Борис'), texts('#friendList .nm').join('|'));
check('в друзьях есть статус', texts('#friendList .st').includes('не беспокоить'), texts('#friendList .st').join('|'));
check('приватный статус друга не «в сети» у офлайн', texts('#friendList .st').includes('не в сети'), texts('#friendList .st').join('|'));
check('заявка в друзья видна', texts('#requests .nm').join('|').includes('Глеб'), texts('#requests .nm').join('|'));
check('личный чат виден', texts('#dmList .nm').join('|').includes('Борис'), texts('#dmList .nm').join('|'));
check('история отрисована', texts('#messages .msg .body').join('|') === 'привет|хай', texts('#messages .msg .body').join('|'));
check('кнопка удаления только у своих', doc.querySelectorAll('#messages .del-msg').length === 1, 'count=' + doc.querySelectorAll('#messages .del-msg').length);
check('join отправлен после hello', ws.sent.some((m) => m.t === 'join'), JSON.stringify(ws.sent));

// --- сообщение в открытом канале ---------------------------------------------
const notifBefore = notifications.length;
ws.push({ t: 'msg', id: 3, room: 'obshiy', author: 'boris', text: 'ещё раз', ts: Date.now(), authorProfile: { displayName: 'Борис' } });
await new Promise((r) => setTimeout(r, 30));
check('новое сообщение в открытом канале дорисовано', texts('#messages .msg .body').includes('ещё раз'));
check('о сообщении в своей комнате не уведомляем', notifications.length === notifBefore, 'notif=' + notifications.length);

// --- сообщение в другом канале: счётчик + уведомление ------------------------
// Окно не в фокусе — как будто человек свернул браузер.
doc.hasFocus = () => false;
ws.push({ t: 'msg', id: 4, room: 'games', author: 'vera', text: 'го играть', ts: Date.now(), authorProfile: { displayName: 'Вера' } });
await new Promise((r) => setTimeout(r, 30));
const badge = [...doc.querySelectorAll('#channels .chan')].find((b) => b.textContent.includes('games'));
check('счётчик непрочитанных у канала', !!badge && badge.querySelector('.badge') && badge.querySelector('.badge').textContent === '1',
  badge ? badge.textContent : 'нет кнопки');
check('в заголовке вкладки счётчик', /^\(1\)/.test(doc.title), doc.title);
check('уведомление о сообщении в другом канале', notifications.length === notifBefore + 1, 'notif=' + notifications.length + ' ' + JSON.stringify(notifications.slice(-1)));
check('уведомление содержит автора и текст', notifications.at(-1) && noticesHas('Вера', 'го играть'), JSON.stringify(notifications.at(-1)));
function noticesHas(a, b) {
  const n = notifications.at(-1) || {};
  return (String(n.title) + ' ' + String(n.body)).includes(a) && String(n.body).includes(b);
}

// --- окно в фокусе: всплывашек нет, только звук и счётчик --------------------
doc.hasFocus = () => true;
const notifFocused = notifications.length;
ws.push({ t: 'msg', id: 41, room: 'games', author: 'vera', text: 'и ещё', ts: Date.now(), authorProfile: { displayName: 'Вера' } });
await new Promise((r) => setTimeout(r, 30));
check('при активном окне система не всплывает', notifications.length === notifFocused, 'notif=' + notifications.length);
check('счётчик всё равно растёт', (badgeOf('games') || '').includes('2'), badgeOf('games'));
doc.hasFocus = () => false;
function badgeOf(name) {
  const b = [...doc.querySelectorAll('#channels .chan')].find((x) => x.textContent.includes(name));
  const badge = b && b.querySelector('.badge');
  return badge ? badge.textContent : '';
}

// --- «печатает…» --------------------------------------------------------------
const typersBefore = ws.sent.filter((m) => m.t === 'typing').length;
ws.push({ t: 'typing', room: 'obshiy', name: 'boris', displayName: 'Борис' });
await new Promise((r) => setTimeout(r, 30));
check('видно «печатает…»', ($('#typing').textContent || '').includes('печатает'), $('#typing') && $('#typing').textContent);
ws.push({ t: 'typing', room: 'obshiy', name: 'boris', stopped: true });
await new Promise((r) => setTimeout(r, 30));
check('«печатает…» гаснет', !($('#typing').textContent || '').includes('печатает'), $('#typing') && $('#typing').textContent);
check('своё «печатает» не отправлялось само', ws.sent.filter((m) => m.t === 'typing').length === typersBefore);

// --- смена открытого канала ---------------------------------------------------
doc.querySelectorAll('#channels .chan')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 30));
check('клик по каналу открывает его', ws.sent.some((m) => m.t === 'join' && m.room === 'games'), JSON.stringify(ws.sent.slice(-2)));
check('непрочитанное сбрасывается при открытии', ![...doc.querySelectorAll('#channels .chan')][1].querySelector('.badge'),
  [...doc.querySelectorAll('#channels .chan')][1].textContent);

// --- диалог удаления сообщения ------------------------------------------------
ws.push({ t: 'msg', id: 5, room: 'games', author: 'anna', text: 'моё', ts: Date.now(), authorProfile: { displayName: 'Анна' } });
await new Promise((r) => setTimeout(r, 30));
const delBtn = doc.querySelector('#messages .del-msg');
check('кнопка удаления у своего сообщения появилась', !!delBtn);
if (delBtn) {
  delBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  const okBtn = [...doc.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Удалить').pop();
  check('диалог удаления открылся', !!okBtn);
  if (okBtn) {
    okBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    check('клиент попросил удалить сообщение', ws.sent.some((m) => m.t === 'msg_delete' && m.id === 5), JSON.stringify(ws.sent.slice(-2)));
  }
}

// --- удаление прилетело обратно ----------------------------------------------
ws.push({ t: 'msg_delete', room: 'games', id: 5 });
await new Promise((r) => setTimeout(r, 30));
check('сообщение исчезло после удаления', !texts('#messages .msg .body').includes('моё'), texts('#messages .msg .body').join('|'));

// --- профиль другого человека обновился --------------------------------------
ws.push({ t: 'profile_changed', name: 'boris', profile: { displayName: 'Борис Новый', avatarUrl: '' } });
await new Promise((r) => setTimeout(r, 30));
check('новое имя друга применилось', texts('#friendList .nm').join('|').includes('Борис Новый'), texts('#friendList .nm').join('|'));

// --- выход -------------------------------------------------------------------
ws.push({ t: 'logged_out' });
await new Promise((r) => setTimeout(r, 30));
check('после logout показан вход', !$('#auth').classList.contains('hidden'));
check('токен стёрт', !window.localStorage.getItem('token'), window.localStorage.getItem('token'));

console.log('\n--- отправленные клиентом сообщения ---');
console.log(ws.sent.map((m) => m.t + (m.room ? '(' + m.room + ')' : '')).join(', '));
console.log('\nпроблем: ' + problems.length);
if (problems.length) {
  for (const p of problems) console.log(' - ' + p);
  process.exitCode = 1;
}
dom.window.close();
