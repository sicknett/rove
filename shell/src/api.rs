//! The page's local service, served under `http://rove.localhost/__api/…` on worker threads:
//!
//! - `POST /__api/fetch` makes an HTTP request for the page (no CORS limits, one user agent),
//!   taking `{url, method?, headers?, body?, timeoutMs?}` and answering
//!   `{status, url, headers, body}` or `{error}`.
//! - `GET`/`PUT /__api/store/<name>` reads and writes a JSON document in the data folder.
//! - `GET`/`PUT /__api/secret/<name>` does the same, encrypted for this Windows user (DPAPI).

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use wry::http::{Request, Response};

pub struct Api {
    store_dir: PathBuf,
    secret_dir: PathBuf,
    agent: ureq::Agent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchRequest {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

const MAX_BODY: u64 = 64 * 1024 * 1024;

fn json_response(status: u16, value: &Value) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .header("Cache-Control", "no-store")
        .body(value.to_string().into_bytes())
        .unwrap()
}

fn text_response(status: u16, body: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(body.as_bytes().to_vec())
        .unwrap()
}

/// Names for stored documents: letters, digits, `-`, `_` and `.` only, no leading dot.
fn safe_name(name: &str) -> Option<&str> {
    let ok = !name.is_empty()
        && name.len() <= 96
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    ok.then_some(name)
}

/// Writes beside the target and renames over it, so a crash never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

impl Api {
    pub fn new(data_dir: &Path) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .user_agent(concat!("ROVE/", env!("CARGO_PKG_VERSION")))
            .redirects(8)
            .build();
        Self { store_dir: data_dir.join("store"), secret_dir: data_dir.join("secrets"), agent }
    }

    /// Whether this request is for the service rather than the page's files.
    pub fn handles(path: &str) -> bool {
        path.starts_with("/__api/")
    }

    pub fn handle(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let path = request.uri().path();
        let method = request.method().as_str();
        let rest = &path["/__api/".len()..];
        match (method, rest.split_once('/').unwrap_or((rest, ""))) {
            ("POST", ("fetch", "")) => self.fetch(request.body()),
            ("GET", ("store", name)) => self.read_doc(&self.store_dir, name, false),
            ("PUT", ("store", name)) => self.write_doc(&self.store_dir, name, request.body(), false),
            ("DELETE", ("store", name)) => self.delete_doc(&self.store_dir, name, false),
            ("GET", ("secret", name)) => self.read_doc(&self.secret_dir, name, true),
            ("PUT", ("secret", name)) => self.write_doc(&self.secret_dir, name, request.body(), true),
            ("DELETE", ("secret", name)) => self.delete_doc(&self.secret_dir, name, true),
            _ => text_response(404, "unknown endpoint"),
        }
    }

    fn doc_path(dir: &Path, name: &str, secret: bool) -> Option<PathBuf> {
        let name = safe_name(name)?;
        Some(dir.join(format!("{name}{}", if secret { ".bin" } else { ".json" })))
    }

    fn read_doc(&self, dir: &Path, name: &str, secret: bool) -> Response<Vec<u8>> {
        let Some(path) = Self::doc_path(dir, name, secret) else { return text_response(400, "bad name") };
        match std::fs::read(&path) {
            Ok(bytes) => {
                let bytes = if secret {
                    match crate::dpapi::unprotect(&bytes) {
                        Some(plain) => plain,
                        None => {
                            log::warn!("secret {name} could not be decrypted");
                            return text_response(404, "unreadable");
                        }
                    }
                } else {
                    bytes
                };
                Response::builder()
                    .status(200)
                    .header("Content-Type", "application/json")
                    .header("Cache-Control", "no-store")
                    .body(bytes)
                    .unwrap()
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => text_response(404, "none"),
            // Present but unreadable (locked, disk error): not the same as "nothing saved yet", or
            // the page would start empty and save that over the real file.
            Err(e) => {
                log::warn!("{name} could not be read: {e}");
                text_response(500, "unreadable")
            }
        }
    }

    fn write_doc(&self, dir: &Path, name: &str, body: &[u8], secret: bool) -> Response<Vec<u8>> {
        let Some(path) = Self::doc_path(dir, name, secret) else { return text_response(400, "bad name") };
        if serde_json::from_slice::<Value>(body).is_err() {
            return text_response(400, "not JSON");
        }
        let bytes = if secret {
            match crate::dpapi::protect(body) {
                Some(b) => b,
                None => return text_response(500, "could not encrypt"),
            }
        } else {
            body.to_vec()
        };
        match write_atomic(&path, &bytes) {
            Ok(()) => text_response(204, ""),
            Err(e) => {
                log::error!("could not save {name}: {e}");
                text_response(500, "could not save")
            }
        }
    }

    fn delete_doc(&self, dir: &Path, name: &str, secret: bool) -> Response<Vec<u8>> {
        let Some(path) = Self::doc_path(dir, name, secret) else { return text_response(400, "bad name") };
        let _ = std::fs::remove_file(path);
        text_response(204, "")
    }

    fn fetch(&self, body: &[u8]) -> Response<Vec<u8>> {
        let req: FetchRequest = match serde_json::from_slice(body) {
            Ok(r) => r,
            Err(e) => return json_response(200, &json!({ "error": format!("bad request: {e}") })),
        };
        if !(req.url.starts_with("https://") || req.url.starts_with("http://")) {
            return json_response(200, &json!({ "error": "only http(s) addresses" }));
        }
        let method = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
        let mut call = self.agent.request(&method, &req.url);
        if let Some(ms) = req.timeout_ms {
            call = call.timeout(Duration::from_millis(ms.clamp(1000, 120_000)));
        }
        let mut has_accept = false;
        for (k, v) in &req.headers {
            if k.eq_ignore_ascii_case("accept") {
                has_accept = true;
            }
            call = call.set(k, v);
        }
        if !has_accept {
            call = call.set("Accept", "application/json, text/plain, */*");
        }
        let result = match &req.body {
            Some(b) => call.send_string(b),
            None => call.call(),
        };
        let response = match result {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(ureq::Error::Transport(t)) => {
                return json_response(200, &json!({ "error": t.to_string() }));
            }
        };
        let status = response.status();
        let final_url = response.get_url().to_string();
        let mut headers = serde_json::Map::new();
        for name in response.headers_names() {
            if let Some(v) = response.header(&name) {
                headers.insert(name.to_ascii_lowercase(), Value::String(v.to_string()));
            }
        }
        let mut bytes = Vec::new();
        if let Err(e) = response.into_reader().take(MAX_BODY).read_to_end(&mut bytes) {
            return json_response(200, &json!({ "error": format!("reading the response failed: {e}") }));
        }
        let text = String::from_utf8_lossy(&bytes);
        json_response(200, &json!({ "status": status, "url": final_url, "headers": headers, "body": text }))
    }
}
