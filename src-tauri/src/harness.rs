use std::{
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::SystemTime,
};

use flate2::read::GzDecoder;
use serde::Serialize;
use tar::Archive;
use tauri::{Manager, WebviewWindow};
use url::Url;

const READY_PREFIX: &str = "dsh web: ";
const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
#[cfg(windows)]
const NODE_BINARY_NAME: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BINARY_NAME: &str = "node";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct RuntimePaths {
    root: PathBuf,
    launcher: PathBuf,
    node: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSnapshot {
    phase: LaunchPhase,
    stage: LaunchStage,
    progress: u8,
    detail: String,
    url: Option<String>,
    cold_start: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum LaunchPhase {
    Starting,
    Ready,
    Failed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum LaunchStage {
    LocatingRuntime,
    CheckingRuntime,
    ExtractingRuntime,
    VerifyingRuntime,
    StartingService,
    WaitingForService,
    LoadingWorkspace,
    Failed,
}

struct ProgressReader<R> {
    inner: R,
    bytes_read: Arc<AtomicU64>,
}

impl<R: Read> Read for ProgressReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.bytes_read.fetch_add(read as u64, Ordering::Relaxed);
        Ok(read)
    }
}

pub struct HarnessProcess {
    child: Option<Child>,
    snapshot: LaunchSnapshot,
}

impl HarnessProcess {
    pub fn new() -> Self {
        Self {
            child: None,
            snapshot: LaunchSnapshot {
                phase: LaunchPhase::Starting,
                stage: LaunchStage::LocatingRuntime,
                progress: 3,
                detail: "正在定位内置 Harness 运行时…".into(),
                url: None,
                cold_start: false,
            },
        }
    }

    pub fn snapshot(&self) -> LaunchSnapshot {
        self.snapshot.clone()
    }

    pub fn spawn(state: Arc<Mutex<Self>>, window: WebviewWindow) {
        thread::spawn(move || {
            if let Err(error) = start_harness(&state, &window) {
                eprintln!("deepseek-harness-desktop: {error}");
                let mut process = lock(&state);
                let progress = process.snapshot.progress;
                let cold_start = process.snapshot.cold_start;
                process.snapshot = LaunchSnapshot {
                    phase: LaunchPhase::Failed,
                    stage: LaunchStage::Failed,
                    progress,
                    detail: error,
                    url: None,
                    cold_start,
                };
                process.stop_child();
            }
        });
    }

    pub fn stop(&mut self) {
        self.stop_child();
    }

    fn stop_child(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };

        #[cfg(windows)]
        {
            let mut terminator = Command::new("taskkill");
            terminator
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            suppress_console_window(&mut terminator);
            let _ = terminator.status();
        }

        #[cfg(not(windows))]
        {
            let _ = child.kill();
        }

        let _ = child.wait();
    }
}

impl Drop for HarnessProcess {
    fn drop(&mut self) {
        self.stop_child();
    }
}

fn start_harness(state: &Arc<Mutex<HarnessProcess>>, window: &WebviewWindow) -> Result<(), String> {
    let runtime = resolve_runtime(state, window)?;

    update_launch(
        state,
        LaunchStage::StartingService,
        76,
        "正在启动 Harness 本地服务…".into(),
    );
    let mut command = Command::new(&runtime.node);
    command
        .arg(&runtime.launcher)
        .args(["web", "--host", "127.0.0.1", "--port", "0"])
        .current_dir(&runtime.root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    #[cfg(windows)]
    suppress_console_window(&mut command);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "启动 Harness Node 运行时失败：{error}\n运行时：{}",
            runtime.node.display()
        )
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "未取得 Harness 标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "未取得 Harness 错误输出".to_string())?;
    lock(state).child = Some(child);

    update_launch(
        state,
        LaunchStage::WaitingForService,
        86,
        "本地服务进程已启动，正在等待随机端口就绪…".into(),
    );

    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_for_thread = Arc::clone(&stderr_buffer);
    let stderr_thread = thread::spawn(move || collect_stderr(stderr, stderr_for_thread));

    let mut stdout_lines = BufReader::new(stdout).lines();
    while let Some(line) = stdout_lines.next() {
        let line = line.map_err(|error| format!("读取 Harness 启动输出失败：{error}"))?;
        if let Some(url) = parse_ready_url(&line) {
            let allowed_origin = format!(
                "{}://{}:{}",
                url.scheme(),
                url.host_str().unwrap_or("127.0.0.1"),
                url.port_or_known_default().unwrap_or(80)
            );
            let mut process = lock(state);
            process.snapshot = LaunchSnapshot {
                phase: LaunchPhase::Ready,
                stage: LaunchStage::LoadingWorkspace,
                progress: 96,
                detail: "本地服务已就绪，正在载入 Harness 工作区…".into(),
                url: Some(allowed_origin),
                cold_start: process.snapshot.cold_start,
            };
            eprintln!("deepseek-harness-desktop: Harness ready at {url}");
            thread::spawn(move || {
                for line in stdout_lines {
                    if let Err(error) = line {
                        eprintln!(
                            "deepseek-harness-desktop: reading Harness stdout failed: {error}"
                        );
                        break;
                    }
                }
            });
            return Ok(());
        }
    }

    let _ = stderr_thread.join();
    let stderr = lock(&stderr_buffer).trim().to_string();
    let suffix = if stderr.is_empty() {
        String::new()
    } else {
        format!("\n\n{stderr}")
    };
    Err(format!("Harness 在就绪前退出，未输出本地 URL。{suffix}"))
}

fn resolve_runtime(
    state: &Arc<Mutex<HarnessProcess>>,
    window: &WebviewWindow,
) -> Result<RuntimePaths, String> {
    if let Some(explicit) = env::var_os("DEEPSEEK_HARNESS_ROOT") {
        update_launch(
            state,
            LaunchStage::CheckingRuntime,
            18,
            "正在检查指定的 Harness 开发运行时…".into(),
        );
        return source_runtime(PathBuf::from(explicit));
    }

    // `tauri dev` must use the freshly prepared checkout. A stale resource
    // archive can remain under target/debug after an earlier release build.
    if cfg!(debug_assertions) {
        update_launch(
            state,
            LaunchStage::CheckingRuntime,
            18,
            "正在检查仓库内 Harness 构建产物…".into(),
        );
        return checkout_runtime();
    }

    if let Ok(resource_dir) = window.app_handle().path().resource_dir() {
        update_launch(
            state,
            LaunchStage::CheckingRuntime,
            8,
            "正在检查本地运行时缓存…".into(),
        );
        let archive = resource_dir.join("runtime").join("harness.tar.gz");
        let node = resource_dir.join("runtime").join(NODE_BINARY_NAME);
        if has_content(&archive) && has_content(&node) {
            return installed_runtime(state, window, &archive, node);
        }
    }

    update_launch(
        state,
        LaunchStage::CheckingRuntime,
        18,
        "正在检查仓库内 Harness 构建产物…".into(),
    );
    checkout_runtime()
}

fn checkout_runtime() -> Result<RuntimePaths, String> {
    let desktop_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "桌面项目路径缺少父目录".to_string())?;
    let embedded = desktop_root.join("harness");
    source_runtime(embedded)
}

fn has_content(path: &Path) -> bool {
    path.metadata().is_ok_and(|metadata| metadata.len() > 0)
}

fn source_runtime(path: PathBuf) -> Result<RuntimePaths, String> {
    if !is_source_root(&path) {
        return Err(format!(
            "Harness 源码或构建产物不完整：{}\n请先运行 pnpm run harness:prepare。",
            path.display()
        ));
    }
    // Node.js does not accept the `\\?\C:\...` verbatim form returned by
    // std::fs::canonicalize on Windows. `dunce` keeps the canonical path while
    // converting that prefix back to a regular drive/UNC path.
    let root =
        dunce::canonicalize(&path).map_err(|error| format!("解析 Harness 路径失败：{error}"))?;
    let node = env::var_os("DSH_DESKTOP_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"));
    Ok(RuntimePaths {
        launcher: root.join("apps").join("cli").join("lib").join("bin.js"),
        root,
        node,
    })
}

fn installed_runtime(
    state: &Arc<Mutex<HarnessProcess>>,
    window: &WebviewWindow,
    archive: &Path,
    node: PathBuf,
) -> Result<RuntimePaths, String> {
    let cache_root = window
        .app_handle()
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("解析应用数据目录失败：{error}"))?
        .join("runtime")
        .join(RUNTIME_VERSION);
    let root = cache_root.join("harness");
    let marker = cache_root.join(".ready");
    if !marker_matches(&marker, archive) || !is_installed_root(&root) {
        mark_cold_start(state);
        if cache_root.exists() {
            update_launch(
                state,
                LaunchStage::ExtractingRuntime,
                10,
                "正在清理未完成的运行时缓存…".into(),
            );
            fs::remove_dir_all(&cache_root)
                .map_err(|error| format!("清理旧 Harness 运行时失败：{error}"))?;
        }
        fs::create_dir_all(&cache_root)
            .map_err(|error| format!("创建 Harness 运行时目录失败：{error}"))?;
        unpack_runtime(state, archive, &cache_root)?;
        update_launch(
            state,
            LaunchStage::VerifyingRuntime,
            70,
            "运行时展开完成，正在验证必要文件…".into(),
        );
        if !is_installed_root(&root) {
            return Err("内置 Harness 运行时内容不完整".to_string());
        }
        fs::write(&marker, archive_stamp(archive)?)
            .map_err(|error| format!("写入 Harness 运行时版本标记失败：{error}"))?;
    } else {
        update_launch(
            state,
            LaunchStage::VerifyingRuntime,
            70,
            "已找到可复用的 Harness 运行时缓存…".into(),
        );
    }
    Ok(RuntimePaths {
        launcher: root.join("lib").join("bin.js"),
        root,
        node,
    })
}

fn unpack_runtime(
    state: &Arc<Mutex<HarnessProcess>>,
    archive_path: &Path,
    destination: &Path,
) -> Result<(), String> {
    let archive_size = archive_path
        .metadata()
        .map_err(|error| format!("读取内置 Harness 运行时大小失败：{error}"))?
        .len();
    let file = File::open(archive_path)
        .map_err(|error| format!("打开内置 Harness 运行时失败：{error}"))?;
    let bytes_read = Arc::new(AtomicU64::new(0));
    let reader = ProgressReader {
        inner: file,
        bytes_read: Arc::clone(&bytes_read),
    };
    let mut archive = Archive::new(GzDecoder::new(reader));
    let entries = archive
        .entries()
        .map_err(|error| format!("读取内置 Harness 运行时目录失败：{error}"))?;
    let mut entry_count = 0_u64;
    let mut previous_percent = u8::MAX;

    update_extraction_progress(state, 0, 0);
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("读取 Harness 运行时条目失败：{error}"))?;
        let unpacked = entry
            .unpack_in(destination)
            .map_err(|error| format!("解压内置 Harness 运行时失败：{error}"))?;
        if !unpacked {
            return Err("内置 Harness 运行时包含越界路径".to_string());
        }
        entry_count += 1;

        let percent = extraction_percent(bytes_read.load(Ordering::Relaxed), archive_size);
        if percent != previous_percent {
            previous_percent = percent;
            update_extraction_progress(state, percent, entry_count);
        }
    }
    update_extraction_progress(state, 100, entry_count);
    Ok(())
}

fn extraction_percent(bytes_read: u64, archive_size: u64) -> u8 {
    if archive_size == 0 {
        return 0;
    }
    ((bytes_read.saturating_mul(100) / archive_size).min(99)) as u8
}

fn update_extraction_progress(state: &Arc<Mutex<HarnessProcess>>, percent: u8, entry_count: u64) {
    const START: u16 = 12;
    const END: u16 = 68;
    let percent = percent.min(100);
    let overall = START + ((END - START) * u16::from(percent) / 100);
    let detail = if entry_count == 0 {
        "首次启动：正在展开 Harness 运行时… 0%".to_string()
    } else {
        format!("首次启动：正在展开 Harness 运行时… {percent}% · 已处理 {entry_count} 个项目")
    };
    update_launch(state, LaunchStage::ExtractingRuntime, overall as u8, detail);
}

fn marker_matches(marker: &Path, archive: &Path) -> bool {
    let Ok(expected) = archive_stamp(archive) else {
        return false;
    };
    fs::read_to_string(marker).is_ok_and(|actual| actual == expected)
}

fn archive_stamp(archive: &Path) -> Result<String, String> {
    let metadata = archive
        .metadata()
        .map_err(|error| format!("读取 Harness 运行时信息失败：{error}"))?;
    let modified = metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok(format!("{}:{modified}", metadata.len()))
}

fn is_source_root(path: &Path) -> bool {
    path.join("apps").join("cli").join("package.json").is_file()
        && path.join("docs").join("architecture.md").is_file()
        && path
            .join("apps")
            .join("cli")
            .join("lib")
            .join("bin.js")
            .is_file()
        && path
            .join("apps")
            .join("web")
            .join("dist")
            .join("index.html")
            .is_file()
}

fn is_installed_root(path: &Path) -> bool {
    path.join("package.json").is_file()
        && path.join("lib").join("bin.js").is_file()
        && path
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh-web-frontend")
            .join("dist")
            .join("index.html")
            .is_file()
}

fn parse_ready_url(line: &str) -> Option<Url> {
    let rest = line.strip_prefix(READY_PREFIX)?;
    let raw = rest.split_whitespace().next()?;
    let url = Url::parse(raw).ok()?;
    (url.scheme() == "http" && url.host_str() == Some("127.0.0.1")).then_some(url)
}

fn collect_stderr(mut stderr: impl Read, buffer: Arc<Mutex<String>>) {
    let mut text = String::new();
    if stderr.read_to_string(&mut text).is_ok() {
        const LIMIT: usize = 16 * 1024;
        if text.len() > LIMIT {
            text = text[text.len() - LIMIT..].to_string();
        }
        *lock(&buffer) = text;
    }
}

fn mark_cold_start(state: &Arc<Mutex<HarnessProcess>>) {
    lock(state).snapshot.cold_start = true;
}

fn update_launch(
    state: &Arc<Mutex<HarnessProcess>>,
    stage: LaunchStage,
    progress: u8,
    detail: String,
) {
    let mut process = lock(state);
    process.snapshot.phase = LaunchPhase::Starting;
    process.snapshot.stage = stage;
    process.snapshot.progress = progress.min(99);
    process.snapshot.detail = detail;
    process.snapshot.url = None;
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(windows)]
fn suppress_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(test)]
mod tests {
    use super::{extraction_percent, parse_ready_url};

    #[test]
    fn parses_loopback_readiness_line() {
        let url = parse_ready_url("dsh web: http://127.0.0.1:41823").expect("ready URL");
        assert_eq!(url.as_str(), "http://127.0.0.1:41823/");
    }

    #[test]
    fn rejects_non_loopback_readiness_line() {
        assert!(parse_ready_url("dsh web: http://example.com:3080").is_none());
        assert!(parse_ready_url("noise").is_none());
    }

    #[test]
    fn maps_archive_reads_to_bounded_extraction_progress() {
        assert_eq!(extraction_percent(0, 100), 0);
        assert_eq!(extraction_percent(42, 100), 42);
        assert_eq!(extraction_percent(100, 100), 99);
        assert_eq!(extraction_percent(200, 100), 99);
        assert_eq!(extraction_percent(1, 0), 0);
    }
}
