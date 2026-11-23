//! rust-messenger — мессенджер с каналами, друзьями и голосовым чатом.
//!
//! Сервер на axum: раздаёт страницу, держит WebSocket у каждого клиента,
//! хранит аккаунты, друзей и историю в data/state.json.
//! Голос — WebRTC между браузерами, сервер только передаёт сигналы.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

const HISTORY_LIMIT: usize = 400;
const MAX_TEXT_CHARS: usize = 4000;
const DEFAULT_CHANNEL: &str = "obshiy";
const DEFAULT_PORT: u16 = 8080;
const STATE_FILE: &str = "data/state.json";

static COUNTER: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn next_id() -> u64 {
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn clip(text: &str, limit: usize) -> String {
    let mut out: String = text.chars().take(limit).collect();
    if text.chars().count() > limit {
        out.push('…');
    }
    out
}

fn color_for(seed: &str) -> String {
    const COLORS: [&str; 8] = [
        "#5865f2", "#eb459e", "#3ba55d", "#faa61a", "#00a8fc", "#ed4245", "#9b59b6", "#1abc9c",
    ];
    let mut hash: u64 = 0;
    for byte in seed.as_bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(*byte as u64);
    }
    COLORS[(hash % COLORS.len() as u64) as usize].to_string()
}

fn hash_password(password: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b"|");
    hasher.update(password.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn new_token(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hasher.update(now_ms().to_string().as_bytes());
    hasher.update(next_id().to_string().as_bytes());
    hasher
        .finalize()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// ---------------------------------------------------------------- данные

#[derive(Serialize, Deserialize, Clone, Default)]
struct User {
    key: String,
    name: String,
    pass: String,
    salt: String,
    color: String,
    created: u64,
    #[serde(default)]
    friends: Vec<String>,
    #[serde(default)]
    incoming: Vec<String>,
    #[serde(default)]
    outgoing: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Msg {
    id: u64,
    room: String,
    author: String,
    text: String,
    ts: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Store {
    #[serde(default)]
    users: HashMap<String, User>,
    #[serde(default)]
    rooms: HashMap<String, VecDeque<Msg>>,
    #[serde(default)]
    channels: Vec<String>,
    #[serde(default)]
    tokens: HashMap<String, String>,
}

impl Store {
    fn ensure_defaults(&mut self) {
        // В файле могли остаться дубли/пустые имена (ручная правка, старые версии).
        let mut seen: HashSet<String> = HashSet::new();
        self.channels
            .retain(|channel| !channel.trim().is_empty() && seen.insert(channel.clone()));
        if !self.channels.iter().any(|c| c == DEFAULT_CHANNEL) {
            self.channels.insert(0, DEFAULT_CHANNEL.to_string());
        }
        // У каждого канала должна быть своя (возможно пустая) история.
        for channel in self.channels.clone() {
            self.rooms.entry(channel).or_default();
        }
    }

    fn push_message(&mut self, room: &str, message: Msg) {
        let entry = self.rooms.entry(room.to_string()).or_default();
        entry.push_back(message);
        while entry.len() > HISTORY_LIMIT {
            entry.pop_front();
        }
    }

    fn history(&self, room: &str) -> Vec<Msg> {
        self.rooms
            .get(room)
            .map(|list| list.iter().cloned().collect())
            .unwrap_or_default()
    }
}

fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase()
}

fn valid_name(name: &str) -> bool {
    let count = name.chars().count();
    if !(2..=20).contains(&count) {
        return false;
    }
    name.chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == ' ')
}

fn dm_room(a: &str, b: &str) -> String {
    let (first, second) = if a <= b { (a, b) } else { (b, a) };
    format!("dm:{first}|{second}")
}

fn dm_partners(room: &str) -> Option<(&str, &str)> {
    let rest = room.strip_prefix("dm:")?;
    let (a, b) = rest.split_once('|')?;
    Some((a, b))
}

// ---------------------------------------------------------------- голос

#[derive(Serialize, Clone, Debug)]
struct VoiceMember {
    name: String,
    muted: bool,
}

#[derive(Clone)]
struct Conn {
    id: u64,
    tx: UnboundedSender<String>,
}

struct Hub {
    store: Mutex<Store>,
    /// Сериализует записи на диск: два параллельных save() иначе могут
    /// переименовать временные файлы в неверном порядке и потерять сообщение.
    save_lock: Mutex<()>,
    clients: Mutex<HashMap<String, Conn>>,
    voice: Mutex<HashMap<String, Vec<VoiceMember>>>,
}

fn state_path(suffix: &str) -> String {
    format!("{STATE_FILE}.{suffix}")
}

impl Hub {
    fn load() -> Self {
        let mut store = Self::load_store();
        store.ensure_defaults();
        let hub = Self {
            store: Mutex::new(store),
            save_lock: Mutex::new(()),
            clients: Mutex::new(HashMap::new()),
            voice: Mutex::new(HashMap::new()),
        };
        hub.save();
        hub
    }

    /// Читает состояние. Если файл повреждён — уводит его в `state.json.broken-<ts>`
    /// и возвращает пустое хранилище, чтобы следующее сохранение не затёрло данные молча.
    fn load_store() -> Store {
        let text = match fs::read_to_string(STATE_FILE) {
            Ok(text) => Some(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Сохранение могло прерваться между переименованиями.
                let old = state_path("old");
                match fs::read_to_string(&old) {
                    Ok(text) => {
                        println!("  {STATE_FILE} не найден — восстановлен из {old}");
                        Some(text)
                    }
                    Err(_) => None,
                }
            }
            Err(error) => {
                eprintln!("ВНИМАНИЕ: {STATE_FILE} не читается: {error}");
                fs::read_to_string(state_path("old")).ok()
            }
        };
        let Some(text) = text else {
            return Store::default();
        };
        match serde_json::from_str::<Store>(&text) {
            Ok(store) => store,
            Err(error) => {
                let broken = state_path(&format!("broken-{}", now_ms()));
                eprintln!("ВНИМАНИЕ: {STATE_FILE} повреждён: {error}");
                let moved = fs::rename(STATE_FILE, &broken).is_ok();
                if !moved {
                    let _ = fs::copy(STATE_FILE, &broken);
                }
                if fs::metadata(&broken).is_ok() {
                    eprintln!(
                        "  Повреждённый файл сохранён как {broken} — сервер стартует с пустой базой."
                    );
                    eprintln!(
                        "  Расскажите об этом тому, кто занимается сервером: данные можно спасти."
                    );
                } else {
                    eprintln!("  Копию сделать не удалось — файл будет перезаписан пустым.");
                }
                Store::default()
            }
        }
    }

    /// Пишет состояние атомарно: сначала временный файл рядом, затем rename.
    /// Временный файл остаётся в том же каталоге, поэтому rename не переходит
    /// между дисками. На Windows rename поверх существующего файла запрещён,
    /// поэтому старый файл сначала уводится в `state.json.old`.
    fn save(&self) {
        let _guard = self.save_lock.lock().unwrap();
        let text = {
            let store = self.store.lock().unwrap();
            serde_json::to_string(&*store).unwrap_or_default()
        };
        if text.is_empty() {
            return;
        }
        if let Some(dir) = Path::new(STATE_FILE).parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = state_path(&format!("{}.tmp", next_id()));
        let written = fs::File::create(&tmp)
            .and_then(|mut file| {
                file.write_all(text.as_bytes())?;
                file.sync_all()
            })
            .is_ok();
        if !written {
            eprintln!("ВНИМАНИЕ: не удалось записать {tmp} — состояние не сохранено");
            let _ = fs::remove_file(&tmp);
            return;
        }
        let old = state_path("old");
        let _ = fs::remove_file(&old);
        let had_old = fs::rename(STATE_FILE, &old).is_ok();
        if let Err(error) = fs::rename(&tmp, STATE_FILE) {
            eprintln!("ВНИМАНИЕ: не удалось заменить {STATE_FILE}: {error}");
            if had_old {
                let _ = fs::rename(&old, STATE_FILE);
            }
            let _ = fs::remove_file(&tmp);
        } else if had_old {
            let _ = fs::remove_file(&old);
        }
    }

    fn online_names(&self) -> Vec<String> {
        let clients = self.clients.lock().unwrap();
        let store = self.store.lock().unwrap();
        let mut names: Vec<String> = clients
            .keys()
            .filter_map(|key| store.users.get(key).map(|u| u.name.clone()))
            .collect();
        names.sort();
        names
    }

    fn send_to(&self, key: &str, value: &Value) {
        let text = value.to_string();
        let clients = self.clients.lock().unwrap();
        if let Some(conn) = clients.get(key) {
            let _ = conn.tx.send(text);
        }
    }

    fn broadcast(&self, value: &Value) {
        let text = value.to_string();
        let clients = self.clients.lock().unwrap();
        for conn in clients.values() {
            let _ = conn.tx.send(text.clone());
        }
    }

    fn broadcast_except(&self, skip: &str, value: &Value) {
        let text = value.to_string();
        let clients = self.clients.lock().unwrap();
        for (key, conn) in clients.iter() {
            if key == skip {
                continue;
            }
            let _ = conn.tx.send(text.clone());
        }
    }

    fn friends_view(&self, key: &str) -> Value {
        let online: Vec<String> = self.online_names();
        let store = self.store.lock().unwrap();
        let me = store.users.get(key);
        let (friends, incoming, outgoing) = match me {
            Some(user) => (
                user.friends.clone(),
                user.incoming.clone(),
                user.outgoing.clone(),
            ),
            None => (Vec::new(), Vec::new(), Vec::new()),
        };
        let render = |keys: &[String], store: &Store| -> Vec<Value> {
            keys.iter()
                .filter_map(|k| store.users.get(k))
                .map(|u| {
                    json!({
                        "name": u.name,
                        "color": u.color,
                        "online": online.iter().any(|n| n.eq_ignore_ascii_case(&u.name)),
                    })
                })
                .collect()
        };
        json!({
            "t": "friends",
            "friends": render(&friends, &store),
            "incoming": render(&incoming, &store),
            "outgoing": render(&outgoing, &store),
        })
    }

    fn dm_list(&self, key: &str) -> Vec<Value> {
        let store = self.store.lock().unwrap();
        let mut items: Vec<Value> = Vec::new();
        for (room, messages) in store.rooms.iter() {
            if let Some((a, b)) = dm_partners(room) {
                if a != key && b != key {
                    continue;
                }
                let other_key = if a == key { b } else { a };
                let Some(other) = store.users.get(other_key) else {
                    continue;
                };
                let last = messages.back();
                items.push(json!({
                    "room": room,
                    "name": other.name,
                    "color": other.color,
                    "last_text": last.map(|m| clip(&m.text, 40)).unwrap_or_default(),
                    "last_ts": last.map(|m| m.ts).unwrap_or(0),
                }));
            }
        }
        items.sort_by_key(|item| -item["last_ts"].as_i64().unwrap_or(0));
        items
    }

    fn channels(&self) -> Vec<String> {
        let store = self.store.lock().unwrap();
        store.channels.clone()
    }

    fn voice_state(&self, room: &str) -> Value {
        let voice = self.voice.lock().unwrap();
        let members = voice.get(room).cloned().unwrap_or_default();
        json!({ "t": "voice_state", "room": room, "users": members })
    }

    fn voice_leave_internal(&self, key: &str, name: &str) -> Option<String> {
        let mut voice = self.voice.lock().unwrap();
        let mut left = None;
        voice.retain(|room, members| {
            let before = members.len();
            members.retain(|m| !m.name.eq_ignore_ascii_case(name));
            if members.len() != before {
                left = Some(room.clone());
            }
            !members.is_empty()
        });
        let _ = key;
        left
    }
}
// ---------------------------------------------------------------- websocket

#[derive(Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn ws_handler(
    State(hub): State<Arc<Hub>>,
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
) -> Response {
    let token = query.token.unwrap_or_default();
    let key = {
        let store = hub.store.lock().unwrap();
        store.tokens.get(&token).cloned()
    };
    match key {
        Some(key) => ws
            .on_upgrade(move |socket| handle_socket(hub, socket, key))
            .into_response(),
        None => (StatusCode::UNAUTHORIZED, "Нужен вход").into_response(),
    }
}

async fn handle_socket(hub: Arc<Hub>, socket: WebSocket, key: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = unbounded_channel::<String>();
    let conn_id = next_id();

    let name = {
        let store = hub.store.lock().unwrap();
        match store.users.get(&key) {
            Some(user) => user.name.clone(),
            None => return,
        }
    };

    {
        let mut clients = hub.clients.lock().unwrap();
        clients.insert(
            key.clone(),
            Conn {
                id: conn_id,
                tx: tx.clone(),
            },
        );
    }

    let hello = {
        let store = hub.store.lock().unwrap();
        let me = store.users.get(&key).cloned().unwrap_or_default();
        json!({
            "t": "hello",
            "me": { "name": me.name, "color": me.color },
            "channels": store.channels,
        })
    };
    let _ = tx.send(hello.to_string());
    let _ = tx.send(hub.friends_view(&key).to_string());
    let _ = tx.send(json!({ "t": "dm_list", "items": hub.dm_list(&key) }).to_string());
    hub.broadcast(&json!({ "t": "presence", "online": hub.online_names() }));

    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => handle_client(&hub, &key, &name, text.as_str()),
            Message::Close(_) => break,
            _ => {}
        }
    }

    let was_current = {
        let mut clients = hub.clients.lock().unwrap();
        let current = clients.get(&key).map(|c| c.id) == Some(conn_id);
        if current {
            clients.remove(&key);
        }
        current
    };

    if was_current {
        if let Some(room) = hub.voice_leave_internal(&key, &name) {
            hub.broadcast(&hub.voice_state(&room));
        }
        hub.broadcast(&json!({ "t": "presence", "online": hub.online_names() }));
    }
    writer.abort();
}

fn handle_client(hub: &Arc<Hub>, key: &str, name: &str, text: &str) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return;
    };
    let kind = value["t"].as_str().unwrap_or("");

    match kind {
        "join" | "dm_open" => {
            let mut dm_peer: Option<String> = None;
            let room = if kind == "dm_open" {
                let other = normalize_name(value["name"].as_str().unwrap_or(""));
                let exists = { hub.store.lock().unwrap().users.contains_key(&other) };
                if !exists || other == key {
                    hub.send_to(
                        key,
                        &json!({ "t": "error", "text": "Такого пользователя нет" }),
                    );
                    return;
                }
                let room = dm_room(key, &other);
                {
                    let mut store = hub.store.lock().unwrap();
                    store.rooms.entry(room.clone()).or_default();
                }
                hub.save();
                dm_peer = Some(other);
                room
            } else {
                value["room"].as_str().unwrap_or("").to_string()
            };

            let (allowed, history) = {
                let store = hub.store.lock().unwrap();
                let is_channel = store.channels.iter().any(|c| *c == room);
                let is_dm = dm_partners(&room)
                    .map(|(a, b)| a == key || b == key)
                    .unwrap_or(false);
                (is_channel || is_dm, store.history(&room))
            };
            if !allowed {
                return;
            }
            hub.send_to(
                key,
                &json!({ "t": "history", "room": room, "messages": history }),
            );
            hub.send_to(key, &json!({ "t": "dm_list", "items": hub.dm_list(key) }));
            if let Some(other) = dm_peer {
                // Собеседник должен увидеть новый диалог в списке, даже если ещё молчит.
                hub.send_to(
                    &other,
                    &json!({ "t": "dm_list", "items": hub.dm_list(&other) }),
                );
            }
        }

        // Прикладной heartbeat: браузер шлёт ping, чтобы заметить полумёртвое соединение.
        "ping" => {
            hub.send_to(key, &json!({ "t": "pong", "ts": now_ms() }));
        }

        "typing" => {
            let room = value["room"].as_str().unwrap_or("");
            let allowed = {
                let store = hub.store.lock().unwrap();
                store.channels.iter().any(|c| c == room)
                    || dm_partners(room)
                        .map(|(a, b)| a == key || b == key)
                        .unwrap_or(false)
            };
            if !allowed {
                return;
            }
            hub.broadcast_except(key, &json!({ "t": "typing", "room": room, "author": name }));
        }

        "msg" => {
            let room = value["room"].as_str().unwrap_or("").to_string();
            let body = value["text"].as_str().unwrap_or("").trim().to_string();
            if body.is_empty() || body.chars().count() > MAX_TEXT_CHARS {
                return;
            }
            let saved = {
                let mut store = hub.store.lock().unwrap();
                let is_channel = store.channels.iter().any(|c| *c == room);
                let is_dm = dm_partners(&room)
                    .map(|(a, b)| a == key || b == key)
                    .unwrap_or(false);
                if is_channel || is_dm {
                    let message = Msg {
                        id: next_id(),
                        room: room.clone(),
                        author: name.to_string(),
                        text: body,
                        ts: now_ms(),
                    };
                    store.push_message(&room, message.clone());
                    Some(message)
                } else {
                    None
                }
            };
            let Some(message) = saved else { return };
            hub.save();
            let event = json!({
                "t": "msg",
                "id": message.id,
                "room": message.room,
                "author": message.author,
                "text": message.text,
                "ts": message.ts,
            });
            match dm_partners(&message.room) {
                Some((a, b)) => {
                    hub.send_to(a, &event);
                    hub.send_to(b, &event);
                    hub.send_to(a, &json!({ "t": "dm_list", "items": hub.dm_list(a) }));
                    hub.send_to(b, &json!({ "t": "dm_list", "items": hub.dm_list(b) }));
                }
                None => hub.broadcast(&event),
            }
        }

        "create" => {
            let raw = value["room"].as_str().unwrap_or("").trim().to_lowercase();
            let room: String = raw
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .take(24)
                .collect();
            if room.len() < 2 {
                hub.send_to(
                    key,
                    &json!({ "t": "error", "text": "Название канала: латиница, 2–24 символа" }),
                );
                return;
            }
            let created = {
                let mut store = hub.store.lock().unwrap();
                if store.channels.iter().any(|c| *c == room) {
                    false
                } else {
                    store.channels.push(room.clone());
                    store.rooms.entry(room.clone()).or_default();
                    true
                }
            };
            if !created {
                hub.send_to(
                    key,
                    &json!({ "t": "error", "text": "Такой канал уже есть" }),
                );
                return;
            }
            hub.save();
            hub.broadcast(&json!({ "t": "channels", "channels": hub.channels() }));
            hub.send_to(
                key,
                &json!({ "t": "history", "room": room, "messages": [] }),
            );
        }

        "friend_add" | "friend_accept" | "friend_remove" => {
            let target = normalize_name(value["name"].as_str().unwrap_or(""));
            let outcome = friends_action(hub, key, kind, &target);
            match outcome {
                Ok(notify) => {
                    hub.save();
                    hub.send_to(key, &hub.friends_view(key));
                    hub.send_to(&target, &hub.friends_view(&target));
                    if notify {
                        hub.send_to(
                            &target,
                            &json!({ "t": "notice", "text": format!("{name} хочет добавить вас в друзья") }),
                        );
                    }
                }
                Err(text) => hub.send_to(key, &json!({ "t": "error", "text": text })),
            }
        }

        "voice_join" => {
            let room = value["room"].as_str().unwrap_or("").to_string();
            let valid = {
                let store = hub.store.lock().unwrap();
                store.channels.iter().any(|c| *c == room)
            };
            if !valid {
                return;
            }
            if let Some(old) = hub.voice_leave_internal(key, name) {
                hub.broadcast(&hub.voice_state(&old));
            }
            {
                let mut voice = hub.voice.lock().unwrap();
                let members = voice.entry(room.clone()).or_default();
                if !members.iter().any(|m| m.name.eq_ignore_ascii_case(name)) {
                    members.push(VoiceMember {
                        name: name.to_string(),
                        muted: false,
                    });
                }
            }
            hub.broadcast(&hub.voice_state(&room));
        }

        "voice_leave" => {
            if let Some(room) = hub.voice_leave_internal(key, name) {
                hub.broadcast(&hub.voice_state(&room));
            }
        }

        "voice_mute" => {
            let muted = value["muted"].as_bool().unwrap_or(false);
            let mut rooms = Vec::new();
            {
                let mut voice = hub.voice.lock().unwrap();
                for (room, members) in voice.iter_mut() {
                    if let Some(member) = members
                        .iter_mut()
                        .find(|m| m.name.eq_ignore_ascii_case(name))
                    {
                        member.muted = muted;
                        rooms.push(room.clone());
                    }
                }
            }
            for room in rooms {
                hub.broadcast(&hub.voice_state(&room));
            }
        }

        "rtc" => {
            let to_name = value["to"].as_str().unwrap_or("").to_string();
            let rtc_kind = value["kind"].as_str().unwrap_or("");
            if to_name.is_empty() || rtc_kind.is_empty() {
                return;
            }
            let same_room = {
                let voice = hub.voice.lock().unwrap();
                voice.values().any(|members| {
                    members.iter().any(|m| m.name.eq_ignore_ascii_case(name))
                        && members
                            .iter()
                            .any(|m| m.name.eq_ignore_ascii_case(&to_name))
                })
            };
            if !same_room {
                return;
            }
            let event = json!({
                "t": "rtc",
                "from": name,
                "kind": rtc_kind,
                "payload": value["payload"].clone(),
            });
            hub.send_to(&normalize_name(&to_name), &event);
        }

        _ => {}
    }
}

fn friends_action(hub: &Arc<Hub>, key: &str, kind: &str, target: &str) -> Result<bool, String> {
    let mut store = hub.store.lock().unwrap();
    if target == key {
        return Err("Это вы".into());
    }
    if !store.users.contains_key(target) {
        return Err("Такого пользователя нет".into());
    }
    let already = store
        .users
        .get(key)
        .map(|u| u.friends.iter().any(|f| f == target))
        .unwrap_or(false);

    match kind {
        "friend_add" => {
            if already {
                return Err("Уже в друзьях".into());
            }
            // Повторное нажатие «Добавить» не должно слать второе уведомление.
            let already_requested = store
                .users
                .get(key)
                .map(|u| u.outgoing.iter().any(|k| k == target))
                .unwrap_or(false);
            if already_requested {
                return Err("Заявка уже отправлена".into());
            }
            let mutual = store
                .users
                .get(target)
                .map(|u| u.outgoing.iter().any(|k| k == key) || u.friends.iter().any(|k| k == key))
                .unwrap_or(false);
            if mutual {
                if let Some(me) = store.users.get_mut(key) {
                    if !me.friends.iter().any(|k| k == target) {
                        me.friends.push(target.to_string());
                    }
                    me.incoming.retain(|k| k != target);
                    me.outgoing.retain(|k| k != target);
                }
                if let Some(other) = store.users.get_mut(target) {
                    if !other.friends.iter().any(|k| k == key) {
                        other.friends.push(key.to_string());
                    }
                    other.incoming.retain(|k| k != key);
                    other.outgoing.retain(|k| k != key);
                }
                Ok(false)
            } else {
                if let Some(me) = store.users.get_mut(key) {
                    if !me.outgoing.iter().any(|k| k == target) {
                        me.outgoing.push(target.to_string());
                    }
                }
                if let Some(other) = store.users.get_mut(target) {
                    if !other.incoming.iter().any(|k| k == key) {
                        other.incoming.push(key.to_string());
                    }
                }
                Ok(true)
            }
        }
        "friend_accept" => {
            if already {
                return Err("Уже в друзьях".into());
            }
            // Принять можно только реально пришедшую заявку, а не выдуманное имя.
            let has_request = store
                .users
                .get(key)
                .map(|u| u.incoming.iter().any(|k| k == target))
                .unwrap_or(false);
            if !has_request {
                return Err("Заявки от этого человека нет".into());
            }
            if let Some(me) = store.users.get_mut(key) {
                if !me.friends.iter().any(|k| k == target) {
                    me.friends.push(target.to_string());
                }
                me.incoming.retain(|k| k != target);
                me.outgoing.retain(|k| k != target);
            }
            if let Some(other) = store.users.get_mut(target) {
                if !other.friends.iter().any(|k| k == key) {
                    other.friends.push(key.to_string());
                }
                other.incoming.retain(|k| k != key);
                other.outgoing.retain(|k| k != key);
            }
            Ok(false)
        }
        "friend_remove" => {
            if let Some(me) = store.users.get_mut(key) {
                me.friends.retain(|k| k != target);
                me.incoming.retain(|k| k != target);
                me.outgoing.retain(|k| k != target);
            }
            if let Some(other) = store.users.get_mut(target) {
                other.friends.retain(|k| k != key);
                other.incoming.retain(|k| k != key);
                other.outgoing.retain(|k| k != key);
            }
            Ok(false)
        }
        _ => Ok(false),
    }
}

// ---------------------------------------------------------------- авторизация

#[derive(Deserialize)]
struct AuthBody {
    name: String,
    password: String,
}

fn auth_inner(hub: &Hub, body: &AuthBody, register: bool) -> Result<Value, String> {
    let name = body.name.trim().to_string();
    if register && !valid_name(&name) {
        return Err("Имя: 2–20 символов — буквы, цифры, пробел, _ или -".into());
    }
    if body.password.chars().count() < 4 {
        return Err("Пароль не короче 4 символов".into());
    }
    let key = normalize_name(&name);
    let mut store = hub.store.lock().unwrap();

    if register {
        if store.users.contains_key(&key) {
            return Err("Такое имя уже занято".into());
        }
        let salt = new_token(&format!("{key}{}", now_ms()));
        let user = User {
            key: key.clone(),
            name: name.clone(),
            pass: hash_password(&body.password, &salt),
            salt,
            color: color_for(&key),
            created: now_ms(),
            friends: Vec::new(),
            incoming: Vec::new(),
            outgoing: Vec::new(),
        };
        store.users.insert(key.clone(), user);
    } else {
        let Some(existing) = store.users.get(&key) else {
            return Err("Нет такого пользователя".into());
        };
        if existing.pass != hash_password(&body.password, &existing.salt) {
            return Err("Неверный пароль".into());
        }
    }

    let token = new_token(&key);
    store.tokens.insert(token.clone(), key.clone());
    store.ensure_defaults();
    if store.tokens.len() > 2000 {
        store.tokens.clear();
        store.tokens.insert(token.clone(), key.clone());
    }
    let user = store.users.get(&key).cloned().unwrap_or_default();
    drop(store);
    hub.save();
    Ok(json!({ "token": token, "name": user.name, "color": user.color }))
}

async fn register(State(hub): State<Arc<Hub>>, Json(body): Json<AuthBody>) -> Response {
    match auth_inner(&hub, &body, true) {
        Ok(value) => Json(value).into_response(),
        Err(text) => (StatusCode::BAD_REQUEST, Json(json!({ "error": text }))).into_response(),
    }
}

async fn login(State(hub): State<Arc<Hub>>, Json(body): Json<AuthBody>) -> Response {
    match auth_inner(&hub, &body, false) {
        Ok(value) => Json(value).into_response(),
        Err(text) => (StatusCode::BAD_REQUEST, Json(json!({ "error": text }))).into_response(),
    }
}

// ---------------------------------------------------------------- страницы

async fn index() -> Html<&'static str> {
    Html(include_str!("../web/index.html"))
}

async fn health() -> &'static str {
    "ok"
}

async fn rooms_api(State(hub): State<Arc<Hub>>) -> Json<Value> {
    let online = hub.online_names();
    let store = hub.store.lock().unwrap();
    let mut channels = Vec::new();
    for channel in store.channels.iter() {
        let messages = store.rooms.get(channel);
        channels.push(json!({
            "name": channel,
            "messages": messages.map(|m| m.len()).unwrap_or(0),
            "last_ts": messages.and_then(|m| m.back()).map(|m| m.ts).unwrap_or(0),
        }));
    }
    let users = store.users.len();
    drop(store);
    Json(json!({ "channels": channels, "users": users, "online": online }))
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let hub = Arc::new(Hub::load());

    let router = Router::new()
        .route("/", get(index))
        .route("/ws", get(ws_handler))
        .route("/health", get(health))
        .route("/api/rooms", get(rooms_api))
        .route("/api/register", post(register))
        .route("/api/login", post(login))
        .with_state(hub);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Не удалось занять порт {port}: {error}");
            std::process::exit(1);
        }
    };

    println!();
    println!("  Мессенджер запущен: http://127.0.0.1:{port}");
    println!("  Аккаунты, друзья и история: {STATE_FILE}");
    println!("  Остановить: Ctrl+C");
    println!();

    if let Err(error) = axum::serve(listener, router).await {
        eprintln!("Сервер остановился с ошибкой: {error}");
    }
}
