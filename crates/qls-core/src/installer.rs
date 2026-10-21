//! First-run installer: downloads what a hardware preset needs (see [`crate::catalog`])
//! into the stable-diffusion.cpp folder, with progress, resume and SHA-256 checks.
//!
//! - Large files download over [`CONNECTIONS`] parallel connections, each fetching 16 MB
//!   segments with HTTP Range requests into `<file>.part`; finished segments are recorded in
//!   `<file>.part.segments`, so a pause or crash resumes where it stopped. GitHub's release CDN
//!   limits each connection (measured 2026-10-08: ~1 MB/s on one, 23 MB/s on eight).
//!   A server that ignores ranges gets one plain connection.
//! - Every finished download is hashed; a mismatch deletes it and downloads once more.
//! - A moved link (HTTP 404/403/410) or a second mismatch fails that file with instructions
//!   to download it by hand and to open an issue ([`crate::catalog::manual_download_hint`]).
//! - Zips (the engine) are extracted into the folder of their destination and then deleted.
//!
//! Files already present (by size) are skipped. Network calls only go to the URLs in the
//! catalog (GitHub releases and Hugging Face).

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::catalog::{Download, FileKind, manual_download_hint};
use crate::error::{AppError, AppResult, ErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    /// Already installed; nothing to do.
    Present,
    Pending,
    Downloading,
    Verifying,
    Extracting,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct ItemStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: FileKind,
    pub size: u64,
    pub received: u64,
    pub state: ItemState,
    pub error: Option<String>,
    /// What to do by hand when the download cannot be fixed by retrying.
    pub hint: Option<String>,
    pub url: &'static str,
    pub page: &'static str,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct InstallStatus {
    pub running: bool,
    /// Every item is installed.
    pub complete: bool,
    pub preset: Option<String>,
    pub sdcpp_dir: Option<String>,
    pub items: Vec<ItemStatus>,
    pub bytes_per_sec: f64,
    pub started_at: Option<String>,
}

#[derive(Default)]
pub struct Installer {
    status: Mutex<InstallStatus>,
    cancel: AtomicBool,
    /// Bytes received in this run (all files, all connections), for the speed estimate.
    bytes: AtomicU64,
}

/// Called once when a run ends, with whether everything is installed.
pub type OnFinish = Box<dyn FnOnce(bool) + Send>;

const RETRIES: usize = 3;
const CHUNK_TIMEOUT: Duration = Duration::from_secs(60);
/// How often a connection waiting for data re-checks pause and "finished elsewhere".
const POLL: Duration = Duration::from_millis(250);
/// Parallel connections per file and the size of the pieces they fetch.
pub const CONNECTIONS: usize = 8;
const SEGMENT: u64 = 8 << 20;
/// Endgame: a piece with less than this left is not worth a second connection.
const RACE_MIN_LEFT: u64 = 512 << 10;
const SEGMENT_RETRIES: u64 = 5;

enum Failure {
    /// Worth retrying (network error, server error, truncated stream).
    Transient(String),
    /// Retrying will not help (moved link, refused, file changed upstream).
    Permanent(String),
    Cancelled,
    /// The server answered a range request with the whole file.
    NoRanges,
}

impl Failure {
    fn message(self) -> String {
        match self {
            Self::Transient(m) | Self::Permanent(m) => m,
            Self::Cancelled => "Cancelled.".into(),
            Self::NoRanges => "The server does not support partial downloads.".into(),
        }
    }
}

fn http_failure(status: reqwest::StatusCode, d: &Download) -> Failure {
    match status.as_u16() {
        404 | 410 => Failure::Permanent(format!("The file is no longer at {} (HTTP {status}).", d.url)),
        401 | 403 => Failure::Permanent(format!("The server refused the download (HTTP {status}).")),
        _ => Failure::Transient(format!("HTTP {status}")),
    }
}

/// One file being fetched over several connections. When no piece is left to start, idle
/// connections also fetch the piece with the most left ("endgame"): the bytes are identical,
/// so both write them and the first to finish wins. One slow connection can then no longer
/// hold up the end of a file.
struct Segmented<'a> {
    d: &'a Download,
    client: &'a reqwest::Client,
    part: &'a Path,
    file: std::fs::File,
    queue: Mutex<VecDeque<usize>>,
    done: Vec<AtomicBool>,
    /// Furthest point any connection reached inside each piece.
    progress: Vec<AtomicU64>,
    /// Connections working on each piece.
    workers: Mutex<Vec<u8>>,
    /// Serializes writes of the state file.
    state_lock: Mutex<()>,
    /// Another connection hit an error that ends this attempt.
    stop: AtomicBool,
}

impl Segmented<'_> {
    fn received(&self) -> u64 {
        (0..self.done.len())
            .map(|i| if self.done[i].load(Ordering::SeqCst) { segment_len(i, self.d.size) } else { self.progress[i].load(Ordering::SeqCst) })
            .sum()
    }

    fn save_state(&self) {
        let _g = self.state_lock.lock().unwrap();
        let done: Vec<bool> = self.done.iter().map(|d| d.load(Ordering::SeqCst)).collect();
        write_segment_state(self.part, self.d.size, &done);
    }

    /// The next piece: a queued one, or (endgame) the unfinished piece with the most left
    /// that only one connection is fetching. The bool says whether it is a race.
    fn next(&self) -> Option<(usize, bool)> {
        let mut workers = self.workers.lock().unwrap();
        let pick = if let Some(i) = self.queue.lock().unwrap().pop_front() {
            Some((i, false))
        } else {
            (0..self.done.len())
                .filter(|&i| workers[i] == 1 && !self.done[i].load(Ordering::SeqCst))
                .map(|i| (i, segment_len(i, self.d.size).saturating_sub(self.progress[i].load(Ordering::SeqCst))))
                .filter(|&(_, left)| left >= RACE_MIN_LEFT)
                .max_by_key(|&(_, left)| left)
                .map(|(i, _)| (i, true))
        };
        if let Some((i, _)) = pick {
            workers[i] += 1;
        }
        pick
    }
}

impl Installer {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn status(&self) -> InstallStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn is_running(&self) -> bool {
        self.status.lock().unwrap().running
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Starts installing `downloads` into `dir` in the background.
    pub fn start(self: &Arc<Self>, dir: PathBuf, preset: &str, downloads: Vec<Download>, on_finish: OnFinish) -> AppResult<()> {
        {
            let mut st = self.status.lock().unwrap();
            if st.running {
                return Err(AppError::new(ErrorCode::QueueFull, "An installation is already running."));
            }
            *st = InstallStatus {
                running: true,
                complete: false,
                preset: Some(preset.to_string()),
                sdcpp_dir: Some(dir.display().to_string()),
                items: downloads.iter().map(|d| item_status(d, &dir)).collect(),
                bytes_per_sec: 0.0,
                started_at: Some(crate::store::now_rfc3339()),
            };
        }
        self.cancel.store(false, Ordering::SeqCst);
        self.bytes.store(0, Ordering::SeqCst);
        // Smoothed overall speed, shown with the time left.
        let meter = self.clone();
        tokio::spawn(async move {
            let mut last = (Instant::now(), 0u64);
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let now = meter.bytes.load(Ordering::SeqCst);
                let rate = (now - last.1) as f64 / last.0.elapsed().as_secs_f64();
                last = (Instant::now(), now);
                let mut st = meter.status.lock().unwrap();
                if !st.running {
                    break;
                }
                st.bytes_per_sec = if st.bytes_per_sec > 0.0 { st.bytes_per_sec * 0.7 + rate * 0.3 } else { rate };
            }
        });
        let this = self.clone();
        tokio::spawn(async move {
            let ok = this.run(&dir, &downloads).await;
            let complete = ok && !this.cancel.load(Ordering::SeqCst);
            {
                let mut st = this.status.lock().unwrap();
                st.running = false;
                st.complete = complete;
                st.bytes_per_sec = 0.0;
            }
            on_finish(complete);
        });
        Ok(())
    }

    fn set(&self, id: &str, f: impl FnOnce(&mut ItemStatus)) {
        let mut st = self.status.lock().unwrap();
        if let Some(it) = st.items.iter_mut().find(|i| i.id == id) {
            f(it);
        }
    }

    async fn run(&self, dir: &Path, downloads: &[Download]) -> bool {
        if let Err(e) = std::fs::create_dir_all(dir) {
            for d in downloads {
                self.set(d.id, |i| {
                    i.state = ItemState::Failed;
                    i.error = Some(format!("Cannot create {}: {e}", dir.display()));
                });
            }
            return false;
        }
        let client = match reqwest::Client::builder()
            .user_agent(concat!("kokon/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("HTTP client: {e}");
                return false;
            }
        };
        let mut all_ok = true;
        for d in downloads {
            if self.cancel.load(Ordering::SeqCst) {
                self.set(d.id, |i| {
                    if i.state == ItemState::Pending {
                        i.state = ItemState::Cancelled;
                    }
                });
                all_ok = false;
                continue;
            }
            if d.is_present(dir) {
                self.set(d.id, |i| i.state = ItemState::Present);
                continue;
            }
            match self.install_one(&client, d, dir).await {
                Ok(()) => self.set(d.id, |i| {
                    i.state = ItemState::Done;
                    i.received = i.size;
                }),
                Err(Failure::Cancelled) => {
                    self.set(d.id, |i| i.state = ItemState::Cancelled);
                    all_ok = false;
                }
                Err(f) => {
                    let e = f.message();
                    tracing::warn!("install {} failed: {e}", d.id);
                    let hint = manual_download_hint(d, dir);
                    self.set(d.id, |i| {
                        i.state = ItemState::Failed;
                        i.error = Some(e);
                        i.hint = Some(hint);
                    });
                    // Keep going so the other files still install.
                    all_ok = false;
                }
            }
        }
        all_ok
    }

    async fn install_one(&self, client: &reqwest::Client, d: &Download, dir: &Path) -> Result<(), Failure> {
        let target = d.path(dir);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Failure::Permanent(format!("Cannot create {}: {e}", parent.display())))?;
        }
        let part = part_path(&target);
        // A link that still fails after its retries moves on to the next one (mirror, then
        // the original); the first link's error is the one reported.
        let mut first_error = None;
        for url in d.urls() {
            let from = Download { url, ..*d };
            match self.fetch_verified(client, &from, &part).await {
                Ok(()) => {
                    first_error = None;
                    break;
                }
                Err(Failure::Cancelled) => return Err(Failure::Cancelled),
                Err(f) => {
                    let e = f.message();
                    tracing::warn!("{}: {url} failed ({e})", d.id);
                    first_error.get_or_insert(e);
                    if d.fallback_urls.is_empty() {
                        // Kept, so the next try resumes it.
                        break;
                    }
                    // Another server's partial file must not be resumed.
                    remove_part(&part);
                }
            }
        }
        if let Some(e) = first_error {
            return Err(Failure::Permanent(e));
        }
        if d.is_zip() {
            self.set(d.id, |i| i.state = ItemState::Extracting);
            let (p, out) = (part.clone(), crate::catalog::zip_dir(d, dir));
            tokio::task::spawn_blocking(move || extract_zip(&p, &out))
                .await
                .map_err(|e| Failure::Transient(e.to_string()))?
                .map_err(Failure::Permanent)?;
            let _ = std::fs::remove_file(&part);
            d.write_tag(dir).map_err(|e| Failure::Permanent(format!("Cannot mark the engine as installed: {e}")))?;
        } else {
            std::fs::rename(&part, &target).map_err(|e| Failure::Permanent(format!("Cannot save {}: {e}", target.display())))?;
        }
        Ok(())
    }

    /// Downloads `d` from `d.url` into `part` and checks its hash (retrying interruptions and
    /// one checksum mismatch).
    async fn fetch_verified(&self, client: &reqwest::Client, d: &Download, part: &Path) -> Result<(), Failure> {
        let part = part.to_path_buf();
        let mut mismatches = 0;
        let mut attempt = 0;
        loop {
            attempt += 1;
            match self.download(client, d, &part).await {
                Ok(()) => {}
                Err(Failure::Transient(e)) if attempt < RETRIES => {
                    tracing::info!("download {} interrupted ({e}); resuming", d.id);
                    tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
                    continue;
                }
                Err(e) => return Err(e),
            }
            self.set(d.id, |i| i.state = ItemState::Verifying);
            let p = part.clone();
            let hash = tokio::task::spawn_blocking(move || sha256_file(&p)).await.map_err(|e| Failure::Transient(e.to_string()))?;
            let hash = hash.map_err(|e| Failure::Transient(format!("Cannot read the download: {e}")))?;
            if hash == d.sha256 {
                break;
            }
            remove_part(&part);
            mismatches += 1;
            if mismatches >= 2 {
                return Err(Failure::Permanent(format!("The downloaded file does not match the expected checksum (got {}…). The file may have changed on the server.", &hash[..12])));
            }
            tracing::warn!("{}: checksum mismatch, downloading again", d.id);
            attempt = 0;
        }
        Ok(())
    }

    /// Downloads (or resumes) `d` into `part` until it has `d.size` bytes.
    async fn download(&self, client: &reqwest::Client, d: &Download, part: &Path) -> Result<(), Failure> {
        if d.size >= 2 * SEGMENT {
            match self.download_segmented(client, d, part).await {
                Err(Failure::NoRanges) => {
                    tracing::info!("{}: the server ignores ranges; using one connection", d.id);
                    remove_part(part);
                }
                r => return r,
            }
        }
        self.download_single(client, d, part).await
    }

    async fn download_segmented(&self, client: &reqwest::Client, d: &Download, part: &Path) -> Result<(), Failure> {
        let done = done_segments(part, d.size);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(part)
            .map_err(|e| Failure::Permanent(format!("Cannot write {}: {e}", part.display())))?;
        file.set_len(d.size).map_err(|e| Failure::Permanent(format!("Cannot reserve {} for {}: {e} (is the disk full?)", human(d.size), part.display())))?;
        write_segment_state(part, d.size, &done);
        let s = Segmented {
            d,
            client,
            part,
            file,
            queue: Mutex::new((0..done.len()).filter(|i| !done[*i]).collect()),
            progress: (0..done.len()).map(|_| AtomicU64::new(0)).collect(),
            workers: Mutex::new(vec![0; done.len()]),
            done: done.into_iter().map(AtomicBool::new).collect(),
            state_lock: Mutex::new(()),
            stop: AtomicBool::new(false),
        };
        let have = s.received();
        self.set(d.id, |i| {
            i.state = ItemState::Downloading;
            i.received = have;
            i.error = None;
        });
        let finished = AtomicBool::new(false);
        let work = async {
            let r = futures_util::future::join_all((0..CONNECTIONS).map(|_| self.segment_worker(&s))).await;
            finished.store(true, Ordering::SeqCst);
            r
        };
        let progress = async {
            while !finished.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let r = s.received();
                self.set(d.id, |i| i.received = r);
            }
        };
        let (results, ()) = tokio::join!(work, progress);
        // The most telling outcome wins: a dead link over a pause over a network hiccup.
        let mut outcome = Ok(());
        for r in results {
            outcome = match (outcome, r) {
                (Err(Failure::Permanent(m)), _) | (_, Err(Failure::Permanent(m))) => Err(Failure::Permanent(m)),
                (Err(Failure::NoRanges), _) | (_, Err(Failure::NoRanges)) => Err(Failure::NoRanges),
                (Err(Failure::Cancelled), _) | (_, Err(Failure::Cancelled)) => Err(Failure::Cancelled),
                (Err(e), _) | (_, Err(e)) => Err(e),
                (Ok(()), Ok(())) => Ok(()),
            };
        }
        outcome?;
        if s.done.iter().any(|x| !x.load(Ordering::SeqCst)) {
            return Err(Failure::Transient("Some parts are still missing.".into()));
        }
        s.file.sync_all().map_err(|e| Failure::Transient(e.to_string()))?;
        drop(s);
        let _ = std::fs::remove_file(segments_path(part));
        Ok(())
    }

    /// One connection: takes pieces until none is left, then helps with the slowest one.
    async fn segment_worker(&self, s: &Segmented<'_>) -> Result<(), Failure> {
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled);
            }
            if s.stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            let Some((i, race)) = s.next() else { return Ok(()) };
            let mut attempt = 0;
            let r = loop {
                attempt += 1;
                match self.fetch_segment(s, i).await {
                    Err(Failure::Transient(e)) if !race && attempt < SEGMENT_RETRIES => {
                        tracing::info!("{} part {i}: {e}; retrying", s.d.id);
                        tokio::time::sleep(Duration::from_secs(attempt)).await;
                    }
                    r => break r,
                }
            };
            s.workers.lock().unwrap()[i] -= 1;
            match r {
                Ok(()) => {
                    if !s.done[i].swap(true, Ordering::SeqCst) {
                        s.save_state();
                    }
                }
                // A helper that failed leaves the piece to its first connection.
                Err(Failure::Transient(_)) if race => {}
                Err(e) => {
                    s.stop.store(true, Ordering::SeqCst);
                    return Err(e);
                }
            }
        }
    }

    /// Fetches piece `i` into the file. Returns early (Ok) when another connection finished it.
    async fn fetch_segment(&self, s: &Segmented<'_>, i: usize) -> Result<(), Failure> {
        if s.done[i].load(Ordering::SeqCst) {
            return Ok(());
        }
        let start = i as u64 * SEGMENT;
        let end = start + segment_len(i, s.d.size); // exclusive
        let resp = s.client.get(s.d.url).header(reqwest::header::RANGE, format!("bytes={start}-{}", end - 1)).send().await.map_err(|e| Failure::Transient(describe(&e)))?;
        match resp.status().as_u16() {
            206 => {}
            200 => return Err(Failure::NoRanges),
            _ => return Err(http_failure(resp.status(), s.d)),
        }
        if let Some(total) = content_range_total(resp.headers())
            && total != s.d.size
        {
            return Err(Failure::Permanent(format!("The server offers {total} bytes, expected {}. The file may have changed on the server.", s.d.size)));
        }
        let mut pos = start;
        let mut stream = resp.bytes_stream();
        let mut idle = Duration::ZERO;
        let r = loop {
            if self.cancel.load(Ordering::SeqCst) {
                break Err(Failure::Cancelled);
            }
            if s.stop.load(Ordering::SeqCst) {
                break Err(Failure::Transient("Stopped.".into()));
            }
            if s.done[i].load(Ordering::SeqCst) {
                return Ok(());
            }
            let chunk = match tokio::select! { c = stream.next() => Some(c), _ = tokio::time::sleep(POLL) => None } {
                None => {
                    idle += POLL;
                    if idle >= CHUNK_TIMEOUT {
                        break Err(Failure::Transient("The download stalled.".into()));
                    }
                    continue;
                }
                Some(None) => break Ok(()),
                Some(Some(Err(e))) => break Err(Failure::Transient(describe(&e))),
                Some(Some(Ok(c))) => c,
            };
            idle = Duration::ZERO;
            if pos + chunk.len() as u64 > end {
                break Err(Failure::Transient("The server sent more than requested.".into()));
            }
            if let Err(e) = write_all_at(&s.file, &chunk, pos) {
                break Err(Failure::Permanent(format!("Cannot write {}: {e} (is the disk full?)", s.part.display())));
            }
            pos += chunk.len() as u64;
            s.progress[i].fetch_max(pos - start, Ordering::SeqCst);
            self.bytes.fetch_add(chunk.len() as u64, Ordering::SeqCst);
        };
        let r = r.and_then(|()| if pos == end { Ok(()) } else { Err(Failure::Transient("A part ended early.".into())) });
        if r.is_err() && s.workers.lock().unwrap()[i] <= 1 && !s.done[i].load(Ordering::SeqCst) {
            // Nobody else is on this piece: it starts over, so its bytes no longer count.
            s.progress[i].store(0, Ordering::SeqCst);
        }
        r
    }

    /// One plain connection, appending to `part` (small files, servers without ranges).
    async fn download_single(&self, client: &reqwest::Client, d: &Download, part: &Path) -> Result<(), Failure> {
        let mut have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        if have > d.size {
            let _ = std::fs::remove_file(part);
            have = 0;
        }
        if have == d.size {
            return Ok(());
        }
        self.set(d.id, |i| {
            i.state = ItemState::Downloading;
            i.received = have;
            i.error = None;
        });
        let mut req = client.get(d.url);
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let resp = req.send().await.map_err(|e| Failure::Transient(describe(&e)))?;
        let status = resp.status();
        let append = match status.as_u16() {
            206 => true,
            200 => false,
            416 => {
                // The range starts at or past the end: start over.
                let _ = std::fs::remove_file(part);
                return Err(Failure::Transient("The partial download was not accepted; starting over.".into()));
            }
            _ => return Err(http_failure(status, d)),
        };
        if let Some(len) = resp.content_length() {
            let total = if append { have + len } else { len };
            if total != d.size {
                return Err(Failure::Permanent(format!("The server offers {total} bytes, expected {}. The file may have changed on the server.", d.size)));
            }
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(part)
            .map_err(|e| Failure::Permanent(format!("Cannot write {}: {e}", part.display())))?;
        let mut received = if append { have } else { 0 };
        let mut stream = resp.bytes_stream();
        let mut idle = Duration::ZERO;
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled);
            }
            let chunk = match tokio::select! { c = stream.next() => Some(c), _ = tokio::time::sleep(POLL) => None } {
                None => {
                    idle += POLL;
                    if idle >= CHUNK_TIMEOUT {
                        return Err(Failure::Transient("The download stalled.".into()));
                    }
                    continue;
                }
                Some(None) => break,
                Some(Some(Err(e))) => return Err(Failure::Transient(describe(&e))),
                Some(Some(Ok(c))) => c,
            };
            idle = Duration::ZERO;
            file.write_all(&chunk).map_err(|e| Failure::Permanent(format!("Cannot write {}: {e} (is the disk full?)", part.display())))?;
            received += chunk.len() as u64;
            self.bytes.fetch_add(chunk.len() as u64, Ordering::SeqCst);
            self.set(d.id, |i| i.received = received);
        }
        file.flush().map_err(|e| Failure::Permanent(e.to_string()))?;
        if received != d.size {
            return Err(Failure::Transient(format!("The download ended early ({received} of {} bytes).", d.size)));
        }
        Ok(())
    }
}

fn item_status(d: &Download, dir: &Path) -> ItemStatus {
    let present = d.is_present(dir);
    ItemStatus {
        id: d.id,
        label: d.label,
        kind: d.kind,
        size: d.size,
        received: if present { d.size } else { part_progress(&d.path(dir), d.size) },
        state: if present { ItemState::Present } else { ItemState::Pending },
        error: None,
        hint: None,
        url: d.url,
        page: d.page,
        path: if d.is_zip() { dir.display().to_string() } else { d.path(dir).display().to_string() },
    }
}

/// The wizard's view of a preset before anything runs: which files are present.
pub fn preview(dir: &Path, downloads: &[Download]) -> Vec<ItemStatus> {
    downloads.iter().map(|d| item_status(d, dir)).collect()
}

/// Bytes still to download, and the disk space that needs (zips are also extracted).
pub fn space_needed(dir: &Path, downloads: &[Download]) -> (u64, u64) {
    let missing: Vec<&Download> = downloads.iter().filter(|d| !d.is_present(dir)).collect();
    let download: u64 = missing.iter().map(|d| d.size - part_progress(&d.path(dir), d.size)).sum();
    let disk: u64 = missing.iter().map(|d| if d.is_zip() { d.size * 5 / 2 } else { d.size }).sum();
    (download, disk)
}

/// Folder of the model files shipped inside the app (Tauri resources): next to the
/// executables on Windows, `Contents/Resources` on a Mac, `/usr/lib/Kokon` for the Linux
/// packages (executables in `/usr/bin`). `QLS_BUNDLE_DIR` overrides it.
pub fn bundle_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("QLS_BUNDLE_DIR") {
        return Some(PathBuf::from(p));
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let lib = dir.join("..").join("lib");
    [dir.join("bundled"), dir.join("..").join("Resources").join("bundled"), lib.join("Kokon").join("bundled"), lib.join("kokon").join("bundled")].into_iter().find(|p| p.is_dir())
}

/// Copies `d` from the app's bundle into the stable-diffusion.cpp folder when it is missing
/// there, checking its hash. Ok(true) when it was copied.
pub fn install_bundled(d: &Download, dir: &Path, bundle: &Path) -> std::io::Result<bool> {
    let name = d.dest.rsplit('/').next().unwrap_or(d.dest);
    let src = bundle.join(name);
    if d.is_zip() || d.is_present(dir) || !std::fs::metadata(&src).is_ok_and(|m| m.len() == d.size) {
        return Ok(false);
    }
    let target = d.path(dir);
    if let Some(p) = target.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = part_path(&target);
    std::fs::copy(&src, &tmp)?;
    if sha256_file(&tmp)? != d.sha256 {
        remove_part(&tmp);
        return Err(std::io::Error::other(format!("the bundled {name} is damaged")));
    }
    std::fs::rename(&tmp, &target)?;
    Ok(true)
}

/// ESRGAN models in the app's own upscalers folder other than those named in `keep` (the
/// selected model), with their sizes.
pub fn legacy_upscalers(dir: &Path, keep: &[&str]) -> Vec<(PathBuf, u64)> {
    crate::catalog::LEGACY_UPSCALERS
        .iter()
        .map(|f| crate::catalog::join_rel(dir, f))
        .filter(|p| p.file_stem().and_then(|s| s.to_str()).is_none_or(|s| !keep.contains(&s)))
        .filter_map(|p| std::fs::metadata(&p).ok().filter(|m| m.is_file()).map(|m| (p, m.len())))
        .collect()
}

/// Deletes [`legacy_upscalers`]; returns the bytes freed.
pub fn remove_legacy_upscalers(dir: &Path, keep: &[&str]) -> AppResult<u64> {
    let mut freed = 0;
    for (p, size) in legacy_upscalers(dir, keep) {
        std::fs::remove_file(&p).map_err(|e| AppError::io("delete the old upscaler", &p, e))?;
        freed += size;
    }
    Ok(freed)
}

/// Free space on the drive that holds `dir` (or its nearest existing parent).
pub fn free_space(dir: &Path) -> Option<u64> {
    let mut p = dir.to_path_buf();
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    let p = crate::paths::dunce_canonical(&p).unwrap_or(p);
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| p.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

#[derive(Serialize, Deserialize)]
struct SegmentState {
    size: u64,
    segment: u64,
    done: Vec<usize>,
}

fn segments_path(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_os_string();
    s.push(".segments");
    PathBuf::from(s)
}

fn segment_len(i: usize, size: u64) -> u64 {
    SEGMENT.min(size - i as u64 * SEGMENT)
}

fn write_segment_state(part: &Path, size: u64, done: &[bool]) {
    let st = SegmentState { size, segment: SEGMENT, done: done.iter().enumerate().filter(|(_, d)| **d).map(|(i, _)| i).collect() };
    let p = segments_path(part);
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, serde_json::to_vec(&st).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

/// Segments of a `size`-byte download already in `part`: from the state file, or, for a part
/// written by one plain connection, every whole segment of its prefix.
fn done_segments(part: &Path, size: u64) -> Vec<bool> {
    let n = size.div_ceil(SEGMENT) as usize;
    let mut done = vec![false; n];
    let state_file = segments_path(part);
    if state_file.exists() {
        // A state file for another size or segment length (or a damaged one): start over.
        let st = std::fs::read(&state_file).ok().and_then(|b| serde_json::from_slice::<SegmentState>(&b).ok());
        if let Some(st) = st.filter(|st| st.size == size && st.segment == SEGMENT) {
            for i in st.done.into_iter().filter(|i| *i < n) {
                done[i] = true;
            }
        }
    } else {
        {
            let have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
            let whole = if have == size { n } else { (have.min(size) / SEGMENT) as usize };
            done.iter_mut().take(whole).for_each(|d| *d = true);
        }
    }
    done
}

/// Bytes of `target` already downloaded.
fn part_progress(target: &Path, size: u64) -> u64 {
    let part = part_path(target);
    if !part.exists() {
        return 0;
    }
    if size < 2 * SEGMENT {
        return std::fs::metadata(&part).map(|m| m.len().min(size)).unwrap_or(0);
    }
    done_segments(&part, size).iter().enumerate().filter(|(_, d)| **d).map(|(i, _)| segment_len(i, size)).sum()
}

fn remove_part(part: &Path) {
    let _ = std::fs::remove_file(part);
    let _ = std::fs::remove_file(segments_path(part));
}

/// `Content-Range: bytes a-b/total` → total.
fn content_range_total(h: &reqwest::header::HeaderMap) -> Option<u64> {
    h.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?.rsplit('/').next()?.parse().ok()
}

fn write_all_at(f: &std::fs::File, mut buf: &[u8], mut pos: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        #[cfg(windows)]
        let n = std::os::windows::fs::FileExt::seek_write(f, buf, pos)?;
        #[cfg(unix)]
        let n = std::os::unix::fs::FileExt::write_at(f, buf, pos)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        buf = &buf[n..];
        pos += n as u64;
    }
    Ok(())
}

pub(crate) fn human(n: u64) -> String {
    format!("{:.1} GB", n as f64 / 1e9)
}

fn part_path(target: &Path) -> PathBuf {
    let mut s = target.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

fn describe(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "Could not connect (check the internet connection).".into()
    } else if e.is_timeout() {
        "The connection timed out.".into()
    } else {
        e.to_string()
    }
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Extracts every file of `zip` into `out` (flat or nested; no path may leave `out`).
/// Existing files are replaced, e.g. when updating the engine.
pub fn extract_zip(zip: &Path, out: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip).map_err(|e| e.to_string())?;
    let mut ar = zip::ZipArchive::new(f).map_err(|e| format!("The archive is damaged: {e}"))?;
    for i in 0..ar.len() {
        let mut entry = ar.by_index(i).map_err(|e| format!("The archive is damaged: {e}"))?;
        let Some(rel) = entry.enclosed_name() else { return Err(format!("Unsafe path in the archive: {}", entry.name())) };
        let dest = out.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let tmp = part_path(&dest);
        let mut w = std::fs::File::create(&tmp).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
        std::io::copy(&mut entry, &mut w).map_err(|e| format!("Cannot extract {}: {e}", dest.display()))?;
        drop(w);
        // Keep the executable bit of the macOS/Linux engine (sd-server).
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode & 0o777));
        }
        std::fs::rename(&tmp, &dest).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("Cannot replace {} (is stable-diffusion.cpp still running?): {e}", dest.display())
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_extraction_is_contained() {
        let dir = tempfile::tempdir().unwrap();
        let zp = dir.path().join("a.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&zp).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("sd-server.exe", o).unwrap();
            z.write_all(b"exe").unwrap();
            z.start_file("sub/x.txt", o).unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
        }
        let out = dir.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("sd-server.exe"), b"old").unwrap();
        extract_zip(&zp, &out).unwrap();
        assert_eq!(std::fs::read(out.join("sd-server.exe")).unwrap(), b"exe", "replaced");
        assert!(out.join("sub").join("x.txt").is_file());

        let evil = dir.path().join("evil.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&evil).unwrap());
            z.start_file("../escape.txt", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
        }
        assert!(extract_zip(&evil, &out).is_err());
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn hashing_and_space() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f");
        std::fs::write(&f, b"abc").unwrap();
        assert_eq!(sha256_file(&f).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let p = crate::catalog::preset("16gb").unwrap();
        let all = crate::catalog::downloads_for(p, crate::config::GpuBackend::Cuda, dir.path());
        let (dl, disk) = space_needed(dir.path(), &all);
        assert_eq!(dl, all.iter().map(|d| d.size).sum::<u64>());
        assert!(disk > dl, "zips need room to extract");
        // A partial download counts toward what is left.
        let vae = crate::catalog::VAE;
        std::fs::create_dir_all(vae.path(dir.path()).parent().unwrap()).unwrap();
        std::fs::write(part_path(&vae.path(dir.path())), vec![0u8; (SEGMENT + 1000) as usize]).unwrap();
        assert_eq!(space_needed(dir.path(), &all).0, dl - SEGMENT, "whole segments count");
        assert!(free_space(dir.path()).unwrap_or(1) > 0);
        assert!(preview(dir.path(), &all).iter().all(|i| i.state == ItemState::Pending));
    }

    #[test]
    fn segment_bookkeeping() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("m.gguf");
        let part = part_path(&target);
        let size = 5 * SEGMENT + 123;
        assert_eq!(part_progress(&target, size), 0);
        // A prefix left by a single-connection download counts in whole segments.
        std::fs::write(&part, vec![0u8; (2 * SEGMENT + 10) as usize]).unwrap();
        assert_eq!(done_segments(&part, size), vec![true, true, false, false, false, false]);
        // A segmented download records what is done, in any order (the file is preallocated).
        std::fs::OpenOptions::new().write(true).open(&part).unwrap().set_len(size).unwrap();
        write_segment_state(&part, size, &[true, false, false, false, false, true]);
        assert_eq!(part_progress(&target, size), SEGMENT + 123);
        assert_eq!(segment_len(5, size), 123);
        // State from another file size is ignored.
        write_segment_state(&part, size + 1, &[true; 6]);
        assert_eq!(done_segments(&part, size).iter().filter(|d| **d).count(), 0, "full-size preallocation is not a finished prefix");
        remove_part(&part);
        assert!(!part.exists() && !segments_path(&part).exists());
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(reqwest::header::CONTENT_RANGE, "bytes 0-99/337915440".parse().unwrap());
        assert_eq!(content_range_total(&h), Some(337_915_440));
    }

    #[test]
    fn bundled_upscaler_is_copied_once_and_checked() {
        let (dir, bundle) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let d = Download { size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", ..crate::catalog::UPSCALER };
        assert!(!install_bundled(&d, dir.path(), bundle.path()).unwrap(), "nothing bundled (dev build)");
        std::fs::write(bundle.path().join("4xNomos2_hq_mosr.pth"), b"abd").unwrap();
        assert!(install_bundled(&d, dir.path(), bundle.path()).is_err(), "a damaged copy is refused");
        assert!(!d.is_present(dir.path()) && !part_path(&d.path(dir.path())).exists());
        std::fs::write(bundle.path().join("4xNomos2_hq_mosr.pth"), b"abc").unwrap();
        assert!(install_bundled(&d, dir.path(), bundle.path()).unwrap());
        assert!(d.is_present(dir.path()));
        assert!(!install_bundled(&d, dir.path(), bundle.path()).unwrap(), "already in place");
    }

    #[test]
    fn legacy_upscalers_only_in_the_app_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(legacy_upscalers(dir.path(), &[]).is_empty());
        let up = dir.path().join("models").join("upscalers");
        std::fs::create_dir_all(&up).unwrap();
        std::fs::write(up.join("4x-UltraSharp.pth"), vec![0u8; 100]).unwrap();
        std::fs::write(up.join("4xNomos2_hq_mosr.pth"), b"keep").unwrap();
        std::fs::write(up.join("my-own.pth"), b"keep").unwrap();
        std::fs::write(up.join("4x_NMKD-Superscale-SP_178000_G.pth"), b"in use").unwrap();
        let ss = &["4x_NMKD-Superscale-SP_178000_G"][..];
        assert_eq!(legacy_upscalers(dir.path(), ss), vec![(up.join("4x-UltraSharp.pth"), 100)], "the selected model is never offered");
        assert_eq!(remove_legacy_upscalers(dir.path(), ss).unwrap(), 100);
        assert!(!up.join("4x-UltraSharp.pth").exists() && up.join("4xNomos2_hq_mosr.pth").exists() && up.join("my-own.pth").exists());
        assert!(up.join("4x_NMKD-Superscale-SP_178000_G.pth").exists());
        assert_eq!(remove_legacy_upscalers(dir.path(), ss).unwrap(), 0);
    }

    /// Real download of the smallest catalog file (QLS_TEST_DOWNLOAD=1; ~17 MB).
    #[tokio::test]
    async fn real_download_with_resume() {
        if std::env::var("QLS_TEST_DOWNLOAD").is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let d = crate::catalog::UPSCALER;
        let target = d.path(dir.path());
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        // Start from a fake partial file holding the first bytes, as after an interruption.
        let inst = Installer::new();
        let client = reqwest::Client::new();
        {
            let resp = client.get(d.url).header(reqwest::header::RANGE, "bytes=0-1048575").send().await.unwrap();
            assert_eq!(resp.status().as_u16(), 206, "GitHub's release CDN supports ranges");
            std::fs::write(part_path(&target), resp.bytes().await.unwrap()).unwrap();
        }
        let (tx, rx) = std::sync::mpsc::channel();
        inst.start(dir.path().to_path_buf(), "test", vec![d], Box::new(move |ok| tx.send(ok).unwrap())).unwrap();
        let ok = tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(600)).unwrap()).await.unwrap();
        assert!(ok, "{:?}", inst.status());
        assert!(d.is_present(dir.path()));
        assert_eq!(sha256_file(&target).unwrap(), d.sha256);
    }
}
