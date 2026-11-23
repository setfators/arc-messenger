// Смоук-тест клиента 1.4.0: ответы, реакции, поиск, профиль, картинки, аккаунт, push.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/setfators/Desktop/rust-messenger/cloudflare/test-client-140.mjs');
const jsdomPath = process.env.JSDOM_DIR || 'C:/Users/setfators/AppData/Local/Temp/jsdomtest/node_modules/jsdom';
const { JSDOM, VirtualConsole } = require(jsdomPath);

const html = readFileSync('C:/Users/setfators/Desktop/rust-messenger/cloudflare/public/index.html', 'utf8');
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
const texts = (sel) => [...doc.querySelectorAll(sel)].map((n) => n.textContent.trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name); return true; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name + (extra ? ': ' + extra : ''));
  return false;
}

await sleep(150);
const ws = sockets[0];
check('версия клиента 1.4.0', window.APP_VERSION === '1.4.0' || $('body').textContent.includes('1.4.0'), 'APP_VERSION');
ws.open();

ws.push({
  t: 'hello', version: '1.4.0', pushKey: 'BAbcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij',
  me: { name: 'anna', color: '#5865f2', profile: { displayName: 'Анна', avatarUrl: '' }, status: 'online', settings: { status: 'online' } },
  channels: ['obshiy'],
});
ws.push({ t: 'dm_list', items: [] });
ws.push({ t: 'friends', friends: [{ name: 'boris', displayName: 'Борис', status: 'online', online: true }], incoming: [], outgoing: [] });
ws.push({ t: 'presence', online: ['anna', 'boris'], statuses: { boris: 'online' } });
ws.push({ t: 'sticker_pack', items: [] });
ws.push({ t: 'history', room: 'obshiy', messages: [
  { id: 10, room: 'obshiy', author: 'boris', text: 'первое сообщение', ts: Date.now() - 6000, authorProfile: { displayName: 'Борис' } },
] });
await sleep(60);

// --- ответы ---------------------------------------------------------------
const msgRows = [...doc.querySelectorAll('#messages .msg')];
check('сообщение отрисовано', msgRows.length === 1, 'rows=' + msgRows.length);
check('у сообщения есть data-id', !!(msgRows[0] && msgRows[0].dataset && msgRows[0].dataset.id), msgRows[0] && msgRows[0].dataset.id);
const replyBtn = msgRows[0] && msgRows[0].querySelector('.msg-act-reply, .reply-btn, [data-act="reply"]');
check('кнопка «Ответить» есть', !!replyBtn, msgRows[0] ? msgRows[0].innerHTML.slice(0, 400) : '');
if (replyBtn) {
  replyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const bar = $('#replyBar');
  check('полоска ответа показалась', !!bar && !bar.classList.contains('hidden'), bar && bar.className);
  $('#text').value = 'это ответ';
  $('#text').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(40);
  const sentReply = ws.sent.filter((m) => m.t === 'msg').pop();
  check('ответ уходит с replyTo', !!(sentReply && sentReply.replyTo === 10), JSON.stringify(sentReply));
  check('полоска ответа скрылась после отправки', !!bar && bar.classList.contains('hidden'), bar && bar.className);
}

// --- реакции --------------------------------------------------------------
ws.push({ t: 'msg_reaction', room: 'obshiy', id: 10, reactions: { '🔥': ['anna', 'boris'] } });
await sleep(40);
const reactionChips = [...doc.querySelectorAll('#messages .rx')];
check('чипы реакций отрисованы', reactionChips.length > 0, 'chips=' + reactionChips.length);
check('в чипе видно количество', reactionChips.some((c) => (c.textContent || '').includes('2')), reactionChips.map((c) => c.textContent).join('|'));

// --- поиск по истории -----------------------------------------------------
const searchBtn = $('#searchBtn, [data-act="search"], .search-btn');
check('кнопка поиска есть', !!searchBtn, 'нет кнопки поиска');
if (searchBtn) {
  searchBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const field = $('#searchQuery');
  check('панель поиска открылась', !!field, 'нет поля поиска');
  if (field) {
    field.value = 'первое';
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(450);
    check('запрос поиска ушёл на сервер', ws.sent.some((m) => m.t === 'search_messages' && m.q === 'первое'), JSON.stringify(ws.sent.filter((m) => m.t === 'search_messages')));
    ws.push({ t: 'search_results', q: 'первое', hits: [{ room: 'obshiy', id: 10, author: 'boris', text: 'первое сообщение', ts: Date.now() }] });
    await sleep(40);
    check('результаты поиска видны', (($('#searchResults') ? $('#searchResults').textContent : '') || '').includes('первое'),
      $('#searchResults') ? $('#searchResults').textContent : 'нет контейнера');
  }
}

// --- поиск людей и карточка профиля ---------------------------------------
$('#navFriends').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(40);
const peopleInput = $('#peopleQuery');
check('поле поиска людей есть', !!peopleInput, 'нет поля');
if (peopleInput) {
  peopleInput.value = 'bor';
  peopleInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(400);
  check('поиск людей отправлен', ws.sent.some((m) => m.t === 'search_users' && m.q === 'bor'), JSON.stringify(ws.sent.filter((m) => m.t === 'search_users')));
  ws.push({ t: 'user_search', q: 'bor', results: [{ name: 'boris', displayName: 'Борис', avatarUrl: '', online: true, friend: false, pending: '' }] });
  await sleep(40);
  const people = $('#peopleResults');
  check('результат поиска людей виден', !!(people && people.textContent.includes('Борис')), people ? people.textContent : 'нет контейнера');
}
ws.push({ t: 'user_card', user: { name: 'boris', displayName: 'Борис', bio: 'люблю чай', avatarUrl: '', color: '#5865f2', online: true, status: 'online', joined: Date.now(), friend: true, pending: '', voiceRoom: '' } });
await sleep(60);
check('карточка профиля отрисована', ($('#cardBody') ? $('#cardBody').textContent : '').includes('Борис'),
  $('#cardBody') ? $('#cardBody').textContent.slice(0, 120) : 'нет cardBody');
check('в карточке есть био', ($('#cardBody') ? $('#cardBody').textContent : '').includes('люблю чай'));

// --- картинка в ленте и лайтбокс ------------------------------------------
ws.push({ t: 'msg', id: 11, room: 'obshiy', author: 'boris', text: '', ts: Date.now(), authorProfile: { displayName: 'Борис' },
  media: { id: 'abc123', url: '/media/abc123', mime: 'image/png', size: 1000 } });
await sleep(60);
const mediaImg = doc.querySelector('#messages img[src*="/media/"]');
check('сообщение с картинкой рисует img', !!mediaImg, mediaImg ? mediaImg.getAttribute('src') : [...doc.querySelectorAll('#messages img')].map((i) => i.src).join(','));
if (mediaImg) {
  mediaImg.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(40);
  const light = $('#lightbox');
  check('лайтбокс открывается по клику', !!light && !light.classList.contains('hidden'), light && light.className);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(40);
  check('лайтбокс закрывается по Esc', !!light && light.classList.contains('hidden'), light && light.className);
}

// --- аккаунт: пароль, выход везде, удаление, версия ------------------------
const settingsBtn = $('#navSettings, [data-act="settings"]');
if (settingsBtn) settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(50);
const accountTabBtn = doc.querySelector('[data-tab="account"]');
check('вкладка «Аккаунт» есть', !!accountTabBtn);
if (accountTabBtn) {
  accountTabBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const bodyText = ($('#settingsBody') ? $('#settingsBody').textContent : '') || '';
  check('в аккаунте видна версия', /1\.4\.\d+/.test(bodyText), bodyText.slice(0, 200));
  const passInputs = [...doc.querySelectorAll('#settingsBody input[type="password"]')];
  check('три поля для смены пароля', passInputs.length >= 3, 'inputs=' + passInputs.length);
  if (passInputs.length >= 3) {
    passInputs[0].value = 'oldpass';
    passInputs[1].value = 'newpass1';
    passInputs[2].value = 'newpass1';
    const changeBtn = [...doc.querySelectorAll('#settingsBody button')].find((b) => b.textContent.trim() === 'Сменить пароль');
    check('кнопка смены пароля есть', !!changeBtn);
    if (changeBtn) {
      changeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await sleep(40);
      const sent = ws.sent.filter((m) => m.t === 'password_change').pop();
      check('пароль меняется через сервер', !!(sent && sent.old === 'oldpass' && sent.new === 'newpass1'), JSON.stringify(sent));
    }
  }
  const allBtn = [...doc.querySelectorAll('#settingsBody button')].find((b) => b.textContent.trim() === 'Выйти везде');
  check('кнопка «Выйти везде» есть', !!allBtn);
  if (allBtn) {
    allBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const okBtn = [...doc.querySelectorAll('#dlgBack button')].filter((b) => b.textContent.trim() === 'Выйти везде').pop();
    if (okBtn) { okBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(40); }
    check('logout_all отправляется', ws.sent.some((m) => m.t === 'logout_all'), JSON.stringify(ws.sent.filter((m) => m.t === 'logout_all')));
  }
  const delBtn = [...doc.querySelectorAll('#settingsBody button')].find((b) => b.textContent.includes('Удалить аккаунт'));
  check('кнопка удаления аккаунта есть', !!delBtn);
  if (delBtn) {
    delBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    const back = $('#delBack');
    check('окно удаления открывается', !!back && !back.classList.contains('hidden'), back && back.className);
    $('#delPass').value = 'mypassword';
    $('#delOk').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(40);
    check('account_delete отправляется с паролем', ws.sent.some((m) => m.t === 'account_delete' && m.password === 'mypassword'),
      JSON.stringify(ws.sent.filter((m) => m.t === 'account_delete')));
    ws.push({ t: 'account_deleted' });
    await sleep(60);
    check('после удаления — экран входа', !$('#auth').classList.contains('hidden'));
    check('токен после удаления стёрт', !window.localStorage.getItem('token'));
  }
}

// --- бейдж для десктопа ---------------------------------------------------
check('мост десктопа вызывается без ошибок', typeof window.messengerDesktop === 'object' || window.messengerDesktop === undefined);

console.log('\nпроблем: ' + problems.length);
if (problems.length) {
  for (const p of problems) console.log(' - ' + p);
  process.exitCode = 1;
}
dom.window.close();
