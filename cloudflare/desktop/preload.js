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
  }
});
