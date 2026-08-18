use std::{
    env,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{Manager, WebviewWindow};
use url::Url;

const READY_PREFIX: &str = "dsh web: ";
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
    bundled_plugins: Vec<BundledPlugin>,
    source_checkout: bool,
}

struct BundledPlugin {
    id: &'static str,
    package_name: &'static str,
    package_root: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSnapshot {
    phase: LaunchPhase,
    stage: LaunchStage,
    progress: u8,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum LaunchStage {
    LocatingRuntime,
    CheckingRuntime,
    VerifyingRuntime,
    StartingService,
    WaitingForService,
    LoadingWorkspace,
    Failed,
}

pub struct HarnessProcess {
    child: Option<Child>,
    overlay: Option<PathBuf>,
    snapshot: LaunchSnapshot,
}

impl HarnessProcess {
    pub fn new() -> Self {
        Self {
            child: None,
            overlay: None,
            snapshot: LaunchSnapshot {
                phase: LaunchPhase::Starting,
                stage: LaunchStage::LocatingRuntime,
                progress: 3,
                detail: "正在定位内置 Harness 运行时…".into(),
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
                let progress = process.snapshot.progress;
                process.snapshot = LaunchSnapshot {
                    phase: LaunchPhase::Failed,
                    stage: LaunchStage::Failed,
                    progress,
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
        if let Some(mut child) = self.child.take() {
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

        if let Some(overlay) = self.overlay.take() {
            let _ = std::fs::remove_file(overlay);
        }
    }
}

impl Drop for HarnessProcess {
    fn drop(&mut self) {
        self.stop_child();
    }
}

fn start_harness(state: &Arc<Mutex<HarnessProcess>>, window: &WebviewWindow) -> Result<(), String> {
    let runtime = resolve_runtime(state, window)?;
    if runtime.source_checkout {
        ensure_source_plugin_fallbacks(&runtime)?;
    }
    let overlay = create_desktop_overlay(&runtime.bundled_plugins)?;
    lock(state).overlay = Some(overlay.clone());

    update_launch(
        state,
        LaunchStage::StartingService,
        76,
        "正在启动 Harness 本地服务…".into(),
    );
    let mut command = Command::new(&runtime.node);
    command
        .arg(&runtime.launcher)
        .args(["web", "--patch"])
        .arg(&overlay)
        .args(["--host", "127.0.0.1", "--port", "0"])
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

    // `tauri dev` must use the freshly prepared checkout instead of any
    // release resources left under target/debug by an earlier build.
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
            "正在检查随应用提供的 Harness 运行时…".into(),
        );
        let root = resource_dir.join("runtime").join("harness");
        let node = resource_dir.join("runtime").join(NODE_BINARY_NAME);
        if is_installed_root(&root) && has_content(&node) {
            update_launch(
                state,
                LaunchStage::VerifyingRuntime,
                58,
                "已找到完整的便携运行时，正在校验启动入口…".into(),
            );
            return bundled_runtime(root, node);
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
    let repository_root = root
        .parent()
        .ok_or_else(|| "桌面项目插件目录位置缺失".to_string())?;
    let desktop_plugins_root = env::var_os("DSH_DESKTOP_PLUGINS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| repository_root.join("desktop-plugins"));
    let shared_plugins_root = env::var_os("DSH_PLUGINS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| repository_root.join("plugins"));
    let bundled_plugins = checked_plugins(&root, &desktop_plugins_root, &shared_plugins_root)?;
    Ok(RuntimePaths {
        launcher: root.join("apps").join("cli").join("lib").join("bin.js"),
        root,
        node,
        bundled_plugins,
        source_checkout: true,
    })
}

fn bundled_runtime(path: PathBuf, node: PathBuf) -> Result<RuntimePaths, String> {
    if !is_installed_root(&path) {
        return Err(format!(
            "随应用提供的 Harness 运行时不完整：{}",
            path.display()
        ));
    }
    let root = dunce::canonicalize(&path)
        .map_err(|error| format!("解析便携 Harness 运行时路径失败：{error}"))?;
    let bundled_plugins =
        checked_plugins(&root, &root.join("desktop-plugins"), &root.join("plugins"))?;
    Ok(RuntimePaths {
        launcher: root.join("lib").join("bin.js"),
        root,
        node,
        bundled_plugins,
        source_checkout: false,
    })
}

fn checked_plugin(path: PathBuf) -> Result<PathBuf, String> {
    if !has_content(&path) {
        return Err(format!(
            "插件构建产物不完整：{}\n请先运行 pnpm run plugin:build。",
            path.display()
        ));
    }
    dunce::canonicalize(&path).map_err(|error| format!("解析插件路径失败：{error}"))
}

fn checked_plugins(
    module_root: &Path,
    desktop_root: &Path,
    shared_root: &Path,
) -> Result<Vec<BundledPlugin>, String> {
    [
        (
            "desktop-bridge",
            "@deepseek-ai/dsh-desktop-bridge",
            desktop_root.join("desktop-bridge"),
        ),
        (
            "dsh-attachments",
            "dsh-attachments",
            shared_root.join("dsh-attachments"),
        ),
        (
            "dsh-model-capabilities",
            "dsh-model-capabilities",
            shared_root.join("dsh-model-capabilities"),
        ),
    ]
    .into_iter()
    .map(|(id, package_name, directory)| {
        checked_plugin(directory.join("lib").join("index.mjs"))?;
        let manifest = package_name
            .split('/')
            .fold(module_root.join("node_modules"), |path, segment| {
                path.join(segment)
            })
            .join("package.json");
        if !has_content(&manifest) {
            return Err(format!(
                "插件包解析入口不完整：{}\n请先运行 pnpm run plugin:build。",
                manifest.display()
            ));
        }
        let package_root = manifest
            .parent()
            .ok_or_else(|| format!("插件包解析入口缺少父目录：{}", manifest.display()))?
            .to_path_buf();
        Ok(BundledPlugin {
            id,
            package_name,
            package_root,
        })
    })
    .collect()
}

fn ensure_source_plugin_fallbacks(runtime: &RuntimePaths) -> Result<(), String> {
    let links = runtime
        .bundled_plugins
        .iter()
        .map(|plugin| {
            (
                plugin.package_name,
                plugin.package_root.to_string_lossy().into_owned(),
            )
        })
        .collect::<Vec<_>>();
    let encoded = serde_json::to_string(&links)
        .map_err(|error| format!("序列化桌面插件解析链接失败：{error}"))?;
    let script = r#"
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const {
  lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync,
} = require('node:fs');

const configured = (process.env.DSH_HOME ?? '').trim();
const expanded = configured === '~'
  ? homedir()
  : configured.startsWith('~/') || configured.startsWith('~\\')
    ? join(homedir(), configured.slice(2))
    : configured;
const home = resolve(expanded || join(homedir(), '.dsh'));
const modules = join(home, 'profiles', 'node_modules');

for (const [name, target] of JSON.parse(process.argv[1])) {
  const link = join(modules, ...name.split('/'));
  mkdirSync(dirname(link), { recursive: true });
  let current;
  try {
    current = lstatSync(link);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current !== undefined) {
    if (!current.isSymbolicLink()) {
      throw new Error(`${link} exists and is not a managed plugin link`);
    }
    if (resolve(dirname(link), readlinkSync(link)) === resolve(target)) continue;
    unlinkSync(link);
  }
  symlinkSync(resolve(target), link, process.platform === 'win32' ? 'junction' : 'dir');
}
"#;
    let mut command = Command::new(&runtime.node);
    command
        .arg("-e")
        .arg(script)
        .arg(&encoded)
        .current_dir(&runtime.root)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    suppress_console_window(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("建立桌面插件解析链接失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "建立桌面插件解析链接失败（退出码 {}）：{}",
        output.status.code().unwrap_or(-1),
        if stderr.is_empty() {
            "Node 未返回错误详情"
        } else {
            &stderr
        }
    ))
}

fn desktop_overlay_content(plugins: &[BundledPlugin]) -> Result<String, String> {
    let mut output = String::from(
        "# Generated by DeepSeek Harness Desktop; removed when the app exits.\n- insert:\n",
    );
    for plugin in plugins {
        // A single-quoted YAML scalar treats every character literally;
        // doubling a quote is the only escape it admits.
        let module_name = plugin.package_name.replace('\'', "''");
        output.push_str(&format!(
            "    - id: {}\n      name: '{module_name}'\n",
            plugin.id
        ));
    }
    Ok(output)
}

fn create_desktop_overlay(plugins: &[BundledPlugin]) -> Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("读取系统时间失败：{error}"))?
        .as_nanos();
    let path = env::temp_dir().join(format!(
        "deepseek-harness-desktop-{}-{nonce}.patch.yml",
        std::process::id()
    ));
    std::fs::write(&path, desktop_overlay_content(plugins)?)
        .map_err(|error| format!("写入桌面插件启动覆盖失败：{error}"))?;
    Ok(path)
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
    use std::path::PathBuf;

    use super::{BundledPlugin, desktop_overlay_content, parse_ready_url};

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
    fn desktop_overlay_mounts_each_plugin_by_package_name() {
        let plugins = [
            BundledPlugin {
                id: "desktop-bridge",
                package_name: "@deepseek-ai/dsh-desktop-bridge",
                package_root: PathBuf::from("bridge"),
            },
            BundledPlugin {
                id: "dsh-attachments",
                package_name: "dsh-attachments",
                package_root: PathBuf::from("attachments"),
            },
            BundledPlugin {
                id: "dsh-model-capabilities",
                package_name: "dsh-model-capabilities",
                package_root: PathBuf::from("model-capabilities"),
            },
        ];
        let overlay = desktop_overlay_content(&plugins).expect("overlay");
        assert!(
            overlay.contains("id: desktop-bridge\n      name: '@deepseek-ai/dsh-desktop-bridge'")
        );
        assert!(overlay.contains("id: dsh-attachments\n      name: 'dsh-attachments'"));
        assert!(
            overlay.contains("id: dsh-model-capabilities\n      name: 'dsh-model-capabilities'")
        );
        assert!(!overlay.contains("file://"));
    }
}
