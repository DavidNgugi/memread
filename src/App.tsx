import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type SVGProps,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import "./App.css";

interface StorageEntry {
  name: string;
  path: string;
  size: number | null;
  partial: boolean;
  kind: "Folder" | "File";
  category: string;
  modified: number;
  deletable: boolean;
  protectionReason?: string;
}

interface TrashTarget {
  name: string;
  path: string;
  size: number | null;
}

interface CleanupShortcut {
  action: "simctl" | "trash";
  available: boolean;
  caution: string;
  description: string;
  id: string;
  name: string;
  path: string | null;
  size: number | null;
}

interface SavedCleanupShortcut {
  name: string;
  path: string;
}

interface SimulatorDevice {
  id: string;
  name: string;
  runtime: string;
}

interface DiskSummary {
  total: number;
  available: number;
}

interface ScanProgress {
  scanId: number;
  current: string;
  completed: number;
  total: number;
  completedItem?: string;
}

interface SizedEntry {
  scanId: number;
  path: string;
  size: number;
  partial: boolean;
}

interface DirectoryCache {
  activity: string[];
  entries: StorageEntry[];
  isComplete: boolean;
  progress: ScanProgress;
  summary: DiskSummary | null;
}

interface StorageExplorer {
  accessError: string;
  calculating: boolean;
  entries: StorageEntry[];
  isReady: boolean;
  isScanning: boolean;
  moving: boolean;
  notice: string;
  query: string;
  root: string;
  scanActivity: string[];
  scanProgress: ScanProgress;
  selectedEntry: TrashTarget | null;
  summary: DiskSummary | null;
  trail: string[];
  verifyingAccess: boolean;
  dismissNotice: () => void;
  goBack: () => void;
  moveSelectedToTrash: () => Promise<void>;
  openFolder: (entry: StorageEntry) => void;
  scan: (path?: string, force?: boolean) => Promise<void>;
  scanBreadcrumb: (index: number) => void;
  scanHome: () => void;
  selectEntry: (entry: TrashTarget | null) => void;
  setQuery: (value: string) => void;
  verifyAccess: () => Promise<void>;
}

type SortDirection = "ascending" | "descending";
type SortKey = "name" | "category" | "modified" | "size";

interface SortState {
  direction: SortDirection;
  key: SortKey;
}

interface IconProps extends SVGProps<SVGSVGElement> {
  name:
    | "arrow"
    | "back"
    | "chevron"
    | "drive"
    | "folder"
    | "menu"
    | "overview"
    | "refresh"
    | "search"
    | "shield"
    | "sortAsc"
    | "sortDesc"
    | "trash";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const DEFAULT_SORT: SortState = { key: "size", direction: "descending" };
const CURRENT_VERSION = "0.1.2";
const LATEST_RELEASE_ENDPOINT = "https://api.github.com/repos/DavidNgugi/memread/releases/latest";

function defaultSortDirection(key: SortKey): SortDirection {
  return key === "modified" || key === "size" ? "descending" : "ascending";
}

function compareEntries(left: StorageEntry, right: StorageEntry, sort: SortState): number {
  if (sort.key === "size" && (left.size === null || right.size === null)) {
    if (left.size === right.size) {
      return left.name.localeCompare(right.name, undefined, { numeric: true });
    }

    return left.size === null ? 1 : -1;
  }

  const comparison =
    sort.key === "name"
      ? left.name.localeCompare(right.name, undefined, { numeric: true })
      : sort.key === "category"
        ? left.category.localeCompare(right.category, undefined, { numeric: true })
        : sort.key === "modified"
          ? left.modified - right.modified
          : (left.size ?? 0) - (right.size ?? 0);

  const directionalComparison = sort.direction === "ascending" ? comparison : -comparison;
  return directionalComparison || left.name.localeCompare(right.name, undefined, { numeric: true });
}

function formatBytes(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + " " + BYTE_UNITS[unitIndex];
}

function formatModifiedDate(timestamp: number): string {
  if (!timestamp) {
    return "—";
  }

  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(timestamp * 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function notifyIfAllowed(title: string, body: string): Promise<void> {
  if (await isPermissionGranted()) {
    sendNotification({ title, body });
  }
}

function versionParts(version: string): number[] {
  return version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);
  const longestVersion = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < longestVersion; index += 1) {
    const candidatePart = candidateParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (candidatePart !== currentPart) {
      return candidatePart > currentPart;
    }
  }
  return false;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function Icon({ name, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      {...props}
    >
      {name === "drive" && (
        <>
          <rect height="16" rx="2" width="18" x="3" y="4" />
          <path d="M7 8h10M7 16h.01M11 16h6" />
        </>
      )}
      {name === "folder" && (
        <path d="M3 6.8A1.8 1.8 0 0 1 4.8 5H10l2 2h7.2A1.8 1.8 0 0 1 21 8.8v8.4a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 17.2Z" />
      )}
      {name === "menu" && <path d="M5 7h14M5 12h14M5 17h14" />}
      {name === "overview" && (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5V12h8.5" />
        </>
      )}
      {name === "refresh" && (
        <path d="M19 8V4m0 0h-4m4 0-3 3a7 7 0 1 0 2.1 5M5 16v4m0 0h4m-4 0 3-3a7 7 0 0 0-2.1-5" />
      )}
      {name === "chevron" && <path d="m9 18 6-6-6-6" />}
      {name === "back" && <path d="m15 18-6-6 6-6" />}
      {name === "trash" && (
        <>
          <path d="M4 7h16M10 11v5M14 11v5M9 7l1-3h4l1 3M6 7l1 13h10l1-13" />
        </>
      )}
      {name === "search" && (
        <>
          <circle cx="11" cy="11" r="6" />
          <path d="m20 20-4.2-4.2" />
        </>
      )}
      {name === "shield" && <path d="M12 3 19 6v5c0 4.6-3 8-7 10-4-2-7-5.4-7-10V6Z" />}
      {name === "arrow" && <path d="M5 12h14m-6-6 6 6-6 6" />}
      {name === "sortAsc" && <path d="m8 10 4-4 4 4M12 6v12" />}
      {name === "sortDesc" && <path d="m8 14 4 4 4-4M12 18V6" />}
    </svg>
  );
}

function useStorageExplorer(autoScan: boolean): StorageExplorer {
  const scanIdRef = useRef(0);
  const scanPaths = useRef(new Map<number, string>());
  const directoryCache = useRef(new Map<string, DirectoryCache>());
  const [isReady, setIsReady] = useState(
    () => localStorage.getItem("memread-setup-v2") === "yes",
  );
  const [verifyingAccess, setVerifyingAccess] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [summary, setSummary] = useState<DiskSummary | null>(null);
  const [root, setRoot] = useState("");
  const [trail, setTrail] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress>({
    completed: 0,
    current: "Waiting to scan",
    scanId: 0,
    total: 0,
  });
  const [scanActivity, setScanActivity] = useState<string[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<TrashTarget | null>(null);
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState("");
  const hasAutoScanned = useRef(false);

  function cacheKey(path: string): string {
    return path || "__home__";
  }

  function beginMeasurement(path: string, scanId: number): void {
    void invoke<void>("measure_storage", {
      path: path || undefined,
      scanId,
    }).catch((error: unknown) => {
      if (scanId === scanIdRef.current) {
        setCalculating(false);
        setNotice(errorMessage(error));
      }
    });
  }

  useEffect(() => {
    let stopProgress: (() => void) | undefined;
    let stopSizes: (() => void) | undefined;

    void listen<ScanProgress>("scan-progress", ({ payload }) => {
      if (payload.scanId !== scanIdRef.current) {
        return;
      }

      setScanProgress(payload);
      const key = scanPaths.current.get(payload.scanId);
      if (key) {
        const cached = directoryCache.current.get(key);
        if (cached) {
          cached.progress = payload;
        }
      }

      if (payload.completedItem) {
        const completedItem = payload.completedItem;
        setScanActivity((items) =>
          [completedItem, ...items.filter((item) => item !== completedItem)].slice(0, 5),
        );
        if (key) {
          const cached = directoryCache.current.get(key);
          if (cached) {
            cached.activity = [completedItem, ...cached.activity.filter((item) => item !== completedItem)].slice(0, 5);
          }
        }
      }

      if (payload.total > 0 && payload.completed === payload.total) {
        setCalculating(false);
        if (key) {
          const cached = directoryCache.current.get(key);
          if (cached) {
            cached.isComplete = true;
          }
        }
        void notifyIfAllowed(
          "MemRead scan complete",
          "Measured " + payload.total + " items. Your storage map is ready.",
        );
      }
    }).then((unlisten) => {
      stopProgress = unlisten;
    });

    void listen<SizedEntry>("entry-sized", ({ payload }) => {
      if (payload.scanId !== scanIdRef.current) {
        return;
      }

      startTransition(() => {
        setEntries((items) => {
          const nextEntries = items.map((item) =>
            item.path === payload.path
              ? { ...item, partial: payload.partial, size: payload.size }
              : item,
          );
          const key = scanPaths.current.get(payload.scanId);
          if (key) {
            const cached = directoryCache.current.get(key);
            if (cached) {
              cached.entries = nextEntries;
            }
          }
          return nextEntries;
        });
      });
    }).then((unlisten) => {
      stopSizes = unlisten;
    });

    return () => {
      stopProgress?.();
      stopSizes?.();
    };
  }, []);

  useEffect(() => {
    if (!autoScan || !isReady || hasAutoScanned.current) {
      return;
    }

    hasAutoScanned.current = true;
    void scan();
  }, [autoScan, isReady]);

  async function scan(path = root, force = false): Promise<void> {
    const scanId = ++scanIdRef.current;
    const key = cacheKey(path);
    const cached = directoryCache.current.get(key);

    if (cached && !force) {
      scanPaths.current.set(scanId, key);
      setEntries(cached.entries);
      setSummary(cached.summary);
      setRoot(path);
      setScanActivity(cached.activity);
      setScanProgress({ ...cached.progress, scanId });
      setIsScanning(false);
      setCalculating(!cached.isComplete);
      if (!cached.isComplete) {
        beginMeasurement(path, scanId);
      }
      return;
    }

    setIsScanning(true);
    setCalculating(true);
    setEntries([]);
    setScanActivity([]);
    setScanProgress({
      completed: 0,
      current: path || "Preparing your home folder",
      scanId,
      total: 0,
    });

    await nextFrame();

    try {
      const [nextEntries, disk] = await Promise.all([
        invoke<StorageEntry[]>("scan_storage", { path: path || undefined }),
        invoke<DiskSummary>("disk_summary"),
      ]);

      if (scanId !== scanIdRef.current) {
        return;
      }

      const progress = {
        completed: 0,
        current: path || "Preparing your home folder",
        scanId,
        total: nextEntries.length,
      };
      directoryCache.current.set(key, {
        activity: [],
        entries: nextEntries,
        isComplete: false,
        progress,
        summary: disk,
      });
      scanPaths.current.set(scanId, key);
      setEntries(nextEntries);
      setSummary(disk);
      setRoot(path);
      setIsScanning(false);
      setScanProgress(progress);

      await nextFrame();
      beginMeasurement(path, scanId);
    } catch (error) {
      if (scanId === scanIdRef.current) {
        setCalculating(false);
        setIsScanning(false);
        setNotice(errorMessage(error));
      }
    }
  }

  function openFolder(entry: StorageEntry): void {
    if (entry.kind !== "Folder") {
      return;
    }

    setTrail((currentTrail) => (root ? [...currentTrail, root] : currentTrail));
    void scan(entry.path);
  }

  function goBack(): void {
    const previousPath = trail[trail.length - 1] ?? "";
    setTrail((currentTrail) => currentTrail.slice(0, -1));
    void scan(previousPath);
  }

  function scanHome(): void {
    setTrail([]);
    void scan("");
  }

  function scanBreadcrumb(index: number): void {
    const paths = [...trail, root].filter(Boolean);
    const path = paths[index];

    if (!path) {
      return;
    }

    setTrail(trail.slice(0, index));
    void scan(path);
  }

  async function moveSelectedToTrash(): Promise<void> {
    if (!selectedEntry) {
      return;
    }

    setMoving(true);

    try {
      await invoke<void>("move_to_trash", { path: selectedEntry.path });
      setEntries((items) => {
        const nextEntries = items.filter((item) => item.path !== selectedEntry.path);
        const cached = directoryCache.current.get(cacheKey(root));
        if (cached) {
          cached.entries = nextEntries;
        }
        return nextEntries;
      });
      setNotice(selectedEntry.name + " is now in Trash.");
      setSelectedEntry(null);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setMoving(false);
    }
  }

  async function verifyAccess(): Promise<void> {
    setVerifyingAccess(true);
    setAccessError("");

    try {
      await invoke<void>("verify_storage_access");
      localStorage.setItem("memread-setup-v2", "yes");
      setIsReady(true);
    } catch (error) {
      setAccessError(errorMessage(error));
    } finally {
      setVerifyingAccess(false);
    }
  }

  return {
    accessError,
    calculating,
    dismissNotice: () => setNotice(""),
    entries,
    goBack,
    isReady,
    isScanning,
    moveSelectedToTrash,
    moving,
    notice,
    openFolder,
    query,
    root,
    scan,
    scanBreadcrumb,
    scanHome,
    scanActivity,
    scanProgress,
    selectedEntry,
    selectEntry: setSelectedEntry,
    setQuery,
    summary,
    trail,
    verifyingAccess,
    verifyAccess,
  };
}

function readSavedCleanupShortcuts(): SavedCleanupShortcut[] {
  try {
    const stored = JSON.parse(localStorage.getItem("memread-cleanup-shortcuts") ?? "[]") as unknown;
    if (!Array.isArray(stored)) {
      return [];
    }

    return stored.filter(
      (shortcut): shortcut is SavedCleanupShortcut =>
        typeof shortcut === "object" &&
        shortcut !== null &&
        "name" in shortcut &&
        "path" in shortcut &&
        typeof shortcut.name === "string" &&
        typeof shortcut.path === "string",
    );
  } catch {
    return [];
  }
}

function useCleanupShortcuts() {
  const [shortcuts, setShortcuts] = useState<CleanupShortcut[]>([]);
  const [saved, setSaved] = useState<SavedCleanupShortcut[]>(readSavedCleanupShortcuts);
  const [isLoading, setIsLoading] = useState(true);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const autoMeasuredPaths = useRef(new Set<string>());

  useEffect(() => {
    localStorage.setItem("memread-cleanup-shortcuts", JSON.stringify(saved));
  }, [saved]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      invoke<CleanupShortcut[]>("cleanup_shortcuts"),
      Promise.all(
        saved.map(async (shortcut) => {
          try {
            const inspected = await invoke<CleanupShortcut>("inspect_cleanup_path", {
              path: shortcut.path,
            });
            return { ...inspected, id: "custom:" + shortcut.path, name: shortcut.name };
          } catch {
            return null;
          }
        }),
      ),
    ])
      .then(([builtIn, custom]) => {
        if (!cancelled) {
          setShortcuts([...builtIn, ...custom.filter((item): item is CleanupShortcut => item !== null)]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pending = shortcuts.filter(
      (shortcut) =>
        shortcut.action === "trash" &&
        shortcut.available &&
        shortcut.path !== null &&
        shortcut.size === null &&
        !autoMeasuredPaths.current.has(shortcut.path),
    );

    async function measurePendingShortcuts(): Promise<void> {
      for (const shortcut of pending) {
        if (!shortcut.path || cancelled) {
          return;
        }
        autoMeasuredPaths.current.add(shortcut.path);
        setCheckingId(shortcut.id);
        try {
          const inspected = await invoke<CleanupShortcut>("inspect_cleanup_path", {
            path: shortcut.path,
          });
          if (!cancelled) {
            setShortcuts((items) =>
              items.map((item) =>
                item.id === shortcut.id ? { ...inspected, ...shortcut, size: inspected.size } : item,
              ),
            );
          }
        } catch {
          // A missing cache is simply left without a reclaimable size.
        } finally {
          if (!cancelled) {
            setCheckingId(null);
          }
        }
      }
    }

    void measurePendingShortcuts();
    return () => {
      cancelled = true;
    };
  }, [shortcuts]);

  async function checkSpace(shortcut: CleanupShortcut): Promise<void> {
    if (!shortcut.path) {
      return;
    }

    setCheckingId(shortcut.id);
    try {
      const inspected = await invoke<CleanupShortcut>("inspect_cleanup_path", { path: shortcut.path });
      setShortcuts((items) =>
        items.map((item) =>
          item.id === shortcut.id ? { ...inspected, ...shortcut, size: inspected.size } : item,
        ),
      );
    } finally {
      setCheckingId(null);
    }
  }

  async function addShortcut(name: string, path: string): Promise<void> {
    const inspected = await invoke<CleanupShortcut>("inspect_cleanup_path", { path });
    const savedShortcut = { name: name.trim() || inspected.name, path: inspected.path ?? path };
    setSaved((items) => [...items.filter((item) => item.path !== savedShortcut.path), savedShortcut]);
    setShortcuts((items) => [
      ...items.filter((item) => item.path !== savedShortcut.path),
      { ...inspected, id: "custom:" + savedShortcut.path, name: savedShortcut.name },
    ]);
  }

  function removeShortcut(shortcut: CleanupShortcut): void {
    if (!shortcut.id.startsWith("custom:") || !shortcut.path) {
      return;
    }
    setSaved((items) => items.filter((item) => item.path !== shortcut.path));
    setShortcuts((items) => items.filter((item) => item.id !== shortcut.id));
  }

  return { addShortcut, checkSpace, checkingId, isLoading, removeShortcut, shortcuts };
}

interface AvailableUpdate {
  version: string;
}

function useUpdateCheck() {
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState("");

  async function check(): Promise<void> {
    setChecking(true);
    setStatus("");
    try {
      const response = await fetch(LATEST_RELEASE_ENDPOINT, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) {
        throw new Error("Update check is unavailable.");
      }
      const release = (await response.json()) as { tag_name?: string };
      if (release.tag_name && isNewerVersion(release.tag_name, CURRENT_VERSION)) {
        const update = { version: release.tag_name.replace(/^v/, "") };
        setAvailableUpdate(update);
        setStatus("v" + update.version + " available");
        void notifyIfAllowed("MemRead update available", "Version " + update.version + " is ready to download.");
      } else {
        setAvailableUpdate(null);
        setStatus("Up to date");
      }
    } catch {
      setStatus("Unavailable");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void check();
  }, []);

  return { availableUpdate, check, checking, status };
}

function useNotificationPermission() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    void isPermissionGranted().then(setEnabled).catch(() => setEnabled(false));
  }, []);

  async function enable(): Promise<void> {
    const permission = await requestPermission();
    const granted = permission === "granted";
    setEnabled(granted);
    if (granted) {
      await sendNotification({
        title: "MemRead notifications enabled",
        body: "You will be notified when scans finish and updates are available.",
      });
    }
  }

  return { enable, enabled };
}

function AboutView() {
  return (
    <main className="about">
      <div className="about-mark">
        MEM<span>READ</span>
      </div>
      <p className="kicker">LOCAL STORAGE EXPLORER</p>
      <h1>MemRead</h1>
      <p>Know exactly where your disk space lives.</p>
      <p className="about-credit">
        Created by{" "}
        <a
          href="https://davidngugi.com"
          onClick={(event) => {
            event.preventDefault();
            void invoke<void>("open_creator_website");
          }}
        >
          David Ngugi
        </a>
      </p>
      <p className="about-version">Version 0.1.2</p>
    </main>
  );
}

interface QuickGlanceSnapshot {
  entries: StorageEntry[];
  summary: DiskSummary | null;
}

interface QuickGlanceProps {
  isReady: boolean;
}

function QuickGlance({ isReady }: QuickGlanceProps) {
  const [snapshot, setSnapshot] = useState<QuickGlanceSnapshot>({ entries: [], summary: null });

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    void invoke<QuickGlanceSnapshot>("quick_glance_snapshot")
      .then((nextSnapshot) => {
        if (!disposed) {
          setSnapshot(nextSnapshot);
        }
      })
      .catch(() => undefined);

    void listen<QuickGlanceSnapshot>("quick-glance-updated", ({ payload }) => {
      setSnapshot(payload);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        stopListening = unlisten;
      }
    });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  if (!isReady) {
    return <QuickSetup />;
  }

  const { entries, summary } = snapshot;
  const topEntries = [...entries].sort((left, right) => compareEntries(left, right, DEFAULT_SORT)).slice(0, 5);
  const used = summary ? summary.total - summary.available : 0;
  const usedPercent = summary ? (used / summary.total) * 100 : 0;

  return (
    <main className="quick">
      <div className="quick-head">
        <div>
          <span className="dot" /> MEMREAD
        </div>
        <b>{summary ? formatBytes(summary.available) : "Reading…"} free</b>
      </div>
      <p className="quick-label">OVERALL DISK USE</p>
      <div className="quick-bar">
        <i style={{ width: usedPercent + "%" }} />
      </div>
      <p className="quick-caption">
        {summary ? formatBytes(used) + " used of " + formatBytes(summary.total) : "Mapping your disk…"}
      </p>
      <div className="quick-list">
        <div className="quick-title">
          <span>TOP SPACE USERS</span>
          <span>USED</span>
          <span>%</span>
        </div>
        {topEntries.map((entry, index) => (
          <div className="quick-row" key={entry.path}>
            <span className={"swatch s" + index} />
            <b>{entry.name}</b>
            <span>{entry.size === null ? "..." : formatBytes(entry.size)}</span>
            <span>
              {summary && entry.size !== null
                ? Math.max(0, (entry.size / summary.total) * 100).toFixed(1) + "%"
                : "—"}
            </span>
          </div>
        ))}
        {!topEntries.length && <p className="quick-empty">Run a scan to see your largest folders.</p>}
      </div>
      <div className="quick-actions">
        <button className="quick-open" onClick={() => void invoke<void>("open_main_window")}>
          Open dashboard <Icon name="arrow" />
        </button>
        <button className="quick-quit" onClick={() => void invoke<void>("quit_app")}>
          Quit
        </button>
      </div>
    </main>
  );
}

function QuickSetup() {
  return (
    <main className="quick quick-setup">
      <div className="quick-head">
        <div>
          <span className="dot" /> MEMREAD
        </div>
      </div>
      <p className="quick-label">SETUP REQUIRED</p>
      <h2>Finish setup first.</h2>
      <p>Read and accept the local-use terms in MemRead before it reads storage information.</p>
      <div className="quick-actions">
        <button className="quick-open" onClick={() => void invoke<void>("open_main_window")}>
          Open MemRead <Icon name="arrow" />
        </button>
        <button className="quick-quit" onClick={() => void invoke<void>("quit_app")}>
          Quit
        </button>
      </div>
    </main>
  );
}

interface SetupViewProps {
  accessError: string;
  verifyingAccess: boolean;
  onOpenFullDiskAccess: () => void;
  onVerifyAccess: () => Promise<void>;
}

function SetupView({
  accessError,
  verifyingAccess,
  onOpenFullDiskAccess,
  onVerifyAccess,
}: SetupViewProps) {
  return (
    <main className="setup">
      <section className="setup-card">
        <div className="setup-mark">
          <Icon name="drive" />
        </div>
        <p className="kicker">MEMREAD / FIRST RUN</p>
        <h1>Read your disk without giving away your privacy.</h1>
        <p className="intro">
          MemRead runs locally. It never uploads file names or sizes. One setup step lets macOS
          grant access once, instead of interrupting your scan folder by folder.
        </p>
        <section className="panel-tour">
          <div>
            <p className="kicker">MENU BAR QUICK GLANCE</p>
            <h2>One click. The five biggest things.</h2>
            <p>Click MemRead in the menu bar for space used, percentages, and quick controls.</p>
          </div>
          <div className="tour-preview">
            <div>
              <span className="dot" /> MEMREAD <b>45 GB free</b>
            </div>
            <i />
            <small>
              Library <b>144 GB · 31%</b>
            </small>
            <small>
              .android <b>23 GB · 5%</b>
            </small>
          </div>
        </section>
        <section className="terms-copy">
          <p>
            By continuing, you agree that MemRead works locally, only moves confirmed items to
            Trash, and never permanently deletes files.
          </p>
        </section>
        {accessError && <p className="access-error">{accessError}</p>}
        <div className="setup-actions">
          <button className="secondary" onClick={onOpenFullDiskAccess}>
            Open Full Disk Access
          </button>
          <button
            className="primary"
            disabled={verifyingAccess}
            onClick={() => void onVerifyAccess()}
          >
            {verifyingAccess ? "Verifying access..." : "Verify access and enter"} <Icon name="arrow" />
          </button>
        </div>
      </section>
    </main>
  );
}

interface DashboardHeaderProps {
  calculating: boolean;
  isScanning: boolean;
  summary: DiskSummary | null;
  onScan: () => Promise<void>;
}

function DashboardHeader({ calculating, isScanning, summary, onScan }: DashboardHeaderProps) {
  const used = summary ? summary.total - summary.available : 0;
  const usedPercent = summary ? (used / summary.total) * 100 : 0;
  const buttonLabel = isScanning
    ? "Opening..."
    : calculating
      ? "Scanning in background"
      : "Scan now";

  return (
    <header>
      <p className="dashboard-context">STORAGE WORKSPACE</p>
      <div className="capacity">
        <span>AVAILABLE</span>
        <b>
          {summary ? formatBytes(summary.available) + " of " + formatBytes(summary.total) : "Reading"}
        </b>
        <i style={{ width: usedPercent + "%" }} />
      </div>
      <button className="scan" disabled={isScanning} onClick={() => void onScan()}>
        {buttonLabel}
      </button>
    </header>
  );
}

function StorageCapacityBar({ summary }: { summary: DiskSummary | null }) {
  if (!summary) {
    return null;
  }

  const used = summary.total - summary.available;
  const usedPercent = Math.min(100, (used / summary.total) * 100);

  return (
    <section className="storage-capacity" aria-label="Overall disk usage">
      <div className="storage-capacity-title">
        <span>OVERALL DISK USE</span>
        <b>{formatBytes(used)} used of {formatBytes(summary.total)}</b>
      </div>
      <div
        aria-label={formatBytes(used) + " used, " + formatBytes(summary.available) + " available"}
        aria-valuemax={summary.total}
        aria-valuemin={0}
        aria-valuenow={used}
        className="storage-capacity-bar"
        role="progressbar"
      >
        <i style={{ width: usedPercent + "%" }} />
      </div>
      <div className="storage-capacity-labels">
        <span><i className="used-key" /> Used {formatBytes(used)}</span>
        <span><i className="available-key" /> Available {formatBytes(summary.available)}</span>
      </div>
    </section>
  );
}

interface ScanProgressPanelProps {
  activity: string[];
  progress: ScanProgress;
}

function ScanProgressPanel({ activity, progress }: ScanProgressPanelProps) {
  const percent = progress.total
    ? Math.max(4, Math.min(100, (progress.completed / progress.total) * 100))
    : 4;

  return (
    <section aria-live="polite" className="scan-progress">
      <div className="scan-status">
        <div>
          <span className="pulse" />
          Scanning <b>{progress.current}</b>
        </div>
        <span>
          {progress.total ? progress.completed + " of " + progress.total + " items" : "Preparing..."}
        </span>
        <i style={{ width: percent + "%" }} />
      </div>
      <div className="scan-activity">
        <p>RECENTLY MEASURED</p>
        {activity.length ? (
          activity.map((item) => (
            <span key={item}>
              <b>✓</b> {item}
            </span>
          ))
        ) : (
          <span className="scan-wait">Starting with your home folder...</span>
        )}
      </div>
    </section>
  );
}

interface ExplorerTableProps {
  entries: StorageEntry[];
  query: string;
  root: string;
  trail: string[];
  onBack: () => void;
  onOpenFolder: (entry: StorageEntry) => void;
  onQueryChange: (value: string) => void;
  onSelectForTrash: (entry: StorageEntry) => void;
  onScanBreadcrumb: (index: number) => void;
  onScanHome: () => void;
}

function ExplorerTable({
  entries,
  query,
  root,
  trail,
  onBack,
  onOpenFolder,
  onQueryChange,
  onSelectForTrash,
  onScanBreadcrumb,
  onScanHome,
}: ExplorerTableProps) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredEntries = entries.filter((entry) =>
    (entry.name + " " + entry.category + " " + entry.path).toLowerCase().includes(normalizedQuery),
  );
  const sortedEntries = [...filteredEntries].sort((left, right) => compareEntries(left, right, sort));
  const breadcrumbPaths = [...trail, root].filter(Boolean);

  function changeSort(key: SortKey): void {
    setSort((currentSort) => ({
      key,
      direction:
        currentSort.key === key
          ? currentSort.direction === "ascending"
            ? "descending"
            : "ascending"
          : defaultSortDirection(key),
    }));
  }

  return (
    <section className="browser">
      <div className="browser-top">
        <button className="back" disabled={!trail.length} onClick={onBack}>
          <Icon name="back" /> Back
        </button>
        <div className="crumb">
          <button onClick={onScanHome}>Home</button>
          {breadcrumbPaths.map((path, index) => (
            <span key={path}>
              <Icon name="chevron" />
              <button onClick={() => onScanBreadcrumb(index)}>
                {path.split("/").pop()}
              </button>
            </span>
          ))}
        </div>
        <label className="search">
          <Icon name="search" />
          <input
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Filter this folder"
            value={query}
          />
        </label>
      </div>
      <div className="head" role="row">
        <SortableHeader label="Name" onSort={changeSort} sort={sort} sortKey="name" />
        <SortableHeader label="Type" onSort={changeSort} sort={sort} sortKey="category" />
        <SortableHeader label="Modified" onSort={changeSort} sort={sort} sortKey="modified" />
        <SortableHeader label="Size" onSort={changeSort} sort={sort} sortKey="size" />
        <span />
      </div>
      <div className="items">
        {sortedEntries.map((entry) => (
          <BrowserRow
            entry={entry}
            key={entry.path}
            onOpenFolder={onOpenFolder}
            onSelectForTrash={onSelectForTrash}
          />
        ))}
      </div>
      {!sortedEntries.length && <p className="empty">Nothing here matches that filter.</p>}
    </section>
  );
}

interface SortableHeaderProps {
  label: string;
  onSort: (key: SortKey) => void;
  sort: SortState;
  sortKey: SortKey;
}

function SortableHeader({ label, onSort, sort, sortKey }: SortableHeaderProps) {
  const isActive = sort.key === sortKey;
  const ariaSort = isActive ? sort.direction : "none";
  const directionLabel = isActive ? sort.direction : "not sorted";

  return (
    <div aria-sort={ariaSort} role="columnheader">
      <button
        aria-label={label + ", " + directionLabel + ". Activate to sort."}
        className={isActive ? "sort-header active" : "sort-header"}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {isActive && <Icon name={sort.direction === "ascending" ? "sortAsc" : "sortDesc"} />}
      </button>
    </div>
  );
}

interface BrowserRowProps {
  entry: StorageEntry;
  onOpenFolder: (entry: StorageEntry) => void;
  onSelectForTrash: (entry: StorageEntry) => void;
}

function BrowserRow({ entry, onOpenFolder, onSelectForTrash }: BrowserRowProps) {
  const canOpen = entry.kind === "Folder";
  const canTrash = entry.deletable && entry.size !== null;

  return (
    <article className="row">
      <button className="item" disabled={!canOpen} onClick={() => onOpenFolder(entry)}>
        <span className={canOpen ? "folder" : "file"}>
          <Icon name="folder" />
        </span>
        <div>
          <b>{entry.name}</b>
          <small>{entry.path}</small>
        </div>
        {canOpen && <Icon className="open" name="chevron" />}
      </button>
      <span className="type">{entry.category}</span>
      <span>{formatModifiedDate(entry.modified)}</span>
      <strong>
        {entry.size === null ? (
          <span className="calculating">
            <span className="tiny-spinner" />
            Calculating
          </span>
        ) : entry.partial ? (
          <span className="partial-size" title="Some protected or unreadable content was omitted">
            Partial {formatBytes(entry.size)}
          </span>
        ) : (
          formatBytes(entry.size)
        )}
      </strong>
      {canTrash ? (
        <button
          aria-label={"Move " + entry.name + " to Trash"}
          className="delete"
          onClick={() => onSelectForTrash(entry)}
        >
          <Icon name="trash" />
        </button>
      ) : (
        <span className="protected">
          <Icon name="shield" /> {entry.deletable ? "Calculating" : "Protected"}
        </span>
      )}
    </article>
  );
}

interface TrashDialogProps {
  entry: TrashTarget;
  moving: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

function TrashDialog({ entry, moving, onCancel, onConfirm }: TrashDialogProps) {
  const sizeDescription = entry.size === null ? "This item" : formatBytes(entry.size);

  return (
    <div className="veil">
      <section aria-busy={moving} aria-modal="true" className="modal" role="dialog">
        <Icon className="modal-icon" name="trash" />
        <p className="kicker">{moving ? "MOVING SAFELY" : "MOVE TO TRASH"}</p>
        <h2>{moving ? "Moving to Trash…" : "Move “" + entry.name + "”?"}</h2>
        <p>
          {moving
            ? "MemRead is handing this item to macOS. This window will update when it is done."
            : sizeDescription + " will be recoverable from Trash until you empty it."}
        </p>
        <code>{entry.path}</code>
        <div>
          <button disabled={moving} onClick={onCancel}>
            Cancel
          </button>
          <button className="danger" disabled={moving} onClick={() => void onConfirm()}>
            {moving ? (
              <>
                <span className="spinner" /> Moving…
              </>
            ) : (
              "Move to Trash"
            )}
          </button>
        </div>
      </section>
    </div>
  );
}

interface CleanupShortcutsProps {
  onSelectForTrash: (entry: TrashTarget) => void;
}

function CleanupShortcuts({ onSelectForTrash }: CleanupShortcutsProps) {
  const { addShortcut, checkSpace, checkingId, isLoading, removeShortcut, shortcuts } =
    useCleanupShortcuts();
  const [customName, setCustomName] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [message, setMessage] = useState("");
  const [runningSimulatorCleanup, setRunningSimulatorCleanup] = useState(false);
  const [loadingSimulators, setLoadingSimulators] = useState(false);
  const [simulatorDevices, setSimulatorDevices] = useState<SimulatorDevice[]>([]);
  const [selectedSimulatorIds, setSelectedSimulatorIds] = useState<string[]>([]);
  const [showSimulatorConfirmation, setShowSimulatorConfirmation] = useState(false);

  async function saveCustomShortcut(): Promise<void> {
    setMessage("");
    try {
      await addShortcut(customName, customPath);
      setCustomName("");
      setCustomPath("");
      setMessage("Custom cleanup shortcut saved.");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function removeUnavailableSimulators(): Promise<void> {
    setRunningSimulatorCleanup(true);
    try {
      setMessage(await invoke<string>("run_cleanup_shortcut", {
        id: "unavailable-simulators",
        deviceIds: selectedSimulatorIds,
      }));
      setShowSimulatorConfirmation(false);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setRunningSimulatorCleanup(false);
    }
  }

  async function reviewUnavailableSimulators(): Promise<void> {
    setLoadingSimulators(true);
    setMessage("");
    try {
      const devices = await invoke<SimulatorDevice[]>("unavailable_simulators");
      if (!devices.length) {
        setMessage("No unavailable simulator devices were found.");
        return;
      }
      setSimulatorDevices(devices);
      setSelectedSimulatorIds(devices.map((device) => device.id));
      setShowSimulatorConfirmation(true);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoadingSimulators(false);
    }
  }

  function toggleSimulator(id: string): void {
    setSelectedSimulatorIds((ids) =>
      ids.includes(id) ? ids.filter((selectedId) => selectedId !== id) : [...ids, id],
    );
  }

  return (
    <section className="cleanup-shortcuts" aria-labelledby="cleanup-title">
      <div className="cleanup-heading">
        <div>
          <p className="kicker">QUICK CLEANUPS</p>
          <h2 id="cleanup-title">Developer space, without the guesswork.</h2>
        </div>
        <p>Folders go to Trash. Tool cleanup is always explained before it runs.</p>
      </div>
      <div className="cleanup-grid">
        {isLoading && <p className="cleanup-loading">Loading cleanup shortcuts…</p>}
        {shortcuts.map((shortcut) => (
          <article className="cleanup-card" key={shortcut.id}>
            <div className="cleanup-card-top">
              <div>
                <p className="cleanup-kind">{shortcut.action === "simctl" ? "SIMULATOR TOOL" : "FOLDER"}</p>
                <h3>{shortcut.name}</h3>
              </div>
              {shortcut.size !== null ? (
                <b>{formatBytes(shortcut.size)}</b>
              ) : checkingId === shortcut.id ? (
                <b>Checking…</b>
              ) : null}
            </div>
            <p>{shortcut.description}</p>
            <small>{shortcut.caution}</small>
            <div className="cleanup-card-actions">
              {shortcut.action === "trash" && shortcut.path && (
                <>
                  <button
                    disabled={checkingId === shortcut.id || !shortcut.available}
                    onClick={() => void checkSpace(shortcut).catch((error) => setMessage(errorMessage(error)))}
                  >
                    {checkingId === shortcut.id ? "Checking…" : shortcut.size === null ? "Check space" : "Recheck"}
                  </button>
                  <button
                    className="cleanup-trash"
                    disabled={!shortcut.available}
                    onClick={() =>
                      onSelectForTrash({
                        name: shortcut.name,
                        path: shortcut.path ?? "",
                        size: shortcut.size,
                      })
                    }
                  >
                    Move to Trash
                  </button>
                </>
              )}
              {shortcut.action === "simctl" && (
                <button
                  className="cleanup-tool"
                  disabled={runningSimulatorCleanup || loadingSimulators}
                  onClick={() => void reviewUnavailableSimulators()}
                >
                  {loadingSimulators ? "Checking…" : "Review devices"}
                </button>
              )}
              {shortcut.id.startsWith("custom:") && (
                <button className="cleanup-remove" onClick={() => removeShortcut(shortcut)}>
                  Remove shortcut
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <details className="custom-cleanup">
        <summary>Add your own folder shortcut</summary>
        <div>
          <label>
            Name
            <input onChange={(event) => setCustomName(event.target.value)} placeholder="Project cache" value={customName} />
          </label>
          <label>
            Folder path
            <input onChange={(event) => setCustomPath(event.target.value)} placeholder="/Users/you/Library/Caches/example" value={customPath} />
          </label>
          <button disabled={!customPath.trim()} onClick={() => void saveCustomShortcut()}>
            Save shortcut
          </button>
        </div>
        <p>Only folders inside your home directory can be saved. Protected app data and credentials remain blocked.</p>
      </details>
      {message && <p className="cleanup-message" role="status">{message}</p>}
      {showSimulatorConfirmation && (
        <div className="veil">
          <section aria-busy={runningSimulatorCleanup} aria-modal="true" className="modal" role="dialog">
            <Icon className="modal-icon" name="drive" />
            <p className="kicker">SIMULATOR CLEANUP</p>
            <h2>Choose simulators to remove.</h2>
            <p>
              These devices have no installed runtime. Your active iPhone and iPad simulators are
              not listed here.
            </p>
            <div className="simulator-list">
              {simulatorDevices.map((device) => (
                <label key={device.id}>
                  <input
                    checked={selectedSimulatorIds.includes(device.id)}
                    disabled={runningSimulatorCleanup}
                    onChange={() => toggleSimulator(device.id)}
                    type="checkbox"
                  />
                  <span>
                    <b>{device.name}</b>
                    <small>{device.runtime} · {device.id}</small>
                  </span>
                </label>
              ))}
            </div>
            <div>
              <button disabled={runningSimulatorCleanup} onClick={() => setShowSimulatorConfirmation(false)}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={runningSimulatorCleanup || !selectedSimulatorIds.length}
                onClick={() => void removeUnavailableSimulators()}
              >
                {runningSimulatorCleanup
                  ? "Removing…"
                  : "Remove " + selectedSimulatorIds.length + " device" + (selectedSimulatorIds.length === 1 ? "" : "s")}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

type DashboardView = "cleanups" | "explorer" | "overview";

interface SidebarProps {
  availableUpdate: AvailableUpdate | null;
  checkingForUpdate: boolean;
  collapsed: boolean;
  currentView: DashboardView;
  onCheckForUpdate: () => Promise<void>;
  onCollapse: () => void;
  onNavigate: (view: DashboardView) => void;
  updateStatus: string;
}

function Sidebar({
  availableUpdate,
  checkingForUpdate,
  collapsed,
  currentView,
  onCheckForUpdate,
  onCollapse,
  onNavigate,
  updateStatus,
}: SidebarProps) {
  const navigation: { icon: IconProps["name"]; label: string; view: DashboardView }[] = [
    { icon: "overview", label: "Overview", view: "overview" },
    { icon: "folder", label: "Explorer", view: "explorer" },
    { icon: "trash", label: "Cleanups", view: "cleanups" },
  ];

  return (
    <aside className={collapsed ? "sidebar collapsed" : "sidebar"}>
      <div className="sidebar-brand">
        <span className="sidebar-mark"><span>MEM</span>READ</span>
        <button aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={onCollapse}>
          <Icon name="menu" />
        </button>
      </div>
      <nav aria-label="Dashboard views">
        {navigation.map((item) => (
          <button
            aria-current={currentView === item.view ? "page" : undefined}
            aria-label={collapsed ? item.label : undefined}
            className={currentView === item.view ? "nav-item active" : "nav-item"}
            key={item.view}
            onClick={() => onNavigate(item.view)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-update">
        <button
          aria-label={availableUpdate ? "Open version " + availableUpdate.version : "Check for updates"}
          disabled={checkingForUpdate}
          onClick={() => {
            if (availableUpdate) {
              void invoke<void>("open_latest_release");
            } else {
              void onCheckForUpdate();
            }
          }}
        >
          <Icon name="refresh" />
          <span>
            {checkingForUpdate
              ? "Checking…"
              : availableUpdate
                ? "Update v" + availableUpdate.version
                : updateStatus === "Up to date"
                  ? "v" + CURRENT_VERSION
                  : "Check for updates"}
          </span>
        </button>
        {!collapsed && !availableUpdate && updateStatus && (
          <span>{updateStatus === "Up to date" ? "You have the latest version" : updateStatus}</span>
        )}
      </div>
    </aside>
  );
}

function Overview({
  availableUpdate,
  explorer,
  notificationsEnabled,
  onCleanups,
  onEnableNotifications,
  onExplore,
}: {
  availableUpdate: AvailableUpdate | null;
  explorer: StorageExplorer;
  notificationsEnabled: boolean;
  onCleanups: () => void;
  onEnableNotifications: () => Promise<void>;
  onExplore: () => void;
}) {
  const measuredEntries = explorer.entries.filter((entry) => entry.size !== null);
  const largest = [...measuredEntries]
    .sort((left, right) => compareEntries(left, right, DEFAULT_SORT))
    .slice(0, 4);

  return (
    <section className="overview-view">
      <div className="overview-heading">
        <div>
          <p className="kicker">YOUR MAC, READABLE</p>
          <h1>Space with context.</h1>
        </div>
        <p>
          Scan your home folder once, then move through results without waiting for the next
          directory to be sized.
        </p>
      </div>
      <StorageCapacityBar summary={explorer.summary} />
      <section className="overview-largest" aria-labelledby="largest-title">
        <div className="overview-section-head">
          <div>
            <p className="kicker">TOP SPACE USERS</p>
            <h2 id="largest-title">Largest folders at home</h2>
          </div>
          <button onClick={onExplore}>Open explorer <Icon name="arrow" /></button>
        </div>
        {largest.length ? (
          <div className="overview-list">
            {largest.map((entry, index) => (
              <button key={entry.path} onClick={() => explorer.openFolder(entry)}>
                <span>0{index + 1}</span>
                <b>{entry.name}</b>
                <small>{entry.size === null ? "Calculating" : formatBytes(entry.size)}</small>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        ) : (
          <p className="overview-empty">
            {explorer.calculating ? "Measuring the first folders now…" : "Run a scan to reveal the largest folders."}
          </p>
        )}
      </section>
      <section className="overview-action">
        <div>
          <p className="kicker">SAFE CLEANUP</p>
          <h2>Common developer caches, contained.</h2>
          <p>Review measured Xcode and package-manager caches before anything moves to Trash.</p>
        </div>
        <button onClick={onCleanups}>View cleanups <Icon name="arrow" /></button>
      </section>
      <section className="overview-status">
        <div>
          <p className="kicker">NOTIFICATIONS</p>
          <h2>{notificationsEnabled ? "Scan alerts are on." : "Know when the scan is ready."}</h2>
          <p>
            {notificationsEnabled
              ? "MemRead will notify you when a background scan completes."
              : "Enable native notifications for completed scans and available updates."}
          </p>
        </div>
        {!notificationsEnabled && (
          <button onClick={() => void onEnableNotifications()}>Enable notifications</button>
        )}
        {availableUpdate && (
          <div className="update-available">
            <span>v{availableUpdate.version} is available</span>
            <button onClick={() => void invoke<void>("open_latest_release")}>View update</button>
          </div>
        )}
      </section>
    </section>
  );
}

function Dashboard({ explorer }: { explorer: StorageExplorer }) {
  const [view, setView] = useState<DashboardView>("overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const update = useUpdateCheck();
  const notifications = useNotificationPermission();

  function openFolder(entry: StorageEntry): void {
    explorer.openFolder(entry);
    setView("explorer");
  }

  return (
    <div className={sidebarCollapsed ? "dashboard-shell sidebar-is-collapsed" : "dashboard-shell"}>
      <Sidebar
        availableUpdate={update.availableUpdate}
        checkingForUpdate={update.checking}
        collapsed={sidebarCollapsed}
        currentView={view}
        onCheckForUpdate={update.check}
        onCollapse={() => setSidebarCollapsed((collapsed) => !collapsed)}
        onNavigate={setView}
        updateStatus={update.status}
      />
      <main className="app">
        <DashboardHeader
          calculating={explorer.calculating}
          isScanning={explorer.isScanning}
          onScan={() => explorer.scan(undefined, true)}
          summary={explorer.summary}
        />
        {explorer.calculating && (
          <ScanProgressPanel activity={explorer.scanActivity} progress={explorer.scanProgress} />
        )}
        {view === "overview" && (
          <Overview
            availableUpdate={update.availableUpdate}
            explorer={{ ...explorer, openFolder }}
            notificationsEnabled={notifications.enabled}
            onCleanups={() => setView("cleanups")}
            onEnableNotifications={notifications.enable}
            onExplore={() => setView("explorer")}
          />
        )}
        {view === "explorer" && (
          <>
            <StorageCapacityBar summary={explorer.summary} />
            <ExplorerTable
              entries={explorer.entries}
              onBack={explorer.goBack}
              onOpenFolder={openFolder}
              onQueryChange={explorer.setQuery}
              onScanBreadcrumb={explorer.scanBreadcrumb}
              onScanHome={explorer.scanHome}
              onSelectForTrash={explorer.selectEntry}
              query={explorer.query}
              root={explorer.root}
              trail={explorer.trail}
            />
          </>
        )}
        {view === "cleanups" && <CleanupShortcuts onSelectForTrash={explorer.selectEntry} />}
        {explorer.notice && (
          <button className="toast" onClick={explorer.dismissNotice}>
            {explorer.notice} ×
          </button>
        )}
        {explorer.selectedEntry && (
          <TrashDialog
            entry={explorer.selectedEntry}
            moving={explorer.moving}
            onCancel={() => explorer.selectEntry(null)}
            onConfirm={explorer.moveSelectedToTrash}
          />
        )}
      </main>
    </div>
  );
}

export default function App() {
  const route = window.location.hash;
  const explorer = useStorageExplorer(!route);

  if (route === "#about") {
    return <AboutView />;
  }

  if (route === "#quick-glance") {
    return <QuickGlance isReady={explorer.isReady} />;
  }

  if (!explorer.isReady) {
    return (
      <SetupView
        accessError={explorer.accessError}
        onOpenFullDiskAccess={() => void invoke<void>("open_full_disk_access")}
        onVerifyAccess={explorer.verifyAccess}
        verifyingAccess={explorer.verifyingAccess}
      />
    );
  }

  return <Dashboard explorer={explorer} />;
}
