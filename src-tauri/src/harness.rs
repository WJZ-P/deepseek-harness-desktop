use std::{
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
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
    detail: String,
    url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum LaunchPhase {
    Starting,
    Ready,
    Failed,
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
                detail: "正在定位 DeepSeek Harness…".into(),
                url: None,
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
                process.snapshot = LaunchSnapshot {
                    phase: LaunchPhase::Failed,
                    detail: error,
                    url: None,
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
    let runtime = resolve_runtime(window)?;

    update_starting(
        state,
        format!("正在从 {} 启动 Web profile…", runtime.root.display()),
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
                detail: "DeepSeek Harness 已就绪".into(),
                url: Some(allowed_origin),
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

fn resolve_runtime(window: &WebviewWindow) -> Result<RuntimePaths, String> {
    if let Some(explicit) = env::var_os("DEEPSEEK_HARNESS_ROOT") {
        return source_runtime(PathBuf::from(explicit));
    }

    // `tauri dev` must use the freshly prepared checkout. A stale resource
    // archive can remain under target/debug after an earlier release build.
    if cfg!(debug_assertions) {
        return checkout_runtime();
    }

    if let Ok(resource_dir) = window.app_handle().path().resource_dir() {
        let archive = resource_dir.join("runtime").join("harness.tar.gz");
        let node = resource_dir.join("runtime").join(NODE_BINARY_NAME);
        if has_content(&archive) && has_content(&node) {
            return installed_runtime(window, &archive, node);
        }
    }

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
        if cache_root.exists() {
            fs::remove_dir_all(&cache_root)
                .map_err(|error| format!("清理旧 Harness 运行时失败：{error}"))?;
        }
        fs::create_dir_all(&cache_root)
            .map_err(|error| format!("创建 Harness 运行时目录失败：{error}"))?;
        let file =
            File::open(archive).map_err(|error| format!("打开内置 Harness 运行时失败：{error}"))?;
        Archive::new(GzDecoder::new(file))
            .unpack(&cache_root)
            .map_err(|error| format!("解压内置 Harness 运行时失败：{error}"))?;
        if !is_installed_root(&root) {
            return Err("内置 Harness 运行时内容不完整".to_string());
        }
        fs::write(&marker, archive_stamp(archive)?)
            .map_err(|error| format!("写入 Harness 运行时版本标记失败：{error}"))?;
    }
    Ok(RuntimePaths {
        launcher: root.join("lib").join("bin.js"),
        root,
        node,
    })
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

fn update_starting(state: &Arc<Mutex<HarnessProcess>>, detail: String) {
    lock(state).snapshot = LaunchSnapshot {
        phase: LaunchPhase::Starting,
        detail,
        url: None,
    };
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
    use super::parse_ready_url;

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
}
