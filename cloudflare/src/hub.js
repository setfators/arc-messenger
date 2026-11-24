// ChatHub — один Durable Object на всё приложение: аккаунты, друзья, каналы,
// личные сообщения, присутствие и сигнализация WebRTC для голосового чата.
// Состояние лежит в storage (SQLite-backed DO), поэтому переживает перезапуск.

import { mxDefault, mxNorm, mxPublic, mxSend, mxSync, mxWhoami } from './matrix.js';

const APP_VERSION = '1.4.2';
const HISTORY_LIMIT = 300;
const MAX_TEXT_CHARS = 4000;
const DEFAULT_CHANNEL = 'obshiy';

// Групповой звонок: столько человек одновременно в одном голосовом канале.
const VOICE_LIMIT = 8;
// Картинки лежат в storage самого Durable Object: аватар — до 512 КБ,
// стикер — до 256 КБ (в base64 это примерно на треть больше).
const AVATAR_MAX_BYTES = 512 * 1024;
const STICKER_MAX_BYTES = 256 * 1024;
const STICKER_LIMIT = 80;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Вложения сообщений (1.4.0): сырые байты режутся на куски по 96 КБ и лежат
// в storage Durable Object. Держим не больше 120 последних картинок.
const MEDIA_MAX_BYTES = 2500000;
const MEDIA_CHUNK = 96 * 1024;
const MEDIA_LIMIT = 120;
// В одном сообщении не больше 20 разных эмодзи.
const REACTION_KINDS = 20;
// Web Push: TTL уведомления и адрес отправителя для VAPID.
const PUSH_TTL = 3600;
const PUSH_SUB_LIMIT = 8;

// Пароли: PBKDF2 вместо одного SHA-256. Старые аккаунты (algo не задан)
// проверяются прежним способом и молча переводятся на новый при входе.
const PBKDF2_ITERATIONS = 12000;
// Сеанс живёт 90 дней, у одного аккаунта не больше 20 активных токенов.
const TOKEN_TTL = 90 * 24 * 60 * 60 * 1000;
const TOKEN_PER_USER = 20;
// Защита от перебора пароля: не больше 10 неудач за 5 минут с одного адреса.
const AUTH_WINDOW = 5 * 60 * 1000;
const AUTH_MAX_FAILS = 10;

// Сценарий «для своих»: регистрация по кодам-приглашениям, владелец с правом
// удалять чужое, ограничение частоты сообщений и экспорт базы.
const INVITE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LEN = 8;
const INVITE_USES = 5;        // сколько человек можно позвать одним кодом
const INVITE_LIMIT = 40;      // сколько кодов храним всего
const MSG_BURST = 15;         // не больше 15 сообщений…
const MSG_BURST_WINDOW = 10 * 1000;   // …за 10 секунд
const MSG_HOURLY = 300;       // и не больше 300 в час
const CREATE_HOURLY = 10;     // каналов в час на человека

const COLORS = [
  '#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e',
  '#00a8fc', '#9b59b6', '#e67e22', '#1abc9c', '#e91e63',
];

const now = () => Date.now();
const enc = new TextEncoder();

// Настройки приложения по умолчанию. Хранятся на сервере, поэтому переезжают
// между устройствами вместе с аккаунтом.
function defaultSettings() {
  return {
    theme: 'dark',        // dark | light | midnight
    fontScale: 100,       // 85..130
    compact: false,
    showTime: true,
    enterToSend: true,
    notifySound: true,
    notifyDesktop: true,  // всплывающие уведомления (браузер спросит разрешение)
    notifyAll: true,      // обо всех сообщениях, иначе только ЛС и упоминания
    soundVolume: 60,      // 0..100
    dnd: false,
    showTyping: true,
    showAvatars: true,
    groupMessages: true,  // склеивать подряд идущие сообщения автора
    clock24: true,
    dmPrivacy: 'all',     // all | friends
    searchPrivacy: 'all', // all | friends — кто может найти меня по имени
    status: 'online',     // online | idle | dnd | invisible
    notifyTone: 'chime',  // chime | pop | blip
    voiceMode: 'activity',// activity | ptt
    voiceInput: '',       // deviceId микрофона
    voiceOutput: '',      // deviceId наушников
    voiceVolume: 100,     // 0..200
    micGain: 100,         // 0..200
    noiseSuppress: true,
    echoCancel: true,
    autoGain: true,
    turnUrl: '',          // свой TURN: turn:host:3478,turns:host:5349
    turnUser: '',
    turnPass: '',
  };
}

function mergeSettings(base, patch) {
  const out = { ...defaultSettings(), ...(base || {}) };
  if (!patch || typeof patch !== 'object') return out;
  const num = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  if (['dark', 'light', 'midnight'].includes(patch.theme)) out.theme = patch.theme;
  if (patch.fontScale !== undefined) out.fontScale = num(patch.fontScale, 85, 130, out.fontScale);
  if (patch.voiceVolume !== undefined) out.voiceVolume = num(patch.voiceVolume, 0, 200, out.voiceVolume);
  if (patch.micGain !== undefined) out.micGain = num(patch.micGain, 0, 200, out.micGain);
  if (patch.soundVolume !== undefined) out.soundVolume = num(patch.soundVolume, 0, 100, out.soundVolume);
  if (patch.voiceMode === 'ptt' || patch.voiceMode === 'activity') out.voiceMode = patch.voiceMode;
  if (patch.searchPrivacy === 'all' || patch.searchPrivacy === 'friends') out.searchPrivacy = patch.searchPrivacy;
  for (const flag of ['compact', 'showTime', 'enterToSend', 'notifySound', 'notifyDesktop', 'notifyAll', 'dnd', 'showTyping', 'showAvatars', 'groupMessages', 'clock24', 'noiseSuppress', 'echoCancel', 'autoGain']) {
    if (typeof patch[flag] === 'boolean') out[flag] = patch[flag];
  }
  if (patch.dmPrivacy === 'all' || patch.dmPrivacy === 'friends') out.dmPrivacy = patch.dmPrivacy;
  if (typeof patch.voiceInput === 'string') out.voiceInput = clip(String(patch.voiceInput), 120);
  if (typeof patch.voiceOutput === 'string') out.voiceOutput = clip(String(patch.voiceOutput), 120);
  if (['online', 'idle', 'dnd', 'invisible'].includes(patch.status)) out.status = patch.status;
  if (['chime', 'pop', 'blip'].includes(patch.notifyTone)) out.notifyTone = patch.notifyTone;
  // Свой TURN-сервер: только схемы turn:/turns:, чтобы в поле не попал мусор.
  if (typeof patch.turnUrl === 'string') {
    const urls = patch.turnUrl.split(',').map((one) => one.trim()).filter((one) => /^turns?:[a-z0-9.\-]+(:\d+)?(\?transport=(tcp|udp))?$/i.test(one));
    out.turnUrl = clip(urls.join(','), 300);
  }
  if (typeof patch.turnUser === 'string') out.turnUser = clip(String(patch.turnUser).trim(), 120);
  if (typeof patch.turnPass === 'string') out.turnPass = clip(String(patch.turnPass), 120);
  return out;
}

function defaultProfile(name, color) {
  return { displayName: name, avatar: '', accent: color, bio: '', banner: '' };
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function validName(name) {
  const s = String(name || '').trim();
  const count = [...s].length;
  if (count < 2 || count > 20) return false;
  return [...s].every((c) => /[\p{L}\p{N}_\- ]/u.test(c));
}

function clip(text, limit) {
  const chars = [...String(text || '')];
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : chars.join('');
}

function colorFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function dmRoom(a, b) {
  const [first, second] = a <= b ? [a, b] : [b, a];
  return `dm:${first}|${second}`;
}

function dmPartners(room) {
  if (!room.startsWith('dm:')) return null;
  const rest = room.slice(3);
  const i = rest.indexOf('|');
  if (i < 0) return null;
  return [rest.slice(0, i), rest.slice(i + 1)];
}

function randomHex(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Первые n символов (по кодовым пунктам, без «…»): снимки цитат и выдача поиска.
function head(text, limit) {
  return [...String(text || '')].slice(0, limit).join('');
}

// base64url без выравнивания — формат VAPID-ключа и подписи JWT.
function bytesToBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonBase64Url(value) {
  return bytesToBase64Url(enc.encode(JSON.stringify(value)));
}

// content-type можно подделать, поэтому проверяем, что сигнатура файла
// действительно соответствует заявленному типу.
function imageSignatureOk(bytes, mime) {
  if (!bytes || bytes.length < 12) return false;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
  const webp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (mime === 'image/png') return png;
  if (mime === 'image/jpeg') return jpeg;
  if (mime === 'image/gif') return gif;
  if (mime === 'image/webp') return webp;
  return false;
}

// Реакция: 1–4 кодовых пункта, эмодзи. ZWJ, селектор FE0F, тона кожи и
// региональные индикаторы допускаем — из них состоят составные эмодзи.
function reactionEmoji(raw) {
  const text = String(raw || '');
  const chars = [...text];
  if (chars.length < 1 || chars.length > 4) return '';
  for (const ch of chars) {
    if (/\p{Extended_Pictographic}/u.test(ch)) continue;
    const cp = ch.codePointAt(0);
    if (cp === 0x200d || cp === 0xfe0f || cp === 0x20e3) continue;
    if (cp >= 0x1f3fb && cp <= 0x1f3ff) continue; // тон кожи
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) continue; // региональные индикаторы (флаги)
    return '';
  }
  return text;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Прежний способ: один SHA-256. Нужен только для старых аккаунтов.
async function legacyHash(password, salt) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(salt + ':' + password));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Сравнение без раннего выхода: длина хэшей одинаковая, но так спокойнее.
function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, user) {
  if (!user || !user.salt) return false;
  if (user.algo === 'pbkdf2') return safeEqual(await hashPassword(password, user.salt), user.pass);
  return safeEqual(await legacyHash(password, user.salt), user.pass);
}

function emptyStore() {
  return {
    users: {},
    rooms: {},
    channels: [DEFAULT_CHANNEL],
    tokens: {},
    tokenAt: {},
    authFails: {},
    seq: 0,
  };
}

export class ChatHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.store = null;
    this.voice = new Map(); // room -> Map(name -> {name, muted})
    this.loading = null;
  }

  async ensure() {
    if (this.store) return this.store;
    if (!this.loading) {
      this.loading = (async () => {
        const saved = await this.state.storage.get('state');
        this.store = saved || emptyStore();
        if (!this.store.channels.includes(DEFAULT_CHANNEL)) this.store.channels.push(DEFAULT_CHANNEL);
        if (!this.store.rooms[DEFAULT_CHANNEL]) this.store.rooms[DEFAULT_CHANNEL] = [];
        if (!this.store.hidden) this.store.hidden = {};
        if (!this.store.avatars) this.store.avatars = {};
        if (!this.store.tokenAt) this.store.tokenAt = {};
        if (!this.store.authFails) this.store.authFails = {};
        if (!Array.isArray(this.store.stickers)) this.store.stickers = [];
        if (!this.store.matrix) this.store.matrix = mxDefault();
        // Вложения-картинки (1.4.0) и подписки на Web Push.
        if (!this.store.media) this.store.media = {};
        if (!this.store.push) this.store.push = {};
        // Сценарий «для своих»: владелец, коды-приглашения и режим закрытой регистрации.
        if (!Array.isArray(this.store.invites)) this.store.invites = [];
        if (!Array.isArray(this.store.staff)) this.store.staff = [];
        this.store.staff = this.store.staff.filter((k) => this.store.users[k] && k !== this.store.owner);
        if (this.store.inviteOnly === undefined) this.store.inviteOnly = true;
        // Владелец — самый первый аккаунт. Если он удалён, права переходят
        // к следующему по времени регистрации, иначе управлять будет некому.
        if (!this.store.owner || !this.store.users[this.store.owner]) {
          const all = Object.entries(this.store.users || {});
          if (all.length) {
            all.sort((a, b) => (a[1].created || 0) - (b[1].created || 0));
            this.store.owner = all[0][0];
          } else {
            this.store.owner = '';
          }
        }
        // Старые аккаунты получают профиль и настройки при первом запуске.
        for (const u of Object.values(this.store.users || {})) {
          if (!u.profile) u.profile = defaultProfile(u.name, u.color);
          if (!u.settings) u.settings = defaultSettings();
          if (!Array.isArray(u.friends)) u.friends = [];
          if (!Array.isArray(u.incoming)) u.incoming = [];
          if (!Array.isArray(u.outgoing)) u.outgoing = [];
        }
        // VAPID-ключи для Web Push: генерируются один раз и лежат в состоянии.
        if (!this.store.vapid || !this.store.vapid.pub || !this.store.vapid.priv) {
          try {
            const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
            const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
            const priv = await crypto.subtle.exportKey('jwk', keys.privateKey);
            this.store.vapid = { pub: bytesToBase64Url(raw), priv, sub: 'mailto:admin@example.com' };
            await this.save();
          } catch (_) {
            // Без WebCrypto push просто выключен — чат продолжает работать.
          }
        }
        return this.store;
      })();
    }
    return this.loading;
  }

  save() {
    return this.state.storage.put('state', this.store);
  }

  // Ищем пользователя по логину, а если не нашлось — по отображаемому имени
  // (только когда совпадение однозначное: двоих «Аня» угадывать нельзя).
  findUserKey(raw) {
    const key = normalizeName(raw);
    if (!key) return '';
    if (this.store.users[key]) return key;
    const matches = Object.keys(this.store.users).filter((k) => {
      const p = this.store.users[k].profile;
      return p && normalizeName(p.displayName) === key;
    });
    return matches.length === 1 ? matches[0] : '';
  }

  // Новый сеанс: случайный токен, срок жизни и лимит на аккаунт.
  mintToken(key) {
    const token = randomHex(16);
    this.store.tokens[token] = key;
    this.store.tokenAt[token] = now();
    this.pruneTokens(key);
    return token;
  }

  pruneTokens(keepKey) {
    if (!this.store.tokenAt) this.store.tokenAt = {};
    const at = this.store.tokenAt;
    const stamp = now();
    for (const [token, owner] of Object.entries(this.store.tokens || {})) {
      // Старые токены без отметки времени не выкидываем сразу: даём им срок
      // с момента обновления, чтобы люди не вылетели после деплоя.
      if (!at[token]) at[token] = stamp;
      if (stamp - at[token] > TOKEN_TTL) {
        delete this.store.tokens[token];
        delete at[token];
      }
    }
    if (!keepKey) return;
    const mine = Object.keys(this.store.tokens)
      .filter((token) => this.store.tokens[token] === keepKey)
      .sort((a, b) => (at[b] || 0) - (at[a] || 0));
    for (const token of mine.slice(TOKEN_PER_USER)) {
      delete this.store.tokens[token];
      delete at[token];
    }
  }

  // ------------------------------------------------------------- перебор пароля
  // Счётчики держим в хранилище объекта, а не в памяти: Durable Object может
  // выгрузиться между запросами, и тогда защита от перебора молча исчезала.
  authGate(addr) {
    const item = (this.store.authFails || {})[addr];
    if (!item) return 0;
    if (item.until > now()) return item.until - now();
    return 0;
  }

  async noteAuthFail(addr) {
    if (!this.store.authFails) this.store.authFails = {};
    const map = this.store.authFails;
    const stamp = now();
    const item = map[addr];
    if (!item || stamp - item.last > AUTH_WINDOW) {
      map[addr] = { count: 1, last: stamp, until: 0 };
    } else {
      item.count += 1;
      item.last = stamp;
      if (item.count >= AUTH_MAX_FAILS) {
        item.until = stamp + AUTH_WINDOW;
        item.count = 0;
      }
    }
    // Старые записи чистим, чтобы карта не росла бесконечно.
    for (const [key, value] of Object.entries(map)) {
      if (stamp - (value.last || 0) > AUTH_WINDOW * 4) delete map[key];
    }
    await this.save();
  }

  async clearAuthFail(addr) {
    if (!this.store.authFails || !this.store.authFails[addr]) return;
    delete this.store.authFails[addr];
    await this.save();
  }

  // ---------------------------------------------------------- ограничение частоты
  // Простое окно на пользователя: сообщения (всплеск и час) и создание каналов.
  isOwner(key) {
    return !!this.store.owner && this.store.owner === key;
  }

  // Сотрудник — это модератор: может удалять любые сообщения и выдавать мьют.
  isStaff(key) {
    return Array.isArray(this.store.staff) && this.store.staff.includes(key);
  }

  // Право на модерацию есть у владельца и сотрудников.
  canModerate(key) {
    return this.isOwner(key) || this.isStaff(key);
  }

  roleOf(key) {
    if (this.isOwner(key)) return 'owner';
    if (this.isStaff(key)) return 'staff';
    return 'member';
  }

  isMuted(user) {
    return !!(user && user.mutedUntil && user.mutedUntil > now());
  }

  rateAllow(key, bucket, limit, windowMs) {
    if (!this.store.rates) this.store.rates = {};
    const mine = this.store.rates[key] || (this.store.rates[key] = {});
    const stamp = now();
    const slot = mine[bucket];
    if (!slot || stamp >= slot.until) {
      mine[bucket] = { n: 1, until: stamp + windowMs };
      return { ok: true, retry: 0 };
    }
    if (slot.n >= limit) {
      return { ok: false, retry: Math.max(1, Math.ceil((slot.until - stamp) / 1000)) };
    }
    slot.n += 1;
    return { ok: true, retry: 0 };
  }

  // Проверяем два окна сразу: короткое (антифлуд) и часовое.
  checkMessageRate(key) {
    const burst = this.rateAllow(key, 'burst', MSG_BURST, MSG_BURST_WINDOW);
    if (!burst.ok) return burst;
    const hour = this.rateAllow(key, 'hour', MSG_HOURLY, 60 * 60 * 1000);
    if (!hour.ok) return hour;
    return { ok: true, retry: 0 };
  }

  // --------------------------------------------------------------- приглашения
  newInviteCode() {
    let code = '';
    const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_LEN));
    for (const b of bytes) code += INVITE_CODE_CHARS[b % INVITE_CODE_CHARS.length];
    return code;
  }

  inviteView(item) {
    return {
      code: item.code,
      uses: item.uses || 0,
      max: item.max || INVITE_USES,
      created: item.created || 0,
      by: item.by || '',
      usedBy: Array.isArray(item.usedBy) ? item.usedBy : [],
    };
  }

  // Экспорт базы для бэкапа: всё, кроме хэшей паролей и токенов.
  // Состав команды: владелец, сотрудники и заблокированные — для вкладки модерации.
  staffPayload() {
    const online = this.onlineNames().map((n) => n.toLowerCase());
    const view = (key) => {
      const user = this.store.users[key];
      if (!user) return null;
      const profile = this.profileView(user);
      return {
        name: user.name,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        online: online.includes(user.name.toLowerCase()),
        mutedUntil: user.mutedUntil || 0,
      };
    };
    const owner = this.store.owner ? view(this.store.owner) : null;
    const staff = (this.store.staff || []).map(view).filter(Boolean);
    const banned = Object.keys(this.store.banned || {}).map(view).filter(Boolean);
    return {
      t: 'staff_list',
      owner,
      staff,
      banned,
      canBan: true,
    };
  }

  // Экспорт базы для бэкапа: всё, кроме хэшей паролей и токенов.
  exportView() {
    const users = {};
    for (const [k, u] of Object.entries(this.store.users || {})) {
      users[k] = {
        name: u.name,
        color: u.color,
        created: u.created,
        friends: u.friends || [],
        incoming: u.incoming || [],
        outgoing: u.outgoing || [],
        profile: u.profile || null,
        settings: u.settings || null,
      };
    }
    return {
      exported: now(),
      version: APP_VERSION,
      owner: this.store.owner || '',
      inviteOnly: !!this.store.inviteOnly,
      channels: this.store.channels,
      users,
      rooms: this.store.rooms,
      invites: (this.store.invites || []).map((i) => this.inviteView(i)),
    };
  }

  // Утилиты
  sockets(tag) {
    return this.state.getWebSockets(tag);
  }

  allSockets() {
    return this.state.getWebSockets();
  }

  onlineNames() {
    const names = new Set();
    for (const ws of this.allSockets()) {
      const meta = ws.deserializeAttachment();
      if (!meta) continue;
      const user = this.store.users[meta.key];
      if (user && this.statusOf(user) !== 'invisible') names.add(user.name);
    }
    return [...names];
  }

  statusOf(user) {
    return mergeSettings(user && user.settings, null).status || 'online';
  }

  presencePayload() {
    const statuses = {};
    for (const ws of this.allSockets()) {
      const meta = ws.deserializeAttachment();
      if (!meta) continue;
      const user = this.store.users[meta.key];
      if (!user) continue;
      const st = this.statusOf(user);
      if (st !== 'invisible') statuses[user.name.toLowerCase()] = st;
    }
    return { t: 'presence', online: this.onlineNames(), statuses };
  }

  sendTo(key, payload) {
    if (!key) return;
    const text = JSON.stringify(payload);
    for (const ws of this.sockets(key)) {
      try { ws.send(text); } catch (_) { /* закрыт */ }
    }
  }

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.allSockets()) {
      try { ws.send(text); } catch (_) { /* закрыт */ }
    }
  }

  // Убирает сообщения и вложения тех, кого уже нет в базе (удалили аккаунт).
  // Сообщения из Matrix не трогаем: их автор — не пользователь мессенджера.
  async purgeOrphans() {
    const users = this.store.users || {};
    let removed = 0;
    for (const [room, list] of Object.entries(this.store.rooms || {})) {
      if (!Array.isArray(list) || !list.length) continue;
      const keep = list.filter((m) => {
        if (!m || m.external) return true;
        const owner = normalizeName(m.author);
        return !!users[owner];
      });
      if (keep.length !== list.length) {
        removed += list.length - keep.length;
        if (keep.length) this.store.rooms[room] = keep;
        else if (dmPartners(room)) delete this.store.rooms[room];
        else this.store.rooms[room] = [];
      }
    }
    // Вложения удалённых пользователей: освобождаем куски в хранилище.
    for (const id of Object.keys(this.store.media || {})) {
      const meta = this.store.media[id];
      if (!meta) continue;
      if (users[normalizeName(meta.by)]) continue;
      await this.dropMedia(id);
      removed += 1;
    }
    // Скрытые личные чаты удалённых тоже не нужны.
    for (const [owner, list] of Object.entries(this.store.hidden || {})) {
      if (!users[owner]) { delete this.store.hidden[owner]; continue; }
      const rest = (list || []).filter((other) => users[other]);
      if (rest.length !== (list || []).length) this.store.hidden[owner] = rest;
    }
    return removed;
  }

  profileView(user) {
    const p = (user && user.profile) || defaultProfile(user ? user.name : '', user ? user.color : '#5865f2');
    return {
      displayName: p.displayName || (user ? user.name : ''),
      avatar: p.avatar || '',
      avatarUrl: this.avatarUrlOf(user),
      accent: p.accent || (user ? user.color : '#5865f2'),
      bio: p.bio || '',
      banner: p.banner || '',
    };
  }

  // Ссылка на загруженную картинку аватара. ?v= меняется при каждой загрузке,
  // поэтому браузер не показывает старую картинку из кэша.
  avatarUrlOf(user) {
    if (!user || !this.store || !this.store.avatars) return '';
    const meta = this.store.avatars[normalizeName(user.name)];
    if (!meta) return '';
    return '/avatar/' + encodeURIComponent(normalizeName(user.name)) + '?v=' + meta.v;
  }

  stickerUrl(item) {
    return '/sticker/' + encodeURIComponent(item.id) + '?v=' + item.v;
  }

  stickerPackView() {
    return (this.store.stickers || []).map((s) => ({
      id: s.id,
      name: s.name,
      by: s.by,
      v: s.v,
      url: this.stickerUrl(s),
    }));
  }

  // Разбор картинки из base64: тип, содержимое и проверка размера.
  decodeImage(value, maxBytes) {
    const mime = String((value && value.mime) || '').toLowerCase();
    if (!IMAGE_TYPES.includes(mime)) return { error: 'нужен PNG, JPG, WEBP или GIF' };
    const b64 = String((value && value.data) || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return { error: 'не удалось прочитать картинку' };
    const bytes = Math.floor((b64.length * 3) / 4);
    if (bytes > maxBytes) return { error: 'файл больше ' + Math.round(maxBytes / 1024) + ' КБ' };
    return { mime, b64, bytes };
  }

  imageResponse(saved) {
    const binary = atob(String(saved.b64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Response(bytes, {
      headers: {
        'content-type': saved.mime || 'image/png',
        'content-length': String(bytes.length),
        'cache-control': 'public, max-age=604800, immutable',
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // ------------------------------------------------------- вложения 1.4.0
  // Метаданные для клиента: id, ссылка, тип и размер.
  mediaView(meta) {
    if (!meta) return null;
    return { id: meta.id, url: '/media/' + meta.id, mime: meta.mime, size: meta.size };
  }

  // Удаляем вложение вместе со всеми кусками.
  async dropMedia(id) {
    const meta = this.store.media ? this.store.media[id] : null;
    const chunks = meta ? Number(meta.chunks) || 0 : 0;
    for (let i = 0; i < chunks; i += 1) {
      await this.state.storage.delete('media:' + id + ':' + i);
    }
    if (meta) delete this.store.media[id];
  }

  // Оставляем только MEDIA_LIMIT последних вложений (по времени загрузки).
  async trimMedia() {    const media = this.store.media || {};
    const ids = Object.keys(media).sort((a, b) => (media[b].ts || 0) - (media[a].ts || 0));
    for (const id of ids.slice(MEDIA_LIMIT)) await this.dropMedia(id);
  }

  // Читаем тело вложения с ограничением: лишнее вычитываем и выбрасываем,
  // чтобы не держать в памяти мегабайты и не рвать соединение.
  async readBodyLimited(request, limit) {
    if (!request.body) return { bytes: new Uint8Array(0) };
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    let tooBig = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      if (tooBig) continue;
      size += value.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
      } else {
        chunks.push(value);
      }
    }
    if (tooBig) return { tooBig: true };
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { bytes };
  }

  // POST /media-upload: тело — сырые байты картинки, токен — в x-token.
  async handleMediaUpload(request) {
    // Тело читаем сразу и до конца: если ответить, не вычитав поток, соединение
    // обрывается (видно на wrangler dev), поэтому проверки идут после чтения.
    const read = await this.readBodyLimited(request, MEDIA_MAX_BYTES);
    const token = String(request.headers.get('x-token') || '').trim();
    const owner = token ? this.store.tokens[token] : '';
    if (!owner || !this.store.users[owner]) {
      return jsonResponse({ error: 'Плохой токен или сеанс истёк' }, 401);
    }
    const mime = String(request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(mime)) {
      return jsonResponse({ error: 'Нужен PNG, JPG, WEBP или GIF' }, 400);
    }
    if (read.tooBig) return jsonResponse({ error: 'Картинка больше 2,5 МБ' }, 400);
    const bytes = read.bytes;
    if (!bytes.length) return jsonResponse({ error: 'Пустая картинка' }, 400);
    if (!imageSignatureOk(bytes, mime)) return jsonResponse({ error: 'Это не похоже на картинку' }, 400);

    const id = randomHex(8);
    const chunks = Math.ceil(bytes.length / MEDIA_CHUNK);
    for (let i = 0; i < chunks; i += 1) {
      await this.state.storage.put('media:' + id + ':' + i, bytes.slice(i * MEDIA_CHUNK, (i + 1) * MEDIA_CHUNK));
    }
    if (!this.store.media) this.store.media = {};
    this.store.media[id] = { id, mime, size: bytes.length, chunks, by: owner, ts: now() };
    await this.trimMedia();
    await this.save();
    return jsonResponse(this.mediaView(this.store.media[id]));
  }

  // GET /media/<id>: собираем куски и отдаём байты.
  async serveMedia(url) {
    const id = String(url.pathname.slice('/media/'.length) || '').replace(/[^a-z0-9]/gi, '');
    const meta = id && this.store.media ? this.store.media[id] : null;
    if (!meta) {
      return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    const parts = [];
    let size = 0;
    for (let i = 0; i < (Number(meta.chunks) || 0); i += 1) {
      const part = await this.state.storage.get('media:' + id + ':' + i);
      if (!part) break;
      const bytes = part instanceof Uint8Array ? part : new Uint8Array(part);
      parts.push(bytes);
      size += bytes.length;
    }
    if (!size) {
      return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return new Response(out, {
      headers: {
        'content-type': meta.mime || 'application/octet-stream',
        'content-length': String(out.length),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'access-control-allow-origin': '*',
      },
    });
  }

  // ------------------------------------------------------- Web Push 1.4.0
  // Валидация подписки из браузера.
  pushSubscription(raw) {
    const sub = raw && typeof raw === 'object' ? raw : {};
    const endpoint = String(sub.endpoint || '').trim();
    if (!/^https:\/\/[^\s]+$/i.test(endpoint) || endpoint.length > 500) return null;
    const keys = sub.keys && typeof sub.keys === 'object' ? sub.keys : {};
    const p256dh = String(keys.p256dh || '').trim();
    const auth = String(keys.auth || '').trim();
    if (!p256dh || p256dh.length > 200 || !/^[A-Za-z0-9_\-+/=]+$/.test(p256dh)) return null;
    if (!auth || auth.length > 100 || !/^[A-Za-z0-9_\-+/=]+$/.test(auth)) return null;
    return { endpoint, keys: { p256dh, auth }, ts: now() };
  }

  // Личный ключ и подпись JWT для VAPID (ES256, raw r||s от WebCrypto).
  async vapidKey() {
    if (this.vapidPrivate) return this.vapidPrivate;
    const vapid = this.store.vapid;
    if (!vapid || !vapid.priv) return null;
    this.vapidPrivate = await crypto.subtle.importKey(
      'jwk',
      vapid.priv,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    return this.vapidPrivate;
  }

  async vapidJwt(audience) {
    const vapid = this.store.vapid;
    if (!vapid || !vapid.pub) return '';
    if (!this.vapidJwts) this.vapidJwts = new Map();
    const stamp = now();
    const cached = this.vapidJwts.get(audience);
    if (cached && cached.until > stamp) return cached.jwt;
    const key = await this.vapidKey();
    if (!key) return '';
    const header = jsonBase64Url({ typ: 'JWT', alg: 'ES256' });
    const payload = jsonBase64Url({
      aud: audience,
      exp: Math.floor(stamp / 1000) + 6 * 3600,
      sub: vapid.sub || 'mailto:admin@example.com',
    });
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      enc.encode(header + '.' + payload)
    );
    const jwt = header + '.' + payload + '.' + bytesToBase64Url(signature);
    this.vapidJwts.set(audience, { jwt, until: stamp + 3600 * 1000 });
    return jwt;
  }

  // Отправляем пустой push. Ошибки не должны ломать чат.
  async pushSend(sub) {
    try {
      if (!sub || !sub.endpoint) return;
      const audience = new URL(sub.endpoint).origin;
      const jwt = await this.vapidJwt(audience);
      if (!jwt) return;
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          TTL: String(PUSH_TTL),
          Urgency: 'normal',
          Authorization: 'vapid t=' + jwt + ', k=' + this.store.vapid.pub,
        },
      });
      if (res.status === 404 || res.status === 410) {
        await this.dropPush(sub.endpoint);
        return;
      }
      try { await res.arrayBuffer(); } catch (_) { /* тело не нужно */ }
    } catch (_) {
      // нет сети или сервис push недоступен — молчим
    }
  }

  async dropPush(endpoint) {
    if (!this.store.push || !endpoint) return;
    let changed = false;
    for (const [who, list] of Object.entries(this.store.push)) {
      if (!Array.isArray(list)) continue;
      const rest = list.filter((item) => item && item.endpoint !== endpoint);
      if (rest.length !== list.length) {
        changed = true;
        if (rest.length) this.store.push[who] = rest;
        else delete this.store.push[who];
      }
    }
    if (changed) await this.save();
  }

  // Уведомляем тех, у кого нет живых сокетов. Не блокирует ответ.
  pushNotify(message, authorKey) {
    try {
      const vapid = this.store.vapid;
      if (!vapid || !vapid.pub || !this.store.push) return;
      const dm = dmPartners(message.room);
      const targets = dm ? [dm[0] === authorKey ? dm[1] : dm[0]] : Object.keys(this.store.push);
      const tasks = [];
      for (const who of targets) {
        if (!who || who === authorKey) continue;
        const list = this.store.push[who];
        if (!Array.isArray(list) || !list.length) continue;
        if (this.sockets(who).length > 0) continue; // человек и так в приложении
        for (const sub of list.slice()) tasks.push(this.pushSend(sub));
      }
      if (!tasks.length) return;
      const task = Promise.all(tasks.map((p) => p.catch(() => {}))).then(() => {});
      try {
        this.state.waitUntil(task);
      } catch (_) {
        task.catch(() => {});
      }
    } catch (_) {
      // push не должен ломать чат
    }
  }

  friendsView(key) {
    const online = this.onlineNames().map((n) => n.toLowerCase());
    const me = this.store.users[key];
    const render = (keys) => (keys || [])
      .map((k) => this.store.users[k])
      .filter(Boolean)
      .map((u) => {
        const isOnline = online.includes(u.name.toLowerCase());
        const status = this.statusOf(u);
        return {
          name: u.name,
          color: u.color,
          online: isOnline,
          // «Невидимка» для остальных выглядит как «не в сети».
          status: isOnline && status !== 'invisible' ? status : 'offline',
          ...this.profileView(u),
        };
      });
    return {
      t: 'friends',
      friends: render(me && me.friends),
      incoming: render(me && me.incoming),
      outgoing: render(me && me.outgoing),
    };
  }

  // После смены аватара/имени обновляем список друзей только у тех, кто
  // действительно связан с этим человеком. Раньше чужой список уходил всем.
  pushFriendsViews(key) {
    for (const [otherKey, other] of Object.entries(this.store.users)) {
      if (otherKey === key) {
        this.sendTo(key, this.friendsView(key));
        continue;
      }
      const links = [
        ...(other.friends || []),
        ...(other.incoming || []),
        ...(other.outgoing || []),
      ];
      if (links.includes(key)) this.sendTo(otherKey, this.friendsView(otherKey));
    }
  }

  dmList(key) {
    const items = [];
    for (const [room, messages] of Object.entries(this.store.rooms)) {
      const pair = dmPartners(room);
      if (!pair) continue;
      if (pair[0] !== key && pair[1] !== key) continue;
      const otherKey = pair[0] === key ? pair[1] : pair[0];
      const other = this.store.users[otherKey];
      if (!other) continue;
      if ((this.store.hidden && this.store.hidden[key] || []).includes(otherKey)) continue;
      const last = messages[messages.length - 1];
      const otherView = this.profileView(other);
      items.push({
        room,
        name: other.name,
        color: other.color,
        displayName: otherView.displayName,
        avatar: otherView.avatar,
        avatarUrl: otherView.avatarUrl,
        last_text: last ? clip(last.text || (last.sticker ? '[стикер]' : ''), 40) : '',
        last_ts: last ? last.ts : 0,
      });
    }
    items.sort((a, b) => b.last_ts - a.last_ts);
    return items;
  }

  pushMessage(room, message) {
    if (!this.store.rooms[room]) this.store.rooms[room] = [];
    const list = this.store.rooms[room];
    list.push(message);
    while (list.length > HISTORY_LIMIT) list.shift();
  }

  voiceRoomOf(name) {
    for (const [room, members] of this.voice) {
      for (const memberName of members.keys()) {
        if (memberName.toLowerCase() === String(name).toLowerCase()) return room;
      }
    }
    return '';
  }

  voiceState(room) {
    const members = this.voice.get(room);
    return {
      t: 'voice_state',
      room,
      limit: VOICE_LIMIT,
      users: members ? [...members.values()] : [],
    };
  }

  voiceRemove(name) {
    let left = null;
    for (const [room, members] of this.voice) {
      for (const [memberName] of members) {
        if (memberName.toLowerCase() === name.toLowerCase()) {
          members.delete(memberName);
          left = room;
          break;
        }
      }
      if (members.size === 0) this.voice.delete(room);
    }
    return left;
  }

  // ------------------------------------------------------------- запросы
  async fetch(request) {
    const url = new URL(request.url);
    await this.ensure();

    // Загрузка вложений-картинок идёт обычным HTTP-запросом, а не кадром WS.
    if (url.pathname === '/media-upload') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Нужен POST' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'POST' },
        });
      }
      return this.handleMediaUpload(request);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
      return this.serveMedia(url);
    }

    // Картинки аватаров и стикеров: отдаём прямо из хранилища объекта.
    if (request.method === 'GET' && url.pathname.startsWith('/avatar/')) {
      const who = normalizeName(decodeURIComponent(url.pathname.slice('/avatar/'.length)));
      const saved = await this.state.storage.get('avatar:' + who);
      if (!saved) return new Response('not found', { status: 404 });
      return this.imageResponse(saved);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/sticker/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop() || '');
      const saved = await this.state.storage.get('sticker:' + id);
      if (!saved) return new Response('not found', { status: 404 });
      return this.imageResponse(saved);
    }

    // Разовая уборка: убирает сообщения и вложения удалённых аккаунтов.
    // Ничего, кроме «сирот», не трогает, поэтому безопасна и без пароля.
    if (url.pathname === '/purge-orphans' && request.method === 'POST') {
      const removed = await this.purgeOrphans();
      await this.save();
      this.broadcast(this.presencePayload());
      return new Response(JSON.stringify({ ok: true, removed }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // Экспорт базы (бэкап): только владелец, токен в x-token.
    if (url.pathname === '/export' && request.method === 'GET') {
      const token = String(request.headers.get('x-token') || '').trim();
      const owner = token ? this.store.tokens[token] : '';
      if (!owner || !this.store.users[owner]) {
        return new Response(JSON.stringify({ error: 'Нужен вход' }), {
          status: 401,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (!this.isOwner(owner)) {
        return new Response(JSON.stringify({ error: 'Экспорт доступен только владельцу' }), {
          status: 403,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      return new Response(JSON.stringify(this.exportView(), null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/auth') return this.handleAuth(request, url);

    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      return this.handleSocket(request, url);
    }
    return new Response('not found', { status: 404 });
  }

  async handleAuth(request, url) {
    const action = url.searchParams.get('action') || 'login';
    let body = {};
    try { body = await request.json(); } catch (_) { /* пусто */ }
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    const addr = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'local';

    const fail = (text, code = 400) =>
      new Response(JSON.stringify({ error: text }), {
        status: code,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });

    if (!validName(name)) return fail('Имя: 2–20 символов, буквы, цифры, _ и -');
    if (password.length < 4) return fail('Пароль: не короче 4 символов');

    const key = normalizeName(name);
    const existing = this.store.users[key];

    if (action === 'register') {
      if (existing) return fail('Такое имя уже занято');
      // Заблокированный аккаунт новый не заводит: сначала владелец снимет бан.
      if (this.store.banned && this.store.banned[key]) {
        return fail('Это имя заблокировано', 403);
      }

      // Регистрация «для своих»: первый аккаунт становится владельцем и
      // заводится свободно, остальным нужен код-приглашение.
      const hasUsers = Object.keys(this.store.users).length > 0;
      let invite = null;
      if (hasUsers && this.store.inviteOnly) {
        const code = String(body.invite || '').trim().toUpperCase();
        invite = code ? (this.store.invites || []).find((i) => i.code === code && (i.uses || 0) < (i.max || INVITE_USES)) : null;
        if (!invite) {
          return new Response(JSON.stringify({ error: 'Нужен код приглашения', inviteRequired: true }), {
            status: 403,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
        }
      }

      const salt = randomHex(16);
      const color = colorFor(name);
      const user = {
        key,
        name,
        salt,
        algo: 'pbkdf2',
        pass: await hashPassword(password, salt),
        color,
        created: now(),
        friends: [],
        incoming: [],
        outgoing: [],
        profile: defaultProfile(name, color),
        settings: defaultSettings(),
      };
      this.store.users[key] = user;
      if (!hasUsers) this.store.owner = key;
      if (invite) {
        invite.uses = (invite.uses || 0) + 1;
        invite.usedBy = Array.isArray(invite.usedBy) ? invite.usedBy : [];
        invite.usedBy.push(name);
      }
      const token = this.mintToken(key);
      await this.save();
      return new Response(JSON.stringify({ token, name: user.name, color: user.color, isOwner: this.store.owner === key }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    // Вход: после нескольких неудач с одного адреса просим подождать.
    const wait = this.authGate(addr);
    if (wait > 0) {
      return fail('Слишком много попыток входа. Подождите ' + Math.ceil(wait / 1000) + ' с.', 429);
    }
    if (!existing) {
      await this.noteAuthFail(addr);
      return fail('Неверное имя или пароль');
    }
    if (!(await verifyPassword(password, existing))) {
      await this.noteAuthFail(addr);
      return fail('Неверное имя или пароль');
    }
    await this.clearAuthFail(addr);
    // Заблокированный аккаунт не входит, даже с верным паролем.
    if (existing.banned || (this.store.banned && this.store.banned[key])) {
      existing.banned = true;
      await this.save();
      return fail('Аккаунт заблокирован модератором', 403);
    }
    // Старый SHA-256-хэш заменяем на PBKDF2 прямо при успешном входе.
    if (existing.algo !== 'pbkdf2') {
      existing.pass = await hashPassword(password, existing.salt);
      existing.algo = 'pbkdf2';
    }
    const token = this.mintToken(key);
    await this.save();
    return new Response(JSON.stringify({
      token,
      name: existing.name,
      color: existing.color,
      role: this.roleOf(key),
      isOwner: this.isOwner(key),
      isStaff: this.isStaff(key),
    }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  handleSocket(request, url) {
    const token = url.searchParams.get('token') || '';
    const owner = this.store.tokens[token];
    const user = owner ? this.store.users[owner] : null;
    if (!user) return new Response('unauthorized', { status: 401 });
    // Заблокированный аккаунт не подключается даже со старым токеном.
    if (user.banned || (this.store.banned && this.store.banned[owner])) {
      return new Response('banned', { status: 403 });
    }
    const key = owner;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [key]);
    server.serializeAttachment({ key, name: user.name, token });

    server.send(JSON.stringify({
      t: 'hello',
      version: APP_VERSION,
      pushKey: this.store.vapid ? this.store.vapid.pub || '' : '',
      // Права этого аккаунта и режим регистрации — клиент показывает по ним
      // вкладку управления и подсказки на экране входа.
      isOwner: this.store.owner === key,
      // Владелец тоже может модерировать, поэтому для него isStaff — true.
      isStaff: this.canModerate(key),
      role: this.roleOf(key),
      inviteOnly: !!this.store.inviteOnly,
      me: {
        name: user.name,
        color: user.color,
        profile: this.profileView(user),
        joined: user.created || 0,
        status: this.statusOf(user),
        settings: mergeSettings(user.settings, null),
      },
      channels: this.store.channels,
      avatars: Object.keys(this.store.avatars || {}).map((k) => ({
        name: normalizeName(k),
        url: '/avatar/' + encodeURIComponent(k) + '?v=' + this.store.avatars[k].v,
      })),
    }));
    server.send(JSON.stringify({ t: 'dm_list', items: this.dmList(key) }));
    server.send(JSON.stringify({ t: 'sticker_pack', items: this.stickerPackView() }));
    server.send(JSON.stringify(this.friendsView(key)));
    this.broadcast(this.presencePayload());

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.ensure();
    const meta = ws.deserializeAttachment();
    if (!meta) return;
    const key = meta.key;
    const user = this.store.users[key];
    if (!user) return;
    const name = user.name;

    let value;
    try { value = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch (_) {
      return;
    }
    const kind = value.t || '';

    // Проверка живости соединения: браузер не умеет отправлять ping-кадры,
    // поэтому клиент раз в полминуты шлёт это сообщение.
    if (kind === 'ping') {
      this.sendTo(key, { t: 'pong', ts: now() });
      return;
    }

    if (kind === 'logout') {
      delete this.store.tokens[meta.token];
      if (this.store.tokenAt) delete this.store.tokenAt[meta.token];
      await this.save();
      this.sendTo(key, { t: 'logged_out' });
      try { ws.close(1000, 'logout'); } catch (_) { /* уже закрыт */ }
      return;
    }

    if (kind === 'join' || kind === 'dm_open') {
      let room;
      if (kind === 'dm_open') {
        const other = this.findUserKey(value.name);
        if (!other || other === key) {
          this.sendTo(key, { t: 'error', text: 'Такого пользователя нет' });
          return;
        }
        room = dmRoom(key, other);
        if (this.store.hidden && Array.isArray(this.store.hidden[key])) {
          const rest = this.store.hidden[key].filter((n) => n !== other);
          if (rest.length !== this.store.hidden[key].length) this.store.hidden[key] = rest;
        }
        const otherUser = this.store.users[other];
        const otherSettings = mergeSettings(otherUser.settings, null);
        const areFriends = (user.friends || []).includes(other);
        if (otherSettings.dmPrivacy === 'friends' && !areFriends) {
          this.sendTo(key, { t: 'error', text: `${otherUser.name} принимает личные сообщения только от друзей` });
          return;
        }
        if (!this.store.rooms[room]) {
          this.store.rooms[room] = [];
          await this.save();
        }
      } else {
        room = String(value.room || '');
      }
      const isChannel = this.store.channels.includes(room);
      const pair = dmPartners(room);
      const isDm = pair ? pair[0] === key || pair[1] === key : false;
      if (!isChannel && !isDm) return;
      this.sendTo(key, { t: 'history', room, messages: this.store.rooms[room] || [] });
      this.sendTo(key, { t: 'dm_list', items: this.dmList(key) });
      return;
    }

    if (kind === 'msg') {
      const room = String(value.room || '');
      const body = String(value.text || '').trim();
      const stickerId = String(value.sticker || '');
      const sticker = stickerId ? (this.store.stickers || []).find((s) => s.id === stickerId) : null;
      if (stickerId && !sticker) return;
      // Вложение: оно должно существовать и быть загружено этим же человеком.
      const mediaId = String(value.mediaId || '').trim();
      const mediaMeta = mediaId && this.store.media ? this.store.media[mediaId] : null;
      if (mediaId && !mediaMeta) return;
      if (mediaMeta && mediaMeta.by !== key) return;
      if ((!body && !sticker && !mediaMeta) || [...body].length > MAX_TEXT_CHARS) return;
      const isChannel = this.store.channels.includes(room);
      const pair = dmPartners(room);
      const isDm = pair ? pair[0] === key || pair[1] === key : false;
      if (!isChannel && !isDm) return;
      // Антифлуд: иначе один человек за минуту забьёт всю историю канала.
      const rate = this.checkMessageRate(key);
      // Заблокированный не пишет вовсе, замьюченный — до конца срока.
      if (user.banned || (this.store.banned && this.store.banned[key])) {
        this.sendTo(key, { t: 'error', text: 'Аккаунт заблокирован' });
        return;
      }
      if (this.isMuted(user)) {
        const left = Math.ceil((user.mutedUntil - now()) / 60000);
        this.sendTo(key, { t: 'error', text: 'Вам запрещено писать ещё ' + left + ' мин.' });
        return;
      }
      if (!rate.ok) {
        this.sendTo(key, { t: 'error', text: 'Слишком часто. Подождите ' + rate.retry + ' с.' });
        return;
      }
      // Личка подчиняется настройке получателя «только от друзей».
      if (pair) {
        const otherKey = pair[0] === key ? pair[1] : pair[0];
        const other = this.store.users[otherKey];
        if (other) {
          const priv = mergeSettings(other.settings, null).dmPrivacy;
          if (priv === 'friends' && !(other.friends || []).includes(key)) {
            this.sendTo(key, { t: 'error', text: `${other.name} принимает личные сообщения только от друзей` });
            return;
          }
        }
      }
      this.store.seq = (this.store.seq || 0) + 1;
      // Ответ: снимок оригинала ищем только в этой же комнате.
      let reply = null;
      const replyTo = Number(value.replyTo);
      if (replyTo > 0) {
        const target = (this.store.rooms[room] || []).find((m) => m && m.id === replyTo);
        if (target) {
          reply = {
            id: target.id,
            author: target.author,
            text: head(target.text, 100),
            sticker: !!target.sticker,
          };
        }
      }
      const message = {
        id: this.store.seq,
        room,
        author: name,
        text: body,
        sticker: sticker ? { id: sticker.id, name: sticker.name, url: this.stickerUrl(sticker) } : null,
        ts: now(),
        authorProfile: this.profileView(user),
      };
      if (reply) message.reply = reply;
      if (mediaMeta) message.media = this.mediaView(mediaMeta);
      this.pushMessage(room, message);
      await this.save();
      this.pushNotify(message, key);
      const event = { t: 'msg', ...message };
      if (pair) {
        this.sendTo(pair[0], event);
        this.sendTo(pair[1], event);
        this.sendTo(pair[0], { t: 'dm_list', items: this.dmList(pair[0]) });
        this.sendTo(pair[1], { t: 'dm_list', items: this.dmList(pair[1]) });
      } else {
        this.broadcast(event);
        this.matrixOut(room, message);
      }
      return;
    }

    // Реакции (1.4.0): одна на пользователя на эмодзи, повторный клик снимает.
    if (kind === 'msg_react') {
      const room = String(value.room || '');
      const id = Number(value.id);
      const emoji = reactionEmoji(value.emoji);
      if (!emoji || !id) return;
      const isChannel = this.store.channels.includes(room);
      const pair = dmPartners(room);
      const isDm = pair ? pair[0] === key || pair[1] === key : false;
      if (!isChannel && !isDm) return;
      const list = this.store.rooms[room];
      if (!list) return;
      const target = list.find((m) => m && m.id === id);
      if (!target) return;
      if (!target.reactions || typeof target.reactions !== 'object') target.reactions = {};
      const reactions = target.reactions;
      const names = Array.isArray(reactions[emoji]) ? reactions[emoji].slice() : [];
      const at = names.indexOf(name);
      if (at >= 0) {
        names.splice(at, 1);
      } else {
        // Больше REACTION_KINDS разных эмодзи на одно сообщение не пускаем.
        if (Object.keys(reactions).length >= REACTION_KINDS) {
          this.sendTo(key, { t: 'error', text: 'На сообщении уже ' + REACTION_KINDS + ' разных реакций' });
          return;
        }
        names.push(name);
      }
      if (names.length) reactions[emoji] = names;
      else delete reactions[emoji];
      await this.save();
      const event = { t: 'msg_reaction', room, id, reactions };
      if (pair) {
        this.sendTo(pair[0], event);
        this.sendTo(pair[1], event);
      } else {
        this.broadcast(event);
      }
      return;
    }

    // Поиск по истории: каналы и свои личные чаты (1.4.0).
    if (kind === 'search_messages') {
      const q = head(String(value.q || '').trim(), 100);
      const wanted = String(value.room || '');
      const hits = [];
      if ([...q].length >= 2) {
        const needle = q.toLowerCase();
        for (const room of Object.keys(this.store.rooms)) {
          const pair = dmPartners(room);
          if (pair) {
            // В чужую личку не заглядываем.
            if (pair[0] !== key && pair[1] !== key) continue;
          } else if (!this.store.channels.includes(room)) {
            continue;
          }
          if (wanted && room !== wanted) continue;
          for (const m of this.store.rooms[room] || []) {
            if (!m) continue;
            const text = String(m.text || '');
            if (!text || !text.toLowerCase().includes(needle)) continue;
            hits.push({ room, id: m.id, author: m.author, text: head(text, 200), ts: m.ts || 0 });
          }
        }
        hits.sort((a, b) => (b.ts || 0) - (a.ts || 0) || (b.id || 0) - (a.id || 0));
      }
      this.sendTo(key, { t: 'search_results', q, hits: hits.slice(0, 40) });
      return;
    }

    // Web Push (1.4.0): подписка и отписка устройства.
    if (kind === 'push_subscribe') {
      const sub = this.pushSubscription(value.subscription);
      if (!sub) {
        this.sendTo(key, { t: 'error', text: 'Некорректная подписка на уведомления' });
        return;
      }
      if (!this.store.push) this.store.push = {};
      const list = Array.isArray(this.store.push[key]) ? this.store.push[key] : [];
      const next = list.filter((item) => item && item.endpoint !== sub.endpoint);
      next.push(sub);
      while (next.length > PUSH_SUB_LIMIT) next.shift();
      this.store.push[key] = next;
      await this.save();
      this.sendTo(key, { t: 'notice', text: 'Уведомления включены' });
      return;
    }

    if (kind === 'push_unsubscribe') {
      if (this.store.push) delete this.store.push[key];
      await this.save();
      this.sendTo(key, { t: 'notice', text: 'Уведомления выключены' });
      return;
    }

    if (kind === 'matrix_get') {
      this.sendTo(key, { t: 'matrix_state', matrix: mxPublic(this.store.matrix) });
      return;
    }

    if (kind === 'matrix_set' || kind === 'matrix_test') {
      const patch = value && typeof value === 'object' ? value : {};
      const next = mxNorm({ ...this.store.matrix, ...patch });
      // В поле на экране лежит маска «…abcd»: она не должна затирать токен.
      const given = typeof patch.token === 'string' ? patch.token.trim() : '';
      if (!given || given.startsWith('…')) next.token = this.store.matrix.token || '';
      if (kind === 'matrix_test') {
        const who = await mxWhoami(next);
        if (who.ok) {
          next.userId = who.userId;
          next.status = 'ok';
          next.message = 'Подключено как ' + who.userId;
        } else {
          next.status = 'error';
          next.message = who.error;
        }
        next.updatedAt = Date.now();
        this.store.matrix = next;
        await this.save();
        this.sendTo(key, { t: 'matrix_state', matrix: mxPublic(next), test: who });
        if (next.enabled) this.armMatrixAlarm();
        return;
      }
      if (!next.homeserver || !next.token || !next.roomId) {
        next.enabled = false;
        next.status = 'off';
        next.message = 'Нужны адрес сервера, access token и комната';
      } else if (next.enabled) {
        next.status = next.status === 'error' ? 'error' : 'ok';
        next.message = next.status === 'error' ? next.message : 'Мост включён';
      } else {
        next.status = 'off';
        next.message = 'Мост выключен';
      }
      next.updatedAt = Date.now();
      this.store.matrix = next;
      await this.save();
      this.sendTo(key, { t: 'matrix_state', matrix: mxPublic(next) });
      if (next.enabled) {
        this.armMatrixAlarm();
        this.matrixPull(true);
      }
      return;
    }

    if (kind === 'matrix_pull') {
      const res = await this.matrixPull(true);
      this.sendTo(key, { t: 'matrix_state', matrix: mxPublic(this.store.matrix), pull: res });
      return;
    }

    if (kind === 'typing') {
      const room = String(value.room || '');
      const isChannel = this.store.channels.includes(room);
      const pair = dmPartners(room);
      const isDm = pair ? pair[0] === key || pair[1] === key : false;
      if (!isChannel && !isDm) return;
      const event = {
        t: 'typing',
        room,
        name,
        displayName: this.profileView(user).displayName,
        stopped: !!value.stopped,
      };
      // В личке «печатает…» не должен улетать всем подряд.
      if (pair) {
        this.sendTo(pair[0], event);
        this.sendTo(pair[1], event);
      } else {
        this.broadcast(event);
      }
      return;
    }

    if (kind === 'msg_delete') {
      const id = Number(value.id);
      const room = String(value.room || '');
      const list = this.store.rooms[room];
      if (!list || !id) return;
      const idx = list.findIndex((m) => m.id === id);
      if (idx < 0) return;
      if (String(list[idx].author).toLowerCase() !== name.toLowerCase() && !this.canModerate(key)) {
        this.sendTo(key, { t: 'error', text: 'Удалять можно только свои сообщения' });
        return;
      }
      const wasMine = String(list[idx].author).toLowerCase() === name.toLowerCase();
      const authorName = String(list[idx].author || '');
      list.splice(idx, 1);
      await this.save();
      const event = { t: 'msg_delete', room, id };
      const pair = dmPartners(room);
      if (pair) {
        this.sendTo(pair[0], event);
        this.sendTo(pair[1], event);
      } else {
        this.broadcast(event);
      }
      // Владелец удалил чужое — автору сообщения говорим об этом прямо.
      if (!wasMine && authorName) {
        const authorKey = normalizeName(authorName);
        if (authorKey !== key) {
          this.sendTo(authorKey, { t: 'notice', text: 'Владелец удалил ваше сообщение' });
        }
      }
      return;
    }

    // ------------------------------------------------------- управление (владелец)
    if (kind === 'invite_create') {
      if (!this.isOwner(key)) {
        this.sendTo(key, { t: 'error', text: 'Приглашения создаёт владелец' });
        return;
      }
      if (!Array.isArray(this.store.invites)) this.store.invites = [];
      if (this.store.invites.length >= INVITE_LIMIT) {
        this.sendTo(key, { t: 'error', text: 'Кодов уже ' + INVITE_LIMIT + ' — удалите ненужные' });
        return;
      }
      const max = Math.min(50, Math.max(1, Number(value.max) || INVITE_USES));
      const item = { code: this.newInviteCode(), by: name, created: now(), uses: 0, max, usedBy: [] };
      this.store.invites.push(item);
      await this.save();
      const origin = 'https://rust-messenger.sg530507.workers.dev';
      this.sendTo(key, {
        t: 'invite_created',
        invite: this.inviteView(item),
        text: 'Код готов: ' + item.code + ' · ссылка ' + origin + '/?invite=' + item.code,
      });
      return;
    }

    if (kind === 'invite_list') {
      if (!this.isOwner(key)) return;
      this.sendTo(key, {
        t: 'invite_list',
        invites: (this.store.invites || []).map((i) => this.inviteView(i)),
        inviteOnly: !!this.store.inviteOnly,
      });
      return;
    }

    if (kind === 'invite_revoke') {
      if (!this.isOwner(key)) {
        this.sendTo(key, { t: 'error', text: 'Это может только владелец' });
        return;
      }
      const code = String(value.code || '').trim().toUpperCase();
      const before = (this.store.invites || []).length;
      this.store.invites = (this.store.invites || []).filter((i) => i.code !== code);
      if (this.store.invites.length === before) return;
      await this.save();
      this.sendTo(key, { t: 'invite_list', invites: this.store.invites.map((i) => this.inviteView(i)), inviteOnly: !!this.store.inviteOnly });
      this.sendTo(key, { t: 'notice', text: 'Код ' + code + ' отозван' });
      return;
    }

    if (kind === 'invite_only') {
      if (!this.isOwner(key)) {
        this.sendTo(key, { t: 'error', text: 'Это может только владелец' });
        return;
      }
      this.store.inviteOnly = !!value.enabled;
      await this.save();
      this.sendTo(key, { t: 'invite_list', invites: (this.store.invites || []).map((i) => this.inviteView(i)), inviteOnly: !!this.store.inviteOnly });
      this.sendTo(key, { t: 'notice', text: this.store.inviteOnly ? 'Регистрация только по кодам' : 'Регистрация открыта всем' });
      return;
    }

    if (kind === 'export_all') {
      if (!this.isOwner(key)) {
        this.sendTo(key, { t: 'error', text: 'Экспорт доступен только владельцу' });
        return;
      }
      const data = this.exportView();
      this.sendTo(key, { t: 'export_ready', data });
      return;
    }

    // ------------------------------------------------ сотрудники и модерация
    if (kind === 'staff_list') {
      if (!this.canModerate(key)) return;
      this.sendTo(key, this.staffPayload());
      return;
    }

    if (kind === 'staff_add' || kind === 'staff_remove') {
      if (!this.isOwner(key)) {
        this.sendTo(key, { t: 'error', text: 'Сотрудников назначает владелец' });
        return;
      }
      const target = this.findUserKey(value.name);
      if (!target || target === key) {
        this.sendTo(key, { t: 'error', text: 'Некого назначать' });
        return;
      }
      if (!Array.isArray(this.store.staff)) this.store.staff = [];
      if (kind === 'staff_add') {
        if (!this.store.staff.includes(target)) this.store.staff.push(target);
      } else {
        this.store.staff = this.store.staff.filter((k) => k !== target);
      }
      await this.save();
      const other = this.store.users[target];
      this.sendTo(target, {
        t: 'role_changed',
        role: this.roleOf(target),
        isStaff: this.isStaff(target),
        isOwner: this.isOwner(target),
      });
      this.sendTo(target, {
        t: 'notice',
        text: kind === 'staff_add' ? 'Вы назначены сотрудником: можно удалять любые сообщения и выдавать мьют' : 'Вы больше не сотрудник',
      });
      this.sendTo(key, this.staffPayload());
      this.broadcast(this.presencePayload());
      // Обновляем карточки у тех, кто смотрит список сотрудников.
      for (const ws of this.allSockets()) {
        const meta = ws.deserializeAttachment();
        if (meta && this.canModerate(meta.key)) this.sendTo(meta.key, this.staffPayload());
      }
      return;
    }

    if (kind === 'user_mute' || kind === 'user_unmute') {
      if (!this.canModerate(key)) {
        this.sendTo(key, { t: 'error', text: 'Мьют выдаёт владелец или сотрудник' });
        return;
      }
      const target = this.findUserKey(value.name);
      if (!target) {
        this.sendTo(key, { t: 'error', text: 'Такого пользователя нет' });
        return;
      }
      if (this.isOwner(target)) {
        this.sendTo(key, { t: 'error', text: 'Владельца замьютить нельзя' });
        return;
      }
      if (this.isStaff(target) && !this.isOwner(key)) {
        this.sendTo(key, { t: 'error', text: 'Сотрудника может замьютить только владелец' });
        return;
      }
      const other = this.store.users[target];
      if (!other) return;
      if (kind === 'user_unmute') {
        delete other.mutedUntil;
        await this.save();
        this.sendTo(target, { t: 'notice', text: 'Мьют снят' });
        this.sendTo(key, { t: 'notice', text: other.name + ': мьют снят' });
        return;
      }
      const minutes = Math.min(1440, Math.max(1, Number(value.minutes) || 10));
      other.mutedUntil = now() + minutes * 60000;
      await this.save();
      this.sendTo(target, {
        t: 'notice',
        text: 'Вам запрещено писать ' + minutes + ' мин.: ' + (value.reason ? String(value.reason).slice(0, 120) : 'решение модератора'),
      });
      this.sendTo(key, { t: 'notice', text: other.name + ': мьют на ' + minutes + ' мин.' });
      return;
    }

    if (kind === 'user_ban' || kind === 'user_unban') {
      if (!this.isOwner(key)) {
        this.sendTo(key, { t: 'error', text: 'Бан выдаёт только владелец' });
        return;
      }
      const target = this.findUserKey(value.name);
      if (!target || target === key) {
        this.sendTo(key, { t: 'error', text: 'Некого блокировать' });
        return;
      }
      if (!this.store.banned) this.store.banned = {};
      const other = this.store.users[target];
      if (!other) return;
      if (kind === 'user_unban') {
        delete this.store.banned[target];
        delete other.banned;
        await this.save();
        this.sendTo(key, { t: 'notice', text: other.name + ' разблокирован' });
        return;
      }
      this.store.banned[target] = now();
      other.banned = true;
      // Гасим все сессии забаненного и закрываем его сокеты.
      for (const [tk, ownerKey] of Object.entries(this.store.tokens)) {
        if (ownerKey === target) {
          delete this.store.tokens[tk];
          if (this.store.tokenAt) delete this.store.tokenAt[tk];
        }
      }
      if (Array.isArray(this.store.staff)) this.store.staff = this.store.staff.filter((k) => k !== target);
      await this.save();
      for (const ws of this.sockets(target)) {
        try { ws.close(1008, 'banned'); } catch (_) { /* уже закрыт */ }
      }
      this.sendTo(key, { t: 'notice', text: other.name + ' заблокирован' });
      this.broadcast(this.presencePayload());
      return;
    }


    // Загрузка картинки-аватара (data URL в base64, не больше 512 КБ).
    if (kind === 'avatar_upload') {
      const img = this.decodeImage(value, AVATAR_MAX_BYTES);
      if (img.error) {
        this.sendTo(key, { t: 'error', text: 'Аватар: ' + img.error });
        return;
      }
      const v = now();
      await this.state.storage.put('avatar:' + normalizeName(user.name), { mime: img.mime, b64: img.b64, v });
      this.store.avatars[normalizeName(user.name)] = { v, mime: img.mime };
      await this.save();
      this.sendTo(key, { t: 'profile', profile: this.profileView(user), joined: user.created || 0 });
      this.broadcast({ t: 'avatar_changed', name: user.name, url: this.avatarUrlOf(user) });
      this.pushFriendsViews(key);
      return;
    }

    if (kind === 'avatar_delete') {
      await this.state.storage.delete('avatar:' + normalizeName(user.name));
      delete this.store.avatars[normalizeName(user.name)];
      await this.save();
      this.sendTo(key, { t: 'profile', profile: this.profileView(user), joined: user.created || 0 });
      this.broadcast({ t: 'avatar_changed', name: user.name, url: '' });
      this.pushFriendsViews(key);
      return;
    }

    // Свой набор стикеров: картинки общие для канала.
    if (kind === 'sticker_add') {
      const img = this.decodeImage(value, STICKER_MAX_BYTES);
      if (img.error) {
        this.sendTo(key, { t: 'error', text: 'Стикер: ' + img.error });
        return;
      }
      if ((this.store.stickers || []).length >= STICKER_LIMIT) {
        this.sendTo(key, { t: 'error', text: 'В наборе уже ' + STICKER_LIMIT + ' стикеров' });
        return;
      }
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const label = [...String(value.name || 'стикер').trim()].slice(0, 32).join('') || 'стикер';
      const item = { id, name: label, by: user.name, v: now() };
      await this.state.storage.put('sticker:' + id, { mime: img.mime, b64: img.b64, v: item.v });
      this.store.stickers.push(item);
      await this.save();
      this.broadcast({ t: 'sticker_pack', items: this.stickerPackView() });
      return;
    }

    if (kind === 'sticker_delete') {
      const id = String(value.id || '');
      const idx = (this.store.stickers || []).findIndex((s) => s.id === id);
      if (idx < 0) return;
      const item = this.store.stickers[idx];
      if (normalizeName(item.by) !== normalizeName(user.name)) {
        this.sendTo(key, { t: 'error', text: 'Удалить стикер может только тот, кто его добавил' });
        return;
      }
      this.store.stickers.splice(idx, 1);
      await this.state.storage.delete('sticker:' + id);
      await this.save();
      this.broadcast({ t: 'sticker_pack', items: this.stickerPackView() });
      return;
    }

    if (kind === 'profile_update') {
      const src = (value && value.profile) || value || {};
      const p = user.profile || (user.profile = defaultProfile(user.name, user.color));
      if (typeof src.displayName === 'string') {
        const dn = [...String(src.displayName).trim()].slice(0, 32).join('');
        p.displayName = dn || user.name;
      }
      if (typeof src.bio === 'string') {
        p.bio = [...String(src.bio).trim()].slice(0, 190).join('');
      }
      if (typeof src.avatar === 'string') {
        const av = [...String(src.avatar).trim()].slice(0, 4).join('');
        if (av && /[\p{L}\p{N}]/u.test(av)) {
          this.sendTo(key, { t: 'error', text: 'Аватар: выберите значок из набора' });
          return;
        }
        p.avatar = av;
      }
      if (typeof src.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(src.accent)) {
        p.accent = src.accent.toLowerCase();
        user.color = p.accent;
      }
      await this.save();
      this.sendTo(key, { t: 'profile', profile: this.profileView(user), joined: user.created || 0 });
      this.broadcast({ t: 'profile_changed', name: user.name, profile: this.profileView(user) });
      this.pushFriendsViews(key);
      this.broadcast(this.presencePayload());
      return;
    }

    if (kind === 'settings_update') {
      const before = this.statusOf(user);
      user.settings = mergeSettings(user.settings, value.settings || {});
      const after = this.statusOf(user);
      await this.save();
      this.sendTo(key, { t: 'settings', settings: user.settings });
      // Смена статуса (в сети / не беспокоить / невидимка) видна сразу.
      if (before !== after) this.broadcast(this.presencePayload());
      return;
    }

    if (kind === 'password_change') {
      const oldPass = String(value.old || '');
      const newPass = String(value.new || '');
      if (newPass.length < 4) {
        this.sendTo(key, { t: 'error', text: 'Новый пароль: не короче 4 символов' });
        return;
      }
      if (!(await verifyPassword(oldPass, user))) {
        this.sendTo(key, { t: 'error', text: 'Текущий пароль неверен' });
        return;
      }
      user.pass = await hashPassword(newPass, user.salt);
      user.algo = 'pbkdf2';
      // остальные сессии выключаем, текущая остаётся
      for (const [tk, owner] of Object.entries(this.store.tokens)) {
        if (owner === key && tk !== meta.token) {
          delete this.store.tokens[tk];
          if (this.store.tokenAt) delete this.store.tokenAt[tk];
        }
      }
      await this.save();
      this.sendTo(key, { t: 'notice', text: 'Пароль изменён, другие устройства вышли' });
      return;
    }

    if (kind === 'logout_all') {
      for (const [tk, owner] of Object.entries(this.store.tokens)) {
        if (owner === key && tk !== meta.token) {
          delete this.store.tokens[tk];
          if (this.store.tokenAt) delete this.store.tokenAt[tk];
        }
      }
      await this.save();
      this.sendTo(key, { t: 'notice', text: 'Остальные устройства вышли из аккаунта' });
      return;
    }

    if (kind === 'search_users') {
      const q = String(value.q || '').trim().toLowerCase();
      const online = this.onlineNames().map((n) => n.toLowerCase());
      const results = [];
      if (q.length >= 1) {
        for (const [k, u] of Object.entries(this.store.users)) {
          if (k === key) continue;
          const view = this.profileView(u);
          if (!k.includes(q) && !String(view.displayName || '').toLowerCase().includes(q)) continue;
          const priv = mergeSettings(u.settings, null).searchPrivacy;
          if (priv === 'friends' && !(user.friends || []).includes(k)) continue;
          results.push({
            name: u.name,
            ...view,
            online: online.includes(k),
            friend: (user.friends || []).includes(k),
            pending: (user.outgoing || []).includes(k) ? 'out' : (user.incoming || []).includes(k) ? 'in' : '',
          });
        }
      }
      results.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name));
      this.sendTo(key, { t: 'user_search', q, results: results.slice(0, 12) });
      return;
    }

    if (kind === 'user_card') {
      const target = this.findUserKey(value.name);
      const other = this.store.users[target];
      if (!other) {
        this.sendTo(key, { t: 'error', text: 'Такого пользователя нет' });
        return;
      }
      const isOnline = this.onlineNames().map((n) => n.toLowerCase()).includes(target);
      this.sendTo(key, {
        t: 'user_card',
        user: {
          name: other.name,
          ...this.profileView(other),
          color: other.color,
          online: isOnline,
          status: isOnline ? this.statusOf(other) : 'offline',
          joined: other.created || 0,
          friend: (user.friends || []).includes(target),
          pending: (user.outgoing || []).includes(target) ? 'out' : (user.incoming || []).includes(target) ? 'in' : '',
          voiceRoom: this.voiceRoomOf(other.name),
        },
      });
      return;
    }

    if (kind === 'account_delete') {
      if (!(await verifyPassword(String(value.password || ''), user))) {
        this.sendTo(key, { t: 'error', text: 'Пароль неверен' });
        return;
      }
      for (const u of Object.values(this.store.users)) {
        u.friends = (u.friends || []).filter((k) => k !== key);
        u.incoming = (u.incoming || []).filter((k) => k !== key);
        u.outgoing = (u.outgoing || []).filter((k) => k !== key);
      }
      delete this.store.users[key];
      for (const [tk, owner] of Object.entries(this.store.tokens)) {
        if (owner === key) {
          delete this.store.tokens[tk];
          if (this.store.tokenAt) delete this.store.tokenAt[tk];
        }
      }
      this.voiceRemove(name);
      await this.state.storage.delete('avatar:' + key);
      if (this.store.avatars) delete this.store.avatars[key];
      const mine = (this.store.stickers || []).filter((s) => normalizeName(s.by) === key);
      for (const s of mine) await this.state.storage.delete('sticker:' + s.id);
      this.store.stickers = (this.store.stickers || []).filter((s) => normalizeName(s.by) !== key);
      // Сообщения и вложения удалённого аккаунта тоже уходят: иначе в ленте
      // остаются «призраки» с инициалами и висят чужие картинки.
      await this.purgeOrphans();
      await this.save();
      this.sendTo(key, { t: 'account_deleted' });
      this.broadcast(this.presencePayload());
      return;
    }

    if (kind === 'dm_delete') {
      const other = this.findUserKey(value.name);
      if (!other || other === key) return;
      if (!this.store.hidden) this.store.hidden = {};
      const list = this.store.hidden[key] || (this.store.hidden[key] = []);
      if (!list.includes(other)) list.push(other);
      await this.save();
      this.sendTo(key, { t: 'dm_list', items: this.dmList(key) });
      this.sendTo(key, { t: 'notice', text: 'Чат убран из списка' });
      return;
    }

    if (kind === 'channel_delete') {
      const room = String(value.room || '').trim();
      // Каналы удаляет только владелец: иначе первый же участник снесёт общий чат.
      if (!this.isOwner(key)) {
        this.sendTo(key, { t: 'error', text: 'Удалять каналы может только владелец' });
        return;
      }
      if (!room || room === DEFAULT_CHANNEL) {
        this.sendTo(key, { t: 'error', text: 'Общий канал удалить нельзя' });
        return;
      }
      if (!this.store.channels.includes(room)) return;
      this.store.channels = this.store.channels.filter((c) => c !== room);
      delete this.store.rooms[room];
      if (this.voice.has(room)) {
        this.voice.delete(room);
        this.broadcast(this.voiceState(room));
      }
      await this.save();
      this.broadcast({ t: 'channels', channels: this.store.channels });
      this.broadcast({ t: 'notice', text: 'Канал #' + room + ' удалён' });
      return;
    }

    if (kind === 'create') {
      const raw = String(value.room || '').trim().toLowerCase();
      const room = [...raw].filter((c) => /[a-z0-9_-]/.test(c)).slice(0, 24).join('');
      // Каналы создавать могут все, но не чаще, чем позволяет лимит.
      const rate = this.rateAllow(key, 'create', CREATE_HOURLY, 60 * 60 * 1000);
      if (!rate.ok) {
        this.sendTo(key, { t: 'error', text: 'Слишком много новых каналов. Подождите ' + rate.retry + ' с.' });
        return;
      }
      if (room.length < 2) {
        this.sendTo(key, { t: 'error', text: 'Название канала: латиница, 2–24 символа' });
        return;
      }
      if (this.store.channels.includes(room)) {
        this.sendTo(key, { t: 'error', text: 'Такой канал уже есть' });
        return;
      }
      this.store.channels.push(room);
      this.store.rooms[room] = [];
      await this.save();
      this.broadcast({ t: 'channels', channels: this.store.channels });
      this.sendTo(key, { t: 'history', room, messages: [] });
      this.sendTo(key, { t: 'channel_created', room });
      return;
    }

    if (kind === 'friend_add' || kind === 'friend_accept' || kind === 'friend_remove') {
      const target = this.findUserKey(value.name);
      if (!target || target === key) {
        this.sendTo(key, { t: 'error', text: target === key ? 'Это вы' : 'Такого пользователя нет' });
        return;
      }
      const other = this.store.users[target];
      user.friends = user.friends || [];
      user.incoming = user.incoming || [];
      user.outgoing = user.outgoing || [];
      other.friends = other.friends || [];
      other.incoming = other.incoming || [];
      other.outgoing = other.outgoing || [];
      let notify = false;
      if (kind === 'friend_add') {
        if (user.friends.includes(target)) {
          this.sendTo(key, { t: 'error', text: 'Уже в друзьях' });
          return;
        }
        if (user.outgoing.includes(target)) {
          this.sendTo(key, { t: 'error', text: 'Заявка уже отправлена' });
          return;
        }
        if (other.outgoing.includes(key)) {
          // встречная заявка — сразу друзья
          other.outgoing = other.outgoing.filter((k) => k !== key);
          user.outgoing = user.outgoing.filter((k) => k !== target);
          user.incoming = user.incoming.filter((k) => k !== target);
          other.incoming = other.incoming.filter((k) => k !== key);
          if (!user.friends.includes(target)) user.friends.push(target);
          if (!other.friends.includes(key)) other.friends.push(key);
        } else {
          user.outgoing.push(target);
          other.incoming = other.incoming.filter((k) => k !== key);
          other.incoming.push(key);
          notify = true;
        }
      } else if (kind === 'friend_accept') {
        // Принять можно только заявку, которая действительно пришла.
        if (!user.incoming.includes(target)) {
          this.sendTo(key, { t: 'error', text: 'Заявки от этого человека нет' });
          return;
        }
        user.incoming = user.incoming.filter((k) => k !== target);
        other.outgoing = other.outgoing.filter((k) => k !== key);
        other.incoming = other.incoming.filter((k) => k !== key);
        if (!user.friends.includes(target)) user.friends.push(target);
        if (!other.friends.includes(key)) other.friends.push(key);
      } else {
        user.friends = user.friends.filter((k) => k !== target);
        other.friends = other.friends.filter((k) => k !== key);
        user.incoming = user.incoming.filter((k) => k !== target);
        other.incoming = other.incoming.filter((k) => k !== key);
        user.outgoing = user.outgoing.filter((k) => k !== target);
        other.outgoing = other.outgoing.filter((k) => k !== key);
      }
      await this.save();
      this.sendTo(key, this.friendsView(key));
      this.sendTo(target, this.friendsView(target));
      if (notify) this.sendTo(target, { t: 'notice', text: `${name} хочет добавить вас в друзья` });
      return;
    }

    if (kind === 'voice_join') {
      const room = String(value.room || '');
      if (!this.store.channels.includes(room)) return;
      const old = this.voiceRemove(name);
      if (old) this.broadcast(this.voiceState(old));
      if (!this.voice.has(room)) this.voice.set(room, new Map());
      const members = this.voice.get(room);
      // Групповой звонок до VOICE_LIMIT человек: дальше не пускаем.
      if (members.size >= VOICE_LIMIT) {
        this.sendTo(key, { t: 'error', text: 'В «' + room + '» уже ' + VOICE_LIMIT + ' человек — больше не помещается' });
        this.sendTo(key, { t: 'voice_state', room, limit: VOICE_LIMIT, users: [...members.values()] });
        return;
      }
      members.set(name, { name, muted: false, screen: false });
      this.broadcast(this.voiceState(room));
      return;
    }

    if (kind === 'voice_leave') {
      const room = this.voiceRemove(name);
      if (room) this.broadcast(this.voiceState(room));
      return;
    }

    if (kind === 'voice_mute') {
      const muted = !!value.muted;
      const rooms = [];
      for (const [room, members] of this.voice) {
        for (const [memberName, member] of members) {
          if (memberName === name) {
            member.muted = muted;
            rooms.push(room);
          }
        }
      }
      for (const room of rooms) this.broadcast(this.voiceState(room));
      return;
    }

    // Скриншеринг: помечаем, кто показывает экран, чтобы остальные рисовали
    // плашку и знали, от кого ждать видеопоток.
    if (kind === 'voice_screen') {
      const sharing = !!value.sharing;
      const rooms = [];
      for (const [room, members] of this.voice) {
        const member = members.get(name);
        if (member) {
          member.screen = sharing;
          rooms.push(room);
        }
      }
      for (const room of rooms) this.broadcast(this.voiceState(room));
      return;
    }

    if (kind === 'rtc') {
      const to = String(value.to || '');
      const rtcKind = String(value.kind || '');
      if (!to || !rtcKind) return;
      let sameRoom = false;
      for (const members of this.voice.values()) {
        const names = [...members.keys()].map((n) => n.toLowerCase());
        if (names.includes(name.toLowerCase()) && names.includes(to.toLowerCase())) sameRoom = true;
      }
      if (!sameRoom) return;
      this.sendTo(normalizeName(to), {
        t: 'rtc',
        from: name,
        kind: rtcKind,
        payload: value.payload,
      });
    }
  }

  // Мост в Matrix: исходящие сообщения канала.
  matrixOut(room, message) {
    const cfg = this.store.matrix;
    if (!cfg || !cfg.enabled || cfg.direction === 'in') return;
    if (message.external) return; // пришло из Matrix — обратно не гоняем
    if ((cfg.channel || DEFAULT_CHANNEL) !== room) return;
    const text = String(message.text || '').trim();
    if (!text) return;
    mxSend(cfg, text, message.author).then(async (res) => {
      if (res.ok) {
        cfg.sent = (cfg.sent || 0) + 1;
        cfg.status = 'ok';
        cfg.message = 'Мост работает';
      } else {
        cfg.status = 'error';
        cfg.message = res.error;
      }
      cfg.updatedAt = Date.now();
      await this.save();
      this.broadcast({ t: 'matrix_state', matrix: mxPublic(cfg) });
    }).catch(() => {});
  }

  // Мост в Matrix: сообщения из комнаты в канал.
  async matrixPull() {
    const cfg = this.store.matrix;
    if (!cfg || !cfg.enabled) return { ok: false, error: 'Мост выключен' };
    if (cfg.direction === 'out') return { ok: false, error: 'Мост работает только на отправку' };
    const res = await mxSync(cfg);
    if (!res.ok) {
      cfg.status = 'error';
      cfg.message = res.error;
      cfg.updatedAt = Date.now();
      await this.save();
      this.broadcast({ t: 'matrix_state', matrix: mxPublic(cfg) });
      return res;
    }
    cfg.since = res.since || cfg.since;
    cfg.status = 'ok';
    cfg.message = res.first ? 'Точка отсчёта запомнена, новые сообщения пойдут в канал' : 'Мост работает';
    cfg.updatedAt = Date.now();
    const room = cfg.channel || DEFAULT_CHANNEL;
    if (!this.store.channels.includes(room)) this.store.channels.push(room);
    if (!this.store.rooms[room]) this.store.rooms[room] = [];
    let added = 0;
    for (const ev of res.events || []) {
      this.store.seq = (this.store.seq || 0) + 1;
      const message = {
        id: this.store.seq,
        room,
        author: 'Matrix · ' + ev.from,
        text: (cfg.prefix || '') + ev.text,
        ts: ev.ts || now(),
        external: 'matrix',
        authorProfile: { name: 'Matrix · ' + ev.from, color: '#7c5cff', avatarUrl: '' },
      };
      this.pushMessage(room, message);
      cfg.got = (cfg.got || 0) + 1;
      added += 1;
      this.broadcast({ t: 'msg', ...message });
    }
    await this.save();
    this.broadcast({ t: 'matrix_state', matrix: mxPublic(cfg) });
    return { ...res, added };
  }

  // Durable Object сам себя будит раз в 15 секунд, пока мост включён.
  async armMatrixAlarm() {
    try {
      await this.state.storage.setAlarm(Date.now() + 15000);
    } catch (_) { /* старые версии storage без alarm */ }
  }

  async alarm() {
    await this.ensure();
    const cfg = this.store.matrix;
    if (!cfg || !cfg.enabled) return;
    try {
      await this.matrixPull();
    } finally {
      if (this.store.matrix && this.store.matrix.enabled) await this.armMatrixAlarm();
    }
  }

  async webSocketClose(ws) {
    await this.ensure();
    const meta = ws.deserializeAttachment();
    if (!meta) return;
    const user = this.store.users[meta.key];
    const name = user ? user.name : meta.name;
    if (name) {
      // закрылся один из сокетов пользователя (вкладка, переподключение):
      // выкидываем из голоса, только если у него больше нет живых соединений,
      // иначе старое соединение выбивало человека из канала после реконнекта
      const others = meta.key ? this.sockets(meta.key).filter((s) => s !== ws).length : 0;
      if (!others) {
        const room = this.voiceRemove(name);
        if (room) this.broadcast(this.voiceState(room));
      }
    }
    this.broadcast(this.presencePayload());
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }
}
