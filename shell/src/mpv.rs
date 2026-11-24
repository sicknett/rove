//! libmpv, loaded at runtime, and the thread that turns its events into messages for the page.

use std::collections::BTreeMap;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};

use libloading::Library;
use serde_json::{Map, Value, json};

type Handle = *mut c_void;

const FORMAT_STRING: c_int = 1;
const FORMAT_FLAG: c_int = 3;
const FORMAT_INT64: c_int = 4;
const FORMAT_DOUBLE: c_int = 5;
const FORMAT_NODE: c_int = 6;
const FORMAT_NODE_ARRAY: c_int = 7;
const FORMAT_NODE_MAP: c_int = 8;

const EVENT_SHUTDOWN: c_int = 1;
const EVENT_LOG_MESSAGE: c_int = 2;
const EVENT_START_FILE: c_int = 6;
const EVENT_END_FILE: c_int = 7;
const EVENT_FILE_LOADED: c_int = 8;
const EVENT_SEEK: c_int = 20;
const EVENT_PLAYBACK_RESTART: c_int = 21;
const EVENT_PROPERTY_CHANGE: c_int = 22;

#[repr(C)]
struct Event {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct EventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct EventEndFile {
    reason: c_int,
    error: c_int,
}

#[repr(C)]
struct EventLogMessage {
    prefix: *const c_char,
    level: *const c_char,
    text: *const c_char,
    log_level: c_int,
}

#[repr(C)]
#[derive(Clone, Copy)]
union NodeValue {
    string: *mut c_char,
    flag: c_int,
    int64: i64,
    double: f64,
    list: *mut NodeList,
    ba: *mut c_void,
}

#[repr(C)]
struct Node {
    u: NodeValue,
    format: c_int,
}

#[repr(C)]
struct NodeList {
    num: c_int,
    values: *mut Node,
    keys: *mut *mut c_char,
}

struct Api {
    _lib: Library,
    create: unsafe extern "C" fn() -> Handle,
    initialize: unsafe extern "C" fn(Handle) -> c_int,
    set_option_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    command_async: unsafe extern "C" fn(Handle, u64, *mut *const c_char) -> c_int,
    set_property_async: unsafe extern "C" fn(Handle, u64, *const c_char, c_int, *mut c_void) -> c_int,
    get_property_string: unsafe extern "C" fn(Handle, *const c_char) -> *mut c_char,
    observe_property: unsafe extern "C" fn(Handle, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(Handle, f64) -> *mut Event,
    request_log_messages: unsafe extern "C" fn(Handle, *const c_char) -> c_int,
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    free: unsafe extern "C" fn(*mut c_void),
    terminate_destroy: unsafe extern "C" fn(Handle),
    client_api_version: unsafe extern "C" fn() -> u64,
}

pub struct Mpv {
    api: Api,
    handle: Handle,
    destroyed: AtomicBool,
}

// SAFETY: libmpv's client API is thread-safe for one handle.
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

fn cstr(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

impl Mpv {
    pub fn load(path: &Path) -> Result<Self, String> {
        // SAFETY: loading libmpv runs its initializers, which have no preconditions.
        let lib = unsafe { Library::new(path) }.map_err(|e| format!("could not load {}: {e}", path.display()))?;
        macro_rules! sym {
            ($name:literal) => {
                // SAFETY: the types match libmpv's client.h for these symbols.
                *unsafe { lib.get(concat!($name, "\0").as_bytes()) }
                    .map_err(|e| format!("libmpv has no {}: {e}", $name))?
            };
        }
        let api = Api {
            create: sym!("mpv_create"),
            initialize: sym!("mpv_initialize"),
            set_option_string: sym!("mpv_set_option_string"),
            command_async: sym!("mpv_command_async"),
            set_property_async: sym!("mpv_set_property_async"),
            get_property_string: sym!("mpv_get_property_string"),
            observe_property: sym!("mpv_observe_property"),
            wait_event: sym!("mpv_wait_event"),
            request_log_messages: sym!("mpv_request_log_messages"),
            error_string: sym!("mpv_error_string"),
            free: sym!("mpv_free"),
            terminate_destroy: sym!("mpv_terminate_destroy"),
            client_api_version: sym!("mpv_client_api_version"),
            _lib: lib,
        };
        let handle = unsafe { (api.create)() };
        if handle.is_null() {
            return Err("mpv_create failed".into());
        }
        Ok(Self { api, handle, destroyed: AtomicBool::new(false) })
    }

    pub fn api_version(&self) -> String {
        let v = unsafe { (self.api.client_api_version)() };
        format!("{}.{}", v >> 16, v & 0xffff)
    }

    fn check(&self, code: c_int, what: &str) -> Result<(), String> {
        if code >= 0 {
            return Ok(());
        }
        let text = unsafe { CStr::from_ptr((self.api.error_string)(code)) }.to_string_lossy();
        Err(format!("{what}: {text}"))
    }

    pub fn set_option(&self, name: &str, value: &str) -> Result<(), String> {
        let (n, v) = (cstr(name), cstr(value));
        let code = unsafe { (self.api.set_option_string)(self.handle, n.as_ptr(), v.as_ptr()) };
        self.check(code, &format!("option {name}={value}"))
    }

    pub fn initialize(&self) -> Result<(), String> {
        let code = unsafe { (self.api.initialize)(self.handle) };
        self.check(code, "mpv_initialize")?;
        let level = cstr("warn");
        unsafe { (self.api.request_log_messages)(self.handle, level.as_ptr()) };
        Ok(())
    }

    /// Runs without waiting; mpv copies the arguments.
    pub fn command(&self, args: &[&str]) -> Result<(), String> {
        let owned: Vec<CString> = args.iter().map(|a| cstr(a)).collect();
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let code = unsafe { (self.api.command_async)(self.handle, 0, ptrs.as_mut_ptr()) };
        self.check(code, &format!("command {}", args.first().unwrap_or(&"")))
    }

    pub fn set_property(&self, name: &str, value: &str) -> Result<(), String> {
        let n = cstr(name);
        let v = cstr(value);
        let mut p = v.as_ptr();
        let code = unsafe {
            (self.api.set_property_async)(self.handle, 0, n.as_ptr(), FORMAT_STRING, (&mut p as *mut *const c_char).cast())
        };
        self.check(code, &format!("set {name}={value}"))
    }

    pub fn get_string(&self, name: &str) -> Option<String> {
        let n = cstr(name);
        let p = unsafe { (self.api.get_property_string)(self.handle, n.as_ptr()) };
        if p.is_null() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { (self.api.free)(p.cast()) };
        Some(s)
    }

    fn observe(&self, name: &str) {
        let n = cstr(name);
        unsafe { (self.api.observe_property)(self.handle, 0, n.as_ptr(), FORMAT_NODE) };
    }

    /// Only once the event thread has stopped waiting on the handle.
    pub fn destroy(&self) {
        if !self.destroyed.swap(true, Ordering::SeqCst) {
            unsafe { (self.api.terminate_destroy)(self.handle) };
        }
    }
}

unsafe fn text(p: *const c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

unsafe fn node_json(node: &Node) -> Value {
    unsafe {
        match node.format {
            FORMAT_STRING => Value::String(text(node.u.string)),
            FORMAT_FLAG => Value::Bool(node.u.flag != 0),
            FORMAT_INT64 => json!(node.u.int64),
            FORMAT_DOUBLE => serde_json::Number::from_f64(node.u.double).map_or(Value::Null, Value::Number),
            FORMAT_NODE_ARRAY | FORMAT_NODE_MAP => {
                let list = node.u.list;
                if list.is_null() {
                    return Value::Null;
                }
                let list = &*list;
                let empty = list.num <= 0 || list.values.is_null();
                let values: &[Node] = if empty { &[] } else { std::slice::from_raw_parts(list.values, list.num as usize) };
                if node.format == FORMAT_NODE_ARRAY {
                    Value::Array(values.iter().map(|v| node_json(v)).collect())
                } else {
                    if empty || list.keys.is_null() {
                        return Value::Object(Map::new());
                    }
                    let keys = std::slice::from_raw_parts(list.keys, list.num as usize);
                    let mut map = Map::new();
                    for (k, v) in keys.iter().zip(values) {
                        map.insert(text(*k), node_json(v));
                    }
                    Value::Object(map)
                }
            }
            _ => Value::Null,
        }
    }
}

/// The properties the page follows.
pub const OBSERVED: &[&str] = &[
    "pause",
    "time-pos",
    "duration",
    "paused-for-cache",
    "cache-buffering-state",
    "demuxer-cache-time",
    "seeking",
    "core-idle",
    "idle-active",
    "eof-reached",
    "track-list",
    "aid",
    "sid",
    "volume",
    "mute",
    "media-title",
    "audio-delay",
    "sub-delay",
    "speed",
    "current-ao",
    "hwdec-current",
    "video-params",
    "chapter-list",
];

/// Set while the user has turned audio off themselves, which recovery must leave alone.
pub type AudioRecoveryHandle = Arc<AtomicBool>;

/// Brings sound back when the output device goes away and returns (Bluetooth headphones
/// dropping out). mpv runs with `audio-fallback-to-null`, so losing the device moves audio to
/// a silent output and the picture keeps playing; reopening the output (`ao-reload`) then
/// switches back without touching the track or the buffered video. If mpv dropped the track
/// instead (`aid` = `no`), selecting it again is the fallback, which costs a re-buffer.
///
/// Attempts happen right away when Windows' device list changes, and otherwise on a backoff
/// (5 s, 10 s, 20 s, then every 30 s), since each failed attempt is not free.
pub struct AudioRecovery {
    last_track: i64,
    last_tick: Instant,
    next_attempt: Option<Instant>,
    attempts: u32,
    devices: String,
    polls: u32,
    /// Set when the user turns audio off themselves, which must stay off.
    pub user_off: Arc<AtomicBool>,
}

const BACKOFF_SECS: [u64; 4] = [5, 10, 20, 30];

impl AudioRecovery {
    pub fn new() -> Self {
        Self {
            last_track: 0,
            last_tick: Instant::now(),
            next_attempt: None,
            attempts: 0,
            devices: String::new(),
            polls: 0,
            user_off: Arc::new(AtomicBool::new(false)),
        }
    }

    fn new_file(&mut self) {
        self.last_track = 0;
        self.reset();
        self.user_off.store(false, Ordering::SeqCst);
    }

    fn reset(&mut self) {
        self.attempts = 0;
        self.next_attempt = None;
    }

    fn schedule_next(&mut self) {
        let wait = BACKOFF_SECS[(self.attempts as usize).min(BACKOFF_SECS.len() - 1)];
        self.attempts += 1;
        self.next_attempt = Some(Instant::now() + Duration::from_secs(wait));
    }

    fn tick(&mut self, mpv: &Mpv) {
        if self.last_tick.elapsed() < Duration::from_millis(450) {
            return;
        }
        self.last_tick = Instant::now();
        if mpv.get_string("idle-active").as_deref() == Some("yes") {
            return;
        }
        let mut devices_changed = false;
        self.polls = self.polls.wrapping_add(1);
        if self.polls % 2 == 0 {
            let devices = mpv.get_string("audio-device-list").unwrap_or_default();
            if devices != self.devices {
                devices_changed = !self.devices.is_empty();
                self.devices = devices;
            }
        }
        let aid = mpv.get_string("aid").unwrap_or_default();
        let output = mpv.get_string("current-ao").unwrap_or_default();
        let track = aid.parse::<i64>().ok().filter(|t| *t > 0);
        let healthy = track.is_some() && !output.is_empty() && output != "null";
        if healthy {
            if self.attempts > 0 {
                log::info!("audio output is back ({output})");
            }
            self.last_track = track.unwrap_or(self.last_track);
            self.reset();
            return;
        }
        let on_null = track.is_some() && output == "null";
        let dropped = aid == "no" && self.last_track > 0 && output.is_empty() && !self.user_off.load(Ordering::SeqCst);
        if !on_null && !dropped {
            return;
        }
        if self.next_attempt.is_none() && !devices_changed {
            // Just lost: give the device a moment, then start the backoff.
            log::info!("audio output lost (aid={aid}, output={output:?}); waiting for a device");
            self.schedule_next();
            return;
        }
        let due = self.next_attempt.is_some_and(|t| Instant::now() >= t);
        if !devices_changed && !due {
            return;
        }
        if devices_changed {
            log::info!("audio devices changed; reopening the output");
        }
        if on_null {
            log::info!("reopening the audio output (attempt {})", self.attempts);
            let _ = mpv.command(&["ao-reload"]);
        } else {
            log::info!("selecting audio track {} again (attempt {})", self.last_track, self.attempts);
            let _ = mpv.set_property("aid", &self.last_track.to_string());
        }
        self.schedule_next();
    }
}

/// Reads mpv's events until it shuts down, sending the page batched property changes
/// (at most ~30 times a second) and playback events. `done` fires when it returns.
pub fn spawn_events(
    mpv: Arc<Mpv>,
    mut recovery: AudioRecovery,
    emit: impl Fn(Value) + Send + 'static,
    done: Sender<()>,
) {
    for name in OBSERVED {
        mpv.observe(name);
    }
    std::thread::Builder::new()
        .name("mpv-events".into())
        .spawn(move || {
            let mut pending: BTreeMap<String, Value> = BTreeMap::new();
            let mut last_flush = Instant::now();
            let flush = |pending: &mut BTreeMap<String, Value>| {
                if !pending.is_empty() {
                    let values: Map<String, Value> = std::mem::take(pending).into_iter().collect();
                    emit(json!({ "t": "props", "v": values }));
                }
            };
            loop {
                let timeout = if pending.is_empty() { 0.25 } else { 0.033 };
                let event = unsafe { &*(mpv.api.wait_event)(mpv.handle, timeout) };
                match event.event_id {
                    EVENT_SHUTDOWN => break,
                    EVENT_PROPERTY_CHANGE => {
                        let prop = unsafe { &*(event.data as *const EventProperty) };
                        let name = unsafe { text(prop.name) };
                        let value = if prop.format == FORMAT_NODE && !prop.data.is_null() {
                            unsafe { node_json(&*(prop.data as *const Node)) }
                        } else {
                            Value::Null
                        };
                        pending.insert(name, value);
                    }
                    EVENT_LOG_MESSAGE => {
                        let msg = unsafe { &*(event.data as *const EventLogMessage) };
                        let (prefix, level, line) = unsafe { (text(msg.prefix), text(msg.level), text(msg.text)) };
                        let line = line.trim_end();
                        match level.as_str() {
                            "fatal" | "error" => log::error!("mpv[{prefix}] {line}"),
                            _ => log::warn!("mpv[{prefix}] {line}"),
                        }
                    }
                    EVENT_START_FILE | EVENT_FILE_LOADED | EVENT_SEEK | EVENT_PLAYBACK_RESTART | EVENT_END_FILE => {
                        flush(&mut pending);
                        last_flush = Instant::now();
                        let mut message = json!({ "t": "event", "name": match event.event_id {
                            EVENT_START_FILE => "start-file",
                            EVENT_FILE_LOADED => "file-loaded",
                            EVENT_SEEK => "seek",
                            EVENT_PLAYBACK_RESTART => "playback-restart",
                            _ => "end-file",
                        }});
                        if event.event_id == EVENT_START_FILE {
                            recovery.new_file();
                        }
                        if event.event_id != EVENT_SEEK {
                            log::info!("player: {}", message["name"].as_str().unwrap_or(""));
                        }
                        if event.event_id == EVENT_END_FILE && !event.data.is_null() {
                            let end = unsafe { &*(event.data as *const EventEndFile) };
                            let reason = match end.reason {
                                0 => "eof",
                                2 => "stop",
                                3 => "quit",
                                4 => "error",
                                5 => "redirect",
                                _ => "unknown",
                            };
                            message["reason"] = json!(reason);
                            log::info!("player: ended ({reason})");
                            if end.reason == 4 {
                                let err = unsafe { text((mpv.api.error_string)(end.error)) };
                                log::error!("playback failed: {err}");
                                message["error"] = json!(err);
                            }
                        }
                        emit(message);
                    }
                    _ => {}
                }
                if last_flush.elapsed() >= Duration::from_millis(33) {
                    flush(&mut pending);
                    last_flush = Instant::now();
                }
                recovery.tick(&mpv);
            }
            let _ = done.send(());
        })
        .expect("could not start the mpv event thread");
}
