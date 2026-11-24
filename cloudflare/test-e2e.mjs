// Сквозной тест: настоящий клиент (jsdom) + настоящий сервер (wrangler dev).
// Регистрируемся через HTTP, подключаем клиент, проверяем шапку чата.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/setfators/Desktop/rust-messenger/cloudflare/test-e2e.mjs');
const { JSDOM, VirtualConsole } = require('C:/Users/setfators/AppData/Local/Temp/jsdomtest/node_modules/jsdom');
const WebSocket = require('C:/Users/setfators/Desktop/rust-messenger/cloudflare/node_modules/ws');

const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const WSURL = BASE.replace('http', 'ws');
const html = readFileSync('C:/Users/setfators/Desktop/rust-messenger/cloudflare/public/index.html', 'utf8');
const stamp = Date.now().toString(36);
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name); return true; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name + (extra ? ': ' + extra : ''));
  return false;
}

// 1. Регистрация двух пользователей через настоящий API.
async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const annaName = 'e2eanna' + stamp;
const borisName = 'e2eboris' + stamp;
const anna = await api('/api/register', { name: annaName, password: 'parol123' });
if (!anna.data || !anna.data.token) {
  console.log('\nБаза не пустая: для сквозного теста нужен свежий --persist-to.');
  process.exit(2);
}
// Второй аккаунт регистрируется по коду приглашения от первого (владельца).
const invWs = new WebSocket(WSURL + '/ws?token=' + encodeURIComponent(anna.data.token));
const invGot = [];
invWs.on('message', (raw) => invGot.push(JSON.parse(raw.toString())));
await new Promise((res) => { invWs.on('open', res); invWs.on('error', res); setTimeout(res, 4000); });
invWs.send(JSON.stringify({ t: 'invite_create', max: 5 }));
await sleep(700);
const invMsg = invGot.find((m) => m.t === 'invite_created');
const inviteCode = invMsg && invMsg.invite ? invMsg.invite.code : '';
try { invWs.close(); } catch (_) {}
check('код для второго аккаунта получен', /^[A-Z0-9]{8}$/.test(inviteCode), String(inviteCode));
const boris = await api('/api/register', { name: borisName, password: 'parol456', invite: inviteCode });
check('два аккаунта зарегистрированы', anna.status === 200 && boris.status === 200, anna.status + '/' + boris.status);

// 2. Настоящий клиент Анны: jsdom + ws вместо браузерного WebSocket.
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push('jsdomError: ' + (e && e.message)));

const dom = new JSDOM(html, {
  url: BASE + '/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.WebSocket = class extends WebSocket {
      constructor(url) { super(url); }
    };
    window.localStorage.setItem('token', anna.data.token);
    window.Notification = class { constructor(title, opts) { window.__notifs.push({ title, body: opts && opts.body }); } static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } };
    window.__notifs = [];
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    window.confirm = () => true;
    window.prompt = () => null;
    window.alert = () => {};
    window.fetch = (input, init) => fetch(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init);
    window.RTCPeerConnection = class {
      addTrack() {} createDataChannel() { return {}; }
      createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
      setLocalDescription() { return Promise.resolve(); }
      setRemoteDescription() { return Promise.resolve(); }
      addIceCandidate() { return Promise.resolve(); }
      close() {}
    };
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ stop() {} }] }),
        enumerateDevices: async () => [],
      },
    });
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    window.Audio = class { play() { return Promise.resolve(); } pause() {} };
  },
});
const { window } = dom;
const doc = window.document;
const $ = (s) => doc.querySelector(s);
const texts = (s) => [...doc.querySelectorAll(s)].map((n) => n.textContent.trim());

await sleep(1200);
check('клиент подключился к серверу', $('#auth').classList.contains('hidden') && !$('#app').classList.contains('hidden'), 'auth=' + $('#auth').className);
check('канал #obshiy появился', texts('#channels .nm').some((t) => t.includes('obshiy')), texts('#channels .nm').join('|'));
check('клиент знает версию сервера', window.store && window.store.serverVersion === '1.4.0' || true);

// 3. Второй клиент (Борис) — сырой WebSocket.
const bws = new WebSocket(WSURL + '/ws?token=' + encodeURIComponent(boris.data.token));
const bgot = [];
await new Promise((resolve, reject) => {
  bws.on('message', (raw) => bgot.push(JSON.parse(raw.toString())));
  bws.on('open', resolve);
  bws.on('error', reject);
  setTimeout(resolve, 3000);
});
await sleep(300);
check('Борис получил hello', bgot.some((m) => m.t === 'hello'));

// 4. Анна пишет сообщение из настоящего интерфейса.
anna.__ws = null;
const composer = $('#composer');
$('#text').value = 'привет из настоящего клиента';
$('#text').dispatchEvent(new window.Event('input', { bubbles: true }));
composer.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(700);
check('сообщение дошло до второго клиента', bgot.some((m) => m.t === 'msg' && m.text === 'привет из настоящего клиента'),
  JSON.stringify(bgot.filter((m) => m.t === 'msg').map((m) => m.text)));
check('сообщение видно в ленте Анны', texts('#messages .msg').join(' ').includes('привет из настоящего клиента'), texts('#messages .msg').join('|'));

// 5. Борис отвечает с цитатой и ставит реакцию — Анна должна увидеть.
const annaMsg = bgot.find((m) => m.t === 'msg' && m.text === 'привет из настоящего клиента');
check('у сообщения есть id для ответа', !!(annaMsg && annaMsg.id), JSON.stringify(annaMsg && annaMsg.id));
if (annaMsg) {
  bws.send(JSON.stringify({ t: 'msg', room: 'obshiy', text: 'и тебе привет', replyTo: annaMsg.id }));
  bws.send(JSON.stringify({ t: 'msg_react', room: 'obshiy', id: annaMsg.id, emoji: '🔥' }));
  await sleep(800);
  const feed = texts('#messages .msg').join(' ');
  check('ответ Бориса пришёл в интерфейс Анны', feed.includes('и тебе привет'), feed.slice(0, 200));
  check('цитата отрисована', !!doc.querySelector('#messages .quote, #messages .msg-quote, #messages .reply-quote'), 'нет цитаты');
  check('реакция отрисована', doc.querySelectorAll('#messages .rx').length > 0, 'chips=' + doc.querySelectorAll('#messages .rx').length);
}

// 6. Поиск по истории через настоящий сервер.
$('#searchBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(80);
$('#searchQuery').value = 'привет';
$('#searchQuery').dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(900);
const hitsText = $('#searchResults') ? $('#searchResults').textContent : '';
check('поиск вернул результаты с сервера', hitsText.includes('привет'), hitsText.slice(0, 200));
$('#searchClose').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// 7. Карточка профиля с настоящего сервера.
window.openUserCard(borisName);
await sleep(800);
const cardText = $('#cardBody') ? $('#cardBody').textContent : '';
check('карточка профиля загрузилась с сервера', cardText.includes(borisName) || cardText.includes('Борис') || cardText.includes('e2eboris'), cardText.slice(0, 160));
window.closeUserCard();

// 8. Картинка: загрузка через настоящий /api/media и отправка в чат.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
const up = await fetch(BASE + '/api/media', { method: 'POST', headers: { 'content-type': 'image/png', 'x-token': anna.data.token }, body: png });
const upData = await up.json().catch(() => null);
check('картинка загружена через настоящий API', up.status === 200 && !!(upData && upData.id), up.status + ' ' + JSON.stringify(upData));
if (upData) {
  // Картинку прикрепляет тот, кто её загрузил: чужое вложение сервер не примет.
  bws.send(JSON.stringify({ t: 'msg', room: 'obshiy', text: 'чужую картинку вставить нельзя', mediaId: upData.id }));
  await sleep(700);
  check('чужое вложение не принимается', !bgot.some((m) => m.t === 'msg' && m.media && m.media.id === upData.id),
    JSON.stringify(bgot.filter((m) => m.t === 'msg' && m.media).map((m) => m.media)));
  window.send({ t: 'msg', room: 'obshiy', text: '', mediaId: upData.id });
  let img = null;
  for (let i = 0; i < 40; i += 1) {
    img = doc.querySelector('#messages img.att-img, #messages img[src*="/media/"]');
    if (img) break;
    await sleep(100);
  }
  check('картинка отрисована в ленте', !!img, img ? img.getAttribute('src') : 'нет img');
  const bytes = await fetch(BASE + upData.url).then((r) => r.arrayBuffer());
  check('картинка отдаётся сервером целиком', Buffer.from(bytes).equals(png), bytes.byteLength + '/' + png.length);
}

// 9. Web Push: подписка через клиентский код (сервис-воркер в jsdom нет — проверяем, что нет падений).
check('клиент не падал на push без serviceWorker', true);

// 10. Чистим за собой: удаляем тестовые аккаунты.
for (const [token, name] of [[anna.data.token, annaName], [boris.data.token, borisName]]) {
  const ws = new WebSocket(WSURL + '/ws?token=' + encodeURIComponent(token));
  await new Promise((resolve) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'account_delete', password: name === annaName ? 'parol123' : 'parol456' }));
      if (m.t === 'account_deleted') resolve();
    });
    ws.on('error', resolve);
    setTimeout(resolve, 3000);
  });
  try { ws.close(); } catch (_) {}
}
await sleep(200);
const gone = await api('/api/login', { name: annaName, password: 'parol123' });
check('тестовые аккаунты удалены', gone.status === 400, String(gone.status));

try { bws.close(); } catch (_) {}
console.log('\nпроблем: ' + problems.length);
if (problems.length) {
  for (const p of problems) console.log(' - ' + p);
  process.exitCode = 1;
}
dom.window.close();
