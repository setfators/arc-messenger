// Паритет 1.13.0: закреплённые, опросы, медленный режим, описание канала,
// свои эмодзи и звуки, журнал действий, пересылка, оглушение, статус текстом,
// категории и фильтры поиска. Каждая проверка — отдельная строка «ok/FAIL».
const B = process.env.BASE || 'http://127.0.0.1:8821';
import WebSocket from 'ws';
const WSURL = B.replace('http', 'ws');
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, cond, extra) => {
  if (cond) { console.log('ok   ' + name); return; }
  console.log('FAIL ' + name + (extra ? ' → ' + extra : ''));
  problems.push(name);
};

async function api(path, body) {
  const res = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
function open(token) {
  const ws = new WebSocket(WSURL + '/ws?token=' + encodeURIComponent(token));
  const got = [];
  ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ ws, got })); ws.on('error', () => resolve({ ws, got }));
    setTimeout(() => resolve({ ws, got }), 5000);
  });
}
function send(c, obj) { c.ws.send(JSON.stringify(obj)); }
function mark(c) { return c.got.length; }
async function waitFor(client, pred, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const hit = client.got.find(pred); if (hit) return hit; await sleep(25); }
  return null;
}
// Ждём событие только среди тех, что пришли после отметки from: так старые
// события не «засчитываются» повторно и проверки остаются детерминированными.
async function waitNew(client, from, pred, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = client.got.slice(from).find(pred);
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}
const errorsOf = (c) => c.got.filter((m) => m.t === 'error').map((m) => m.text);

const ownerName = 'pdo' + stamp;
const staffName = 'pds' + stamp;
const guestName = 'pdg' + stamp;

// --- Подготовка: владелец, сотрудник и обычный участник.
const owner = await api('/api/register', { name: ownerName, password: 'parol123' });
if (!owner.data || !owner.data.token) { console.log('\nБаза не пустая: нужен свежий --persist-to.'); process.exit(2); }
const ows = await open(owner.data.token);
await waitFor(ows, (m) => m.t === 'hello');
send(ows, { t: 'invite_create', max: 5 });
const inv = await waitFor(ows, (m) => m.t === 'invite_created');
const staff = await api('/api/register', { name: staffName, password: 'parol123', invite: inv.invite.code });
const guest = await api('/api/register', { name: guestName, password: 'parol123', invite: inv.invite.code });
const sws = await open(staff.data.token);
const gws = await open(guest.data.token);
await waitFor(sws, (m) => m.t === 'hello');
await waitFor(gws, (m) => m.t === 'hello');

// Сотрудник — модератор: права на эмодзи, звуки и аудит проверяем на нём.
send(ows, { t: 'staff_add', name: staffName });
const roleUp = await waitNew(sws, 0, (m) => m.t === 'role_changed' && m.isStaff === true);
check('сотрудник назначен', !!roleUp, JSON.stringify(await waitFor(sws, (m) => m.t === 'notice')));

// --- Канал, в который позвали обоих.
send(ows, { t: 'create', room: 'parity ' + stamp, title: 'parity ' + stamp });
const created = await waitFor(ows, (m) => m.t === 'channel_created' && m.room);
const room = created && created.room;
check('канал создан', !!room, JSON.stringify(created));
send(ows, { t: 'channel_add', room, name: staffName });
send(ows, { t: 'channel_add', room, name: guestName });
const seenG = await waitFor(gws, (m) => m.t === 'channels' && (m.channels || []).includes(room));
const seenS = await waitFor(sws, (m) => m.t === 'channels' && (m.channels || []).includes(room));
check('сотрудник и участник видят канал', !!(seenG && seenS), '');

// --- 3. Медленный режим.
send(ows, { t: 'channel_slow', room, seconds: 2 });
const slowList = await waitFor(ows, (m) => m.t === 'channels'
  && (m.items || []).some((i) => i.room === room && i.slow === 2));
check('медленный режим сохраняется в channelView', !!slowList, JSON.stringify(slowList && slowList.items));
let from = mark(gws);
send(gws, { t: 'msg', room, text: 'медленное 1 ' + stamp });
const slowFirst = await waitNew(gws, from, (m) => m.t === 'msg' && m.text === 'медленное 1 ' + stamp);
check('первое сообщение в медленном режиме проходит', !!slowFirst, JSON.stringify(errorsOf(gws)));
from = mark(gws);
send(gws, { t: 'msg', room, text: 'медленное 2 ' + stamp });
const slowHit = await waitNew(gws, from, (m) => m.t === 'slow_wait' && m.room === room);
check('второе сообщение получает slow_wait', !!(slowHit && slowHit.left >= 1), JSON.stringify(slowHit));
const slowErr = await waitNew(gws, from, (m) => m.t === 'error' && /Медленный режим/.test(m.text || ''));
check('второе сообщение получает ошибку про медленный режим', !!slowErr, JSON.stringify(errorsOf(gws)));
const slowGhost = await waitNew(gws, from, (m) => m.t === 'msg' && m.text === 'медленное 2 ' + stamp, 500);
check('отклонённое сообщение не создаётся', !slowGhost, '');
// Владелец канала пишет без ограничения.
from = mark(ows);
send(ows, { t: 'msg', room, text: 'владелец 1 ' + stamp });
send(ows, { t: 'msg', room, text: 'владелец 2 ' + stamp });
const ownerFast1 = await waitNew(ows, from, (m) => m.t === 'msg' && m.text === 'владелец 1 ' + stamp);
const ownerFast2 = await waitNew(ows, from, (m) => m.t === 'msg' && m.text === 'владелец 2 ' + stamp);
check('владельца медленный режим не касается', !!(ownerFast1 && ownerFast2), '');
send(ows, { t: 'channel_slow', room, seconds: 0 });
await waitFor(ows, (m) => m.t === 'channels' && (m.items || []).some((i) => i.room === room && i.slow === 0));

// --- 4. Описание канала.
send(ows, { t: 'channel_topic', room, topic: 'правила канала ' + stamp });
const topicList = await waitFor(ows, (m) => m.t === 'channels'
  && (m.items || []).some((i) => i.room === room && i.topic === 'правила канала ' + stamp));
check('описание канала приходит в channelView', !!topicList, JSON.stringify(topicList && topicList.items));
from = mark(gws);
send(gws, { t: 'channel_topic', room, topic: 'я тут главный' });
const topicDeny = await waitNew(gws, from, (m) => m.t === 'error' && /Описание/.test(m.text || ''));
check('участник не может менять описание канала', !!topicDeny, JSON.stringify(errorsOf(gws)));

// --- 1. Закреплённые сообщения.
from = mark(gws);
send(gws, { t: 'msg', room, text: 'закрепи меня ' + stamp });
const pinSource = await waitNew(gws, from, (m) => m.t === 'msg' && m.text === 'закрепи меня ' + stamp);
from = mark(ows);
send(ows, { t: 'msg', room, text: 'чужое сообщение ' + stamp });
const otherMsg = await waitNew(ows, from, (m) => m.t === 'msg' && m.text === 'чужое сообщение ' + stamp);
from = mark(ows);
const guestSeenFrom = mark(gws);
send(ows, { t: 'msg_pin', room, id: pinSource && pinSource.id });
const pinsEvent = await waitNew(ows, from, (m) => m.t === 'pins' && m.room === room);
check('сообщение закрепляется (автор ответа — владелец канала)',
  !!(pinsEvent && (pinsEvent.items || []).some((i) => i.id === (pinSource && pinSource.id)
    && i.text === 'закрепи меня ' + stamp && i.author === guestName)),
  JSON.stringify(pinsEvent));
const pinsForGuest = await waitNew(gws, guestSeenFrom, (m) => m.t === 'pins' && m.room === room
  && (m.items || []).some((i) => i.id === (pinSource && pinSource.id)));
check('закрепление видят все участники канала', !!pinsForGuest, '');
// Чужое (не своё) сообщение участник закрепить не может.
from = mark(gws);
send(gws, { t: 'msg_pin', room, id: otherMsg && otherMsg.id });
const pinDeny = await waitNew(gws, from, (m) => m.t === 'error' && /Закреплять/.test(m.text || ''));
check('участник не может закрепить чужое сообщение', !!pinDeny, JSON.stringify(errorsOf(gws)));
// Своё сообщение участник закрепить может.
from = mark(gws);
send(gws, { t: 'msg_pin', room, id: pinSource && pinSource.id });
const ownPin = await waitNew(gws, from, (m) => m.t === 'pins' && (m.items || []).some((i) => i.id === (pinSource && pinSource.id)));
check('участник может закрепить своё сообщение', !!ownPin, JSON.stringify(errorsOf(gws)));
// Открепление.
from = mark(ows);
send(ows, { t: 'msg_unpin', room, id: pinSource && pinSource.id });
const unpinned = await waitNew(ows, from, (m) => m.t === 'pins' && m.room === room && (m.items || []).length === 0);
check('сообщение открепляется', !!unpinned, JSON.stringify(unpinned));
// Закреплённые приходят при join.
send(ows, { t: 'msg_pin', room, id: pinSource && pinSource.id });
await waitFor(ows, (m) => m.t === 'pins' && (m.items || []).length === 1);
from = mark(gws);
send(gws, { t: 'join', room });
const pinsOnJoin = await waitNew(gws, from, (m) => m.t === 'pins' && m.room === room
  && (m.items || []).some((i) => i.id === (pinSource && pinSource.id)));
check('при join приходят закреплённые', !!pinsOnJoin, '');
// Удаление сообщения убирает его из закреплённых.
from = mark(ows);
send(ows, { t: 'msg_delete', room, id: pinSource && pinSource.id });
const pinsAfterDelete = await waitNew(ows, from, (m) => m.t === 'pins' && m.room === room && (m.items || []).length === 0);
check('удалённое сообщение исчезает из закреплённых', !!pinsAfterDelete, '');

// --- 2. Опросы.
const pollQuestion = 'Куда идём ' + stamp;
from = mark(ows);
send(ows, { t: 'poll_create', room, question: pollQuestion, options: ['В кино', 'Домой'] });
const pollMsg = await waitNew(ows, from, (m) => m.t === 'msg' && m.poll && m.poll.question === pollQuestion);
check('опрос создаётся как сообщение', !!(pollMsg && pollMsg.text === pollQuestion
  && (pollMsg.poll.options || []).length === 2 && pollMsg.poll.options[0].id === '1'
  && (pollMsg.poll.votes && Object.keys(pollMsg.poll.votes).length === 0)
  && pollMsg.poll.closed === false && pollMsg.poll.multiple === false), JSON.stringify(pollMsg && pollMsg.poll));
const pollId = pollMsg && pollMsg.id;
from = mark(gws);
send(gws, { t: 'poll_vote', room, id: pollId, option: '1' });
const vote1 = await waitNew(gws, from, (m) => m.t === 'msg_poll' && m.id === pollId);
check('голос в опросе засчитывается', !!(vote1 && (vote1.poll.votes['1'] || []).includes(guestName)),
  JSON.stringify(vote1 && vote1.poll.votes));
from = mark(gws);
send(gws, { t: 'poll_vote', room, id: pollId, option: '2' });
const vote2 = await waitNew(gws, from, (m) => m.t === 'msg_poll' && m.id === pollId);
check('голос меняется (в одном варианте остаётся одно имя)',
  !!(vote2 && (vote2.poll.votes['2'] || []).includes(guestName) && !vote2.poll.votes['1']),
  JSON.stringify(vote2 && vote2.poll.votes));
from = mark(gws);
send(gws, { t: 'poll_vote', room, id: pollId, option: '2' });
const vote3 = await waitNew(gws, from, (m) => m.t === 'msg_poll' && m.id === pollId);
check('повторный клик снимает голос', !!(vote3 && Object.keys(vote3.poll.votes).length === 0),
  JSON.stringify(vote3 && vote3.poll.votes));
// Чужой (не автор, не владелец, не сотрудник) закрыть опрос не может.
from = mark(gws);
send(gws, { t: 'poll_close', room, id: pollId });
const closeDeny = await waitNew(gws, from, (m) => m.t === 'error' && /Закрыть опрос/.test(m.text || ''));
check('участник не может закрыть чужой опрос', !!closeDeny, JSON.stringify(errorsOf(gws)));
from = mark(ows);
send(ows, { t: 'poll_close', room, id: pollId });
const closed = await waitNew(ows, from, (m) => m.t === 'msg_poll' && m.id === pollId && m.poll.closed === true);
check('автор закрывает опрос', !!closed, JSON.stringify(closed));
from = mark(gws);
send(gws, { t: 'poll_vote', room, id: pollId, option: '1' });
const voteClosed = await waitNew(gws, from, (m) => m.t === 'error' && /Опрос закрыт/.test(m.text || ''));
check('закрытый опрос не принимает голоса', !!voteClosed, JSON.stringify(errorsOf(gws)));

// --- 5. Свои эмодзи.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const emojiName = 'parity_' + stamp;
from = mark(gws);
send(sws, { t: 'emoji_add', name: emojiName, mime: 'image/png', data: PNG });
const emojiPack = await waitNew(gws, from, (m) => m.t === 'emoji_pack'
  && (m.items || []).some((i) => i.name === emojiName));
check('сотрудник добавляет свой эмодзи', !!emojiPack, JSON.stringify(errorsOf(sws)));
const emojiItem = emojiPack && (emojiPack.items || []).find((i) => i.name === emojiName);
check('в наборе есть id, автор и ссылка', !!(emojiItem && emojiItem.id && emojiItem.by === staffName
  && emojiItem.url === '/emoji/' + emojiItem.id + '?v=' + emojiItem.v), JSON.stringify(emojiItem));
from = mark(gws);
send(gws, { t: 'emoji_add', name: 'guest_' + stamp, mime: 'image/png', data: PNG });
const emojiDeny = await waitNew(gws, from, (m) => m.t === 'error' && /эмодзи/.test(m.text || ''));
check('участник не может добавить эмодзи', !!emojiDeny, JSON.stringify(errorsOf(gws)));
const emojiRes = await fetch(B + emojiItem.url);
check('картинка эмодзи отдаётся по ссылке',
  emojiRes.status === 200 && String(emojiRes.headers.get('content-type') || '').includes('image/png'),
  String(emojiRes.status));
from = mark(sws);
send(ows, { t: 'emoji_delete', id: emojiItem && emojiItem.id });
const emojiGone = await waitNew(sws, from, (m) => m.t === 'emoji_pack'
  && !(m.items || []).some((i) => i.id === (emojiItem && emojiItem.id)));
check('эмодзи удаляется из набора', !!emojiGone, JSON.stringify(errorsOf(ows)));

// --- 6. Звуковая панель.
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(96)]).toString('base64');
const soundName = 'beep' + stamp;
from = mark(gws);
send(ows, { t: 'sound_add', name: soundName, mime: 'audio/mpeg', data: mp3 });
const soundPack = await waitNew(gws, from, (m) => m.t === 'sound_pack'
  && (m.items || []).some((i) => i.name === soundName));
check('владелец добавляет звук', !!soundPack, JSON.stringify(errorsOf(ows)));
const soundItem = soundPack && (soundPack.items || []).find((i) => i.name === soundName);
check('у звука есть id и ссылка', !!(soundItem && soundItem.id && soundItem.url === '/sound/' + soundItem.id + '?v=' + soundItem.v),
  JSON.stringify(soundItem));
from = mark(gws);
send(gws, { t: 'sound_add', name: 'guest' + stamp, mime: 'audio/mpeg', data: mp3 });
const soundDeny = await waitNew(gws, from, (m) => m.t === 'error' && /Звуки добавляет/.test(m.text || ''));
check('участник не может добавлять звуки', !!soundDeny, JSON.stringify(errorsOf(gws)));
// Не в голосовом канале играть нельзя.
from = mark(gws);
send(gws, { t: 'soundboard_play', room, key: 'boing' });
const playDeny = await waitNew(gws, from, (m) => m.t === 'error' && /голосовом канале/.test(m.text || ''));
check('soundboard_play без голосового канала отклоняется', !!playDeny, JSON.stringify(errorsOf(gws)));
// Оба в голосе: второй участник получает звук.
send(ows, { t: 'voice_join', room });
await waitFor(gws, (m) => m.t === 'voice_state' && m.room === room && (m.users || []).some((u) => u.name === ownerName));
send(gws, { t: 'voice_join', room });
const voiceBoth = await waitFor(gws, (m) => m.t === 'voice_state' && m.room === room
  && (m.users || []).length === 2 && (m.users || []).every((u) => u.deaf === false));
check('deaf по умолчанию false у участников голоса', !!voiceBoth, JSON.stringify(voiceBoth && voiceBoth.users));
from = mark(ows);
send(gws, { t: 'soundboard_play', room, key: 'boing' });
const builtin = await waitNew(ows, from, (m) => m.t === 'sound_play' && m.room === room && m.by === guestName);
check('второй участник получает встроенный звук',
  !!(builtin && builtin.key === 'boing' && builtin.id === '' && builtin.url === '' && builtin.name === 'boing'),
  JSON.stringify(builtin));
await sleep(1700);
from = mark(ows);
send(gws, { t: 'soundboard_play', room, id: soundItem && soundItem.id });
const custom = await waitNew(ows, from, (m) => m.t === 'sound_play' && m.room === room && m.id === (soundItem && soundItem.id));
check('свой звук проигрывается со ссылкой',
  !!(custom && custom.name === soundName && custom.url === soundItem.url && custom.key === ''),
  JSON.stringify(custom));
const soundRes = await fetch(B + soundItem.url);
check('звук отдаётся по ссылке с долгим кэшем',
  soundRes.status === 200 && String(soundRes.headers.get('cache-control') || '').includes('604800'),
  String(soundRes.status));
// --- 9. Оглушение.
from = mark(gws);
send(ows, { t: 'voice_deafen', deaf: true });
const deafState = await waitNew(gws, from, (m) => m.t === 'voice_state' && m.room === room
  && (m.users || []).some((u) => u.name === ownerName && u.deaf === true && u.muted === true));
check('voice_deafen виден в voice_state и глушит микрофон', !!deafState, JSON.stringify(deafState && deafState.users));
from = mark(gws);
send(ows, { t: 'voice_mute', muted: false });
const undeaf = await waitNew(gws, from, (m) => m.t === 'voice_state' && m.room === room
  && (m.users || []).some((u) => u.name === ownerName && u.deaf === false && u.muted === false));
check('включение микрофона снимает оглушение', !!undeaf, JSON.stringify(undeaf && undeaf.users));
send(ows, { t: 'voice_leave' });
send(gws, { t: 'voice_leave' });
await waitFor(ows, (m) => m.t === 'voice_state' && m.room === room && (m.users || []).length === 0);

// --- 7. Аудит.
from = mark(sws);
send(sws, { t: 'audit_list' });
const audit = await waitNew(sws, from, (m) => m.t === 'audit');
const actions = audit ? (audit.items || []).map((i) => i.action) : [];
check('сотрудник видит журнал действий', !!(audit && actions.length >= 4), JSON.stringify(actions));
check('в журнале есть ключевые действия',
  ['channel_create', 'channel_slow', 'channel_topic', 'pin', 'unpin', 'emoji_add', 'sound_add'].every((a) => actions.includes(a)),
  JSON.stringify(actions));
check('записи журнала с актором и целью',
  !!(audit && (audit.items || []).every((i) => i.ts > 0 && i.actor && i.action)), JSON.stringify(audit && audit.items && audit.items[0]));
from = mark(gws);
send(gws, { t: 'audit_list' });
const auditDeny = await waitNew(gws, from, (m) => m.t === 'error' && /Журнал/.test(m.text || ''));
check('участнику журнал закрыт', !!auditDeny, JSON.stringify(errorsOf(gws)));

// --- 8. Пересылка сообщения в другой канал.
send(ows, { t: 'create', room: 'forward ' + stamp, title: 'forward ' + stamp });
const created2 = await waitFor(ows, (m) => m.t === 'channel_created' && m.room && m.room !== room);
const room2 = created2 && created2.room;
send(ows, { t: 'channel_add', room: room2, name: guestName });
await waitFor(gws, (m) => m.t === 'channels' && (m.channels || []).includes(room2));
from = mark(gws);
send(gws, { t: 'msg', room, text: 'перешли меня ' + stamp });
const fwdSource = await waitNew(gws, from, (m) => m.t === 'msg' && m.text === 'перешли меня ' + stamp);
from = mark(ows);
const guestFwdFrom = mark(gws);
send(ows, { t: 'msg_forward', room, id: fwdSource && fwdSource.id, to: room2 });
const forwarded = await waitNew(ows, from, (m) => m.t === 'forwarded' && m.to === room2);
check('отправителю приходит подтверждение пересылки', !!forwarded, JSON.stringify(errorsOf(ows)));
const fwdMsg = await waitNew(gws, guestFwdFrom, (m) => m.t === 'msg' && m.room === room2 && m.fwd);
check('пересланное сообщение получает адресат и поле fwd',
  !!(fwdMsg && fwdMsg.text === 'перешли меня ' + stamp && fwdMsg.author === ownerName
    && fwdMsg.fwd.author === guestName && fwdMsg.fwd.text === 'перешли меня ' + stamp
    && fwdMsg.fwd.ts === (fwdSource && fwdSource.ts)), JSON.stringify(fwdMsg));

// --- 10. Статус текстом.
from = mark(ows);
const statusFromOthers = mark(sws);
send(ows, { t: 'profile_update', profile: { statusText: 'На связи ' + stamp, statusEmoji: '🎧' } });
const statusProfile = await waitNew(ows, from, (m) => m.t === 'profile' && m.profile
  && m.profile.statusText === 'На связи ' + stamp);
check('статус текстом сохраняется в профиле',
  !!(statusProfile && statusProfile.profile.statusEmoji === '🎧'), JSON.stringify(statusProfile && statusProfile.profile));
const statusChanged = await waitNew(sws, statusFromOthers, (m) => m.t === 'profile_changed' && m.profile
  && m.profile.statusText === 'На связи ' + stamp);
check('статус приходит другим как profile_changed', !!statusChanged, '');

// --- 11. Категории каналов.
from = mark(gws);
send(gws, { t: 'cat_add', name: 'Работа' });
const cats1 = await waitNew(gws, from, (m) => m.t === 'cats' && (m.items || []).length === 1);
const catId = cats1 && cats1.items[0] && cats1.items[0].id;
check('категория добавляется', !!(cats1 && cats1.items[0].name === 'Работа' && catId), JSON.stringify(cats1));
from = mark(gws);
send(gws, { t: 'channel_cat', room, cat: catId });
const cats2 = await waitNew(gws, from, (m) => m.t === 'cats' && (m.map || {})[room] === catId);
check('канал назначается в категорию', !!cats2, JSON.stringify(cats2));
send(gws, { t: 'join', room });
const chansWithCats = await waitFor(gws, (m) => m.t === 'channels' && (m.catMap || {})[room] === catId
  && (m.cats || []).some((c) => c.id === catId));
check('channelPayload содержит cats и catMap', !!chansWithCats, JSON.stringify(chansWithCats && { cats: chansWithCats.cats, catMap: chansWithCats.catMap }));
from = mark(gws);
send(gws, { t: 'cat_rename', id: catId, name: 'Дела' });
const cats3 = await waitNew(gws, from, (m) => m.t === 'cats' && (m.items || []).some((c) => c.id === catId && c.name === 'Дела'));
check('категория переименовывается', !!cats3, JSON.stringify(cats3 && cats3.items));
from = mark(gws);
send(gws, { t: 'cat_remove', id: catId });
const cats4 = await waitNew(gws, from, (m) => m.t === 'cats' && (m.items || []).length === 0
  && !((m.map || {})[room]));
check('категория удаляется вместе с привязкой', !!cats4, JSON.stringify(cats4));

// --- 12. Фильтры поиска.
const searchText = 'уникальное слово ' + stamp;
from = mark(gws);
send(gws, { t: 'msg', room, text: searchText + ' https://example.com/x' });
const searchMsg = await waitNew(gws, from, (m) => m.t === 'msg' && m.text.includes('уникальное слово'));
from = mark(ows);
send(ows, { t: 'search_messages', q: 'уникальное', from: guestName });
const foundFrom = await waitNew(ows, from, (m) => m.t === 'search_results' && m.q === 'уникальное');
check('поиск с фильтром from находит сообщения автора',
  !!(foundFrom && (foundFrom.hits || []).length === 1
    && foundFrom.hits[0].author === guestName
    && foundFrom.hits[0].id === (searchMsg && searchMsg.id)
    && foundFrom.hits[0].kind === 'link'), JSON.stringify(foundFrom));
from = mark(ows);
send(ows, { t: 'search_messages', q: 'уникальное', from: 'нет-такого' });
const foundNone = await waitNew(ows, from, (m) => m.t === 'search_results');
check('фильтр from отсекает чужих авторов', !!(foundNone && (foundNone.hits || []).length === 0), JSON.stringify(foundNone));
from = mark(ows);
send(ows, { t: 'search_messages', q: 'Куда идём', has: 'poll' });
const foundPoll = await waitNew(ows, from, (m) => m.t === 'search_results');
check('поиск has=poll находит опросы',
  !!(foundPoll && (foundPoll.hits || []).length === 1 && foundPoll.hits[0].kind === 'poll'
    && foundPoll.hits[0].id === pollId), JSON.stringify(foundPoll));
from = mark(ows);
send(ows, { t: 'search_messages', q: 'уникальное', before: (searchMsg && searchMsg.ts) });
const noneOld = await waitNew(ows, from, (m) => m.t === 'search_results');
check('фильтр before отсекает свежие сообщения', !!(noneOld && (noneOld.hits || []).length === 0), JSON.stringify(noneOld));
from = mark(ows);
send(ows, { t: 'search_messages', q: 'уникальное', before: (searchMsg && searchMsg.ts) + 1 });
const foundOld = await waitNew(ows, from, (m) => m.t === 'search_results');
check('фильтр before оставляет сообщения старше времени', !!(foundOld && (foundOld.hits || []).length === 1), JSON.stringify(foundOld));

// Уборка.
for (const [tok, pass] of [[owner.data.token, 'parol123'], [staff.data.token, 'parol123'], [guest.data.token, 'parol123']]) {
  const c = await open(tok);
  send(c, { t: 'account_delete', password: pass });
  await sleep(500);
  try { c.ws.close(); } catch (_) {}
}
try { ows.ws.close(); sws.ws.close(); gws.ws.close(); } catch (_) {}

console.log('\nпроблем: ' + problems.length);
if (problems.length) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 300);
