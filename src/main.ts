import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  type Theme,
  type Window as TauriWindow,
} from "@tauri-apps/api/window";

interface LaunchStatus {
  phase: "starting" | "ready" | "failed";
  detail: string;
  url: string | null;
}

const title = document.querySelector<HTMLElement>("#launch-title");
const detail = document.querySelector<HTMLElement>("#launch-detail");
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

function resolveWindow(): TauriWindow | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

const appWindow = resolveWindow();

function applyTheme(theme: Theme | null): void {
  const dark = theme === "dark" || (theme === null && systemTheme.matches);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.body.toggleAttribute("data-ds-dark-theme", dark);
  document.body.setAttribute("data-ds-theme-ready", "");
}

function bindSystemTheme(): void {
  applyTheme(systemTheme.matches ? "dark" : "light");
  systemTheme.addEventListener("change", ({ matches }) => {
    applyTheme(matches ? "dark" : "light");
  });
}

async function bindWindowTheme(): Promise<void> {
  if (!appWindow) {
    bindSystemTheme();
    return;
  }

  try {
    applyTheme(await appWindow.theme());
    await appWindow.onThemeChanged(({ payload }) => applyTheme(payload));
  } catch {
    bindSystemTheme();
  }
}

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

function showFailure(message: string): void {
  if (title) title.textContent = "Harness 启动失败";
  if (detail) detail.textContent = "请检查路径、构建产物和 Node.js 环境。";
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
  harnessSurface.hidden = false;
  harnessFrame.dataset.loading = "true";
  harnessFrame.src = url.href;
}

harnessFrame?.addEventListener("load", () => {
  if (harnessFrame.dataset.loading !== "true") return;
  delete harnessFrame.dataset.loading;
  if (stage) stage.setAttribute("aria-busy", "false");
  if (launchShell) launchShell.setAttribute("aria-hidden", "true");
  document.body.classList.add("is-harness-ready");
});

async function pollLaunch(): Promise<void> {
  try {
    const status = await invoke<LaunchStatus>("launch_status");
    if (detail) detail.textContent = status.detail;
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
