/** Tiny DOM + API helpers shared by the three views. No framework, no runtime dependencies. */

type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function mount(...nodes: Node[]) {
  const app = document.getElementById("app")!;
  app.replaceChildren(...nodes);
}

/** Polite screen-reader announcement for meaningful changes only (never every timer tick). */
export function announce(message: string) {
  const live = document.getElementById("live")!;
  live.textContent = "";
  setTimeout(() => (live.textContent = message), 30);
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
  get network() {
    return this.status === 0;
  }
}

export async function api<T = any>(method: string, path: string, auth: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new ApiError(0, "NETWORK", "No connection. Nothing was recorded.");
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? "Something went wrong. Please try again.");
  return data as T;
}

export type State = "OUT" | "IN" | "BREAK";
export type Action = "CLOCK_IN" | "BREAK_START" | "BREAK_END" | "CLOCK_OUT";
export const STATE_TEXT: Record<State, string> = { OUT: "Clocked out", IN: "Clocked in", BREAK: "On break" };
export const DONE_TEXT: Record<Action, string> = { CLOCK_IN: "Clocked in", BREAK_START: "Break started", BREAK_END: "Break ended", CLOCK_OUT: "Clocked out" };
export const EVENT_TEXT: Record<string, string> = { clock_in: "Clocked in", break_start: "Break started", break_end: "Break ended", clock_out: "Clocked out" };

/** Actions offered for a state, primary first. */
export function actionsFor(state: State): Array<{ action: Action; label: string; endBreak?: boolean; kind: string }> {
  if (state === "OUT") return [{ action: "CLOCK_IN", label: "Start shift", kind: "btn-primary" }];
  if (state === "IN") return [
    { action: "CLOCK_OUT", label: "End shift", kind: "btn-dark" },
    { action: "BREAK_START", label: "Start break", kind: "" },
  ];
  return [
    { action: "BREAK_END", label: "End break", kind: "btn-primary" },
    { action: "CLOCK_OUT", label: "End break and end shift", endBreak: true, kind: "" },
  ];
}

export const fmtTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
export const fmtTimeSec = (iso: string, tz: string) =>
  new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
export function hms(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export function hm(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** Reads a credential from the URL fragment. Fragments are never sent to servers or in Referer headers. */
export function fragmentParam(name: string): string | null {
  return new URLSearchParams(location.hash.slice(1)).get(name);
}

export const BRAND = "ShiftSnap";

/** Logo mark + wordmark. The mark is drawn in CSS so it inherits the theme. */
export function brand(suffix?: string) {
  return h("div", { class: "brand" },
    h("span", { class: "logo", "aria-hidden": "true" }),
    h("span", { class: "brand-name" }, BRAND, suffix ? h("span", { class: "brand-suffix" }, suffix) : null),
  );
}

export function greeting(d = new Date()) {
  const hour = d.getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export const fmtDate = (d: Date, tz?: string) =>
  new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d);

/** Short-lived confirmation or error that doesn't move focus. Errors are announced assertively. */
export function toast(message: string, kind: "ok" | "error" = "ok") {
  let region = document.getElementById("toasts");
  if (!region) {
    region = h("div", { id: "toasts", class: "toasts" });
    document.body.append(region);
  }
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  region.append(t);
  setTimeout(() => t.classList.add("leaving"), kind === "error" ? 6000 : 3200);
  setTimeout(() => t.remove(), kind === "error" ? 6400 : 3600);
}
