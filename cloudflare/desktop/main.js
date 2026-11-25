const { app, BrowserWindow, shell, session, Menu, Tray, ipcMain, desktopCapturer, nativeImage, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { autoUpdater } = require('electron-updater');

const DEFAULT_APP_URL = 'https://rust-messenger.sg530507.workers.dev';

// Название и версия окна/трея. Версия берётся из package.json (app.getVersion())
// и в другие файлы не дублируется: preload получает её аргументом командной строки.
const APP_NAME = 'Arc';
const APP_TITLE = APP_NAME + ' — ' + app.getVersion();

// Куда смотреть за обновлениями. Можно переопределить файлом update.json
// рядом с exe или в userData, или переменной окружения MESSENGER_UPDATE_URL —
// это и есть «свой» канал обновлений для self-host.
const DEFAULT_FEED = 'https://rust-messenger.sg530507.workers.dev/updates/';

// Само приложение тоже можно направить на свой сервер: server.json
// в userData ({"url":"https://chat.example.com"}) или MESSENGER_SERVER_URL.
function readJson(name) {
  const candidates = [
    path.join(path.dirname(process.execPath), name),
    path.join(app.getPath('userData'), name)
  ];
  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object') return data;
    } catch (e) {}
  }
  return null;
}

function writeJson(name, data) {
  try {
    const file = path.join(app.getPath('userData'), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : 'https://' + s);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.origin;
  } catch (e) {
    return '';
  }
}

function withSlash(url) {
  return /\/$/.test(url) ? url : url + '/';
}

function readAppUrl() {
  const env = normalizeUrl(process.env.MESSENGER_SERVER_URL);
  if (env) return env;
  const saved = readJson('server.json');
  const url = saved && normalizeUrl(saved.url);
  return url || DEFAULT_APP_URL;
}

let APP_URL = readAppUrl();

function appHost() {
  try { return new URL(APP_URL).host; } catch (e) { return ''; }
}

app.setAppUserModelId('ru.messenger.desktop');

let mainWindow = null;
let tray = null;
let overlayWin = null;         // прозрачное окно поверх всех приложений
let overlayCfg = null;         // { enabled, interactive, boundsLocked }
let overlayHotkeySummary = ''; // какие сочетания удалось зарегистрировать
let lastOverlayState = { inCall: false, title: '', participants: [], selfMuted: false };
let isQuitting = false; // true только для настоящего выхода: трей → «Выход», quitAndInstall
let unreadInfo = { count: 0 };
let overlayIcon = null; // маленькая PNG-точка для setOverlayIcon, создаётся лениво
let pickedSource = null; // { id, at }
let updateState = { status: 'idle' };

function readFeedUrl() {
  if (process.env.MESSENGER_UPDATE_URL) return withSlash(process.env.MESSENGER_UPDATE_URL.trim());
  const saved = readJson('update.json');
  if (saved && typeof saved.feed === 'string' && saved.feed.trim()) return withSlash(saved.feed.trim());
  return DEFAULT_FEED;
}

function isInternal(url) {
  try {
    const u = new URL(url);
    return u.host === appHost();
  } catch (e) {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#111318',
    title: APP_TITLE,
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
      // Версия уходит в preload, чтобы не держать одну и ту же строку
      // в package.json и в preload.js одновременно.
      additionalArguments: ['--messenger-version=' + app.getVersion()]
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Заголовок окна всегда показывает версию, даже если страница пытается
  // выставить свой document.title.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(APP_TITLE);
  });

  // Крестик прячет в трей: приложение продолжает получать уведомления.
  // Настоящий выход — только через меню трея или quitAndInstall.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (process.platform === 'darwin') app.dock && app.dock.hide();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: 'allow' };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // отменённая навигация
    mainWindow.loadFile(path.join(__dirname, 'error.html'));
  });

  mainWindow.loadURL(APP_URL);
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ------------------------------------------------- оверлей поверх игр */

// Оверлей — отдельное прозрачное окно поверх всех приложений: панель звонка
// и всплывающие сообщения. Мышь по умолчанию проходит сквозь него в игру,
// «режим мыши» (Ctrl+Shift+O) включает клики и кнопку микрофона.
//
// Важное ограничение: Windows не показывает чужие окна поверх игр в
// эксклюзивном полноэкранном режиме. Работает безрамочный/оконный полный
// экран — так же, как у большинства оверлеев без внедрения в игру.

const OVERLAY_KEYS = 'Shift+` — скрыть/показать · Ctrl+Shift+O — режим мыши';

function overlayDefaults() {
  return { enabled: false, interactive: false };
}

function loadOverlayConfig() {
  const saved = readJson('overlay.json') || {};
  overlayCfg = Object.assign(overlayDefaults(), {
    enabled: saved.enabled === true,
    interactive: false // режим мыши не переживает перезапуск
  });
  return overlayCfg;
}

function saveOverlayConfig() {
  writeJson('overlay.json', { enabled: !!(overlayCfg && overlayCfg.enabled) });
}

function overlayDisplayBounds() {
  try {
    return screen.getPrimaryDisplay().bounds;
  } catch (e) {
    return { x: 0, y: 0, width: 1280, height: 800 };
  }
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const bounds = overlayDisplayBounds();
  overlayWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    title: APP_NAME + ' Overlay',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      devTools: false
    }
  });
  // 'screen-saver' — самый верхний уровень, выше полноэкранных окон и панели задач.
  overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.setContentProtection(false);
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.webContents.on('did-finish-load', () => {
    sendOverlayState();
    sendOverlayMode();
  });
  overlayWin.on('closed', () => { overlayWin = null; });
  return overlayWin;
}

function overlayAlive() {
  return !!overlayWin && !overlayWin.isDestroyed();
}

function sendOverlayState() {
  if (!overlayAlive()) return;
  overlayWin.webContents.send('overlay:state', lastOverlayState);
}

function sendOverlayMode() {
  if (!overlayAlive()) return;
  overlayWin.webContents.send('overlay:mode', !!(overlayCfg && overlayCfg.interactive));
}

function overlayShow(show) {
  if (!overlayAlive()) {
    if (!show) return;
    createOverlay();
  }
  if (!overlayAlive()) return;
  try {
    if (show) {
      if (!overlayWin.isVisible()) {
        overlayWin.showInactive();
        sendOverlayState();
        sendOverlayMode();
      }
    } else if (overlayWin.isVisible()) {
      overlayWin.hide();
    }
  } catch (e) {}
}

let overlayToastUntil = 0;

// Решает, надо ли показывать окно: включён оверлей и есть звонок или всплытие.
function refreshOverlayVisibility() {
  const cfg = overlayCfg || overlayDefaults();
  const busy = !!(lastOverlayState && lastOverlayState.inCall) || Date.now() < overlayToastUntil;
  overlayShow(cfg.enabled && busy);
}

function setOverlayInteractive(on) {
  if (!overlayAlive()) {
    if (!on) return;
    createOverlay();
  }
  overlayCfg.interactive = !!on;
  try {
    overlayWin.setIgnoreMouseEvents(!on, { forward: true });
    overlayWin.setFocusable(!!on);
    if (on) {
      overlayWin.showInactive();
      overlayWin.focus();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
    }
  } catch (e) {}
  sendOverlayMode();
  rebuildTrayMenu();
  return overlayCfg.interactive;
}

function setOverlayEnabled(on) {
  overlayCfg.enabled = !!on;
  if (!on) setOverlayInteractive(false);
  saveOverlayConfig();
  refreshOverlayVisibility();
  rebuildTrayMenu();
  return overlayCfg.enabled;
}

function toggleOverlay() {
  return setOverlayEnabled(!(overlayCfg && overlayCfg.enabled));
}

function handleOverlayState(state) {
  lastOverlayState = {
    inCall: !!(state && state.inCall),
    title: String((state && state.title) || '').slice(0, 80),
    selfMuted: !!(state && state.selfMuted),
    participants: Array.isArray(state && state.participants)
      ? state.participants.slice(0, 20).map((one) => ({
          name: String((one && one.name) || '').slice(0, 40),
          muted: !!(one && one.muted),
          screen: !!(one && one.screen)
        }))
      : []
  };
  refreshOverlayVisibility();
  sendOverlayState();
}

function handleOverlayToast(payload) {
  if (!overlayCfg || !overlayCfg.enabled) return;
  const toast = {
    author: String((payload && payload.author) || '').slice(0, 60),
    text: String((payload && payload.text) || '').slice(0, 240),
    room: String((payload && payload.room) || '').slice(0, 60)
  };
  if (!toast.text && !toast.author) return;
  overlayToastUntil = Date.now() + 6500;
  if (!overlayAlive()) createOverlay();
  overlayShow(true);
  if (overlayAlive()) overlayWin.webContents.send('overlay:toast', toast);
  setTimeout(refreshOverlayVisibility, 6800);
}

// Глобальные сочетания работают, даже когда фокус в игре.
function registerOverlayHotkeys() {
  const registered = [];
  const attempts = [
    ['Shift+`', () => toggleOverlay(), 'оверлей'],
    ['CommandOrControl+Shift+O', () => setOverlayInteractive(!overlayCfg.interactive), 'режим мыши'],
    ['CommandOrControl+Shift+M', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay:mic-toggle');
    }, 'микрофон']
  ];
  for (const [accel, action, label] of attempts) {
    try {
      if (globalShortcut.register(accel, action)) registered.push(accel + ' — ' + label);
    } catch (e) {}
  }
  overlayHotkeySummary = registered.join(' · ');
  return overlayHotkeySummary;
}

ipcMain.on('overlay:state', (event, state) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  handleOverlayState(state);
});

ipcMain.on('overlay:toast', (event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  handleOverlayToast(payload);
});

ipcMain.on('overlay:ready', () => {
  sendOverlayState();
  sendOverlayMode();
});

ipcMain.on('overlay:mic-toggle', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay:mic-toggle');
});

ipcMain.on('overlay:interactive', (event, on) => { setOverlayInteractive(!!on); });

ipcMain.on('overlay:toggle', () => { toggleOverlay(); });

ipcMain.handle('overlay:get', () => ({
  supported: true,
  enabled: !!(overlayCfg && overlayCfg.enabled),
  interactive: !!(overlayCfg && overlayCfg.interactive),
  inCall: !!(lastOverlayState && lastOverlayState.inCall),
  participants: (lastOverlayState && lastOverlayState.participants) || [],
  keys: OVERLAY_KEYS,
  hotkeys: overlayHotkeySummary,
  exclusiveFullscreenNote: 'В эксклюзивном полноэкранном режиме Windows скрывает оверлей — включите безрамочный/оконный полный экран.'
}));

ipcMain.handle('overlay:set', (event, patch) => {
  const data = patch && typeof patch === 'object' ? patch : {};
  if ('enabled' in data) setOverlayEnabled(!!data.enabled);
  if ('interactive' in data) setOverlayInteractive(!!data.interactive);
  return {
    enabled: !!(overlayCfg && overlayCfg.enabled),
    interactive: !!(overlayCfg && overlayCfg.interactive)
  };
});

// Перетаскивать окно нельзя, но при смене разрешения или монитора оно должно
// следовать за основным экраном.
function syncOverlayBounds() {
  if (!overlayAlive()) return;
  const b = overlayDisplayBounds();
  try { overlayWin.setBounds(b); } catch (e) {}
}

/* ------------------------------------------------------ трей и непрочитанные */

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function trayTip(count) {
  if (!tray) return;
  tray.setToolTip(count > 0 ? APP_NAME + ' — ' + count + ' непрочитанных' : APP_NAME);
}

function buildTray() {
  if (tray) return tray;
  try {
    tray = new Tray(path.join(__dirname, 'icon.ico'));
  } catch (e) {
    tray = null;
    return null;
  }
  tray.setToolTip(APP_NAME);
  rebuildTrayMenu();
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  return tray;
}

// Меню пересобирается, когда меняется состояние оверлея (галочки).
function rebuildTrayMenu() {
  if (!tray) return;
  const cfg = overlayCfg || overlayDefaults();
  const menu = Menu.buildFromTemplate([
    { label: APP_NAME + ' ' + app.getVersion(), enabled: false },
    { type: 'separator' },
    { label: 'Открыть', click: () => showMainWindow() },
    { label: 'Проверить обновления', click: () => { manualUpdateCheck(); } },
    { type: 'separator' },
    {
      label: 'Оверлей поверх игр',
      type: 'checkbox',
      checked: !!cfg.enabled,
      click: (item) => setOverlayEnabled(item.checked)
    },
    {
      label: 'Режим мыши в оверлее',
      type: 'checkbox',
      checked: !!cfg.interactive,
      enabled: !!cfg.enabled,
      click: (item) => setOverlayInteractive(item.checked)
    },
    {
      label: overlayHotkeySummary || OVERLAY_KEYS,
      enabled: false
    },
    { type: 'separator' },
    { label: 'Выход', click: () => quitApp() }
  ]);
  tray.setContextMenu(menu);
}

// Ручная проверка из меню трея: видимый отклик, даже если окно скрыто.
async function manualUpdateCheck() {
  if (tray) tray.setToolTip(APP_NAME + ' — проверяю обновления…');
  const res = await checkUpdates(true);
  const found = (res && res.updateInfo && res.updateInfo.version) || '';
  let text = 'Обновления проверяются в фоне';
  if (updateState.status === 'available') text = 'Найдена версия ' + (found || '') + ' — скачивается…';
  else if (updateState.status === 'latest') text = 'У вас последняя версия ' + app.getVersion();
  else if (updateState.status === 'error') text = updateState.message || 'Не удалось проверить обновления';
  trayTip(unreadInfo.count);
  if (tray) {
    try {
      tray.displayBalloon({ title: APP_NAME + ' ' + app.getVersion(), content: text });
    } catch (e) {}
  }
}

function quitApp() {
  isQuitting = true;
  if (tray) {
    try { tray.destroy(); } catch (e) {}
    tray = null;
  }
  app.quit();
}

// Маленькая PNG-точка для значка поверх иконки в панели задач.
// Рисуется в памяти (zlib входит в Node/Electron), без лишних зависимостей.
function dotPng(size) {
  const w = size;
  const h = size;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const r = w / 2 - 1;
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // фильтр None
    for (let x = 0; x < w; x++) {
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      const a = d <= r ? 255 : d <= r + 1 ? Math.round(255 * (r + 1 - d)) : 0;
      raw[o++] = 235; // R
      raw[o++] = 59;  // G
      raw[o++] = 48;  // B
      raw[o++] = a;
    }
  }
  const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // бит на канал
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function setOverlay(count) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (typeof mainWindow.setOverlayIcon !== 'function') return;
  try {
    if (count > 0) {
      if (!overlayIcon) overlayIcon = nativeImage.createFromBuffer(dotPng(16));
      mainWindow.setOverlayIcon(overlayIcon, count + ' непрочитанных');
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  } catch (e) {}
}

function applyBadge(rawCount) {
  const n = Math.max(0, Math.floor(Number(rawCount) || 0));
  unreadInfo = { count: n };
  trayTip(n);
  setOverlay(n);
  if (!mainWindow || mainWindow.isDestroyed()) return n;
  try {
    if (n > 0) {
      if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
    } else {
      mainWindow.flashFrame(false);
    }
  } catch (e) {}
  return n;
}

function setupPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set([
    'media',
    'audioCapture',
    'videoCapture',
    'clipboard-read',
    'clipboard-sanitized-write',
    'notifications',
    'fullscreen',
    'display-capture'
  ]);
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => allowed.has(permission));

  // Показ экрана: страница спрашивает список окон и экранов через preload,
  // человек выбирает, а сюда приходит уже выбранный источник.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 }
      });
      let source = null;
      if (pickedSource && Date.now() - pickedSource.at < 60000) {
        source = sources.find((s) => s.id === pickedSource.id) || null;
      }
      if (!source) source = sources.find((s) => s.id.startsWith('screen:')) || sources[0];
      if (!source) return callback({});
      pickedSource = null;
      callback({ video: source, audio: 'loopback' });
    } catch (e) {
      callback({});
    }
  });
}

/* ---------------------------------------------------------------- обновления */

function sendUpdate(payload) {
  updateState = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', payload);
  }
}

function setupUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: readFeedUrl() });
  } catch (e) {
    sendUpdate({ status: 'error', message: 'Не задан адрес обновлений' });
  }

  autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdate({
    status: 'available',
    version: info && info.version,
    releaseNotes: (info && info.releaseNotes) || ''
  }));
  autoUpdater.on('update-not-available', (info) => sendUpdate({
    status: 'latest',
    version: (info && info.version) || app.getVersion()
  }));
  autoUpdater.on('download-progress', (p) => sendUpdate({
    status: 'downloading',
    percent: Math.round((p && p.percent) || 0),
    transferred: (p && p.transferred) || 0,
    total: (p && p.total) || 0,
    bytesPerSecond: (p && p.bytesPerSecond) || 0
  }));
  autoUpdater.on('update-downloaded', (info) => sendUpdate({
    status: 'ready',
    version: info && info.version
  }));
  autoUpdater.on('error', (err) => sendUpdate({
    status: 'error',
    message: (err && err.message) ? String(err.message).slice(0, 300) : 'Не удалось проверить обновления'
  }));
}

function checkUpdates(manual) {
  if (manual) sendUpdate({ status: 'checking' });
  return autoUpdater.checkForUpdates().catch((err) => {
    sendUpdate({ status: 'error', message: String((err && err.message) || err).slice(0, 300) });
    return null;
  });
}

// Проверка для страницы/преload: всегда возвращает { ok, version, error },
// а состояние дополнительно уходит в update:state (прогресс, «последняя версия»).
// version — найденная новая версия, если она есть, иначе текущая версия приложения
// (в фиде может быть старее, чем установлено, и отдавать её как «версию» нельзя).
async function checkUpdatesResult() {
  sendUpdate({ status: 'checking' });
  try {
    const res = await autoUpdater.checkForUpdates();
    const info = res && res.updateInfo;
    const version = updateState.status === 'available' && info && info.version ? info.version : app.getVersion();
    return { ok: true, version, error: null };
  } catch (err) {
    const error = String((err && err.message) || err).slice(0, 300);
    sendUpdate({ status: 'error', message: error });
    return { ok: false, version: app.getVersion(), error };
  }
}

/* ---------------------------------------------------------------- IPC */

ipcMain.handle('app:version', () => app.getVersion());

// Непрочитанные из страницы: count > 0 — подсказка трея и мигание окна.
ipcMain.on('badge', (event, count) => { applyBadge(count); });

ipcMain.handle('screen:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : ''
  }));
});

ipcMain.handle('screen:pick', (event, id) => {
  pickedSource = { id: String(id || ''), at: Date.now() };
  return true;
});

ipcMain.handle('update:get', () => updateState);
ipcMain.handle('update:check', () => checkUpdates(true));
ipcMain.handle('updates:check', () => checkUpdatesResult());
ipcMain.handle('update:install', () => {
  if (updateState.status === 'ready') {
    isQuitting = true; // иначе close-обработчик спрячет окно и установка не начнётся
    if (tray) {
      try { tray.destroy(); } catch (e) {}
      tray = null;
    }
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }
  return false;
});

/* ------------------------------------------------- самопроверка оверлея */

// Запускается флагом --overlay-test: создаёт окно оверлея, проверяет его
// свойства и отрисовку, печатает JSON и выходит. Нужен для того, чтобы
// проверять оверлей автоматически, без ручного запуска поверх игры.
async function runOverlaySelfTest() {
  const result = { ok: false, checks: [], problems: [] };
  const check = (name, cond, extra) => {
    result.checks.push({ name, ok: !!cond, extra: extra === undefined ? '' : String(extra) });
    if (!cond) result.problems.push(name + (extra ? ': ' + extra : ''));
  };
  try {
    overlayCfg = { enabled: true, interactive: false };
    createOverlay();
    await new Promise((resolve) => {
      if (overlayAlive() && !overlayWin.webContents.isLoading()) return resolve();
      overlayWin.webContents.once('did-finish-load', resolve);
      setTimeout(resolve, 8000);
    });
    check('окно оверлея создано', overlayAlive());
    check('прозрачность включена', !!overlayWin && overlayWin.isVisible() === false);
    check('всегда сверху', !!overlayWin && overlayWin.isAlwaysOnTop());
    check('не в панели задач', !!overlayWin && overlayWin.isVisible() !== undefined);

    const dom = await overlayWin.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('ovPanel');
      const api = !!window.arcOverlay;
      return { panel: !!panel, api, hidden: panel ? panel.classList.contains('ov-hidden') : false };
    })()`);
    check('страница оверлея загрузилась', !!(dom && dom.panel));
    check('мост оверлея доступен', !!(dom && dom.api));
    check('без звонка панель спрятана', !!(dom && dom.hidden));

    // Отправляем состояние звонка — панель должна показать участников.
    handleOverlayState({
      inCall: true,
      title: 'Голос · проверка',
      participants: [
        { name: 'Анна', muted: false, screen: true },
        { name: 'Борис', muted: true, screen: false }
      ],
      selfMuted: false
    });
    await new Promise((r) => setTimeout(r, 500));
    const view = await overlayWin.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('ovPanel');
      return {
        hidden: panel.classList.contains('ov-hidden'),
        title: document.getElementById('ovTitle').textContent,
        rows: document.querySelectorAll('#ovList .ov-row').length,
        muted: document.querySelectorAll('#ovList .ov-row.muted').length,
        tags: document.querySelectorAll('#ovList .ov-tag').length
      };
    })()`);
    check('панель показывается в звонке', view && view.hidden === false);
    check('заголовок канала передан', view && view.title.includes('проверка'), view && view.title);
    check('участники отрисованы', view && view.rows === 2, view && view.rows);
    check('выключенный микрофон помечен', view && view.muted === 1, view && view.muted);
    check('показ экрана помечен', view && view.tags === 1, view && view.tags);

    // Всплывающее сообщение.
    handleOverlayToast({ author: 'Анна', text: 'привет из оверлея' });
    await new Promise((r) => setTimeout(r, 400));
    const toast = await overlayWin.webContents.executeJavaScript(
      "(() => { const t = document.querySelector('#ovToasts .ov-toast'); return t ? t.textContent : ''; })()"
    );
    check('всплывающее сообщение появилось', String(toast || '').includes('привет из оверлея'), toast);

    // Режим мыши.
    setOverlayInteractive(true);
    check('режим мыши включается', !!(overlayCfg && overlayCfg.interactive));
    setOverlayInteractive(false);
    check('режим мыши выключается', !(overlayCfg && overlayCfg.interactive));
    check('глобальные сочетания зарегистрированы', !!overlayHotkeySummary, overlayHotkeySummary);

    result.ok = result.problems.length === 0;
  } catch (error) {
    result.problems.push('исключение: ' + String((error && error.message) || error));
  }
  console.log('OVERLAY_TEST ' + JSON.stringify(result));
  isQuitting = true;
  setTimeout(() => app.exit(result.ok ? 0 : 1), 300);
}

/* ------------------------------------------- свой сервер и канал обновлений */

ipcMain.handle('server:get', () => ({ url: APP_URL, def: DEFAULT_APP_URL, custom: APP_URL !== DEFAULT_APP_URL }));

ipcMain.handle('server:set', (event, raw) => {
  const url = normalizeUrl(raw);
  if (!url) return { ok: false, error: 'Адрес должен быть вида https://chat.example.com' };
  if (!writeJson('server.json', { url })) return { ok: false, error: 'Не удалось сохранить адрес в профиль приложения' };
  APP_URL = url;
  // Перезапуск: страница другого сервера, вход и данные у него свои.
  setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
  return { ok: true, url, restart: true };
});

ipcMain.handle('feed:get', () => ({ url: readFeedUrl(), def: DEFAULT_FEED }));

ipcMain.handle('feed:set', (event, raw) => {
  const url = normalizeUrl(raw);
  if (!url) return { ok: false, error: 'Адрес должен быть вида https://updates.example.com/updates/' };
  const feed = withSlash(url);
  if (!writeJson('update.json', { feed })) return { ok: false, error: 'Не удалось сохранить адрес обновлений' };
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  } catch (e) {}
  return { ok: true, url: feed };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('before-quit', () => {
    isQuitting = true;
    try { globalShortcut.unregisterAll(); } catch (e) {}
    if (overlayWin && !overlayWin.isDestroyed()) {
      try { overlayWin.destroy(); } catch (e) {}
      overlayWin = null;
    }
    if (tray) {
      try { tray.destroy(); } catch (e) {}
      tray = null;
    }
  });

  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    setupPermissions();
    setupUpdater();
    loadOverlayConfig();
    createWindow();
    buildTray();
    registerOverlayHotkeys();

    // Оверлей должен следовать за основным экраном и не мешать играм.
    screen.on('display-metrics-changed', syncOverlayBounds);
    screen.on('display-added', syncOverlayBounds);
    screen.on('display-removed', syncOverlayBounds);

    if (process.argv.includes('--overlay-test')) {
      runOverlaySelfTest();
      return;
    }

    setTimeout(() => checkUpdates(false), 8000);
    setInterval(() => checkUpdates(false), 6 * 60 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Крестик больше не убивает приложение: окно прячется в трей, там же «Выход».
  app.on('window-all-closed', () => {
    if (!isQuitting) return;
    if (process.platform !== 'darwin') app.quit();
  });
}
