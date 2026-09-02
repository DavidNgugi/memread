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
  selectedEntry: StorageEntry | null;
  summary: DiskSummary | null;
  trail: string[];
  verifyingAccess: boolean;
  dismissNotice: () => void;
  goBack: () => void;
  moveSelectedToTrash: () => Promise<void>;
  openFolder: (entry: StorageEntry) => void;
  scan: (path?: string) => Promise<void>;
  scanBreadcrumb: (index: number) => void;
  scanHome: () => void;
  selectEntry: (entry: StorageEntry | null) => void;
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
    | "search"
    | "shield"
    | "sortAsc"
    | "sortDesc"
    | "trash";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const DEFAULT_SORT: SortState = { key: "size", direction: "descending" };

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

function useStorageExplorer(): StorageExplorer {
  const scanIdRef = useRef(0);
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
  const [selectedEntry, setSelectedEntry] = useState<StorageEntry | null>(null);
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let stopProgress: (() => void) | undefined;
    let stopSizes: (() => void) | undefined;

    void listen<ScanProgress>("scan-progress", ({ payload }) => {
      if (payload.scanId !== scanIdRef.current) {
        return;
      }

      setScanProgress(payload);

      if (payload.completedItem) {
        const completedItem = payload.completedItem;
        setScanActivity((items) =>
          [completedItem, ...items.filter((item) => item !== completedItem)].slice(0, 5),
        );
      }

      if (payload.total > 0 && payload.completed === payload.total) {
        setCalculating(false);
      }
    }).then((unlisten) => {
      stopProgress = unlisten;
    });

    void listen<SizedEntry>("entry-sized", ({ payload }) => {
      if (payload.scanId !== scanIdRef.current) {
        return;
      }

      startTransition(() => {
        setEntries((items) =>
          items.map((item) =>
            item.path === payload.path
              ? { ...item, partial: payload.partial, size: payload.size }
              : item,
          ),
        );
      });
    }).then((unlisten) => {
      stopSizes = unlisten;
    });

    return () => {
      stopProgress?.();
      stopSizes?.();
    };
  }, []);

  async function scan(path = root): Promise<void> {
    const scanId = ++scanIdRef.current;

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

      setEntries(nextEntries);
      setSummary(disk);
      setRoot(path);
      setIsScanning(false);

      await nextFrame();

      void invoke<void>("measure_storage", {
        path: path || undefined,
        scanId,
      }).catch((error: unknown) => {
        if (scanId === scanIdRef.current) {
          setCalculating(false);
          setNotice(errorMessage(error));
        }
      });
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
      setEntries((items) => items.filter((item) => item.path !== selectedEntry.path));
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
      <p className="about-version">Version 0.1.0</p>
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
      <div className="wordmark">
        <span>MEM</span>READ
      </div>
      <div className="capacity">
        <span>AVAILABLE</span>
        <b>{summary ? formatBytes(summary.available) : "Reading"}</b>
        <i style={{ width: usedPercent + "%" }} />
      </div>
      <button className="scan" disabled={isScanning} onClick={() => void onScan()}>
        {buttonLabel}
      </button>
    </header>
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
  entry: StorageEntry;
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

function Dashboard({ explorer }: { explorer: StorageExplorer }) {
  return (
    <main className="app">
      <DashboardHeader
        calculating={explorer.calculating}
        isScanning={explorer.isScanning}
        onScan={explorer.scan}
        summary={explorer.summary}
      />
      {explorer.calculating && (
        <ScanProgressPanel activity={explorer.scanActivity} progress={explorer.scanProgress} />
      )}
      <section className="hero">
        <div>
          <p className="kicker">LOCAL STORAGE AT A GLANCE</p>
          <h1>
            Every byte has
            <br />
            an address.
          </h1>
        </div>
        <div className="hero-note">
          <Icon name="shield" />
          <p>
            Protected paths are visible but never removable here. Everything else goes to Trash,
            never straight to deletion.
          </p>
        </div>
      </section>
      {explorer.notice && (
        <button className="toast" onClick={explorer.dismissNotice}>
          {explorer.notice} ×
        </button>
      )}
      <ExplorerTable
        entries={explorer.entries}
        onBack={explorer.goBack}
        onOpenFolder={explorer.openFolder}
        onQueryChange={explorer.setQuery}
        onScanBreadcrumb={explorer.scanBreadcrumb}
        onScanHome={explorer.scanHome}
        onSelectForTrash={explorer.selectEntry}
        query={explorer.query}
        root={explorer.root}
        trail={explorer.trail}
      />
      {explorer.selectedEntry && (
        <TrashDialog
          entry={explorer.selectedEntry}
          moving={explorer.moving}
          onCancel={() => explorer.selectEntry(null)}
          onConfirm={explorer.moveSelectedToTrash}
        />
      )}
    </main>
  );
}

export default function App() {
  const explorer = useStorageExplorer();
  const route = window.location.hash;

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
