import { ChatHub } from './hub.js';

export { ChatHub };

// Установщик обновления весит больше 25 МиБ, а один файл статики Cloudflare
// столько не отдаёт. Поэтому exe режется на части (public/updates/parts),
// а этот маршрут склеивает их в один поток — electron-updater видит обычный файл.
// Безопасные заголовки для статики: страница не должна открываться в iframe
// и не должна угадывать тип содержимого.
function secure(res, html) {
  const headers = new Headers(res.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'camera=(), geolocation=(), microphone=(self)');
  if (html) headers.set('cache-control', 'public, max-age=0, must-revalidate');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function streamUpdate(request, env, url) {
  const manRes = await env.ASSETS.fetch(new URL('/updates/parts/manifest.json', url.origin).toString());
  if (!manRes.ok) {
    return new Response('Обновление не найдено', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const man = await manRes.json();
  if (!man || !Array.isArray(man.parts) || !man.parts.length || !Number.isFinite(man.size) || man.size <= 0) {
    return new Response('Обновление повреждено', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const total = man.size;
  // Отдаём только актуальный файл из manifest: по любому другому имени
  // вроде старого Messenger-Setup-1.4.0.exe отвечаем 404, а не «что есть».
  const asked = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (man.file && asked !== man.file) {
    return new Response('Такого обновления нет — возьмите файл из latest.yml', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const sum = man.parts.reduce((acc, p) => acc + (Number(p && p.len) || 0), 0);
  if (sum < total) {
    return new Response('Обновление неполное', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=300',
    'content-disposition': 'attachment; filename="' + man.file + '"',
  });
  let start = 0;
  let end = total - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get('range') || '').trim());
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = parseInt(m[1], 10);
      end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    } else {
      const n = parseInt(m[2], 10);
      start = Math.max(total - n, 0);
      end = total - 1;
    }
    if (!(start >= 0 && start <= end && start < total)) {
      return new Response('bad range', { status: 416, headers: { 'content-range': 'bytes */' + total } });
    }
    status = 206;
    headers.set('content-range', 'bytes ' + start + '-' + end + '/' + total);
  }
  headers.set('content-length', String(end - start + 1));
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  const bounds = [];
  let acc = 0;
  for (const p of man.parts) {
    const len = Number(p && p.len) || 0;
    bounds.push({ name: p.name, from: acc, to: acc + len - 1 });
    acc += len;
  }

  const found = bounds.findIndex((b) => end >= b.from && start <= b.to);
  if (found < 0) {
    return new Response('bad range', { status: 416, headers: { 'content-range': 'bytes */' + total } });
  }
  const cursor = { i: found, at: start };
  const stream = new ReadableStream({
    async pull(controller) {
      if (cursor.at > end) {
        controller.close();
        return;
      }
      const b = bounds[cursor.i];
      if (!b || cursor.at > b.to) {
        controller.close();
        return;
      }
      const res = await env.ASSETS.fetch(new URL('/updates/parts/' + b.name, url.origin).toString());
      if (!res.ok) {
        controller.error(new Error('part ' + b.name + ': ' + res.status));
        return;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const from = cursor.at - b.from;
      const to = Math.min(buf.length - 1, end - b.from);
      if (to < from) {
        controller.close();
        return;
      }
      controller.enqueue(buf.subarray(from, to + 1));
      cursor.at = b.from + to + 1;
      cursor.i += 1;
    },
  });
  return new Response(stream, { status, headers });
}

// Мобильное приложение живёт на своём origin (https://localhost в WebView),
// поэтому браузер внутри APK требует CORS для /api/*. Пускаем только свои:
// сам сайт и адрес, с которого работает Capacitor.
const ALLOWED_ORIGINS = new Set([
  'https://rust-messenger.sg530507.workers.dev',
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
]);

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const headers = new Headers();
  if (!ALLOWED_ORIGINS.has(origin)) return headers;
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  headers.set('access-control-allow-headers', 'content-type, x-token');
  headers.set('access-control-max-age', '86400');
  headers.set('vary', 'origin');
  return headers;
}

// Предварительный запрос браузера перед POST: отвечаем без тела.
function corsPreflight(request) {
  const headers = corsHeaders(request);
  if (!headers.has('access-control-allow-origin')) {
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = env.HUB.idFromName('main');
    const stub = env.HUB.get(name);

    if (url.pathname.startsWith('/api/') && request.method === 'OPTIONS') {
      return corsPreflight(request);
    }

    if (url.pathname === '/api/register' || url.pathname === '/api/login') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Нужен POST' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST' },
        });
      }
      const action = url.pathname.endsWith('register') ? 'register' : 'login';
      const body = await request.text();
      // Адрес клиента нужен Durable Object, чтобы ограничивать перебор пароля.
      const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
      const headers = { 'content-type': 'application/json' };
      if (ip) headers['cf-connecting-ip'] = ip;
      const res = await stub.fetch('https://hub.internal/auth?action=' + action, {
        method: 'POST',
        headers,
        body,
      });
      const cors = corsHeaders(request);
      cors.set('content-type', 'application/json; charset=utf-8');
      return new Response(res.body, { status: res.status, headers: cors });
    }

    // Картинки-вложения (1.4.0): загрузка идёт обычным POST, токен проверяет
    // Durable Object. Тело отдаём потоком, чтобы не упереться в лимит памяти.
    if (url.pathname === '/api/media') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Нужен POST' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'POST' },
        });
      }
      const headers = new Headers();
      headers.set('x-token', request.headers.get('x-token') || '');
      headers.set('content-type', request.headers.get('content-type') || '');
      const res = await stub.fetch('https://hub.internal/media-upload', {
        method: 'POST',
        headers,
        body: request.body,
      });
      const out = new Headers(corsHeaders(request));
      out.set('content-type', 'application/json; charset=utf-8');
      if (!res.ok) out.set('cache-control', 'no-store');
      return new Response(res.body, { status: res.status, headers: out });
    }

    // Скачивание снимка базы (владелец): токен проверяет Durable Object.
    if (url.pathname === '/api/backup') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Нужен GET' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'GET' },
        });
      }
      const res = await stub.fetch('https://hub.internal/backup' + url.search, {
        method: 'GET',
        headers: { 'x-token': request.headers.get('x-token') || '' },
      });
      const out = new Headers(corsHeaders(request));
      out.set('content-type', 'application/json; charset=utf-8');
      out.set('cache-control', 'no-store');
      for (const key of ['content-disposition']) {
        const v = res.headers.get(key);
        if (v) out.set(key, v);
      }
      return new Response(res.body, { status: res.status, headers: out });
    }

    if (url.pathname === '/ws') return stub.fetch(request);
    // Разовая уборка «осиротевших» сообщений (удалённые аккаунты).
    // Экспорт базы для бэкапа: только владелец, токен в заголовке x-token.
    if (url.pathname === '/api/export') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Нужен GET' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'GET' },
        });
      }
      const res = await stub.fetch('https://hub.internal/export', {
        method: 'GET',
        headers: { 'x-token': request.headers.get('x-token') || '' },
      });
      const out = new Headers(corsHeaders(request));
      out.set('content-type', 'application/json; charset=utf-8');
      out.set('cache-control', 'no-store');
      out.set('content-disposition', 'attachment; filename="arc-export.json"');
      return new Response(res.body, { status: res.status, headers: out });
    }

    if (url.pathname === '/api/purge-orphans') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Нужен POST' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'POST' },
        });
      }
      const res = await stub.fetch('https://hub.internal/purge-orphans', { method: 'POST' });
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    // Вложения-картинки из сообщений отдаёт Durable Object.
    if (url.pathname.startsWith('/media/')) {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Нужен GET' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'GET' },
        });
      }
      return stub.fetch(request);
    }
    // Картинки аватаров и стикеров отдаёт сам Durable Object.
    if (url.pathname.startsWith('/avatar/') || url.pathname.startsWith('/sticker/')) {
      return stub.fetch(request);
    }
    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname.startsWith('/updates/') && url.pathname.endsWith('.exe')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Метод не поддерживается', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      return streamUpdate(request, env, url);
    }

    const html = url.pathname === '/' || url.pathname.endsWith('.html');
    return secure(await env.ASSETS.fetch(request), html);
  },
};
