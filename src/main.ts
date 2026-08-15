import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  type Theme,
  type Window as TauriWindow,
} from "@tauri-apps/api/window";

type LaunchStage =
  | "locatingRuntime"
  | "checkingRuntime"
  | "extractingRuntime"
  | "verifyingRuntime"
  | "startingService"
  | "waitingForService"
  | "loadingWorkspace"
  | "failed";

interface LaunchStatus {
  phase: "starting" | "ready" | "failed";
  stage: LaunchStage;
  progress: number;
  detail: string;
  url: string | null;
  coldStart: boolean;
}

interface StagePresentation {
  step: number;
  kicker: string;
  title: string;
  progressLabel: string;
}

interface HarnessThemeMessage {
  type: "deepseek-harness:theme";
  colorScheme: "light" | "dark";
}

const HARNESS_THEME_MESSAGE = "deepseek-harness:theme";
const HARNESS_THEME_REQUEST = "deepseek-harness:theme-request";

const title = document.querySelector<HTMLElement>("#launch-title");
const kicker = document.querySelector<HTMLElement>("#launch-kicker");
const detail = document.querySelector<HTMLElement>("#launch-detail");
const coldStartNote = document.querySelector<HTMLElement>("#cold-start-note");
const progressLabel = document.querySelector<HTMLElement>("#progress-label");
const progressValue = document.querySelector<HTMLElement>("#progress-value");
const progressTrack = document.querySelector<HTMLElement>("#progress-track");
const progressFill = document.querySelector<HTMLElement>("#progress-fill");
const launchSteps = Array.from(
  document.querySelectorAll<HTMLElement>("[data-launch-step]"),
);
const error = document.querySelector<HTMLElement>("#launch-error");
const failure = document.querySelector<HTMLElement>("#launch-failure");
const stage = document.querySelector<HTMLElement>(".launch-stage");
const launchShell = document.querySelector<HTMLElement>(".launch-shell");
const harnessSurface = document.querySelector<HTMLElement>("#harness-surface");
const harnessFrame = document.querySelector<HTMLIFrameElement>("#harness-frame");
const retry = document.querySelector<HTMLButtonElement>("#retry");
const copyError = document.querySelector<HTMLButtonElement>("#copy-error");
const minimize = document.querySelector<HTMLButtonElement>("#window-minimize");
const maximize = document.querySelector<HTMLButtonElement>("#window-maximize");
const close = document.querySelector<HTMLButtonElement>("#window-close");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

let mountedHarnessUrl: string | null = null;
let mountedHarnessOrigin: string | null = null;
let harnessTheme: Theme | null = null;
let renderedProgress = 3;

const STAGE_PRESENTATION: Record<LaunchStage, StagePresentation> = {
  locatingRuntime: {
    step: 0,
    kicker: "步骤 1/3 · 准备运行时",
    title: "正在准备 Harness",
    progressLabel: "定位内置运行时",
  },
  checkingRuntime: {
    step: 0,
    kicker: "步骤 1/3 · 准备运行时",
    title: "正在检查运行环境",
    progressLabel: "检查运行时缓存",
  },
  extractingRuntime: {
    step: 0,
    kicker: "步骤 1/3 · 首次启动准备",
    title: "正在完成首次启动",
    progressLabel: "展开 Harness 运行时",
  },
  verifyingRuntime: {
    step: 0,
    kicker: "步骤 1/3 · 准备运行时",
    title: "正在验证 Harness",
    progressLabel: "验证运行时完整性",
  },
  startingService: {
    step: 1,
    kicker: "步骤 2/3 · 启动本地服务",
    title: "正在启动本地服务",
    progressLabel: "创建 Harness 进程",
  },
  waitingForService: {
    step: 1,
    kicker: "步骤 2/3 · 启动本地服务",
    title: "正在等待服务就绪",
    progressLabel: "等待随机端口响应",
  },
  loadingWorkspace: {
    step: 2,
    kicker: "步骤 3/3 · 载入工作区",
    title: "正在载入工作区",
    progressLabel: "连接 Harness 界面",
  },
  failed: {
    step: 0,
    kicker: "启动未完成",
    title: "Harness 启动失败",
    progressLabel: "启动中断",
  },
};

function resolveWindow(): TauriWindow | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

const appWindow = resolveWindow();

function renderTheme(theme: Theme | null): void {
  const dark = theme === "dark" || (theme === null && systemTheme.matches);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.body.toggleAttribute("data-ds-dark-theme", dark);
  document.body.setAttribute("data-ds-theme-ready", "");
}

function applyWindowTheme(theme: Theme | null): void {
  if (harnessTheme === null) renderTheme(theme);
}

function applyHarnessTheme(theme: Theme): void {
  harnessTheme = theme;
  renderTheme(theme);
}

function bindSystemTheme(): void {
  applyWindowTheme(systemTheme.matches ? "dark" : "light");
  systemTheme.addEventListener("change", ({ matches }) => {
    applyWindowTheme(matches ? "dark" : "light");
  });
}

async function bindWindowTheme(): Promise<void> {
  if (!appWindow) {
    bindSystemTheme();
    return;
  }

  try {
    applyWindowTheme(await appWindow.theme());
    await appWindow.onThemeChanged(({ payload }) => applyWindowTheme(payload));
  } catch {
    bindSystemTheme();
  }
}

function isHarnessThemeMessage(value: unknown): value is HarnessThemeMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<HarnessThemeMessage>;
  return message.type === HARNESS_THEME_MESSAGE
    && (message.colorScheme === "light" || message.colorScheme === "dark");
}

window.addEventListener("message", (event) => {
  if (
    mountedHarnessOrigin === null
    || event.origin !== mountedHarnessOrigin
    || event.source !== harnessFrame?.contentWindow
    || !isHarnessThemeMessage(event.data)
  ) return;

  applyHarnessTheme(event.data.colorScheme);
});

async function syncMaximizedState(): Promise<void> {
  if (!appWindow) return;
  const maximized = await appWindow.isMaximized();
  document.body.classList.toggle("is-maximized", maximized);
  if (maximize) maximize.setAttribute("aria-label", maximized ? "还原" : "最大化");
}

async function runWindowAction(action: (window: TauriWindow) => Promise<void>): Promise<void> {
  if (!appWindow) return;
  try {
    await action(appWindow);
  } catch (reason) {
    console.error("Desktop window action failed", reason);
  }
}

function setProgress(value: number, allowDecrease = false): void {
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  renderedProgress = allowDecrease ? bounded : Math.max(renderedProgress, bounded);
  if (progressValue) progressValue.textContent = `${renderedProgress}%`;
  if (progressTrack) progressTrack.setAttribute("aria-valuenow", String(renderedProgress));
  if (progressFill) {
    progressFill.style.transform = `scaleX(${renderedProgress / 100})`;
  }
}

function renderSteps(activeStep: number, complete = false): void {
  launchSteps.forEach((element, index) => {
    element.classList.toggle("is-active", !complete && index === activeStep);
    element.classList.toggle("is-complete", complete || index < activeStep);
  });
}

function renderLaunchStatus(status: LaunchStatus): void {
  const presentation = STAGE_PRESENTATION[status.stage] ?? STAGE_PRESENTATION.locatingRuntime;
  document.body.dataset.launchStage = status.stage;
  if (kicker) kicker.textContent = presentation.kicker;
  if (title) title.textContent = presentation.title;
  if (detail) detail.textContent = status.detail;
  if (progressLabel) progressLabel.textContent = presentation.progressLabel;
  setProgress(status.progress);
  renderSteps(presentation.step);

  if (coldStartNote) {
    coldStartNote.hidden = !status.coldStart;
    coldStartNote.textContent = status.stage === "extractingRuntime"
      ? "首次启动正在展开本地运行时，通常需要十几秒；请保持窗口开启，完成后再次启动会明显更快。"
      : "首次运行时已经准备完成，接下来的启动步骤通常只需要几秒。";
  }
}

function showFailure(message: string): void {
  if (kicker) kicker.textContent = "启动未完成";
  if (title) title.textContent = "Harness 启动失败";
  if (detail) detail.textContent = "请检查路径、构建产物和 Node.js 环境。";
  if (progressLabel) progressLabel.textContent = "启动中断";
  if (coldStartNote) coldStartNote.hidden = true;
  if (error) error.textContent = message;
  if (failure) failure.hidden = false;
  if (stage) stage.setAttribute("aria-busy", "false");
  document.body.classList.add("is-failed");
}

function mountHarness(rawUrl: string): void {
  if (!harnessFrame || !harnessSurface || mountedHarnessUrl === rawUrl) return;

  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    showFailure(`Harness 返回了无效的本地地址：${rawUrl}`);
    return;
  }

  mountedHarnessUrl = rawUrl;
  mountedHarnessOrigin = url.origin;
  harnessSurface.hidden = false;
  harnessFrame.dataset.loading = "true";
  harnessFrame.src = url.href;
}

harnessFrame?.addEventListener("load", () => {
  if (harnessFrame.dataset.loading !== "true") return;
  delete harnessFrame.dataset.loading;
  if (kicker) kicker.textContent = "步骤 3/3 · 工作区已就绪";
  if (title) title.textContent = "DeepSeek Harness 已就绪";
  if (detail) detail.textContent = "正在显示工作区…";
  if (progressLabel) progressLabel.textContent = "启动完成";
  setProgress(100);
  renderSteps(2, true);
  if (stage) stage.setAttribute("aria-busy", "false");
  if (launchShell) launchShell.setAttribute("aria-hidden", "true");
  document.body.classList.add("is-harness-ready");
  if (mountedHarnessOrigin !== null) {
    harnessFrame.contentWindow?.postMessage(
      { type: HARNESS_THEME_REQUEST },
      mountedHarnessOrigin,
    );
  }
});

async function pollLaunch(): Promise<void> {
  try {
    const status = await invoke<LaunchStatus>("launch_status");
    renderLaunchStatus(status);
    if (status.phase === "failed") {
      showFailure(status.detail);
      return;
    }
    if (status.phase === "ready") {
      if (status.url) mountHarness(status.url);
      else showFailure("Harness 已就绪，但没有返回本地页面地址。");
      return;
    }
    window.setTimeout(pollLaunch, 180);
  } catch (reason) {
    showFailure(String(reason));
  }
}

minimize?.addEventListener("click", () => {
  void runWindowAction((window) => window.minimize());
});

maximize?.addEventListener("click", () => {
  void runWindowAction(async (window) => {
    await window.toggleMaximize();
    await syncMaximizedState();
  });
});

close?.addEventListener("click", () => {
  void runWindowAction((window) => window.close());
});

retry?.addEventListener("click", () => window.location.reload());

copyError?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(error?.textContent ?? "");
  if (copyError) copyError.textContent = "已复制";
});

if (appWindow) {
  void syncMaximizedState();
  void appWindow.onResized(() => {
    void syncMaximizedState();
  });
}

void bindWindowTheme();
void pollLaunch();
