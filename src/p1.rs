//! rust-messenger — мессенджер с каналами, друзьями и голосовым чатом.
//!
//! Сервер на axum: раздаёт страницу, держит WebSocket у каждого клиента,
//! хранит аккаунты, друзей и историю в data/state.json.
//! Голос — WebRTC между браузерами, сервер только передаёт сигналы.

use std::collections::{HashMap, VecDeque};
use std::fs;
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
        if !self.channels.iter().any(|c| c == DEFAULT_CHANNEL) {
            self.channels.push(DEFAULT_CHANNEL.to_string());
        }
        self.rooms.entry(DEFAULT_CHANNEL.to_string()).or_default();
    }

    fn find_by_name(&self, name: &str) -> Option<&User> {
        let key = normalize_name(name);
        self.users.get(&key)
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
    clients: Mutex<HashMap<String, Conn>>,
    voice: Mutex<HashMap<String, Vec<VoiceMember>>>,
}

impl Hub {
    fn load() -> Self {
        let mut store = if let Ok(text) = fs::read_to_string(STATE_FILE) {
            serde_json::from_str::<Store>(&text).unwrap_or_default()
        } else {
            Store::default()
        };
        store.ensure_defaults();
        let hub = Self {
            store: Mutex::new(store),
            clients: Mutex::new(HashMap::new()),
            voice: Mutex::new(HashMap::new()),
        };
        hub.save();
        hub
    }

    fn save(&self) {
        let text = {
            let store = self.store.lock().unwrap();
            serde_json::to_string(&*store).unwrap_or_default()
        };
        if let Some(dir) = Path::new(STATE_FILE).parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(STATE_FILE, text);
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

    fn friends_view(&self, key: &str) -> Value {
        let store = self.store.lock().unwrap();
        let me = store.users.get(key);
        let online: Vec<String> = self.online_names();
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
