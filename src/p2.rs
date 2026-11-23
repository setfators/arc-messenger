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
        drop(hub.voice_leave_internal(&key, &name));
        let voice = hub.voice.lock().unwrap().keys().cloned().collect::<Vec<_>>();
        drop(voice);
        for room in hub.voice.lock().unwrap().keys().cloned().collect::<Vec<_>>() {
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
                hub.send_to(key, &json!({ "t": "error", "text": "Такой канал уже есть" }));
                return;
            }
            hub.save();
            hub.broadcast(&json!({ "t": "channels", "channels": hub.channels() }));
            hub.send_to(key, &json!({ "t": "history", "room": room, "messages": [] }));
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
                if !members.iter().any(|m| m.name == name) {
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
                    if let Some(member) = members.iter_mut().find(|m| m.name == name) {
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
                    members.iter().any(|m| m.name == name)
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
            let mutual = store
                .users
                .get(target)
                .map(|u| u.outgoing.iter().any(|k| k == key))
                .unwrap_or(false);
            if mutual {
                if let Some(me) = store.users.get_mut(key) {
                    me.friends.push(target.to_string());
                    me.incoming.retain(|k| k != target);
                    me.outgoing.retain(|k| k != target);
                }
                if let Some(other) = store.users.get_mut(target) {
                    other.friends.push(key.to_string());
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
            if let Some(me) = store.users.get_mut(key) {
                me.friends.push(target.to_string());
                me.incoming.retain(|k| k != target);
            }
            if let Some(other) = store.users.get_mut(target) {
                other.friends.push(key.to_string());
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
    Json(json!({ "channels": channels, "users": store.users.len(), "online": hub.online_names() }))
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
