import { actionsFor, announce, api, ApiError, DONE_TEXT, fmtTimeSec, fragmentParam, h, mount, STATE_TEXT, type Action, type State } from "./lib";

const STORE = "shift.kiosk";
const BADGE_PREFIX = "shiftbadge:";
const IDLE_AFTER_MS = 20_000;
const DONE_AFTER_MS = 6_000;

function read(): string | null {
  try { return localStorage.getItem(STORE); } catch { return null; }
}
function save(token: string | null) {
  try { token ? localStorage.setItem(STORE, token) : localStorage.removeItem(STORE); } catch { /* storage blocked */ }
}

/** Badge QR codes carry "shiftbadge:CODE"; anything else scanned is ignored. Typed codes are accepted as-is. */
export function badgeFromScan(text: string): string | null {
  const t = text.trim();
  return t.toLowerCase().startsWith(BADGE_PREFIX) ? t.slice(BADGE_PREFIX.length) : null;
}

type Screen =
  | { kind: "idle"; error?: string }
  | { kind: "scan" }
  | { kind: "who"; badge: string; name: string; state: State; error?: string; busy?: Action; pending?: { action: Action; endBreak?: boolean; key: string } }
  | { kind: "done"; name: string; text: string };

export function start() {
  // Pairing: /kiosk#pair=TOKEN stores the device token, then removes it from the address bar and history.
  const pairing = fragmentParam("pair");
  if (pairing) {
    save(pairing);
    history.replaceState(null, "", "/kiosk");
  }
  const token = read();
  document.title = "Kiosk · Shift";
  if (!token) {
    mount(h("div", { class: "kiosk" }, h("div", { class: "kiosk-stage" }, h("div", { class: "kiosk-card" },
      h("h1", {}, "This tablet isn't set up yet"),
      h("p", {}, "Ask an administrator to open the kiosk pairing link on this device."),
    ))));
    return;
  }
  const auth = `Kiosk ${token}`;
  let screen: Screen = { kind: "idle" };
  let timeout: number | undefined;
  let stopCamera: (() => void) | null = null;
  const clock = h("div", { class: "kiosk-clock", "aria-hidden": "true" });
  const updateClock = () => (clock.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date()));
  updateClock();
  setInterval(updateClock, 5000);
  keepAwake();

  const go = (next: Screen, resetAfter?: number) => {
    stopCamera?.();
    stopCamera = null;
    window.clearTimeout(timeout);
    screen = next;
    if (resetAfter) timeout = window.setTimeout(() => go({ kind: "idle" }), resetAfter);
    render();
  };

  const identify = async (badge: string) => {
    try {
      const who = await api<{ display_name: string; state: State }>("POST", "/api/v1/kiosk/identify", auth, { badge });
      go({ kind: "who", badge, name: who.display_name, state: who.state }, IDLE_AFTER_MS);
      announce(`${who.display_name}, ${STATE_TEXT[who.state]}`);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) {
        save(null);
        location.reload();
        return;
      }
      go({ kind: "idle", error: err.message });
    }
  };

  const doPunch = async (action: Action, endBreak?: boolean) => {
    if (screen.kind !== "who" || screen.busy) return;
    const s = screen;
    const pending = s.pending?.action === action ? s.pending : { action, endBreak, key: crypto.randomUUID() };
    go({ ...s, busy: action, pending, error: undefined }, IDLE_AFTER_MS);
    try {
      const res = await api<{ event: { occurred_at: string } }>(
        "POST", "/api/v1/kiosk/punch", auth,
        { badge: s.badge, action, end_break: endBreak, client_time: new Date().toISOString() },
        { "idempotency-key": pending.key },
      );
      const text = `${DONE_TEXT[action]} at ${fmtTimeSec(res.event.occurred_at, Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
      announce(`${s.name}: ${text}`);
      go({ kind: "done", name: s.name, text }, DONE_AFTER_MS);
    } catch (e) {
      const err = e as ApiError;
      go({ ...s, busy: undefined, pending: err.network ? pending : undefined, error: err.network ? "No connection, so this wasn't recorded. Try again; it will only count once." : err.message }, IDLE_AFTER_MS);
    }
  };

  function render() {
    const stage = h("div", { class: "kiosk-stage" });
    const card = h("div", { class: "kiosk-card pop" });
    stage.append(card);
    if (screen.kind === "idle") {
      const input = h("input", { type: "text", class: "code-input", id: "code", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: "20", placeholder: "XXXX-XXXX-XXXX", "aria-describedby": screen.error ? "kerr" : undefined }) as HTMLInputElement;
      card.append(
        h("h1", {}, "Tap to clock in or out"),
        screen.error ? h("div", { class: "notice error", role: "alert", id: "kerr" }, h("p", {}, screen.error)) : "",
        h("div", { class: "actions" }, h("button", { class: "btn btn-primary", onclick: () => go({ kind: "scan" }, IDLE_AFTER_MS) }, "Scan my badge")),
        h("form", { style: "margin-top:1.5rem", onsubmit: (ev: Event) => { ev.preventDefault(); if (input.value.trim()) void identify(input.value); } },
          h("label", { for: "code" }, "Or type your badge code"),
          h("div", { class: "btn-row", style: "flex-wrap:nowrap" }, input, h("button", { class: "btn", type: "submit" }, "Continue")),
        ),
      );
    } else if (screen.kind === "scan") {
      const video = h("video", { playsinline: true, muted: true, "aria-label": "Camera preview" }) as HTMLVideoElement;
      card.append(h("h1", {}, "Hold your badge up to the camera"), h("div", { class: "scan" }, video), h("button", { class: "btn btn-quiet", onclick: () => go({ kind: "idle" }) }, "Cancel"));
      void startScanner(video, (badge) => void identify(badge), (msg) => go({ kind: "idle", error: msg })).then((stop) => {
        if (screen.kind === "scan") stopCamera = stop;
        else stop();
      });
    } else if (screen.kind === "who") {
      const s = screen;
      card.append(
        h("p", { class: "muted" }, "Hello"),
        h("h1", {}, s.name),
        h("p", {}, h("span", { class: `pill ${s.state}` }, STATE_TEXT[s.state])),
        s.error ? h("div", { class: "notice error", role: "alert" }, h("p", {}, s.error)) : "",
        h("div", { class: "actions", style: "margin-top:1rem" },
          ...actionsFor(s.state).map((a) => h("button", { class: `btn ${a.kind}`, disabled: !!s.busy, onclick: () => doPunch(a.action, a.endBreak) }, s.busy === a.action ? "Saving…" : a.label)),
        ),
        h("button", { class: "btn btn-quiet", style: "margin-top:1rem", onclick: () => go({ kind: "idle" }) }, "Not you? Start again"),
      );
    } else {
      card.append(h("div", { class: "big-tick", "aria-hidden": "true" }, "✓"), h("h1", {}, screen.name), h("p", { style: "font-size:1.4rem" }, screen.text));
    }
    mount(h("div", { class: "kiosk" }, h("div", { class: "kiosk-top" }, clock, h("span", { class: "muted small" }, "Shift kiosk")), stage));
    (card.querySelector("input, .btn-primary") as HTMLElement | null)?.focus();
  }

  render();
}

/** Front camera + jsQR (loaded only here). Returns a stop function that releases the camera. */
async function startScanner(video: HTMLVideoElement, onBadge: (badge: string) => void, onError: (msg: string) => void): Promise<() => void> {
  let stream: MediaStream | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
  };
  try {
    const [{ default: jsQR }, media] = await Promise.all([
      import("jsqr"),
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 } }, audio: false }),
    ]);
    stream = media;
    if (stopped) {
      stop();
      return stop;
    }
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const scan = () => {
      if (stopped) return;
      if (video.readyState >= 2) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const found = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
        const badge = found ? badgeFromScan(found.data) : null;
        if (badge) {
          stop();
          onBadge(badge);
          return;
        }
      }
      setTimeout(scan, 200);
    };
    scan();
  } catch {
    stop();
    onError("The camera isn't available. Type your badge code instead.");
  }
  return stop;
}

/** Keep the tablet screen on where the Screen Wake Lock API exists. */
function keepAwake() {
  const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<unknown> } };
  const request = () => nav.wakeLock?.request("screen").catch(() => undefined);
  void request();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void request());
}
