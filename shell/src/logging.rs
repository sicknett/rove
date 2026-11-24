//! A plain log file in the data folder: `logs\rove.log`, started fresh past 4 MB.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

struct FileLog(Mutex<File>);

impl log::Log for FileLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) || !record.target().starts_with("rove") {
            return;
        }
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        let line = format!("{secs:.3} {:<5} {}\n", record.level(), record.args());
        if let Ok(mut file) = self.0.lock() {
            let _ = file.write_all(line.as_bytes());
        }
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
    }

    fn flush(&self) {
        if let Ok(mut file) = self.0.lock() {
            let _ = file.flush();
        }
    }
}

pub fn init(data_dir: &Path) {
    let dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("rove.log");
    let too_big = std::fs::metadata(&path).map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(false);
    let file = if too_big {
        File::create(&path)
    } else {
        OpenOptions::new().create(true).append(true).open(&path)
    };
    if let Ok(file) = file {
        let _ = log::set_boxed_logger(Box::new(FileLog(Mutex::new(file))));
        log::set_max_level(log::LevelFilter::Info);
    }
}
