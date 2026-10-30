import { actionsFor, announce, api, ApiError, DONE_TEXT, EVENT_TEXT, fmtTime, fmtTimeSec, fragmentParam, h, hms, mount, STATE_TEXT, type Action, type State } from "./lib";

interface Me {
  employee: { display_name: string };
  state: State;
  since: string | null;
  today: { worked_seconds: number; events: Array<{ id: string; type: string; occurred_at: string; source: string }> };
  timezone: string;
  server_time: string;
}

/**
 * Personal link page (/s#t=TOKEN). The token lives only in the URL fragment and in memory: it is sent as
 * an Authorization header, never in a URL the server sees, and never written to storage.
 */
export function start() {
  const token = fragmentParam("t");
  if (!token) {
    mount(h("div", { class: "solo" }, h("h1", {}, "This link is incomplete"), h("p", {}, "Open the full link your manager sent you. It ends with a long code.")));
    return;
  }
  const auth = `Link ${token}`;
  let me: Me | null = null;
  let loadedAt = Date.now();
  let skewMs = 0;
  let busy: Action | null = null;
  let message: { kind: "error" | "ok" | "warn"; text: string } | null = null;
  // A punch that may not have reached the server keeps its key, so "Try again" can never double-record.
  let pending: { action: Action; endBreak?: boolean; key: string } | null = null;

  const load = async () => {
    try {
      me = await api<Me>("GET", "/api/v1/me", auth);
      loadedAt = Date.now();
      skewMs = new Date(me.server_time).getTime() - Date.now();
      document.title = `${STATE_TEXT[me.state]} · Shift`;
    } catch (e) {
      message = { kind: "error", text: (e as ApiError).message };
    }
    render();
  };

  const doPunch = async (action: Action, endBreak?: boolean) => {
    if (busy) return;
    if (!pending || pending.action !== action) pending = { action, endBreak, key: crypto.randomUUID() };
    busy = action;
    message = null;
    render();
    try {
      const res = await api<{ event: { occurred_at: string }; state: State }>(
        "POST", "/api/v1/punch", auth,
        { action, end_break: endBreak, client_time: new Date().toISOString() },
        { "idempotency-key": pending.key },
      );
      pending = null;
      const text = `${DONE_TEXT[action]} at ${fmtTimeSec(res.event.occurred_at, me?.timezone ?? "UTC")}`;
      message = { kind: "ok", text };
      announce(text);
      await load();
    } catch (e) {
      const err = e as ApiError;
      if (!err.network) pending = null;
      message = { kind: "error", text: err.network ? "No connection, so this wasn't recorded. Try again; it will only count once." : err.message };
      if (err.status === 409) await load();
    } finally {
      busy = null;
      render();
    }
  };

  const timerEl = h("p", { class: "timer", role: "timer" });
  const tick = () => {
    if (!me) return;
    const now = Date.now() + skewMs;
    const elapsedSinceLoad = (Date.now() - loadedAt) / 1000;
    if (me.state === "BREAK" && me.since) {
      timerEl.textContent = hms((now - new Date(me.since).getTime()) / 1000);
      timerEl.setAttribute("aria-label", "Time on break");
    } else {
      timerEl.textContent = hms(me.today.worked_seconds + (me.state === "IN" ? elapsedSinceLoad : 0));
      timerEl.setAttribute("aria-label", "Time worked today");
    }
  };
  setInterval(tick, 1000);
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());

  function render() {
    if (!me) {
      mount(h("div", { class: "solo" }, message ? h("div", { class: "notice error", role: "alert" }, h("p", {}, message.text)) : h("p", { class: "muted" }, "Loading…")));
      return;
    }
    const offline = !navigator.onLine;
    tick();
    const tz = me.timezone;
    mount(
      h("div", { class: "solo" },
        h("p", { class: "hello" }, `Hi ${me.employee.display_name.split(" ")[0]}`),
        h("h1", { class: `state ${me.state}` }, STATE_TEXT[me.state]),
        timerEl,
        h("p", { class: "sub" },
          me.state === "BREAK" ? `On break since ${fmtTime(me.since!, tz)}` : me.state === "IN" ? `Worked today. On shift since ${fmtTime(me.since!, tz)}.` : me.today.worked_seconds ? "Worked today" : "Ready when you are.",
        ),
        offline && h("div", { class: "notice warn", role: "status" }, h("p", {}, "You're offline. Punches need a connection so the official time can be recorded.")),
        message && h("div", { class: `notice ${message.kind} pop`, role: message.kind === "error" ? "alert" : "status" },
          h("p", {}, message.text),
          message.kind === "error" && pending && h("button", { class: "btn", onclick: () => doPunch(pending!.action, pending!.endBreak), disabled: offline }, "Try again"),
        ),
        h("div", { class: "actions" },
          ...actionsFor(me.state).map((a) =>
            h("button", { class: `btn ${a.kind}`, disabled: !!busy || offline, onclick: () => doPunch(a.action, a.endBreak) }, busy === a.action ? "Saving…" : a.label),
          ),
        ),
        me.today.events.length > 0 && h("section", { class: "day", "aria-labelledby": "today-h" },
          h("h2", { id: "today-h" }, "Today"),
          h("ol", {}, ...me.today.events.map((e) => h("li", { "data-t": e.type }, h("strong", {}, EVENT_TEXT[e.type] ?? e.type), " ", h("span", { class: "num" }, fmtTime(e.occurred_at, tz)), e.source === "kiosk" ? h("span", { class: "muted small" }, " at the kiosk") : null))),
        ),
        h("p", { class: "muted small", style: "margin-top:2rem" }, "This link is personal to you. Don't share it. Tip: add it to your home screen."),
      ),
    );
  }

  render();
  void load();
}
