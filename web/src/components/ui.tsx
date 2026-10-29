import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import { IconAlert, IconCheck, IconClock, IconHourglass, IconPause, IconPlay, IconStop, IconX } from "./icons";

export type ClockState = "IN" | "BREAK" | "OUT";

const STATE_TEXT: Record<ClockState, string> = { IN: "Clocked in", BREAK: "On break", OUT: "Clocked out" };
export function StateBadge({ state }: { state: ClockState }) {
  const Icon = state === "IN" ? IconPlay : state === "BREAK" ? IconPause : IconStop;
  return (
    <span className={`status status-${state.toLowerCase()}`}>
      <Icon size={16} />
      {STATE_TEXT[state]}
    </span>
  );
}
export const stateText = (s: ClockState) => STATE_TEXT[s];

const REVIEW: Record<string, { text: string; cls: string; icon: typeof IconCheck }> = {
  pending: { text: "Pending review", cls: "status-warn", icon: IconHourglass },
  approved: { text: "Approved", cls: "status-in", icon: IconCheck },
  rejected: { text: "Rejected", cls: "status-bad", icon: IconX },
  withdrawn: { text: "Withdrawn", cls: "status-out", icon: IconX },
  accepted: { text: "Accepted", cls: "status-in", icon: IconCheck },
  pending_review: { text: "Needs review", cls: "status-warn", icon: IconHourglass },
  open: { text: "In progress", cls: "status-in", icon: IconClock },
};
export function ReviewStatus({ status }: { status: string }) {
  const s = REVIEW[status] ?? { text: status, cls: "status-out", icon: IconClock };
  const Icon = s.icon;
  return (
    <span className={`status ${s.cls}`}>
      <Icon size={15} />
      {s.text}
    </span>
  );
}

export interface Flag {
  code: string;
  label: string;
}
const QUIET_FLAGS = new Set(["adjusted", "pending_correction"]);
export function Flags({ flags }: { flags: Flag[] }) {
  if (!flags.length) return null;
  return (
    <span className="flags">
      {flags.map((f, i) => (
        <span key={i} className={`status ${QUIET_FLAGS.has(f.code) ? "status-out" : f.code === "voided" ? "status-bad" : "status-warn"}`}>
          {QUIET_FLAGS.has(f.code) ? <IconClock size={14} /> : <IconAlert size={14} />}
          {f.label}
        </span>
      ))}
    </span>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : "Something went wrong. Please try again.";
  return (
    <div className="notice notice-error" role="alert">
      <p>{message}</p>
      {error instanceof ApiError && error.requestId && <p className="small muted">Reference: {error.requestId}</p>}
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p className="muted" role="status">
      {label}…
    </p>
  );
}

/** Data loader with explicit loading / error / reload states. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await fn();
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e);
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      )}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error && (
        <span className="error" id={errId}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Native <dialog>: modal focus trapping, Escape to close, focus returns to the opener. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
      (opener.current as HTMLElement | null)?.focus?.();
    }
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      {open && (
        <div className="dialog-body">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Announcements: a polite live region + a visual toast for meaningful results.
// ---------------------------------------------------------------------------
const AnnounceCtx = createContext<(msg: string) => void>(() => undefined);
export const useAnnounce = () => useContext(AnnounceCtx);

export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number>(undefined);
  const announce = useCallback((msg: string) => {
    setMessage("");
    window.setTimeout(() => setMessage(msg), 30);
    setToast(msg);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 4500);
  }, []);
  return (
    <AnnounceCtx.Provider value={announce}>
      {children}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {message}
      </div>
      {toast && (
        <div className="toast" aria-hidden="true">
          {toast}
        </div>
      )}
    </AnnounceCtx.Provider>
  );
}

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} — Tutor Time Clock`;
  }, [title]);
}
