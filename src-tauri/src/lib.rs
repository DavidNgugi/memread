use serde::Serialize;
use std::{
    fs, io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
    time::UNIX_EPOCH,
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageEntry {
    name: String,
    path: String,
    size: Option<u64>,
    partial: bool,
    kind: String,
    category: String,
    modified: u64,
    deletable: bool,
    protection_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskSummary {
    total: u64,
    available: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    scan_id: u64,
    current: String,
    completed: usize,
    total: usize,
    completed_item: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SizedEntry {
    scan_id: u64,
    path: String,
    size: u64,
    partial: bool,
}

struct SizeMeasurement {
    size: u64,
    partial: bool,
}

struct ActiveScan {
    id: u64,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct ScanManager {
    active: Mutex<Option<ActiveScan>>,
}

impl ScanManager {
    fn begin(&self, id: u64) -> Result<Arc<AtomicBool>, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "The scan manager became unavailable.".to_string())?;
        if let Some(previous) = active.as_ref() {
            previous.cancelled.store(true, Ordering::Relaxed);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(ActiveScan {
            id,
            cancelled: cancelled.clone(),
        });
        Ok(cancelled)
    }

    fn finish(&self, id: u64) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "The scan manager became unavailable.".to_string())?;
        if active.as_ref().is_some_and(|scan| scan.id == id) {
            *active = None;
        }
        Ok(())
    }
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Could not find the current home directory.".into())
}

// Sequoia/Tahoe protects these containers independently of Full Disk Access.
// Traversing them causes a system prompt per app, so automatic scans omit them.
fn is_other_app_container(path: &Path, home: &Path) -> bool {
    let library = home.join("Library");
    ["Containers", "Group Containers"]
        .iter()
        .any(|name| path == library.join(name))
}

fn bytes_in(path: &Path, home: &Path, cancelled: &AtomicBool) -> Option<SizeMeasurement> {
    if cancelled.load(Ordering::Relaxed) {
        return None;
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            eprintln!("MemRead could not inspect {}: {error}", path.display());
            return Some(SizeMeasurement {
                size: 0,
                partial: true,
            });
        }
    };
    if metadata.file_type().is_symlink() {
        return Some(SizeMeasurement {
            size: 0,
            partial: false,
        });
    }
    if metadata.is_file() {
        return Some(SizeMeasurement {
            size: metadata.blocks().saturating_mul(512),
            partial: false,
        });
    }
    if !metadata.is_dir() {
        return Some(SizeMeasurement {
            size: 0,
            partial: false,
        });
    }
    let mut measurement = SizeMeasurement {
        size: 0,
        partial: false,
    };
    let mut stack = vec![path.to_path_buf()];
    while let Some(directory) = stack.pop() {
        if cancelled.load(Ordering::Relaxed) {
            return None;
        }
        let children = match fs::read_dir(&directory) {
            Ok(children) => children,
            Err(error) => {
                eprintln!("MemRead could not read {}: {error}", directory.display());
                measurement.partial = true;
                continue;
            }
        };
        for child in children {
            if cancelled.load(Ordering::Relaxed) {
                return None;
            }
            let child = match child {
                Ok(child) => child,
                Err(error) => {
                    eprintln!(
                        "MemRead could not read an item in {}: {error}",
                        directory.display()
                    );
                    measurement.partial = true;
                    continue;
                }
            };
            let child_path = child.path();
            if is_other_app_container(&child_path, home) {
                measurement.partial = true;
                continue;
            }
            let child_metadata = match fs::symlink_metadata(&child_path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    eprintln!(
                        "MemRead could not inspect {}: {error}",
                        child_path.display()
                    );
                    measurement.partial = true;
                    continue;
                }
            };
            if child_metadata.file_type().is_symlink() {
                continue;
            }
            if child_metadata.is_dir() {
                stack.push(child_path);
            } else if child_metadata.is_file() {
                measurement.size = measurement
                    .size
                    .saturating_add(child_metadata.blocks().saturating_mul(512));
            }
        }
    }
    Some(measurement)
}

fn emit_progress(app: &tauri::AppHandle, progress: ScanProgress) {
    if let Err(error) = app.emit("scan-progress", progress) {
        eprintln!("MemRead could not send scan progress: {error}");
    }
}

fn emit_sized_entry(app: &tauri::AppHandle, entry: SizedEntry) {
    if let Err(error) = app.emit("entry-sized", entry) {
        eprintln!("MemRead could not send a calculated size: {error}");
    }
}

fn category_for(path: &Path) -> String {
    match path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
    {
        "Downloads" => "Downloads",
        "Documents" | "Desktop" | "Movies" | "Music" | "Pictures" => "Personal",
        "Library" => "App data",
        ".npm" | ".gradle" | ".android" | ".cargo" | ".rustup" | ".cache" | ".codex"
        | ".cursor" => "Developer",
        _ => "Other",
    }
    .into()
}

fn protection_for(path: &Path, home: &Path) -> Option<String> {
    if path == home.join("Library") {
        return Some("App data is protected to prevent breaking installed apps.".into());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if matches!(
        name,
        ".ssh" | ".gnupg" | ".aws" | ".config" | ".zshrc" | ".zprofile"
    ) {
        return Some("Credentials and configuration are protected.".into());
    }
    if matches!(name, ".android" | ".gradle" | ".npm" | ".cargo" | ".rustup") {
        return Some("Developer tooling is protected; clear it from its own tool instead.".into());
    }
    None
}

fn scan_root(path: Option<String>) -> Result<(PathBuf, PathBuf), String> {
    let home = home_dir()?;
    let root = path
        .map(PathBuf::from)
        .unwrap_or_else(|| home.clone())
        .canonicalize()
        .map_err(|_| "That folder is not available.".to_string())?;
    if root != home && !root.starts_with(&home) {
        return Err("MemRead only scans folders inside your home directory.".into());
    }
    let library = home.join("Library");
    if ["Containers", "Group Containers"]
        .iter()
        .any(|name| root.starts_with(library.join(name)))
    {
        return Err("macOS protects data owned by other apps. MemRead leaves these containers out to avoid permission prompts.".into());
    }
    Ok((home, root))
}

#[tauri::command]
async fn scan_storage(path: Option<String>) -> Result<Vec<StorageEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_storage_sync(path))
        .await
        .map_err(|error| format!("The folder listing worker stopped unexpectedly: {error}"))?
}

fn scan_storage_sync(path: Option<String>) -> Result<Vec<StorageEntry>, String> {
    let (home, root) = scan_root(path)?;
    let mut results = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!(
                    "MemRead could not list an item in {}: {error}",
                    root.display()
                );
                continue;
            }
        };
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                eprintln!("MemRead could not inspect {}: {error}", path.display());
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let protection_reason = protection_for(&path, &home);
        results.push(StorageEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            size: None,
            partial: false,
            kind: if metadata.is_dir() {
                "Folder".into()
            } else {
                "File".into()
            },
            category: category_for(&path),
            modified,
            deletable: protection_reason.is_none(),
            protection_reason,
        });
    }
    results.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(results)
}

#[tauri::command]
async fn measure_storage(
    app: tauri::AppHandle,
    scan_manager: tauri::State<'_, ScanManager>,
    path: Option<String>,
    scan_id: u64,
) -> Result<(), String> {
    let cancelled = scan_manager.begin(scan_id)?;
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        measure_storage_sync(app, path, scan_id, cancelled)
    })
    .await
    .map_err(|error| format!("The size worker stopped unexpectedly: {error}"));
    scan_manager.finish(scan_id)?;
    worker_result?
}

fn measure_storage_sync(
    app: tauri::AppHandle,
    path: Option<String>,
    scan_id: u64,
    cancelled: Arc<AtomicBool>,
) -> Result<(), String> {
    let (home, root) = scan_root(path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        match entry {
            Ok(entry) => entries.push(entry),
            Err(error) => eprintln!(
                "MemRead could not list an item in {}: {error}",
                root.display()
            ),
        }
    }
    let total = entries.len();
    for (index, entry) in entries.into_iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(());
        }
        let path = entry.path();
        let item_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("item")
            .to_string();
        emit_progress(
            &app,
            ScanProgress {
                scan_id,
                current: item_name.clone(),
                completed: index,
                total,
                completed_item: None,
            },
        );
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let measurement = if metadata.is_file() {
            Some(SizeMeasurement {
                size: metadata.blocks().saturating_mul(512),
                partial: false,
            })
        } else {
            bytes_in(&path, &home, &cancelled)
        };
        let Some(measurement) = measurement else {
            return Ok(());
        };
        emit_sized_entry(
            &app,
            SizedEntry {
                scan_id,
                path: path.to_string_lossy().into_owned(),
                size: measurement.size,
                partial: measurement.partial,
            },
        );
        emit_progress(
            &app,
            ScanProgress {
                scan_id,
                current: item_name.clone(),
                completed: index + 1,
                total,
                completed_item: Some(item_name),
            },
        );
    }
    emit_progress(
        &app,
        ScanProgress {
            scan_id,
            current: "All sizes calculated".into(),
            completed: total,
            total,
            completed_item: None,
        },
    );
    Ok(())
}

#[tauri::command]
fn disk_summary() -> Result<DiskSummary, String> {
    let home = home_dir()?;
    let path = std::ffi::CString::new(home.as_os_str().as_encoded_bytes())
        .map_err(|_| "Invalid home directory.".to_string())?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    let block_size = stats.f_frsize as u64;
    Ok(DiskSummary {
        total: stats.f_blocks as u64 * block_size,
        available: stats.f_bavail as u64 * block_size,
    })
}

#[tauri::command]
async fn move_to_trash(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || move_to_trash_sync(path))
        .await
        .map_err(|error| format!("The move worker stopped unexpectedly: {error}"))?
}

fn move_to_trash_sync(path: String) -> Result<(), String> {
    let home = home_dir()?;
    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "The selected item no longer exists.".to_string())?;
    if canonical == home || !canonical.starts_with(&home) {
        return Err("MemRead can only move items from your home folder to Trash.".into());
    }
    if let Some(reason) = protection_for(&canonical, &home) {
        return Err(reason);
    }
    let trash = home.join(".Trash").join("MemRead");
    fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
    let name = canonical
        .file_name()
        .ok_or_else(|| "Invalid item name.".to_string())?;
    let mut destination = trash.join(name);
    let mut suffix = 1;
    while destination.exists() {
        destination = trash.join(format!("{}-{suffix}", name.to_string_lossy()));
        suffix += 1;
    }
    fs::rename(&canonical, destination)
        .map_err(|error| format!("Could not move this item to Trash: {error}"))
}

#[tauri::command]
fn open_full_disk_access() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .spawn()
            .map_err(|error| format!("Could not open System Settings: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Err("Full Disk Access setup is available on macOS only.".into())
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn open_creator_website() -> Result<(), String> {
    Command::new("open")
        .arg("https://davidngugi.com")
        .spawn()
        .map_err(|error| format!("Could not open David Ngugi's website: {error}"))?;
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn verify_storage_access() -> Result<(), String> {
    let home = home_dir()?;
    for folder in ["Desktop", "Documents", "Downloads"] {
        fs::read_dir(home.join(folder)).map_err(|_| {
            "Full Disk Access is still unavailable. In System Settings, add and enable /Applications/MemRead.app, then quit and reopen MemRead before verifying again.".to_string()
        })?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ScanManager::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_storage,
            measure_storage,
            disk_summary,
            move_to_trash,
            open_full_disk_access,
            open_main_window,
            open_creator_website,
            quit_app,
            verify_storage_access
        ])
        .setup(|app| {
            let about = MenuItemBuilder::with_id("about", "About MemRead").build(app)?;
            let open = MenuItemBuilder::with_id("open", "Open MemRead").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit MemRead").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&about)
                .separator()
                .item(&open)
                .separator()
                .item(&quit)
                .build()?;
            let quick_window = WebviewWindowBuilder::new(
                app,
                "quick-glance",
                WebviewUrl::App("index.html#quick-glance".into()),
            )
            .title("MemRead quick glance")
            .inner_size(420.0, 500.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()?;
            WebviewWindowBuilder::new(app, "about", WebviewUrl::App("index.html#about".into()))
                .title("About MemRead")
                .inner_size(430.0, 310.0)
                .resizable(false)
                .visible(false)
                .build()?;
            let quick_app = app.handle().clone();
            // macOS briefly reports a focus loss immediately after a tray icon opens a window.
            // Ignore only that opening transition; subsequent focus loss is a genuine click-away.
            let ignore_opening_blur = Arc::new(AtomicBool::new(false));
            let presentation_id = Arc::new(AtomicU64::new(0));
            let blur_state = ignore_opening_blur.clone();
            quick_window.on_window_event(move |event| match event {
                WindowEvent::Focused(false) if !blur_state.swap(false, Ordering::Relaxed) => {
                    if let Some(window) = quick_app.get_webview_window("quick-glance") {
                        let _ = window.hide();
                    }
                }
                _ => {}
            });
            TrayIconBuilder::with_id("memread")
                .icon(
                    app.default_window_icon()
                        .ok_or("MemRead is missing its tray icon.")?
                        .clone(),
                )
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "about" => {
                        if let Some(window) = app.get_webview_window("about") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("quick-glance") {
                            if window.is_visible().unwrap_or(false) {
                                ignore_opening_blur.store(false, Ordering::Relaxed);
                                presentation_id.fetch_add(1, Ordering::Relaxed);
                                let _ = window.hide();
                            } else {
                                let id = presentation_id.fetch_add(1, Ordering::Relaxed) + 1;
                                ignore_opening_blur.store(true, Ordering::Relaxed);
                                let _ = window.set_position(position);
                                let _ = window.show();
                                let _ = window.set_focus();

                                let blur_state = ignore_opening_blur.clone();
                                let presentation_id = presentation_id.clone();
                                thread::spawn(move || {
                                    thread::sleep(Duration::from_millis(750));
                                    if presentation_id.load(Ordering::Relaxed) == id {
                                        blur_state.store(false, Ordering::Relaxed);
                                    }
                                });
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| eprintln!("MemRead could not start: {error}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_test_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("memread-{name}-{}-{stamp}", std::process::id()))
    }

    #[test]
    fn app_containers_are_identified_relative_to_home_library() {
        let home = PathBuf::from("/Users/example");
        assert!(is_other_app_container(
            &home.join("Library/Containers"),
            &home
        ));
        assert!(is_other_app_container(
            &home.join("Library/Group Containers"),
            &home
        ));
        assert!(!is_other_app_container(&home.join("Library/Caches"), &home));
    }

    #[test]
    fn new_scan_cancels_the_previous_scan() {
        let manager = ScanManager::default();
        let first = manager.begin(1).expect("first scan should start");
        let second = manager.begin(2).expect("second scan should start");
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
        manager.finish(2).expect("active scan should finish");
    }

    #[test]
    fn protected_containers_make_a_measurement_partial() {
        let home = unique_test_dir("partial");
        fs::create_dir_all(home.join("Library/Containers/other.app"))
            .expect("fixture should be created");
        fs::write(home.join("Library/Containers/other.app/data"), b"secret")
            .expect("fixture data should be written");
        let cancelled = AtomicBool::new(false);
        let measurement = bytes_in(&home, &home, &cancelled).expect("scan should not be cancelled");
        assert!(measurement.partial);
        fs::remove_dir_all(home).expect("fixture should be removed");
    }

    #[test]
    fn cancelled_measurement_stops_before_io() {
        let home = unique_test_dir("cancelled");
        fs::create_dir_all(&home).expect("fixture should be created");
        let cancelled = AtomicBool::new(true);
        assert!(bytes_in(&home, &home, &cancelled).is_none());
        fs::remove_dir_all(home).expect("fixture should be removed");
    }
}
