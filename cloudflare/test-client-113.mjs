// Смоук-тест клиента 1.13.0: разметка, опросы, закреплённые, ветки, эмодзи,
// звуковая панель, категории, участники, пересылка, фильтры поиска, команды.
import { readFileSync } from 'node:fs';
import { CLIENT_HTML, loadJsdom } from './test-helpers.mjs';

const { JSDOM, VirtualConsole } = loadJsdom();
const html = readFileSync(CLIENT_HTML, 'utf8');
const problems = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push('jsdomError: ' + (e && e.message)));
vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));

const sockets = [];
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose({}); }
  open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  push(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}

const dom = new JSDOM(html, {
  url: 'https://example.test/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.WebSocket = FakeWS;
    window.localStorage.setItem('token', 'tok123');
    window.Notification = class {
      constructor() {}
      static permission = 'granted';
      static requestPermission() { return Promise.resolve('granted'); }
    };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    window.confirm = () => true;
    window.prompt = () => null;
    window.alert = () => {};
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    window.RTCPeerConnection = class {
      constructor() { this.connectionState = 'new'; }
      addTrack() {} createDataChannel() { return {}; }
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
    window.Audio = class { play() { return Promise.resolve(); } pause() {} };
  },
});

const { window } = dom;
const doc = window.document;
const $ = (sel) => doc.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name); return true; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name + (extra ? ': ' + extra : ''));
  return false;
}
function click(node) {
  if (!node) return;
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const me = { name: 'anna', color: '#6d6afc', profile: { displayName: 'Анна', avatarUrl: '' }, status: 'online', settings: { status: 'online' } };
const channel = {
  room: 'obshiy', title: 'Добро пожаловать', owner: 'anna', ownerKey: 'anna', mine: true,
  count: 2, topic: 'Главный канал', slow: 0,
  members: [
    { name: 'anna', displayName: 'Анна', online: true, color: '#6d6afc' },
    { name: 'boris', displayName: 'Борис', online: true, color: '#3ba55d' },
  ],
};
const now = Date.now();

await sleep(150);
const ws = sockets[0];
check('клиент 1.13.0 загрузился', window.eval('APP_VERSION') === '1.13.0', window.eval('APP_VERSION'));
ws.open();
ws.push({
  t: 'hello', version: '1.13.0', pushKey: '',
  me, isOwner: true, isStaff: true, role: 'owner', inviteOnly: true,
  channels: ['obshiy'], channelItems: [channel],
  settings: { status: 'online' },
});
ws.push({ t: 'dm_list', items: [{ room: 'dm:anna|boris', name: 'boris', displayName: 'Борис', last_text: 'привет', last_ts: now }] });
ws.push({ t: 'friends', friends: [{ name: 'boris', displayName: 'Борис', status: 'online', online: true }], incoming: [], outgoing: [] });
ws.push({ t: 'presence', online: ['anna', 'boris'], statuses: { boris: 'online' } });
ws.push({ t: 'sticker_pack', items: [] });
ws.push({ t: 'emoji_pack', items: [{ id: 'e1', name: 'cat', by: 'anna', v: 1, url: '/emoji/e1?v=1' }] });
ws.push({ t: 'sound_pack', items: [{ id: 's1', name: 'барабан', by: 'anna', v: 1, url: '/sound/s1?v=1' }] });
ws.push({ t: 'cats', items: [{ id: 'c1', name: 'Работа' }], map: { obshiy: 'c1' } });
ws.push({
  t: 'history', room: 'obshiy', messages: [
    { id: 1, room: 'obshiy', author: 'boris', text: 'привет **жирный**', ts: now - 60000, authorProfile: { displayName: 'Борис' } },
    { id: 2, room: 'obshiy', author: 'boris', text: 'тут ||секрет|| спрятан', ts: now - 59000, authorProfile: { displayName: 'Борис' } },
    { id: 3, room: 'obshiy', author: 'boris', text: 'мой :cat: эмодзи', ts: now - 58000, authorProfile: { displayName: 'Борис' } },
    { id: 4, room: 'obshiy', author: 'anna', text: 'Когда собираемся?', ts: now - 57000, authorProfile: { displayName: 'Анна' },
      poll: { question: 'Когда собираемся?', options: [{ id: '1', text: 'Сегодня' }, { id: '2', text: 'Завтра' }], votes: { '1': ['boris'] }, multiple: false, closed: false } },
    { id: 5, room: 'obshiy', author: 'anna', text: 'Пересылаю', ts: now - 56000, authorProfile: { displayName: 'Анна' }, fwd: { author: 'boris', text: 'исходный текст', ts: now - 70000 } },
    { id: 6, room: 'obshiy', author: 'boris', text: 'смотри https://youtu.be/dQw4w9WgXcQ', ts: now - 55000, authorProfile: { displayName: 'Борис' } },
  ],
});
ws.push({ t: 'pins', room: 'obshiy', items: [{ id: 1, author: 'boris', text: 'привет **жирный**', ts: now - 60000 }] });
await sleep(120);

// --- разметка ---------------------------------------------------------------
check('жирный текст отрисован', !!$('#messages strong'), (doc.body.textContent || '').slice(0, 100));
check('имя автора на месте', !!$('#messages .who'), 'нет .who');
const spoiler = $('#messages .md-spoiler');
check('спойлер создан', !!spoiler && spoiler.textContent.includes('секрет'), spoiler ? spoiler.className : 'нет');
if (spoiler) {
  click(spoiler);
  await sleep(30);
  check('спойлер открывается кликом', spoiler.classList.contains('open'), spoiler.className);
}
const customEmoji = $('#messages img.md-emoji');
check('свой эмодзи стал картинкой', !!customEmoji && customEmoji.getAttribute('src').includes('/emoji/e1'), customEmoji && customEmoji.getAttribute('src'));

// --- опрос ------------------------------------------------------------------
const poll = $('#messages .poll');
check('опрос отрисован', !!poll && poll.textContent.includes('Сегодня'), poll ? poll.textContent.slice(0, 60) : 'нет');
const pollOptions = [...doc.querySelectorAll('#messages .poll-opt')];
check('варианты опроса кликабельны', pollOptions.length === 2, 'options=' + pollOptions.length);
if (pollOptions.length) {
  click(pollOptions[1]);
  await sleep(30);
  const vote = ws.sent.filter((m) => m.t === 'poll_vote').pop();
  check('голос уходит на сервер', !!vote && vote.option === '2' && vote.id === 4, JSON.stringify(vote));
}
ws.push({ t: 'msg_poll', room: 'obshiy', id: 4, poll: { question: 'Когда собираемся?', options: [{ id: '1', text: 'Сегодня' }, { id: '2', text: 'Завтра' }], votes: { '1': ['boris'], '2': ['anna'] }, multiple: false, closed: true } });
await sleep(30);
check('опрос обновляется живьём', ($('#messages .poll-meta') || {}).textContent.includes('закрыт'), ($('#messages .poll-meta') || {}).textContent);

// --- пересылка и карточка ссылки -------------------------------------------
check('карточка пересылки есть', !!$('#messages .fwd-card'), 'нет .fwd-card');
check('карточка YouTube есть', !!$('#messages .embed.em-video'), 'нет эмбеда');
check('в карточке ссылки есть превью', !!$('#messages .embed.em-video img'), 'нет картинки');

// --- закреплённые -----------------------------------------------------------
const pinsBtn = $('#pinsBtn');
check('кнопка закреплённых видна и со счётчиком', !!pinsBtn && !pinsBtn.classList.contains('hidden') && pinsBtn.textContent.includes('1'), pinsBtn ? pinsBtn.textContent : 'нет');
click(pinsBtn);
await sleep(40);
check('панель закреплённых открылась', !$('#pinsPane').classList.contains('hidden'));
check('закреплённое сообщение в списке', !!$('#pinsList .pin-item'), 'нет элемента');
const pinsClose = $('#pinsClose');
click(pinsClose);

// --- категории и участники --------------------------------------------------
check('категория канала видна', !!$('#channels .cat-head') && $('#channels .cat-head').textContent.includes('Работа'), ($('#channels .cat-head') || {}).textContent);
const membersBtn = $('#membersBtn');
click(membersBtn);
await sleep(40);
check('список участников открылся', !$('#membersPane').classList.contains('hidden'));
const memberRows = [...doc.querySelectorAll('#memList .mem-row')];
check('в списке оба участника', memberRows.length === 2, 'rows=' + memberRows.length);
check('создатель помечен', memberRows.some((r) => r.textContent.includes('создатель')), memberRows.map((r) => r.textContent).join('|'));
click($('#membersClose'));

// --- эмодзи и звуки в панелях ----------------------------------------------
click($('#emojiBtn'));
await sleep(30);
check('вкладка набора канала есть', !!doc.querySelector('.ep-tab[data-ep="server"]'), 'нет вкладки');
click(doc.querySelector('.ep-tab[data-ep="server"]'));
await sleep(30);
check('свой эмодзи в панели', !!$('#epServer .ep-server-item'), 'нет эмодзи');
click($('#emojiClose'));

// --- голос: звуковая панель и оглушение ------------------------------------
await window.joinVoice('obshiy');
await sleep(60);
ws.push({ t: 'voice_state', room: 'obshiy', limit: 8, users: [{ name: 'anna', muted: false, deaf: false }, { name: 'boris', muted: false, deaf: false }] });
await sleep(40);
const soundBtn = $('#soundBtn');
click(soundBtn);
await sleep(30);
check('звуковая панель открылась', !$('#soundPop').classList.contains('hidden'));
const gridButtons = [...doc.querySelectorAll('#soundGrid .sound-btn')];
check('в панели встроенные и свои звуки', gridButtons.length >= 9, 'buttons=' + gridButtons.length);
click(gridButtons[0]);
await sleep(30);
const soundSent = ws.sent.filter((m) => m.t === 'soundboard_play').pop();
check('звук уходит в голосовой канал', !!soundSent && !!soundSent.key, JSON.stringify(soundSent));
const deafen = $('#deafenBtn');
click(deafen);
await sleep(30);
const deafSent = ws.sent.filter((m) => m.t === 'voice_deafen').pop();
check('оглушение уходит на сервер', !!deafSent && deafSent.deaf === true, JSON.stringify(deafSent));
check('кнопка оглушения показывает состояние', deafen.textContent === '🔕', deafen.textContent);
ws.push({ t: 'sound_play', room: 'obshiy', by: 'boris', key: 'boing', id: '', name: 'boing', url: '' });
await sleep(30);
check('звук другого показан подсказкой', (($('#toast') || {}).textContent || '').includes('Борис'), ($('#toast') || {}).textContent);

// --- команды ----------------------------------------------------------------
const input = $('#text');
input.value = '/roll 2d6';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(30);
const rollMsg = ws.sent.filter((m) => m.t === 'msg').pop();
check('команда /roll отправила бросок', !!rollMsg && rollMsg.text.includes('🎲') && rollMsg.text.includes('2d6'), JSON.stringify(rollMsg));
input.value = '/poll Что дальше?';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(30);
check('команда /poll открыла диалог', !$('#pollBack').classList.contains('hidden'));
$('#pollQ').value = 'Что дальше?';
const pollInputs = [...doc.querySelectorAll('#pollOpts input')];
pollInputs[0].value = 'Отдыхать';
pollInputs[1].value = 'Работать';
click($('#pollGo'));
await sleep(30);
const pollSent = ws.sent.filter((m) => m.t === 'poll_create').pop();
check('опрос уходит на сервер', !!pollSent && pollSent.options.length === 2, JSON.stringify(pollSent));

// --- ветка ------------------------------------------------------------------
const firstRow = doc.querySelector('#messages .msg[data-id="1"]');
click(firstRow.querySelector('.thread-btn'));
await sleep(40);
check('ветка открылась', !$('#threadPane').classList.contains('hidden'));
$('#threadText').value = 'ответ в ветке';
$('#threadForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(30);
const threadMsg = ws.sent.filter((m) => m.t === 'msg').pop();
check('ответ в ветке уходит с replyTo', !!threadMsg && threadMsg.replyTo === 1 && threadMsg.text === 'ответ в ветке', JSON.stringify(threadMsg));
ws.push({ t: 'msg', id: 20, room: 'obshiy', author: 'anna', text: 'ответ в ветке', ts: Date.now(), authorProfile: { displayName: 'Анна' }, reply: { id: 1, author: 'boris', text: 'привет' } });
await sleep(40);
check('ответ появился в ветке', [...doc.querySelectorAll('#threadList .msg')].length >= 2, 'rows=' + doc.querySelectorAll('#threadList .msg').length);
click($('#threadClose'));

// --- пересылка --------------------------------------------------------------
const secondRow = doc.querySelector('#messages .msg[data-id="6"]');
click(secondRow.querySelector('.fwd-btn'));
await sleep(40);
check('окно пересылки открылось', !$('#fwdBack').classList.contains('hidden'));
const fwdTargets = [...doc.querySelectorAll('#fwdList .fwd-item')];
check('в пересылке есть куда отправить', fwdTargets.length >= 1, 'targets=' + fwdTargets.length);
if (fwdTargets.length) {
  click(fwdTargets[0]);
  await sleep(30);
  const fwdSent = ws.sent.filter((m) => m.t === 'msg_forward').pop();
  check('пересылка уходит на сервер', !!fwdSent && fwdSent.id === 6, JSON.stringify(fwdSent));
}

// --- медленный режим --------------------------------------------------------
ws.push({ t: 'slow_wait', room: 'obshiy', left: 5 });
await sleep(30);
check('медленный режим показан у поля ввода', (($('#composerHint') || {}).textContent || '').includes('Медленный'), ($('#composerHint') || {}).textContent);
check('кнопка отправки заблокирована', !!$('#composer .send-btn') && $('#composer .send-btn').disabled, 'не заблокирована');

// --- черновик ---------------------------------------------------------------
ws.push({ t: 'slow_wait', room: 'obshiy', left: 0 });
await sleep(30);
input.value = 'недописанный черновик';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(350);
check('черновик сохраняется', (window.localStorage.getItem('arc-draft:obshiy') || '').includes('недописанный'), window.localStorage.getItem('arc-draft:obshiy'));
input.value = '';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(350);

// --- поиск с фильтрами ------------------------------------------------------
click($('#searchBtn'));
await sleep(30);
const sq = $('#searchQuery');
sq.value = 'привет от:борис';
sq.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(450);
const searchSent = ws.sent.filter((m) => m.t === 'search_messages').pop();
check('фильтр «от:» уходит на сервер', !!searchSent && searchSent.from === 'борис' && searchSent.q === 'привет', JSON.stringify(searchSent));
ws.push({ t: 'search_results', q: 'привет', hits: [{ room: 'obshiy', id: 1, author: 'boris', text: 'привет **жирный**', ts: now - 60000 }] });
await sleep(40);
check('результат поиска отрисован', !!$('#searchResults .hit'), 'нет результата');
click($('#searchClose'));

// --- справка и журнал -------------------------------------------------------
doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }));
await sleep(30);
check('Ctrl+/ открывает справку', !$('#helpBack').classList.contains('hidden'));
click($('#helpClose'));
await window.openSettings('audit');
await sleep(30);
check('вкладка журнала открывается', !!$('#auditList'), 'нет списка');
ws.push({ t: 'audit', items: [{ id: 'a1', ts: now, actor: 'anna', action: 'channel_create', target: 'Добро пожаловать', detail: '' }] });
await sleep(30);
check('запись журнала отрисована', !!$('#auditList .audit-row'), 'нет записи');

check('в консоли нет ошибок', problems.filter((p) => p.startsWith('jsdomError') || p.startsWith('console.error')).length === 0, JSON.stringify(problems.slice(0, 4)));

console.log('\nпроверок: ' + (problems.length ? 'есть проблемы' : 'все пройдены') + ', проблем: ' + problems.length);
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
process.exit(0);
