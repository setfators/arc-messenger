// Мост в Matrix. Работает в две стороны:
//   out — сообщения канала уходят в комнату Matrix;
//   in  — сообщения из комнаты появляются в канале (забираются по /sync).
// Достаточно адреса home-сервера и access token: вход в аккаунт выполняет
// человек на своём сервере, токен выдаёт Matrix. Пароль нигде не хранится.

const MX_TIMEOUT = 8000;

export function mxDefault() {
  return {
    enabled: false,
    homeserver: '',      // https://matrix.org
    token: '',           // access token владельца моста
    roomId: '',          // !abc:matrix.org или #alias:matrix.org
    channel: 'obshiy',   // канал мессенджера
    direction: 'both',   // both | out | in
    prefix: '',          // приписка к сообщениям из Matrix, например «[MX] »
    since: '',           // токен /sync — чтобы не тянуть одно и то же дважды
    status: 'off',       // off | ok | error | paused
    message: '',         // что показать человеку
    userId: '',          // @name:server — от кого идёт мост
    updatedAt: 0,
    sent: 0,
    got: 0,
  };
}

function cleanHome(value) {
  let hs = String(value || '').trim();
  if (!hs) return '';
  if (!/^https?:\/\//i.test(hs)) hs = 'https://' + hs;
  hs = hs.replace(/\/+$/, '');
  try {
    const url = new URL(hs);
    return url.origin;
  } catch (e) {
    return '';
  }
}

function cleanRoom(value) {
  const room = String(value || '').trim();
  if (!room) return '';
  // !opaque:server или #alias:server — другого Matrix не знает.
  if (room.startsWith('!') || room.startsWith('#')) return room;
  return '';
}

export function mxNorm(raw) {
  const out = mxDefault();
  const src = raw && typeof raw === 'object' ? raw : {};
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (typeof src.homeserver === 'string') out.homeserver = cleanHome(src.homeserver);
  if (typeof src.token === 'string') out.token = src.token.trim();
  if (typeof src.roomId === 'string') out.roomId = cleanRoom(src.roomId);
  if (typeof src.channel === 'string') out.channel = src.channel.trim().slice(0, 64);
  if (['both', 'out', 'in'].includes(src.direction)) out.direction = src.direction;
  if (typeof src.prefix === 'string') out.prefix = src.prefix.slice(0, 24);
  if (typeof src.since === 'string') out.since = src.since.slice(0, 200);
  if (['off', 'ok', 'error', 'paused'].includes(src.status)) out.status = src.status;
  if (typeof src.message === 'string') out.message = src.message.slice(0, 300);
  if (typeof src.userId === 'string') out.userId = src.userId.slice(0, 128);
  if (typeof src.updatedAt === 'number') out.updatedAt = src.updatedAt;
  if (typeof src.sent === 'number') out.sent = src.sent;
  if (typeof src.got === 'number') out.got = src.got;
  return out;
}

// Клиенту токен целиком не нужен: показываем только хвост, чтобы человек
// узнавал, что поле уже заполнено, и мог заменить его целиком.
export function mxPublic(raw) {
  const cfg = mxNorm(raw);
  const token = cfg.token;
  return {
    ...cfg,
    token: token ? '…' + token.slice(-4) : '',
    hasToken: !!token,
    ready: !!(cfg.homeserver && cfg.token && cfg.roomId),
  };
}

function mxHeaders(cfg) {
  return { Authorization: 'Bearer ' + cfg.token };
}

async function mxFetch(cfg, path, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MX_TIMEOUT);
  try {
    return await fetch(cfg.homeserver + path, {
      ...init,
      headers: { ...mxHeaders(cfg), ...(init && init.headers ? init.headers : {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function mxErrorText(status, body) {
  if (body && body.error) return body.error + (body.errcode ? ' (' + body.errcode + ')' : '');
  return 'HTTP ' + status;
}

// Кто мы для сервера: заодно проверяет адрес, токен и срок его жизни.
export async function mxWhoami(cfg) {
  if (!cfg.homeserver) return { ok: false, error: 'Не указан адрес home-сервера' };
  if (!cfg.token) return { ok: false, error: 'Не указан access token' };
  try {
    const res = await mxFetch(cfg, '/_matrix/client/v3/account/whoami');
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: mxErrorText(res.status, body) };
    return { ok: true, userId: (body && body.user_id) || '' };
  } catch (e) {
    return { ok: false, error: 'Сервер не ответил: ' + (e && e.name === 'AbortError' ? 'таймаут' : e.message) };
  }
}

// Отправить одну строку текста в комнату. txnId делает повтор безопасным.
export async function mxSend(cfg, text, sender) {
  const lines = [];
  if (sender) lines.push('**' + sender + '**: ' + text);
  const body = sender ? lines.join('\n') : text;
  const txn = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const room = encodeURIComponent(cfg.roomId);
  try {
    const res = await mxFetch(cfg, '/_matrix/client/v3/rooms/' + room + '/send/m.room.message/' + txn, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'm.text', body }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: mxErrorText(res.status, data) };
    return { ok: true, eventId: (data && data.event_id) || '' };
  } catch (e) {
    return { ok: false, error: 'Не отправлено: ' + (e && e.name === 'AbortError' ? 'таймаут' : e.message) };
  }
}

// Забрать новые сообщения из комнаты. Первый вызов только запоминает позицию,
// чтобы не вылить в чат всю историю Matrix.
export async function mxSync(cfg) {
  if (!cfg.homeserver || !cfg.token || !cfg.roomId) {
    return { ok: false, error: 'Мост не настроен', events: [], since: cfg.since };
  }
  const filter = encodeURIComponent(JSON.stringify({
    room: { timeline: { limit: 30, types: ['m.room.message'] } },
  }));
  let path = '/_matrix/client/v3/sync?timeout=0&filter=' + filter;
  if (cfg.since) path += '&since=' + encodeURIComponent(cfg.since);
  try {
    const res = await mxFetch(cfg, path);
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: mxErrorText(res.status, data), events: [], since: cfg.since };
    const nextBatch = (data && data.next_batch) || cfg.since;
    if (!cfg.since) return { ok: true, events: [], since: nextBatch, first: true };
    const join = (data && data.rooms && data.rooms.join) || {};
    const room = join[cfg.roomId] || {};
    const timeline = (room.timeline && room.timeline.events) || [];
    const events = [];
    for (const ev of timeline) {
      if (!ev || ev.type !== 'm.room.message') continue;
      if (cfg.userId && ev.sender === cfg.userId) continue; // своё не дублируем
      const content = ev.content || {};
      const text = String(content.body || '').trim();
      if (!text || text.length > 4000) continue;
      const name = String(ev.sender || '').replace(/^@/, '').split(':')[0] || 'matrix';
      events.push({ id: ev.event_id || '', from: name, text, ts: (ev.origin_server_ts || 0) });
    }
    return { ok: true, events, since: nextBatch };
  } catch (e) {
    return {
      ok: false,
      error: 'Не удалось получить сообщения: ' + (e && e.name === 'AbortError' ? 'таймаут' : e.message),
      events: [],
      since: cfg.since,
    };
  }
}
