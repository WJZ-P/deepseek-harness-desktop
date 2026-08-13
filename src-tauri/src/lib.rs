mod harness;

use std::sync::{Arc, Mutex};

use harness::{HarnessProcess, LaunchSnapshot};
use tauri::{Manager, RunEvent, WindowEvent};

type SharedHarness = Arc<Mutex<HarnessProcess>>;

#[tauri::command]
fn launch_status(state: tauri::State<'_, SharedHarness>) -> LaunchSnapshot {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .snapshot()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let harness = Arc::new(Mutex::new(HarnessProcess::new()));
    let setup_harness = Arc::clone(&harness);

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(true)
                .build(),
        )
        .manage(Arc::clone(&harness))
        .invoke_handler(tauri::generate_handler![launch_status])
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window was not created".to_string())?;
            HarnessProcess::spawn(setup_harness, window);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DeepSeek Harness Desktop");

    app.run(move |_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            harness
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .stop();
        }
        if let RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } = event
        {
            if label == "main" {
                harness
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .stop();
            }
        }
    });
}
