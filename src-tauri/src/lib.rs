use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
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

#[derive(Serialize, Clone)]
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskSummary {
    total: u64,
    available: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CleanupShortcut {
    id: String,
    name: String,
    description: String,
    caution: String,
    path: Option<String>,
    size: Option<u64>,
    available: bool,
    action: String,
}

struct CleanupDefinition {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    caution: &'static str,
    path: Option<PathBuf>,
    action: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SimulatorDevice {
    id: String,
    name: String,
    runtime: String,
}

#[derive(Deserialize)]
struct SimctlDeviceList {
    devices: BTreeMap<String, Vec<SimctlDevice>>,
}

#[derive(Deserialize)]
struct SimctlDevice {
    name: String,
    udid: String,
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

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct QuickGlanceSnapshot {
    entries: Vec<StorageEntry>,
    summary: Option<DiskSummary>,
}

#[derive(Default)]
struct QuickGlanceStore {
    snapshot: Mutex<QuickGlanceSnapshot>,
}

impl QuickGlanceStore {
    fn snapshot(&self) -> Result<QuickGlanceSnapshot, String> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| "The quick glance data became unavailable.".to_string())
    }

    fn replace_entries(&self, entries: Vec<StorageEntry>) -> Result<(), String> {
        let mut snapshot = self
            .snapshot
            .lock()
            .map_err(|_| "The quick glance data became unavailable.".to_string())?;
        snapshot.entries = entries;
        Ok(())
    }

    fn set_summary(&self, summary: DiskSummary) -> Result<(), String> {
        let mut snapshot = self
            .snapshot
            .lock()
            .map_err(|_| "The quick glance data became unavailable.".to_string())?;
        snapshot.summary = Some(summary);
        Ok(())
    }

    fn update_size(&self, path: &str, size: u64, partial: bool) -> Result<(), String> {
        let mut snapshot = self
            .snapshot
            .lock()
            .map_err(|_| "The quick glance data became unavailable.".to_string())?;
        if let Some(entry) = snapshot.entries.iter_mut().find(|entry| entry.path == path) {
            entry.size = Some(size);
            entry.partial = partial;
        }
        Ok(())
    }
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

fn emit_quick_glance(app: &tauri::AppHandle, store: &QuickGlanceStore) {
    match store.snapshot() {
        Ok(snapshot) => {
            if let Err(error) = app.emit("quick-glance-updated", snapshot) {
                eprintln!("MemRead could not update quick glance: {error}");
            }
        }
        Err(error) => eprintln!("MemRead could not read quick glance data: {error}"),
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

fn cleanup_definitions(home: &Path) -> Vec<CleanupDefinition> {
    vec![
        CleanupDefinition {
            id: "xcode-derived-data",
            name: "Xcode Derived Data",
            description: "Build indexes, intermediates, and previews recreated by Xcode.",
            caution: "Safe to rebuild. Your projects and source code stay untouched.",
            path: Some(home.join("Library/Developer/Xcode/DerivedData")),
            action: "trash",
        },
        CleanupDefinition {
            id: "xcode-archives",
            name: "Xcode Archives",
            description: "Archived app builds created for distribution or export.",
            caution: "Keep any archive you may need to re-export or submit again.",
            path: Some(home.join("Library/Developer/Xcode/Archives")),
            action: "trash",
        },
        CleanupDefinition {
            id: "yarn-cache",
            name: "Yarn Cache",
            description: "Downloaded Yarn packages that can be fetched again.",
            caution: "The next install may take longer while packages download again.",
            path: Some(home.join("Library/Caches/Yarn")),
            action: "trash",
        },
        CleanupDefinition {
            id: "cocoapods-cache",
            name: "CocoaPods Cache",
            description: "Cached CocoaPods specs and downloaded pod archives.",
            caution: "The next pod install may take longer while dependencies download again.",
            path: Some(home.join("Library/Caches/CocoaPods")),
            action: "trash",
        },
        CleanupDefinition {
            id: "unavailable-simulators",
            name: "Unavailable iOS Simulators",
            description: "Simulator devices whose matching runtime is no longer installed.",
            caution:
                "This permanently removes unavailable simulator devices, not your active runtimes.",
            path: None,
            action: "simctl",
        },
    ]
}

fn cleanup_shortcut(definition: CleanupDefinition) -> CleanupShortcut {
    let available = definition.path.as_ref().is_none_or(|path| path.exists());
    CleanupShortcut {
        id: definition.id.into(),
        name: definition.name.into(),
        description: definition.description.into(),
        caution: definition.caution.into(),
        path: definition
            .path
            .map(|path| path.to_string_lossy().into_owned()),
        size: None,
        available,
        action: definition.action.into(),
    }
}

fn inspect_cleanup_path_sync(path: PathBuf) -> Result<CleanupShortcut, String> {
    let home = home_dir()?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "That folder is not available.".to_string())?;
    if canonical == home || !canonical.starts_with(&home) {
        return Err("Custom shortcuts must point to a folder inside your home directory.".into());
    }
    if canonical.starts_with(home.join("Library/Containers"))
        || canonical.starts_with(home.join("Library/Group Containers"))
    {
        return Err(
            "macOS protects other apps' containers. MemRead will not create cleanup shortcuts for them."
                .into(),
        );
    }
    if let Some(reason) = protection_for(&canonical, &home) {
        return Err(reason);
    }

    let cancelled = AtomicBool::new(false);
    let measurement = bytes_in(&canonical, &home, &cancelled)
        .ok_or_else(|| "Measuring this folder was cancelled.".to_string())?;
    let name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Custom folder");
    Ok(CleanupShortcut {
        id: canonical.to_string_lossy().into_owned(),
        name: name.into(),
        description: "Your saved cleanup target.".into(),
        caution: "Confirm this folder only contains files you are comfortable moving to Trash."
            .into(),
        path: Some(canonical.to_string_lossy().into_owned()),
        size: Some(measurement.size),
        available: true,
        action: "trash".into(),
    })
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

fn is_home_scan(path: Option<&String>) -> bool {
    let Ok(home) = home_dir() else {
        return false;
    };

    path.is_none_or(|path| {
        Path::new(path)
            .canonicalize()
            .is_ok_and(|root| root == home)
    })
}

#[tauri::command]
async fn scan_storage(
    app: tauri::AppHandle,
    quick_glance: tauri::State<'_, Arc<QuickGlanceStore>>,
    path: Option<String>,
) -> Result<Vec<StorageEntry>, String> {
    let home_scan = is_home_scan(path.as_ref());
    let entries = tauri::async_runtime::spawn_blocking(move || scan_storage_sync(path))
        .await
        .map_err(|error| format!("The folder listing worker stopped unexpectedly: {error}"))??;

    if home_scan {
        quick_glance.replace_entries(entries.clone())?;
        emit_quick_glance(&app, &quick_glance);
    }

    Ok(entries)
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
    quick_glance: tauri::State<'_, Arc<QuickGlanceStore>>,
    path: Option<String>,
    scan_id: u64,
) -> Result<(), String> {
    let cancelled = scan_manager.begin(scan_id)?;
    let home_scan = is_home_scan(path.as_ref());
    let quick_glance = quick_glance.inner().clone();
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        measure_storage_sync(app, path, scan_id, cancelled, quick_glance, home_scan)
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
    quick_glance: Arc<QuickGlanceStore>,
    is_home_scan: bool,
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
        let sized_entry = SizedEntry {
            scan_id,
            path: path.to_string_lossy().into_owned(),
            size: measurement.size,
            partial: measurement.partial,
        };
        if is_home_scan {
            quick_glance.update_size(&sized_entry.path, sized_entry.size, sized_entry.partial)?;
            emit_quick_glance(&app, &quick_glance);
        }
        emit_sized_entry(&app, sized_entry);
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
fn disk_summary(
    app: tauri::AppHandle,
    quick_glance: tauri::State<'_, Arc<QuickGlanceStore>>,
) -> Result<DiskSummary, String> {
    let home = home_dir()?;
    let path = std::ffi::CString::new(home.as_os_str().as_encoded_bytes())
        .map_err(|_| "Invalid home directory.".to_string())?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    let block_size = stats.f_frsize as u64;
    let summary = DiskSummary {
        total: stats.f_blocks as u64 * block_size,
        available: stats.f_bavail as u64 * block_size,
    };
    quick_glance.set_summary(summary.clone())?;
    emit_quick_glance(&app, &quick_glance);
    Ok(summary)
}

#[tauri::command]
fn cleanup_shortcuts() -> Result<Vec<CleanupShortcut>, String> {
    let home = home_dir()?;
    Ok(cleanup_definitions(&home)
        .into_iter()
        .map(cleanup_shortcut)
        .collect())
}

#[tauri::command]
async fn inspect_cleanup_path(path: String) -> Result<CleanupShortcut, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_cleanup_path_sync(PathBuf::from(path)))
        .await
        .map_err(|error| format!("The cleanup inspection worker stopped unexpectedly: {error}"))?
}

fn display_runtime(runtime: &str) -> String {
    runtime
        .rsplit('.')
        .next()
        .unwrap_or(runtime)
        .replace("SimRuntime-", "")
        .replace('-', ".")
}

fn unavailable_simulators_sync() -> Result<Vec<SimulatorDevice>, String> {
    let output = Command::new("xcrun")
        .args(["simctl", "list", "devices", "unavailable", "-j"])
        .output()
        .map_err(|error| format!("Could not read Simulator devices: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Simulator device discovery did not complete.".into()
        } else {
            format!("Simulator device discovery did not complete: {detail}")
        });
    }

    let list: SimctlDeviceList = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Simulator returned an unreadable device list: {error}"))?;
    Ok(list
        .devices
        .into_iter()
        .flat_map(|(runtime, devices)| {
            devices.into_iter().map(move |device| SimulatorDevice {
                id: device.udid,
                name: device.name,
                runtime: display_runtime(&runtime),
            })
        })
        .collect())
}

#[tauri::command]
async fn unavailable_simulators() -> Result<Vec<SimulatorDevice>, String> {
    tauri::async_runtime::spawn_blocking(unavailable_simulators_sync)
        .await
        .map_err(|error| format!("The simulator discovery worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn run_cleanup_shortcut(id: String, device_ids: Vec<String>) -> Result<String, String> {
    if id != "unavailable-simulators" || device_ids.is_empty() {
        return Err("Select at least one unavailable simulator to remove.".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let available_ids = unavailable_simulators_sync()?
            .into_iter()
            .map(|device| device.id)
            .collect::<Vec<_>>();
        if device_ids.iter().any(|id| !available_ids.contains(id)) {
            return Err("One or more selected simulators are no longer unavailable. Refresh the list and try again.".into());
        }

        let output = Command::new("xcrun")
            .arg("simctl")
            .arg("delete")
            .args(&device_ids)
            .output()
            .map_err(|error| format!("Could not run Simulator cleanup: {error}"))?;
        if output.status.success() {
            Ok(format!(
                "{} unavailable simulator{} removed.",
                device_ids.len(),
                if device_ids.len() == 1 { "" } else { "s" }
            ))
        } else {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if detail.is_empty() {
                "Simulator cleanup did not complete.".into()
            } else {
                format!("Simulator cleanup did not complete: {detail}")
            })
        }
    })
    .await
    .map_err(|error| format!("The simulator cleanup worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn quick_glance_snapshot(
    quick_glance: tauri::State<'_, Arc<QuickGlanceStore>>,
) -> Result<QuickGlanceSnapshot, String> {
    quick_glance.snapshot()
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
    let trash = home.join(".Trash");
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

fn migrate_legacy_trash_items() {
    let Ok(home) = home_dir() else {
        return;
    };
    let trash = home.join(".Trash");
    let legacy_trash = trash.join("MemRead");
    let Ok(items) = fs::read_dir(&legacy_trash) else {
        return;
    };

    for item in items.flatten() {
        let source = item.path();
        let Some(name) = source.file_name() else {
            continue;
        };
        let mut destination = trash.join(name);
        let mut suffix = 1;
        while destination.exists() {
            destination = trash.join(format!("{}-{suffix}", name.to_string_lossy()));
            suffix += 1;
        }
        if let Err(error) = fs::rename(&source, destination) {
            eprintln!("MemRead could not expose a legacy Trash item: {error}");
        }
    }

    if let Err(error) = fs::remove_dir(&legacy_trash) {
        if error.kind() != io::ErrorKind::NotFound {
            eprintln!("MemRead could not remove its empty legacy Trash folder: {error}");
        }
    }
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
fn open_latest_release() -> Result<(), String> {
    Command::new("open")
        .arg("https://github.com/DavidNgugi/memread/releases/latest")
        .spawn()
        .map_err(|error| format!("Could not open the latest release: {error}"))?;
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
        .manage(Arc::new(QuickGlanceStore::default()))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            scan_storage,
            measure_storage,
            disk_summary,
            cleanup_shortcuts,
            inspect_cleanup_path,
            unavailable_simulators,
            run_cleanup_shortcut,
            quick_glance_snapshot,
            move_to_trash,
            open_full_disk_access,
            open_main_window,
            open_creator_website,
            open_latest_release,
            quit_app,
            verify_storage_access
        ])
        .setup(|app| {
            migrate_legacy_trash_items();
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
                                let quick_glance =
                                    tray.app_handle().state::<Arc<QuickGlanceStore>>();
                                emit_quick_glance(tray.app_handle(), &quick_glance);

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
