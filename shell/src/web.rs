//! Serves the page's built files to the web view under its own origin.

use std::path::{Component, Path, PathBuf};

pub struct Served {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

/// Paths without an extension get index.html, so the page's own routes load.
pub fn serve(root: &Path, request_path: &str) -> Served {
    let relative = request_path.split(['?', '#']).next().unwrap_or("").trim_start_matches('/');
    let relative = PathBuf::from(relative.replace("%20", " "));
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Served { status: 403, content_type: "text/plain", body: b"forbidden".to_vec() };
    }
    let mut file = root.join(&relative);
    if relative.as_os_str().is_empty() || (relative.extension().is_none() && !file.is_file()) {
        file = root.join("index.html");
    }
    match std::fs::read(&file) {
        Ok(body) => Served { status: 200, content_type: content_type(&file), body },
        Err(_) => Served { status: 404, content_type: "text/plain", body: b"not found".to_vec() },
    }
}
