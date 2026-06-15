use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use krill_desktop_core::{dev as kdev, fs as kfs, state as kstate, updater::BuilderExt};

const SLUG: &str = "krill-pixel-editor";

#[derive(Debug, Serialize)]
struct PngRead {
    path: String,
    bytes: Vec<u8>,
}

// The .png IS the document — Rust is a plain byte courier. The webview canvas
// does the PNG encode/decode; read_png hands over the raw file bytes (decoded
// into a grid there) and write_png persists the bytes the canvas produced.
#[tauri::command]
fn read_png(path: String) -> Result<PngRead, String> {
    let p = Path::new(&path);
    let bytes = kfs::read_bytes(p)?;
    Ok(PngRead {
        path: kfs::absolute_path(p),
        bytes,
    })
}

#[tauri::command]
fn write_png(path: String, bytes: Vec<u8>) -> Result<String, String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| kfs::format_io_err(&path, e))?;
        }
    }
    fs::write(p, bytes).map_err(|e| kfs::format_io_err(&path, e))?;
    Ok(kfs::absolute_path(p))
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    window: Option<kstate::WindowGeometry>,
    recent: Option<Vec<String>>,
    /// Recently used colors (hex strings) — feeds the rail's recent strip,
    /// cross-document.
    recent_colors: Option<Vec<String>>,
}

#[tauri::command]
fn load_state() -> Option<AppState> {
    kstate::load(SLUG, "state.json")
}

#[tauri::command]
fn save_state(state: AppState) -> Result<(), String> {
    kstate::save(SLUG, "state.json", &state)
}

#[tauri::command]
fn dev_test_file() -> Option<String> {
    kdev::test_file(env!("CARGO_MANIFEST_DIR"), &["test.png"])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .with_updater()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_png,
            write_png,
            load_state,
            save_state,
            dev_test_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
