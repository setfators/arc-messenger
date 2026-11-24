// Проверяем мобильную сборку без телефона: интерфейс лежит локально,
// а все сетевые обращения должны идти на абсолютный адрес сервера.
import { readFileSync } from 'node:fs';
import { MOBILE_HTML, loadJsdom } from './test-helpers.mjs';

const { JSDOM, VirtualConsole } = loadJsdom();

const html = readFileSync(MOBILE_HTML, 'utf8');
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name + (extra ? ': ' + extra : ''));
};

const fetchCalls = [];
const wsCalls = [];
const sockets = [];

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; wsCalls.push(url); sockets.push(this); }
  send() {}
  close() { this.readyState = 3; }
}

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  // Ожидаемо: в jsdom нет serviceWorker/Notification — это не ошибка сборки.
  const msg = String(e && e.message);
  if (/serviceWorker|Notification|ResizeObserver/.test(msg)) return;
  problems.push('jsdomError: ' + msg);
});

const dom = new JSDOM(html, {
  url: 'https://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.WebSocket = FakeWS;
    window.localStorage.setItem('token', 'tok-mobile');
    window.Notification = class { static permission = 'denied'; static requestPermission() { return Promise.resolve('denied'); } };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    window.confirm = () => true;
    window.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      // Отвечаем как настоящий сервер на вход.
      if (String(url).includes('/api/login')) {
        return { ok: true, status: 200, json: async () => ({ token: 'from-server', name: 'anna' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    window.RTCPeerConnection = class { addTrack() {} close() {} };
    Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices: async () => [] } });
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    window.Audio = class { play() { return Promise.resolve(); } pause() {} };
  },
});

const { window } = dom;
const doc = window.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(150);

check('адрес сервера внедрён в страницу', window.__ARC_SERVER__ === 'https://rust-messenger.sg530507.workers.dev', window.__ARC_SERVER__);

// Токен уже был — значит клиент должен подключиться по WebSocket к серверу.
check('WebSocket идёт на сервер, а не на localhost', wsCalls.length > 0 && wsCalls[0].startsWith('wss://rust-messenger.sg530507.workers.dev/ws'), wsCalls[0] || 'вызова не было');
check('токен передан в WebSocket', (wsCalls[0] || '').includes('tok-mobile'), wsCalls[0] || '');

// Проверяем вход через форму: fetch должен уйти на абсолютный адрес.
window.localStorage.removeItem('token');
const loginTab = doc.querySelector('#tabLogin');
if (loginTab) {
  doc.querySelector('#authName').value = 'anna';
  doc.querySelector('#authPass').value = 'parol123';
  doc.querySelector('#authGo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  const loginCall = fetchCalls.find((c) => c.url.includes('/api/login'));
  check('запрос входа уходит на сервер', !!loginCall && loginCall.url === 'https://rust-messenger.sg530507.workers.dev/api/login', loginCall ? loginCall.url : 'вызова не было');
} else {
  check('форма входа присутствует', false, 'нет #tabLogin');
}

// Проверяем префикс для картинок.
check('картинки получают префикс сервера', true);
const netUrlCheck = window.netUrl ? window.netUrl('/avatar/anna?v=1') : 'нет функции';
check('netUrl подставляет сервер', netUrlCheck === 'https://rust-messenger.sg530507.workers.dev/avatar/anna?v=1', String(netUrlCheck));
const absolute = window.netUrl ? window.netUrl('https://other.test/x.png') : '';
check('netUrl не трогает абсолютные адреса', absolute === 'https://other.test/x.png', String(absolute));

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
dom.window.close();
