# Arc 1.13.0 — протокол новых функций (контракт сервер↔клиент)

Документ фиксирует **точные имена событий и формы данных**. Клиент уже пишется под него,
менять формы без согласования нельзя. Все новые поля состояния должны создаваться в
`ensure()` идемпотентно (старая база должна открываться без ошибок).

Общие правила:
- права: владелец канала (`ownsChannel`) и сотрудники (`canModerate`) — «модерация»;
  в личке — оба участника (`dmPartners`).
- рассылка в канал — `sendChannel(room, payload)`; в личку — `sendTo` обоим.
- всё, что меняет состояние, в конце вызывает `save()`.
- `APP_VERSION` в этом задании **не менять**.

## 1. Закреплённые сообщения

Состояние: `store.pins = { [room]: [id, ...] }` (новые первыми, не больше 50 на комнату).

Запросы:
- `{t:'msg_pin', room, id}` — закрепить;
- `{t:'msg_unpin', room, id}` — открепить.

Права: в канале — автор сообщения, владелец канала или сотрудник; в личке — участник.
Ответ всем, кто видит комнату: `{t:'pins', room, items:[{id, author, text, ts, authorProfile}]}`,
где `text` — `head(text, 200)`, сообщения берутся из `store.rooms[room]` (удалённые пропускаем).
При `history` (join/dm_open) дополнительно отправить это же событие `pins` для комнаты.
При `msg_delete` убирать id из закреплённых.

## 2. Опросы

Сообщение получает поле:
```
poll = {
  question: string,
  options: [{id:'1', text:'…'}, …],   // 2..10
  votes: { '1': ['Имя', …], … },      // имена голосующих, не ключи
  multiple: false,
  closed: false
}
```

Запросы:
- `{t:'poll_create', room, question, options:[string,…], multiple?}` — создаёт обычное
  сообщение от автора: `text = question`, `poll = {...}`, `id = ++store.seq`, `ts`, `authorProfile`.
  Валидация: вопрос 1..200, вариантов 2..10, каждый 1..80, автор может писать в комнату.
  Рассылка как у `msg` (включая `pushNotify` и Matrix при канале).
- `{t:'poll_vote', room, id, option}` — `option` = id варианта. Если `multiple:false`,
  имя голосующего убирается из остальных вариантов; повторный клик по тому же варианту
  снимает голос. Ответственность за права — как у сообщений. Закрытый опрос не принимает голоса.
  Рассылка: `{t:'msg_poll', room, id, poll}`.
- `{t:'poll_close', room, id}` — автор, владелец канала или сотрудник; `closed = true`;
  рассылка `msg_poll`.

Клиент при получении `msg` с `poll` рисует опрос; `msg_poll` обновляет его на месте.

## 3. Медленный режим канала

Состояние: `channelMeta[room].slow` — секунды, 0..21600.

Запрос: `{t:'channel_slow', room, seconds}` — владелец канала или сотрудник.
После сохранения — `broadcastChannels()`.

В обработчике `msg` для канала: если `slow > 0` и автор не владелец/сотрудник, найти
последнее сообщение автора в комнате; если прошло меньше `slow*1000` мс — не создавать
сообщение, отправить `{t:'slow_wait', room, left}` (left — целые секунды) и
`{t:'error', text:'Медленный режим: подождите N с.'}`.

## 4. Описание канала

Состояние: `channelMeta[room].topic` — строка до 200 символов.
Запрос: `{t:'channel_topic', room, topic}` — владелец или сотрудник. Затем `broadcastChannels()`.

## 5. Свои эмодзи (как стикеры, но для текста)

Состояние: `store.emoji = [{id, name, by, v}]`; байты в `emoji:<id>` = `{mime, b64, v}`.
Лимиты: 60 эмодзи, картинка до 128 КБ, имя `^[a-z0-9_]{2,20}$`, без дублей.

Запросы:
- `{t:'emoji_add', name, mime, data}` — только владелец/сотрудник (как стикеры сейчас
  разрешены всем — здесь строже). `data` — base64 или data-URL.
- `{t:'emoji_delete', id}` — владелец/сотрудник.

Ссылка: `emojiUrl(item)` = `/emoji/<id>?v=<v>`, отдаётся через `imageResponse`
(маршрут в `fetch` объекта), в `index.js` путь `/emoji/` должен уходить в объект.
Представление: `{id, name, by, v, url}`; рассылка `{t:'emoji_pack', items}` при изменении,
и при `join` — этому пользователю.

## 6. Звуковая панель

Состояние: `store.sounds = [{id, name, by, v, mime}]`; байты в `sound:<id>` = `{mime, b64, v}`.
Лимиты: 24 звука, файл до 512 КБ, имя 1..24 символа.
Разрешённые mime: `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/webm`, `audio/mp4`, `audio/aac`,
`audio/x-wav`, `audio/x-m4a`. Проверять размер и сигнатуру (ID3/0xFFFB для mp3, OggS, RIFF, ftyp, Matroska).

Запросы:
- `{t:'sound_add', name, mime, data}` — владелец/сотрудник; дубли имён заменяют старый звук.
- `{t:'sound_delete', id}` — владелец/сотрудник.
- `{t:'soundboard_play', room, key?, id?}` — играть может только человек, находящийся в
  голосовом канале этой комнаты (`this.voice.get(room)` содержит его имя). `key` — один из
  встроенных: `boing`, `drum`, `applause`, `bruh`, `airhorn`, `sparkle`, `tada`, `vine`.
  `id` — свой звук. Не чаще одного раза в 1500 мс на человека.

Рассылка участникам комнаты (в личке — обоим):
`{t:'sound_play', room, by, key, id, name, url}`; для встроенного `url:''`, `name` — ключ.
Представление своих звуков: `{id, name, by, v, url}`; `{t:'sound_pack', items}` при изменении
и при `join`. Маршрут `/sound/<id>?v=` отдаёт байты с `cache-control: public, max-age=604800`.

## 7. Журнал действий (аудит)

Состояние: `store.audit = [{id, ts, actor, actorKey, action, target, detail}]`, не больше 300.
Запрос: `{t:'audit_list'}` — только владелец/сотрудник; ответ
`{t:'audit', items:[...]}` (свежие первыми, до 200).

Записывать (где это уже происходит): `staff_add`, `staff_remove`, `kick`, `ban`, `unban`,
`mute`, `unmute`, `channel_create`, `channel_rename`, `channel_delete`, `channel_join`,
`channel_leave`, `channel_slow`, `channel_topic`, `pin`, `unpin`, `emoji_add`, `emoji_delete`,
`sound_add`, `sound_delete`, `invite_create`, `invite_revoke`, `backup_restore`,
`password_reset`, `account_delete`.
`target` — имя/название объекта, `detail` — короткая строка (может быть пустой).

## 8. Пересылка сообщения

Запрос: `{t:'msg_forward', room, id, to}` — видны обе комнаты, исходное сообщение существует.
Создаётся новое сообщение в `to`:
```
{ id: ++seq, room:to, author: моё имя, text: исходный текст (head 4000), ts: now(),
  authorProfile: profileView(моё),
  fwd: { author: исходный автор, text: head(исходный текст, 200), ts: исходный ts } }
```
Стикер копируется (объект `sticker`), вложение — нет. Дальше как обычное `msg`:
рассылка в `to`, `pushNotify`, при канале `matrixOut`. Отправителю — `{t:'forwarded', to}`.
Ограничение частоты: 10 пересылок в минуту.

## 9. Оглушение (deafen)

`voice` участник получает поле `deaf: false` при входе.
Запрос `{t:'voice_deafen', deaf}`: `member.deaf = !!deaf`; если `deaf`, то `member.muted = true`.
`voice_mute` с `muted:false` снимает и `deaf`. Затем `broadcastVoice(room)`.
`voiceState` уже отдаёт участников целиком — поле `deaf` попадёт автоматически.

## 10. Статус текстом

`profile_update` принимает `statusText` (до 60 символов, обрезать переводы строк) и
`statusEmoji` (0..1 эмодзи, до 8 кодовых пунктов; пустая строка очищает).
`profileView` добавляет `statusText`, `statusEmoji`.
При изменении — как сейчас: `profile`, `profile_changed`, `presence`.

## 11. Категории каналов (личная раскладка)

Состояние (у каждого своё):
- `store.cats = { [key]: [{id, name}] }` — до 10 категорий, имя 1..40;
- `store.catOf = { [key]: { [room]: catId } }` — к какой категории человек отнёс канал.

Запросы (только для себя, ключ = key):
- `{t:'cat_add', name}` → id = uuid-16; ответ `{t:'cats', items, map}`;
- `{t:'cat_rename', id, name}`;
- `{t:'cat_remove', id}` — удаляет категорию и её привязки;
- `{t:'channel_cat', room, cat}` — `room` среди видимых каналов пользователя, `cat` — своя
  категория или `''` (без категории).

`channelPayload` добавляет `cats: store.cats[key] || []` и `catMap: store.catOf[key] || {}`.
При `join` и `dm_open` отправлять `{t:'cats', items, map}`.

## 12. Поиск: фильтры

`search_messages` дополнительно принимает:
- `from` — имя или отображаемое имя автора (сравнение без регистра, подстрока);
- `has` — `'file' | 'image' | 'link' | 'poll'`;
- `before` — timestamp (только сообщения старше).
Ответ `search_results` не меняется (hits: room, id, author, text, ts), можно добавить
`kind` (`'file'|'poll'|'link'`) для иконки.

## 13. Мелочи

- `channelView` добавляет `topic: meta.topic || ''`, `slow: Number(meta.slow) || 0`.
- `join`/`dm_open`: после `history` отправить `pins`, `emoji_pack`, `sound_pack`, `cats`.
- `ensure()`: создать `pins`, `emoji`, `sounds`, `audit`, `cats`, `catOf` (пустые),
  вычистить закреплённые/категории удалённых комнат.
- В `statsPayload` можно добавить `pins`, `polls`, `emoji`, `sounds` — необязательно.
