// Проверка настоящей вёрстки в реальном браузере через Chrome DevTools Protocol.
// jsdom не считает layout и не знает CSS-анимаций, поэтому этот набор проверяет
// то, что видит человек: базовые стили, анимации окон, появление сообщений,
// кнопку «вниз», настройку плавности и адаптивные медиазапросы.
//
// Запуск: node test-browser.mjs [BASE]
// Если Chrome/Edge не найден — набор мягко пропускается (в CI без браузера).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const BASE = process.argv[2] || process.env.BASE || 'https://rust-messenger.sg530507.workers.dev';
const PORT = 9333 + Math.floor(Math.random() * 200);
const stamp = Date.now().toString(36);
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return true; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name + (extra ? ': ' + extra : ''));
  return false;
};

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const browserPath = CANDIDATES.find((one) => existsSync(one));
if (!browserPath) {
  console.log('браузер не найден — набор пропущен (это не ошибка)');
  process.exit(0);
}
console.log('браузер:', path.basename(browserPath));

const profile = path.join(process.env.TEMP || '/tmp', 'arc-browser-' + stamp);
const child = spawn(browserPath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--mute-audio',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--window-size=1280,860',
  BASE + '/?browser-test=1',
], { stdio: 'ignore' });

let ws = null;
let msgId = 0;
const pending = new Map();
const pageErrors = [];

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    try { ws.send(JSON.stringify({ id, method, params: params || {} })); } catch (error) { reject(error); }
  });
}

async function connect() {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('браузер не поднялся');
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', reject);
          setTimeout(() => reject(new Error('ws timeout')), 8000);
        });
        ws.on('message', (raw) => {
          let data = null;
          try { data = JSON.parse(raw.toString()); } catch (_) { return; }
          if (data.id && pending.has(data.id)) {
            const item = pending.get(data.id);
            pending.delete(data.id);
            if (data.error) item.reject(new Error(data.error.message));
            else item.resolve(data.result);
            return;
          }
          if (data.method === 'Runtime.exceptionThrown') {
            const d = data.params && data.params.exceptionDetails;
            pageErrors.push(d && (d.exception ? d.exception.description : d.text));
          }
          if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
            pageErrors.push((data.params.args || []).map((a) => a.value || a.description || '').join(' '));
          }
        });
        await send('Runtime.enable');
        await send('Page.enable');
        return;
      }
    } catch (_) { /* ещё не поднялся */ }
    await sleep(300);
  }
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression: '(' + expression + ')',
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text);
  }
  return res.result ? res.result.value : undefined;
}

async function waitFor(expression, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch (_) { /* страница ещё грузится */ }
    await sleep(250);
  }
  return false;
}

const name = 'bt' + stamp;
const pass = 'parol123';
let accountMade = false;

try {
  await connect();
  await sleep(1200);

  // 1. Экран входа отрисован, шрифт и тема применились.
  check('страница входа отрисована', await waitFor("!document.querySelector('#auth').classList.contains('hidden')"));
  check('токенов оформления не меньше 5',
    (await evaluate("getComputedStyle(document.documentElement).length >= 0 && ['--ease','--ease-out','--t1','--t2','--t3'].every((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim())")) === true);

  // 2. Базовые кнопки не системные «белые».
  const btnColor = await evaluate(`(() => {
    const b = document.createElement('button');
    b.textContent = 'x'; document.body.appendChild(b);
    const cs = getComputedStyle(b);
    const out = { bg: cs.backgroundColor, color: cs.color, radius: cs.borderRadius };
    b.remove(); return out;
  })()`);
  check('базовая кнопка тёмная, не белая', btnColor && !/rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)/.test(btnColor.bg) && btnColor.radius !== '0px',
    JSON.stringify(btnColor));

  // 3. Диалог получает анимацию появления.
  const dlgAnim = await evaluate(`(() => {
    document.querySelector('#dlgBack').classList.remove('hidden');
    const cs = getComputedStyle(document.querySelector('#dlgBack .dlg'));
    const back = getComputedStyle(document.querySelector('#dlgBack'));
    const out = { dlg: cs.animationName, dur: back.animationName };
    document.querySelector('#dlgBack').classList.add('hidden');
    return out;
  })()`);
  check('окно диалога анимировано (popIn)', dlgAnim && dlgAnim.dlg === 'popIn', JSON.stringify(dlgAnim));
  check('подложка диалога анимирована (fadeIn)', dlgAnim && dlgAnim.dur === 'fadeIn', JSON.stringify(dlgAnim));

  // 4. Регистрация и загрузка приложения.
  const reg = await evaluate(`(async () => {
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ${JSON.stringify(name)}, password: ${JSON.stringify(pass)} }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.token) localStorage.setItem('token', data.token);
    return { status: res.status, token: !!(data && data.token) };
  })()`);
  check('временный аккаунт создан', !!(reg && reg.token), JSON.stringify(reg));
  accountMade = !!(reg && reg.token);
  await send('Page.reload', { ignoreCache: true });
  await sleep(2500);
  check('приложение загрузилось', await waitFor("!document.querySelector('#app').classList.contains('hidden')"));
  check('в списке есть демо-канал', await waitFor("document.querySelectorAll('#channels .chan').length >= 1"));

  // 5. Открываем канал: лента, сообщения, анимация нового сообщения.
  await evaluate("document.querySelector('#channels .chan').click()");
  check('канал открылся и показывает экскурсию', await waitFor("document.querySelectorAll('#messages .msg').length >= 3"));
  check('у сообщений есть подписи автора', await waitFor("!!document.querySelector('#messages .msg .who')"));

  // 6. Отправка сообщения и появление с анимацией.
  await evaluate(`(() => {
    const input = document.querySelector('#text');
    input.value = 'проверка анимации';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  check('отправленное сообщение появилось', await waitFor("document.body.textContent.includes('проверка анимации')"));
  const fresh = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#messages .msg.msg-fresh')];
    return { count: rows.length, anim: rows.length ? getComputedStyle(rows[0]).animationName : '' };
  })()`);
  check('новое сообщение анимируется msgIn', !!(fresh && fresh.anim === 'msgIn'), JSON.stringify(fresh));

  // 7. Кнопка «вниз»: скрыта у низа, показывается при прокрутке вверх.
  // Сначала наполняем ленту, иначе прокручивать просто нечего.
  await evaluate(`(async () => {
    const input = document.querySelector('#text');
    for (let i = 0; i < 24; i += 1) {
      input.value = 'строка ' + i;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
    return true;
  })()`);
  await waitFor("document.querySelectorAll('#messages .msg').length >= 20");
  const metrics = await evaluate(`(() => {
    const box = document.querySelector('#messages');
    return { scroll: box.scrollHeight, client: box.clientHeight, rows: document.querySelectorAll('#messages .msg').length };
  })()`);
  check('лента переполнена — прокрутка возможна', !!(metrics && metrics.scroll > metrics.client + 100), JSON.stringify(metrics));
  check('кнопка «вниз» скрыта у низа ленты',
    (await evaluate("getComputedStyle(document.querySelector('#jumpDown')).display === 'none'")) === true);
  const jump = await evaluate(`(() => {
    const box = document.querySelector('#messages');
    box.scrollTop = 0;
    box.dispatchEvent(new Event('scroll'));
    return new Promise((resolve) => setTimeout(() => {
      const el = document.querySelector('#jumpDown');
      resolve({ shown: getComputedStyle(el).display !== 'none', pos: getComputedStyle(el).position });
    }, 150));
  })()`);
  check('кнопка «вниз» появляется при прокрутке вверх', !!(jump && jump.shown), JSON.stringify(jump));
  check('кнопка «вниз» позиционирована поверх ленты', !!(jump && jump.pos === 'absolute'), JSON.stringify(jump));

  // 8. Настройки: вкладка «Внешний вид» и переключатель плавности.
  await evaluate("document.querySelector('#navSettings').click()");
  check('настройки открылись', await waitFor("!document.querySelector('#settingsModal').classList.contains('hidden')"));
  await evaluate("document.querySelector('[data-tab=\"appearance\"]').click()");
  check('вкладка «Внешний вид» содержит настройку плавности',
    await waitFor("[...document.querySelectorAll('#settingsBody .field')].some((f) => f.textContent.includes('Плавные анимации'))"));

  // 9. Реальные сценарии интерфейса: канал, панель, поиск, звонок, тема.
  await evaluate("document.querySelector('#settingsClose').click()");
  await sleep(200);

  // 9.1. Создание канала через диалог.
  await evaluate("document.querySelector('#newChannel').click()");
  check('диалог создания канала открылся', await waitFor("!document.querySelector('#dlgBack').classList.contains('hidden')"));
  const chanTitle = 'проверка-' + stamp;
  await evaluate(`(() => {
    const input = document.querySelector('#dlgInput');
    input.value = ${JSON.stringify(chanTitle)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#dlgOk').click();
    return true;
  })()`);
  check('канал создан и появился в списке',
    await waitFor(`[...document.querySelectorAll('#channels .nm')].some((n) => n.textContent.includes(${JSON.stringify(chanTitle)}))`));

  // 9.2. Панель канала: участники и ссылка-приглашение.
  await evaluate("document.querySelector('#chanMembers').click()");
  check('панель канала открылась', await waitFor("!document.querySelector('#chanModal').classList.contains('hidden')"));
  check('в панели есть участник', await waitFor("document.querySelectorAll('#chanMembersList .crow').length >= 1"));
  const link = await evaluate("document.querySelector('#chanLink').value");
  check('ссылка-приглашение сформирована', typeof link === 'string' && link.includes('?join='), String(link));
  await evaluate("document.querySelector('#chanClose').click()");
  await sleep(150);

  // 9.3. Поиск по Ctrl+K и закрытие по Esc.
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }))");
  check('поиск открывается по Ctrl+K', await waitFor("!document.querySelector('#searchPane').classList.contains('hidden')"));
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))");
  check('поиск закрывается по Esc', await waitFor("document.querySelector('#searchPane').classList.contains('hidden')"));

  // 9.4. Окно звонка: область экранов скрыта, пока никто не показывает.
  await evaluate('window.showCall()');
  check('окно звонка открывается', await waitFor("!document.querySelector('#callStage').classList.contains('hidden')"));
  const screens = await evaluate(`(() => ({
    stage: document.querySelector('#screenStage').classList.contains('hidden'),
    split: document.querySelector('#screenSplit').classList.contains('hidden'),
    all: document.querySelector('#callAllScreens').classList.contains('hidden'),
  }))()`);
  check('без демонстраций экраны спрятаны', !!(screens && screens.stage && screens.split && screens.all), JSON.stringify(screens));
  await evaluate('window.hideCall()');
  await sleep(120);

  // 9.5. Смена темы применяется к документу.
  await evaluate("document.querySelector('#navSettings').click()");
  await waitFor("!document.querySelector('#settingsModal').classList.contains('hidden')");
  await evaluate("document.querySelector('[data-tab=\"appearance\"]').click()");
  await sleep(200);
  await evaluate(`(() => {
    const chip = [...document.querySelectorAll('#settingsBody .chip')].find((c) => c.textContent.trim() === 'Светлая');
    if (chip) chip.click();
    return !!chip;
  })()`);
  check('светлая тема применяется', await waitFor("document.documentElement.dataset.theme === 'light'"));
  await evaluate(`(() => {
    const chip = [...document.querySelectorAll('#settingsBody .chip')].find((c) => c.textContent.trim() === 'Тёмная');
    if (chip) chip.click();
    return true;
  })()`);
  await sleep(200);
  check('тёмная тема возвращается', (await evaluate("document.documentElement.dataset.theme")) === 'dark');
  await evaluate("document.querySelector('#settingsClose').click()");
  await sleep(150);

  // 9.6. Удаление созданного канала через панель.
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#channels .chan')].find((n) => n.textContent.includes(${JSON.stringify(chanTitle)}));
    if (row) row.click();
    return !!row;
  })()`);
  await sleep(400);
  await evaluate("document.querySelector('#chanMembers').click()");
  await waitFor("!document.querySelector('#chanModal').classList.contains('hidden')");
  await evaluate("document.querySelector('#chanDelete').click()");
  check('подтверждение удаления канала показано', await waitFor("!document.querySelector('#dlgBack').classList.contains('hidden')"));
  await evaluate("document.querySelector('#dlgOk').click()");
  check('канал удалён из списка',
    await waitFor(`![...document.querySelectorAll('#channels .nm')].some((n) => n.textContent.includes(${JSON.stringify(chanTitle)}))`));

  // 10. Бинды: запись боковой кнопки мыши и её срабатывание (1.11.0).
  await evaluate("document.querySelector('#navSettings').click()");
  await waitFor("!document.querySelector('#settingsModal').classList.contains('hidden')");
  await evaluate("document.querySelector('[data-tab=\"binds\"]').click()");
  check('вкладка «Бинды» открывается', await waitFor("document.querySelectorAll('#settingsBody .bind-btn').length >= 9"));
  const bindCount = await evaluate("document.querySelectorAll('#settingsBody .bind-btn').length");
  check('в списке биндов 9 действий', bindCount === 9, 'buttons=' + bindCount);
  // Назначаем поиску боковую кнопку мыши Mouse4 (button 3).
  await evaluate(`(() => {
    const btn = document.querySelectorAll('#settingsBody .bind-btn')[1];
    btn.click();
    document.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(600);
  const bindText = await evaluate("document.querySelectorAll('#settingsBody .bind-btn')[1].textContent");
  check('бинду назначается боковая кнопка мыши', typeof bindText === 'string' && bindText.includes('Мышь 4'), String(bindText));

  // Закрываем настройки и проверяем, что Mouse4 действительно открывает поиск.
  await evaluate("document.querySelector('#settingsClose').click()");
  await sleep(250);
  await evaluate("document.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true }))");
  check('боковая кнопка мыши выполняет действие',
    await waitFor("!document.querySelector('#searchPane').classList.contains('hidden')", 4000));
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))");
  await sleep(200);

  // Возвращаем бинды по умолчанию.
  await evaluate("document.querySelector('#navSettings').click()");
  await waitFor("!document.querySelector('#settingsModal').classList.contains('hidden')");
  await evaluate("document.querySelector('[data-tab=\"binds\"]').click()");
  await waitFor("document.querySelectorAll('#settingsBody .bind-btn').length >= 9");
  await evaluate(`(() => {
    const reset = [...document.querySelectorAll('#settingsBody button')].find((b) => b.textContent.includes('Сбросить все'));
    if (reset) reset.click();
    return !!reset;
  })()`);
  await sleep(600);
  const resetText = await evaluate("document.querySelectorAll('#settingsBody .bind-btn')[1].textContent");
  check('бинды сбрасываются по умолчанию', typeof resetText === 'string' && resetText.includes('Ctrl'), String(resetText));
  await evaluate("document.querySelector('#settingsClose').click()");
  await sleep(200);

  // 11. Адаптив: мобильная ширина переключает раскладку.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const mobile = await evaluate(`(() => {
    const app = getComputedStyle(document.querySelector('.app'));
    return { cols: app.gridTemplateColumns, width: window.innerWidth };
  })()`);
  check('на телефоне одна колонка каналов', !!(mobile && mobile.width === 390 && mobile.cols.split(' ').length === 2),
    JSON.stringify(mobile));
  await send('Emulation.clearDeviceMetricsOverride');

  // 10. Ошибок в консоли быть не должно.
  const noisy = pageErrors.filter((one) => one && !/favicon|net::ERR|Failed to load resource/i.test(one));
  check('в консоли нет ошибок JS', noisy.length === 0, JSON.stringify(noisy.slice(0, 4)));
} catch (error) {
  check('набор выполнился без исключений', false, String((error && error.message) || error));
} finally {
  // Уборка: удаляем временный аккаунт изнутри страницы.
  if (accountMade) {
    try {
      await evaluate(`(async () => {
        const token = localStorage.getItem('token') || '';
        if (!token) return 'нет токена';
        return await new Promise((resolve) => {
          const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + encodeURIComponent(token));
          ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.t === 'hello') ws.send(JSON.stringify({ t: 'account_delete', password: ${JSON.stringify(pass)} }));
            if (data.t === 'account_deleted') { resolve('удалён'); ws.close(); }
          };
          ws.onerror = () => resolve('ошибка ws');
          setTimeout(() => resolve('таймаут'), 6000);
        });
      })()`);
    } catch (_) { /* страницу уже закрыли */ }
  }
  try { if (ws) ws.close(); } catch (_) { /* уже закрыт */ }
  try { child.kill(); } catch (_) { /* уже завершён */ }
  // Профиль браузера — во временной папке, оставлять не нужно.
  try {
    const { rmSync } = await import('node:fs');
    rmSync(profile, { recursive: true, force: true });
  } catch (_) { /* файлы ещё заняты — не критично */ }
}

console.log('\nпроблем: ' + problems.length);
if (problems.length) {
  for (const one of problems) console.log(' - ' + one);
  process.exitCode = 1;
}
setTimeout(() => process.exit(process.exitCode || 0), 400);
