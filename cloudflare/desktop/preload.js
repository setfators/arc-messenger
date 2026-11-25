const { contextBridge, ipcRenderer } = require('electron');

// Версию приложения не дублируем в двух файлах: main.js передаёт её
// аргументом командной строки через webPreferences.additionalArguments
// (--messenger-version=1.4.0). process.env.MESSENGER_VERSION остаётся
// запасным вариантом для ручных сборок и отладки.
function readVersionArg() {
  const prefix = '--messenger-version=';
  const argv = Array.isArray(process.argv) ? process.argv : [];
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.indexOf(prefix) === 0) return arg.slice(prefix.length);
  }
  return '';
}

const APP_VERSION = readVersionArg() || process.env.MESSENGER_VERSION || '';

// Мост между страницей мессенджера и оболочкой Electron.
// Нужен для выбора источника при показе экрана, версии приложения,
// значка непрочитанных в трее и проверки обновлений.
// Ничего, кроме этих функций, странице не доступно.
contextBridge.exposeInMainWorld('messengerDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: APP_VERSION,
  versions: {
    app: APP_VERSION,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },
  appVersion: () => ipcRenderer.invoke('app:version'),
  screenSources: () => ipcRenderer.invoke('screen:sources'),
  pickScreenSource: (id) => ipcRenderer.invoke('screen:pick', id),
  // Значок непрочитанных: count > 0 — подсказка трея и мигание окна,
  // count === 0 — сброс. Возвращает undefined, ответ странице не нужен.
  setBadge: (count) => ipcRenderer.send('badge', Number(count) || 0),
  // Ручная проверка обновлений: промис с { ok, version, error }.
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  // Совместимость со старым каналом update:check (возвращает результат
  // autoUpdater.checkForUpdates или null).
  updateState: () => ipcRenderer.invoke('update:get'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  serverGet: () => ipcRenderer.invoke('server:get'),
  serverSet: (url) => ipcRenderer.invoke('server:set', url),
  feedGet: () => ipcRenderer.invoke('feed:get'),
  feedSet: (url) => ipcRenderer.invoke('feed:set', url),
  onUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update:state', handler);
    return () => ipcRenderer.removeListener('update:state', handler);
  },
  // Оверлей поверх игр (1.11.0): состояние звонка собирается из DOM и уходит
  // в основной процесс, а он рисует его в отдельном прозрачном окне.
  overlaySupported: true,
  overlayGet: () => ipcRenderer.invoke('overlay:get'),
  overlaySet: (patch) => ipcRenderer.invoke('overlay:set', patch)
});

/* ------------------------------------------------------- оверлей поверх игр */
// Ниже — только работа с DOM мессенджера. Ничего не отправляется чаще, чем
// меняется состояние, поэтому на игру это не влияет.
function readOverlayState() {
  const callStage = document.getElementById('callStage');
  const inCall = !!callStage && !callStage.classList.contains('hidden');
  const titleNode = document.getElementById('callTitle');
  const micNode = document.getElementById('micBtn');
  const participants = [];
  for (const tile of document.querySelectorAll('#callGrid .vtile')) {
    const nameNode = tile.querySelector('.vname');
    const stateNode = tile.querySelector('.vstate');
    const stateText = stateNode ? stateNode.textContent || '' : '';
    participants.push({
      name: nameNode ? nameNode.textContent || '' : '',
      muted: stateText.includes('выключ'),
      speaking: tile.classList.contains('speaking'),
      screen: !!tile.querySelector('.vscreen')
    });
  }
  const selfMuted = !!micNode && (micNode.classList.contains('off')
    || /выключ/i.test(micNode.getAttribute('title') || ''));
  return {
    inCall,
    title: titleNode ? titleNode.textContent || '' : '',
    participants,
    selfMuted
  };
}

let lastOverlayJson = '';
function pushOverlayState() {
  if (!document.getElementById('app') || document.getElementById('app').classList.contains('hidden')) {
    if (lastOverlayJson === '') return;
    lastOverlayJson = '';
    ipcRenderer.send('overlay:state', { inCall: false, title: '', participants: [], selfMuted: false });
    return;
  }
  const state = readOverlayState();
  const json = JSON.stringify(state);
  if (json === lastOverlayJson) return;
  lastOverlayJson = json;
  ipcRenderer.send('overlay:state', state);
}

setInterval(pushOverlayState, 700);
document.addEventListener('visibilitychange', pushOverlayState);
window.addEventListener('load', () => setTimeout(pushOverlayState, 500));

// Новые сообщения: приложение помечает их классом msg-fresh, поэтому
// полноценная перерисовка ленты не вызывает ложных всплытий.
function toastFromNode(node) {
  if (!node || node.nodeType !== 1) return;
  const row = node.classList && node.classList.contains('msg') ? node : node.closest ? node.closest('.msg') : null;
  if (!row || !row.classList.contains('msg-fresh')) return;
  const who = row.querySelector('.who');
  const body = row.querySelector('.body');
  const author = who ? (who.textContent || '').trim() : '';
  const text = body ? (body.textContent || '').trim() : '';
  if (!text && !author) return;
  ipcRenderer.send('overlay:toast', { author, text, room: row.dataset.room || '' });
}

const overlayObserver = new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) toastFromNode(node);
  }
});
function startOverlayObserver() {
  const box = document.getElementById('messages');
  if (!box) { setTimeout(startOverlayObserver, 400); return; }
  overlayObserver.observe(box, { childList: true });
}
startOverlayObserver();

// Кнопка микрофона в оверлее: нажимаем ту же кнопку в приложении.
ipcRenderer.on('overlay:mic-toggle', () => {
  const btn = document.getElementById('micBtn');
  if (btn) btn.click();
});
