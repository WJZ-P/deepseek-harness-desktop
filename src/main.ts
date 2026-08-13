import { invoke } from "@tauri-apps/api/core";

interface LaunchStatus {
  phase: "starting" | "ready" | "failed";
  detail: string;
  url: string | null;
}

const title = document.querySelector<HTMLElement>("#launch-title");
const detail = document.querySelector<HTMLElement>("#launch-detail");
const error = document.querySelector<HTMLElement>("#launch-error");
const actions = document.querySelector<HTMLElement>("#launch-actions");
const retry = document.querySelector<HTMLButtonElement>("#retry");
const copyError = document.querySelector<HTMLButtonElement>("#copy-error");

function showFailure(message: string): void {
  if (title) title.textContent = "Harness 启动失败";
  if (detail) detail.textContent = "请检查路径、构建产物和 Node.js 环境。";
  if (error) {
    error.hidden = false;
    error.textContent = message;
  }
  if (actions) actions.hidden = false;
}

async function pollLaunch(): Promise<void> {
  try {
    const status = await invoke<LaunchStatus>("launch_status");
    if (detail) detail.textContent = status.detail;
    if (status.phase === "failed") {
      showFailure(status.detail);
      return;
    }
    window.setTimeout(pollLaunch, 180);
  } catch (reason) {
    showFailure(String(reason));
  }
}

retry?.addEventListener("click", () => window.location.reload());

copyError?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(error?.textContent ?? "");
  if (copyError) copyError.textContent = "已复制";
});

void pollLaunch();
