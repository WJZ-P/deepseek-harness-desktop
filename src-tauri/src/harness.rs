use std::{
    env,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use serde::Serialize;
use tauri::WebviewWindow;
use url::Url;

const READY_PREFIX: &str = "dsh web: ";

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
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
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
    let root = resolve_harness_root()?;
    let launcher = root.join("apps").join("cli").join("lib").join("bin.js");
    let frontend = root
        .join("apps")
        .join("web")
        .join("dist")
        .join("index.html");
    if !launcher.is_file() || !frontend.is_file() {
        return Err(format!(
            "Harness 构建产物不完整。请先在 {} 运行 pnpm run build。",
            root.display()
        ));
    }

    update_starting(
        state,
        format!("正在从 {} 启动 Web profile…", root.display()),
    );
    let node = env::var_os("DSH_DESKTOP_NODE").unwrap_or_else(|| "node".into());
    let mut command = Command::new(node);
    command
        .arg(&launcher)
        .args(["web", "--host", "127.0.0.1", "--port", "0"])
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let mut child = command.spawn().map_err(|error| {
        format!("启动 Node.js 失败：{error}\n可通过 DSH_DESKTOP_NODE 指定 Node 可执行文件。")
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
    thread::spawn(move || collect_stderr(stderr, stderr_for_thread));

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
            window
                .navigate(url.clone())
                .map_err(|error| format!("打开 Harness 页面失败：{error}"))?;
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

    let stderr = lock(&stderr_buffer).trim().to_string();
    let suffix = if stderr.is_empty() {
        String::new()
    } else {
        format!("\n\n{stderr}")
    };
    Err(format!("Harness 在就绪前退出，未输出本地 URL。{suffix}"))
}

fn resolve_harness_root() -> Result<PathBuf, String> {
    if let Some(explicit) = env::var_os("DEEPSEEK_HARNESS_ROOT") {
        return validate_root(PathBuf::from(explicit));
    }

    let desktop_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "桌面项目路径缺少父目录".to_string())?;
    let embedded = desktop_root.join("harness");
    if is_harness_root(&embedded) {
        return validate_root(embedded);
    }

    Err(format!(
        "仓库内缺少随项目分发的 Harness 源码：{}\n请重新获取完整的 desktop 仓库。",
        embedded.display()
    ))
}

fn validate_root(path: PathBuf) -> Result<PathBuf, String> {
    if is_harness_root(&path) {
        path.canonicalize()
            .map_err(|error| format!("解析 Harness 路径失败：{error}"))
    } else {
        Err(format!(
            "DEEPSEEK_HARNESS_ROOT 不是 Harness 仓库：{}",
            path.display()
        ))
    }
}

fn is_harness_root(path: &Path) -> bool {
    path.join("apps").join("cli").join("package.json").is_file()
        && path.join("docs").join("architecture.md").is_file()
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
