#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! ROVE's window: mpv draws the video into a child window, and a transparent WebView2 page
//! draws everything else on top of it. The page drives mpv through a small JSON bridge.

mod api;
mod dpapi;
mod logging;
mod media;
mod mpv;
mod platform;
mod web;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::platform::windows::{IconExtWindows, WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Fullscreen, Icon, Window, WindowBuilder};
use wry::http::{Request, Response};
use wry::{NewWindowResponse, Rect, WebContext, WebViewBuilder, WebViewBuilderExtWindows};

const APP_ORIGIN: &str = "http://rove.localhost";

/// Things that must happen on the window's thread.
enum UserEvent {
    Emit(Value),
    Window(WindowAction),
    Fullscreen(Option<bool>),
    PageReady,
    Pip(bool),
    Video(bool),
    /// The page has saved everything; the app can close.
    CloseReady,
    NowPlaying(media::NowPlaying),
    /// Self-test: logs the window, video and page sizes under a label.
    Probe(&'static str),
}

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
    Drag,
    ResizeN,
    ResizeNe,
    ResizeNw,
}

/// What the page sends. Anything else is ignored.
#[derive(Deserialize, Debug)]
#[serde(tag = "t", rename_all = "kebab-case")]
enum Inbound {
    Command { args: Vec<String> },
    Set { name: String, value: Value },
    Window { action: WindowAction },
    Fullscreen { value: Option<bool> },
    Pip { value: bool },
    /// See-through page over the video (only while something plays).
    Video { visible: bool },
    Ready,
    CloseReady,
    OpenFolder { which: String },
    NowPlaying(media::NowPlaying),
    OpenExternal { url: String },
    OpenExternalPlayer { url: String, player: String },
    Log { message: String },
}

const SETTABLE: &[&str] = &[
    "pause",
    "volume",
    "volume-max",
    "mute",
    "aid",
    "sid",
    "secondary-sid",
    "audio-delay",
    "sub-delay",
    "speed",
    "sub-scale",
    "sub-pos",
    "sub-visibility",
    "sub-font",
    "sub-font-size",
    "sub-color",
    "sub-bold",
    "sub-border-color",
    "sub-border-size",
    "sub-back-color",
    "sub-shadow-color",
    "sub-shadow-offset",
    "sub-margin-y",
    "sub-ass-override",
    "sub-border-style",
    "loop-file",
    "hwdec",
    "force-media-title",
    "http-header-fields",
    "user-agent",
    "referrer",
    "video-aspect-override",
    "panscan",
    "video-zoom",
    "video-unscaled",
    "deband",
    "brightness",
    "contrast",
    "saturation",
    "gamma",
    "audio-spdif",
    "audio-exclusive",
    "af",
];

/** Audio filters the page may choose: off, or loudness levelling. */
const AUDIO_FILTERS: &[&str] = &["", "lavfi=[dynaudnorm=f=200:g=11:p=0.9:m=8]"];

fn is_web_url(s: &str) -> bool {
    s.starts_with("https://") || s.starts_with("http://")
}

/// Pages may only play web addresses, never local files or scripts.
fn allowed_command(args: &[String]) -> bool {
    let Some(name) = args.first() else { return false };
    match name.as_str() {
        "loadfile" => {
            args.len() >= 2
                && args.len() <= 5
                && is_web_url(&args[1])
                && args.get(2).is_none_or(|f| matches!(f.as_str(), "replace" | "append" | "append-play"))
                && args.get(4).is_none_or(|o| {
                    o.split(',').all(|kv| {
                        // Seconds, or a percentage (progress known only as a share of the video).
                        kv.strip_prefix("start=").is_some_and(|v| v.strip_suffix('%').unwrap_or(v).parse::<f64>().is_ok())
                    })
                })
        }
        "sub-add" | "audio-add" => args.len() >= 2 && args.len() <= 5 && is_web_url(&args[1]),
        "stop" | "frame-step" | "frame-back-step" | "ao-reload" | "playlist-next" | "playlist-clear" | "sub-reload" => args.len() == 1,
        "screenshot" => args.len() <= 2 && args.get(1).is_none_or(|f| matches!(f.as_str(), "video" | "subtitles" | "window")),
        "sub-remove" => args.len() <= 2 && args.get(1).is_none_or(|id| id.parse::<i64>().is_ok()),
        "seek" => {
            args.len() >= 2
                && args.len() <= 3
                && args[1].parse::<f64>().is_ok()
                && args.get(2).is_none_or(|m| matches!(m.as_str(), "relative" | "absolute" | "absolute-percent" | "relative+exact" | "absolute+exact" | "exact"))
        }
        "cycle" => args.len() == 2 && matches!(args[1].as_str(), "pause" | "mute" | "sub-visibility"),
        _ => false,
    }
}

/// Hands a stream to the user's own player (mpv, VLC, MPC-HC…): an existing .exe they chose,
/// given only the http(s) link as its argument.
fn open_in_player(url: &str, player: &str) {
    let path = std::path::Path::new(player);
    let is_exe = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    if !is_web_url(url) || !is_exe || !path.is_file() {
        return log::warn!("refused to open an external player");
    }
    match std::process::Command::new(path).arg(url).spawn() {
        Ok(_) => log::info!("opened the stream in {}", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()),
        Err(e) => log::warn!("could not start the external player: {e}"),
    }
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::Bool(b) => Some(if *b { "yes" } else { "no" }.into()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn data_dir() -> PathBuf {
    // A separate data folder (and so a separate running copy), for tests and development.
    if let Some(dir) = std::env::var_os("ROVE_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("ROVE")
}

struct Args {
    web_url: Option<String>,
    devtools: bool,
    /// Opens this stream as soon as the page is ready.
    play: Option<String>,
    /// Starts with the sound muted (for checks run while someone is at the computer).
    muted: bool,
    /// Debug builds: walks the window through maximize and fullscreen and cuts the audio
    /// device mid-play, logging what follows, then closes.
    self_test: bool,
}

/// See `Args::self_test`. Each step waits long enough for the window and mpv to settle.
fn self_test(proxy: tao::event_loop::EventLoopProxy<UserEvent>, mpv: Arc<mpv::Mpv>) {
    std::thread::spawn(move || {
        let wait = |ms: u64| std::thread::sleep(Duration::from_millis(ms));
        let send = |e: UserEvent| {
            let _ = proxy.send_event(e);
        };
        let audio = |label: &str| {
            let get = |name: &str| mpv.get_string(name).unwrap_or_default();
            log::info!(
                "self-test [{label}] aid={} current-ao={:?} time-pos={} pause={} paused-for-cache={} core-idle={} cache-ahead={}s",
                get("aid"),
                get("current-ao"),
                get("time-pos"),
                get("pause"),
                get("paused-for-cache"),
                get("core-idle"),
                get("demuxer-cache-duration"),
            );
        };
        wait(9000);
        audio("playing");
        send(UserEvent::Probe("start"));
        send(UserEvent::Window(WindowAction::ToggleMaximize));
        wait(1500);
        send(UserEvent::Probe("maximized"));
        send(UserEvent::Fullscreen(Some(true)));
        wait(1500);
        send(UserEvent::Probe("fullscreen"));
        send(UserEvent::Fullscreen(Some(false)));
        wait(1500);
        send(UserEvent::Probe("left fullscreen"));
        send(UserEvent::Window(WindowAction::ToggleMaximize));
        wait(1500);
        send(UserEvent::Probe("restored"));
        audio("before device loss");
        let _ = mpv.set_property("audio-device", "wasapi/{rove-self-test-missing-device}");
        for label in ["device gone +2s", "device gone +4s", "device gone +6s", "device gone +8s"] {
            wait(2000);
            audio(label);
        }
        // Back to the default device without mpv reopening the output by itself, the way a
        // reconnecting headset looks: the property is set through the option, then recovery reopens it.
        let _ = mpv.set_property("audio-device", "auto");
        for label in ["device back +2s", "device back +4s", "device back +6s"] {
            wait(2000);
            audio(label);
        }
        send(UserEvent::Window(WindowAction::Close));
    });
}

fn parse_args() -> Args {
    let mut args = Args { web_url: None, devtools: cfg!(debug_assertions), play: None, muted: false, self_test: false };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--web" => args.web_url = it.next(),
            "--devtools" => args.devtools = true,
            "--play" => args.play = it.next().filter(|u| is_web_url(u)),
            "--muted" => args.muted = true,
            "--self-test" => args.self_test = true,
            _ => {}
        }
    }
    args
}

fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from)).unwrap_or_default()
}

fn find_libmpv() -> Option<PathBuf> {
    let mut candidates = vec![exe_dir().join("libmpv-2.dll")];
    if let Some(p) = std::env::var_os("ROVE_LIBMPV") {
        candidates.insert(0, PathBuf::from(p));
    }
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/mpv/libmpv-2.dll"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn find_web_dir() -> PathBuf {
    let beside = exe_dir().join("web");
    if beside.join("index.html").is_file() || !cfg!(debug_assertions) {
        return beside;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui/dist")
}

fn origin_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(s, r)| (s, r));
    match rest {
        Some((scheme, r)) => format!("{scheme}://{}", r.split('/').next().unwrap_or("")),
        None => String::new(),
    }
}

/// tao keeps a maximized frameless window clear of the taskbar even in fullscreen,
/// so the window leaves maximized first and goes back after.
fn set_fullscreen(window: &Window, value: Option<bool>, remaximize: &mut bool) {
    let on = value.unwrap_or(window.fullscreen().is_none());
    if on == window.fullscreen().is_some() {
        return;
    }
    if on {
        *remaximize = window.is_maximized();
        if *remaximize {
            window.set_maximized(false);
        }
        window.set_fullscreen(Some(Fullscreen::Borderless(None)));
    } else {
        window.set_fullscreen(None);
        if std::mem::take(remaximize) {
            window.set_maximized(true);
        }
    }
}

fn browser_args() -> String {
    let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required");
    // For measurements and debugging tools: ROVE_DEBUG_PORT opens the web view's debugging port.
    if let Some(port) = std::env::var("ROVE_DEBUG_PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
        args.push_str(&format!(" --remote-debugging-port={port}"));
    }
    args
}

fn enable_title_bar_regions(webview: &wry::WebView) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings9;
    use windows::core::Interface;
    use wry::WebViewExtWindows;
    let result = unsafe {
        webview
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|s| s.cast::<ICoreWebView2Settings9>())
            .and_then(|s| s.SetIsNonClientRegionSupportEnabled(true))
    };
    if let Err(e) = result {
        log::warn!("title bar regions unavailable: {e}");
    }
}

/// Resizing from the top edge, done by following the mouse (the page holds the mouse capture,
/// so the system's own sizing loop cannot start from it).
struct EdgeResize {
    edge: WindowAction,
    start_mouse: (i32, i32),
    start_pos: PhysicalPosition<i32>,
    start_size: PhysicalSize<u32>,
}

fn record_placement(window: &Window, p: &mut Placement, pip: bool) {
    if pip || window.fullscreen().is_some() || window.is_minimized() {
        return;
    }
    p.maximized = window.is_maximized();
    if !p.maximized {
        let size = window.inner_size().to_logical::<f64>(window.scale_factor());
        p.width = size.width.round();
        p.height = size.height.round();
        if let Ok(pos) = window.outer_position() {
            p.x = pos.x;
            p.y = pos.y;
        }
    }
}

fn window_state(window: &Window, pip: bool) -> Value {
    json!({ "t": "window", "maximized": window.is_maximized(), "fullscreen": window.fullscreen().is_some(), "pip": pip })
}

/// Where the window was, so the next start opens there. Logical pixels for size.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
struct Placement {
    x: i32,
    y: i32,
    width: f64,
    height: f64,
    maximized: bool,
}

fn load_placement(dir: &std::path::Path) -> Option<Placement> {
    serde_json::from_slice(&std::fs::read(dir.join("window.json")).ok()?).ok()
}

fn save_placement(dir: &std::path::Path, p: &Placement) {
    if let Ok(bytes) = serde_json::to_vec(p) {
        let _ = std::fs::write(dir.join("window.json"), bytes);
    }
}

/// What picture-in-picture replaced, to put back.
struct PipRestore {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
    fullscreen: bool,
}

fn start_mpv(video: &platform::VideoSurface, muted: bool, emit: impl Fn(Value) + Send + 'static) -> Result<(Arc<mpv::Mpv>, mpv::AudioRecoveryHandle, std::sync::mpsc::Receiver<()>), String> {
    let path = find_libmpv().ok_or("libmpv-2.dll was not found next to rove.exe")?;
    let mpv = Arc::new(mpv::Mpv::load(&path)?);
    log::info!("libmpv {} (client API {})", path.display(), mpv.api_version());
    let wid = video.id();
    let screenshot_dir = std::env::var_os("USERPROFILE")
        .map(|h| PathBuf::from(h).join("Pictures").join("ROVE").display().to_string())
        .unwrap_or_default();
    let options: &[(&str, &str)] = &[
        ("wid", &wid),
        ("vo", "gpu-next,gpu"),
        ("gpu-context", "d3d11"),
        ("hwdec", "auto-safe"),
        ("config", "no"),
        ("terminal", "no"),
        ("idle", "yes"),
        ("keep-open", "yes"),
        ("force-window", "yes"),
        ("osc", "no"),
        ("osd-level", "0"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("input-cursor", "no"),
        ("cursor-autohide", "no"),
        ("ytdl", "no"),
        ("audio-display", "no"),
        ("cache", "yes"),
        ("demuxer-max-bytes", "512MiB"),
        ("demuxer-max-back-bytes", "128MiB"),
        ("cache-pause-wait", "2"),
        ("network-timeout", "20"),
        ("volume-max", "150"),
        ("sub-font-size", "46"),
        ("sub-border-size", "2.5"),
        ("sub-shadow-offset", "1"),
        ("sub-color", "#F2F2F2"),
        ("sub-margin-y", "48"),
        ("mute", if muted { "yes" } else { "no" }),
        ("screenshot-directory", &screenshot_dir),
        ("screenshot-format", "png"),
        ("screenshot-template", "ROVE %F %wH-%wM-%wS"),
        // A lost device moves audio to a silent output instead of stopping the track.
        ("audio-fallback-to-null", "yes"),
    ];
    for (name, value) in options {
        if let Err(e) = mpv.set_option(name, value) {
            log::warn!("{e}");
        }
    }
    mpv.initialize()?;
    let recovery = mpv::AudioRecovery::new();
    let user_off = recovery.user_off.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    mpv::spawn_events(mpv.clone(), recovery, emit, done_tx);
    Ok((mpv, user_off, done_rx))
}

fn handle(message: Inbound, mpv: &mpv::Mpv, user_off: &mpv::AudioRecoveryHandle, send: &dyn Fn(UserEvent)) {
    match message {
        Inbound::Command { args } => {
            if !allowed_command(&args) {
                return log::warn!("refused command {:?}", args.first());
            }
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            if let Err(e) = mpv.command(&refs) {
                log::warn!("{e}");
            }
        }
        Inbound::Set { name, value } => {
            if !SETTABLE.contains(&name.as_str()) {
                return log::warn!("refused to set {name}");
            }
            let Some(text) = value_text(&value) else { return };
            if name == "af" && !AUDIO_FILTERS.contains(&text.as_str()) {
                return log::warn!("refused audio filter");
            }
            if name == "aid" {
                user_off.store(text == "no", Ordering::SeqCst);
            }
            if let Err(e) = mpv.set_property(&name, &text) {
                log::warn!("{e}");
            }
        }
        Inbound::Window { action } => send(UserEvent::Window(action)),
        Inbound::Fullscreen { value } => send(UserEvent::Fullscreen(value)),
        Inbound::Pip { value } => send(UserEvent::Pip(value)),
        Inbound::Video { visible } => send(UserEvent::Video(visible)),
        Inbound::CloseReady => send(UserEvent::CloseReady),
        Inbound::NowPlaying(np) => send(UserEvent::NowPlaying(np)),
        Inbound::OpenFolder { which } => {
            let dir = data_dir();
            let path = match which.as_str() {
                "logs" => dir.join("logs"),
                "data" => dir,
                "screenshots" => std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Pictures").join("ROVE")).unwrap_or(dir),
                _ => return,
            };
            let _ = std::fs::create_dir_all(&path);
            platform::open_folder(&path);
        }
        Inbound::Ready => {
            log::info!("page ready");
            send(UserEvent::PageReady);
        }
        Inbound::OpenExternal { url } => platform::open_external(&url),
        Inbound::OpenExternalPlayer { url, player } => open_in_player(&url, &player),
        Inbound::Log { message } => log::info!("page: {}", message.chars().take(500).collect::<String>()),
    }
}

fn main() {
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    logging::init(&dir);
    log::info!("ROVE {} starting", env!("CARGO_PKG_VERSION"));
    let Some(_instance) = platform::claim_instance(&dir) else {
        log::info!("already running; brought the open window forward");
        return;
    };
    let args = parse_args();

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let icon = Icon::from_resource(1, None).ok();
    let saved = load_placement(&dir);
    let mut builder = WindowBuilder::new()
        .with_title("ROVE")
        .with_window_icon(icon.clone())
        .with_taskbar_icon(icon)
        .with_inner_size(saved.map_or(LogicalSize::new(1440.0, 900.0), |p| LogicalSize::new(p.width.max(960.0), p.height.max(600.0))))
        .with_maximized(saved.is_some_and(|p| p.maximized));
    if let Some(p) = saved
        && event_loop.available_monitors().any(|m| {
            let (o, sz) = (m.position(), m.size());
            (o.x..o.x + sz.width as i32).contains(&(p.x + 60)) && (o.y..o.y + sz.height as i32).contains(&(p.y + 20))
        })
    {
        builder = builder.with_position(PhysicalPosition::new(p.x, p.y));
    }
    let window = builder
        .with_min_inner_size(LogicalSize::new(960.0, 600.0))
        .with_visible(false)
        .with_decorations(false)
        .with_undecorated_shadow(true)
        // ROVE's background, so a resize never flashes white or shows stale pixels.
        .with_background_color((11, 12, 13, 255))
        .with_window_classname(platform::WINDOW_CLASS)
        .build(&event_loop)
        .unwrap_or_else(|e| platform::fatal(&format!("could not open a window: {e}")));
    let size = window.inner_size();
    // The window must not paint over the video and the page while resizing (that flickers).
    platform::clip_children(window.hwnd());

    let controls = media::MediaControls::new(window.hwnd(), {
        let proxy = proxy.clone();
        move |key| {
            let _ = proxy.send_event(UserEvent::Emit(json!({ "t": "media-key", "key": key })));
        }
    })
    .map_err(|e| log::warn!("media controls unavailable: {e}"))
    .ok();
    let video = platform::VideoSurface::new(window.hwnd(), size.width, size.height)
        .unwrap_or_else(|e| platform::fatal(&e));
    let (mpv, user_off, mpv_done) = start_mpv(&video, args.muted, {
        let proxy = proxy.clone();
        move |message| {
            let _ = proxy.send_event(UserEvent::Emit(message));
        }
    })
    .unwrap_or_else(|e| platform::fatal(&format!("The video player could not start.\n\n{e}")));

    let web_dir = find_web_dir();
    let start_url = args.web_url.clone().unwrap_or_else(|| format!("{APP_ORIGIN}/"));
    let page_origin = origin_of(&start_url);
    log::info!("page {start_url} (files from {})", web_dir.display());

    let mut context = WebContext::new(Some(dir.join("WebView2")));
    let page_bounds = |size: PhysicalSize<u32>| Rect { position: PhysicalPosition::new(0, 0).into(), size: size.into() };
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_bounds(page_bounds(size))
        .with_transparent(true)
        .with_devtools(args.devtools)
        .with_initialization_script(include_str!("bridge.js"))
        .with_asynchronous_custom_protocol("rove".into(), {
            let api = Arc::new(api::Api::new(&dir));
            let web_dir = Arc::new(web_dir);
            move |_, req: Request<Vec<u8>>, responder| {
                let (api, web_dir) = (api.clone(), web_dir.clone());
                // Network calls can take seconds, so every request gets its own worker.
                std::thread::spawn(move || {
                    let response = if api::Api::handles(req.uri().path()) {
                        api.handle(&req)
                    } else {
                        let served = web::serve(&web_dir, req.uri().path());
                        Response::builder()
                            .status(served.status)
                            .header("Content-Type", served.content_type)
                            .header("Cache-Control", "no-cache")
                            .body(served.body)
                            .unwrap()
                    };
                    responder.respond(response);
                });
            }
        })
        .with_ipc_handler({
            let (mpv, proxy, page_origin, user_off) = (mpv.clone(), proxy.clone(), page_origin.clone(), user_off.clone());
            move |req: Request<String>| {
                let from = origin_of(&req.uri().to_string());
                if from != page_origin {
                    return log::warn!("ignored a message from {from}");
                }
                match serde_json::from_str::<Inbound>(req.body()) {
                    Ok(message) => handle(message, &mpv, &user_off, &|e| {
                        let _ = proxy.send_event(e);
                    }),
                    Err(e) => log::warn!("unreadable message from the page: {e}"),
                }
            }
        })
        .with_navigation_handler({
            let page_origin = page_origin.clone();
            move |url| {
                let allowed = origin_of(&url) == page_origin || url.starts_with("about:");
                if !allowed {
                    platform::open_external(&url);
                }
                allowed
            }
        })
        .with_new_window_req_handler(|url, _| {
            platform::open_external(&url);
            NewWindowResponse::Deny
        })
        .with_additional_browser_args(&browser_args())
        .build_as_child(&window)
        .unwrap_or_else(|e| platform::fatal(&format!("could not start the web view: {e}")));
    // Parts of the page marked `app-region: drag` act as the window's title bar: drag to move,
    // Snap, double-click to maximize, right-click for the window menu. Set before the first page.
    enable_title_bar_regions(&webview);
    let _ = webview.load_url(&start_url);

    // Nothing plays yet: an opaque page is far cheaper to scroll than a see-through one.
    let _ = webview.set_background_color((11, 12, 13, 255));
    video.set_visible(false);
    window.set_visible(true);
    let size = window.inner_size();
    let _ = webview.set_bounds(page_bounds(size));
    video.resize(size.width, size.height);

    if args.self_test && cfg!(debug_assertions) {
        self_test(proxy.clone(), mpv.clone());
    }

    let mut remaximize = false;
    let mut last_state = Value::Null;
    let mut pip_restore: Option<PipRestore> = None;
    let mut placement = saved.unwrap_or(Placement { x: 0, y: 0, width: 1440.0, height: 900.0, maximized: false });
    // Closing asks the page to save first; it gets two seconds.
    let mut closing_deadline: Option<std::time::Instant> = None;
    let mut edge_resize: Option<EdgeResize> = None;
    let mut play_on_ready = args.play.clone();
    event_loop.run(move |event, _, control_flow| {
        *control_flow = match closing_deadline {
            Some(at) if std::time::Instant::now() >= at => ControlFlow::Exit,
            Some(at) => ControlFlow::WaitUntil(at),
            None => ControlFlow::Wait,
        };
        if let Some(r) = &edge_resize {
            let ((mx, my), down) = platform::mouse();
            if !down {
                edge_resize = None;
            } else {
                let dy = my - r.start_mouse.1;
                let dx = mx - r.start_mouse.0;
                let min = window.scale_factor();
                let min_w = (960.0 * min) as i32;
                let min_h = (600.0 * min) as i32;
                let h = (r.start_size.height as i32 - dy).max(min_h);
                let top = r.start_pos.y + (r.start_size.height as i32 - h);
                let (w, left) = match r.edge {
                    WindowAction::ResizeNe => ((r.start_size.width as i32 + dx).max(min_w), r.start_pos.x),
                    WindowAction::ResizeNw => {
                        let w = (r.start_size.width as i32 - dx).max(min_w);
                        (w, r.start_pos.x + (r.start_size.width as i32 - w))
                    }
                    _ => (r.start_size.width as i32, r.start_pos.x),
                };
                window.set_outer_position(PhysicalPosition::new(left, top));
                window.set_inner_size(PhysicalSize::new(w as u32, h as u32));
                *control_flow = ControlFlow::WaitUntil(std::time::Instant::now() + Duration::from_millis(8));
            }
        }
        let mut begin_close = false;
        let mut report_state = false;
        match event {
            Event::WindowEvent { event: WindowEvent::Resized(size), .. } => {
                if size.width > 0 && size.height > 0 {
                    video.resize(size.width, size.height);
                    let _ = webview.set_bounds(page_bounds(size));
                }
                report_state = true;
                record_placement(&window, &mut placement, pip_restore.is_some());
            }
            Event::WindowEvent { event: WindowEvent::Moved(_), .. } => {
                record_placement(&window, &mut placement, pip_restore.is_some());
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => begin_close = true,
            Event::UserEvent(UserEvent::CloseReady) => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::NowPlaying(np)) => {
                if let Some(c) = &controls {
                    c.update(&np);
                }
            }
            Event::UserEvent(UserEvent::Emit(message)) => {
                let script = format!("window.__roveReceive({message})");
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::Window(action)) => match action {
                WindowAction::Minimize => window.set_minimized(true),
                WindowAction::ToggleMaximize => {
                    if window.fullscreen().is_none() {
                        window.set_maximized(!window.is_maximized());
                    }
                }
                WindowAction::Close => begin_close = true,
                WindowAction::Drag => {
                    let _ = window.drag_window();
                }
                WindowAction::ResizeN | WindowAction::ResizeNe | WindowAction::ResizeNw => {
                    if !window.is_maximized() && window.fullscreen().is_none() {
                        edge_resize = Some(EdgeResize {
                            edge: action,
                            start_mouse: platform::mouse().0,
                            start_pos: window.outer_position().unwrap_or_default(),
                            start_size: window.inner_size(),
                        });
                        *control_flow = ControlFlow::WaitUntil(std::time::Instant::now() + Duration::from_millis(8));
                    }
                }
            },
            Event::UserEvent(UserEvent::Fullscreen(value)) => {
                set_fullscreen(&window, value, &mut remaximize);
                report_state = true;
            }
            Event::UserEvent(UserEvent::Probe(label)) => {
                let client = window.inner_size();
                let page = webview.bounds().map(|b| format!("{:?}", b.size)).unwrap_or_default();
                log::info!(
                    "self-test [{label}] window {}x{} maximized={} fullscreen={} | video {:?} | page {page}",
                    client.width,
                    client.height,
                    window.is_maximized(),
                    window.fullscreen().is_some(),
                    video.size(),
                );
            }
            Event::UserEvent(UserEvent::Video(on)) => {
                let _ = webview.set_background_color(if on { (0, 0, 0, 0) } else { (11, 12, 13, 255) });
                video.set_visible(on);
            }
            Event::UserEvent(UserEvent::Pip(on)) => {
                if on && pip_restore.is_none() {
                    let restore = PipRestore {
                        position: window.outer_position().unwrap_or_default(),
                        size: window.inner_size(),
                        maximized: window.is_maximized(),
                        fullscreen: window.fullscreen().is_some(),
                    };
                    if restore.fullscreen {
                        window.set_fullscreen(None);
                    }
                    if window.is_maximized() {
                        window.set_maximized(false);
                    }
                    let scale = window.scale_factor();
                    let (w, h) = ((480.0 * scale) as i32, (270.0 * scale) as i32);
                    window.set_min_inner_size(Some(LogicalSize::new(320.0, 180.0)));
                    window.set_inner_size(PhysicalSize::new(w as u32, h as u32));
                    if let Some((_, _, right, bottom)) = platform::work_area(window.hwnd()) {
                        let margin = (20.0 * scale) as i32;
                        window.set_outer_position(PhysicalPosition::new(right - w - margin, bottom - h - margin));
                    }
                    window.set_always_on_top(true);
                    pip_restore = Some(restore);
                } else if !on && let Some(r) = pip_restore.take() {
                    window.set_always_on_top(false);
                    window.set_min_inner_size(Some(LogicalSize::new(960.0, 600.0)));
                    window.set_inner_size(r.size);
                    window.set_outer_position(r.position);
                    if r.maximized {
                        window.set_maximized(true);
                    }
                    if r.fullscreen {
                        set_fullscreen(&window, Some(true), &mut remaximize);
                    }
                }
                report_state = true;
            }
            Event::UserEvent(UserEvent::PageReady) => {
                // A reloaded page starts from nothing, so it hears the window's state again.
                last_state = Value::Null;
                report_state = true;
                if let Some(url) = play_on_ready.take() {
                    let open = json!({ "t": "open", "url": url });
                    let _ = webview.evaluate_script(&format!("window.__roveReceive({open})"));
                }
            }
            Event::LoopDestroyed => {
                log::info!("closing");
                save_placement(&dir, &placement);
                let _ = mpv.command(&["quit"]);
                if mpv_done.recv_timeout(Duration::from_millis(1500)).is_ok() {
                    mpv.destroy();
                }
                log::logger().flush();
            }
            _ => {}
        }
        if begin_close && closing_deadline.is_none() {
            let at = std::time::Instant::now() + Duration::from_secs(2);
            closing_deadline = Some(at);
            window.set_visible(false);
            let _ = webview.evaluate_script(&format!("window.__roveReceive({})", json!({ "t": "closing" })));
            *control_flow = ControlFlow::WaitUntil(at);
        }
        if report_state {
            let state = window_state(&window, pip_restore.is_some());
            if state != last_state {
                last_state = state.clone();
                let _ = webview.evaluate_script(&format!("window.__roveReceive({state})"));
            }
        }
    });
}
