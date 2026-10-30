import { api, ApiError, BRAND, brand, EVENT_TEXT, fmtDate, h, hm, hms, mount, STATE_TEXT, toast, type State } from "./lib";

const KEY_STORE = "shift.admin";
type Tab = "live" | "people" | "activity" | "timesheet" | "kiosks" | "integration";
const TABS: Array<[Tab, string]> = [["live", "Live"], ["people", "People"], ["activity", "Activity"], ["timesheet", "Timesheet"], ["kiosks", "Kiosks"], ["integration", "Integration"]];
const LIVE_REFRESH_MS = 30_000;

interface Employee {
  id: string;
  display_name: string;
  external_ref: string | null;
  link_enabled: boolean;
  kiosk_enabled: boolean;
  active: boolean;
  state: State;
  since: string | null;
}
interface Overview {
  timezone: string;
  server_time: string;
  counts: Record<State, number>;
  today: { worked_seconds: number; punches: number };
  people: Array<{ id: string; display_name: string; external_ref: string | null; state: State; since: string | null; today_worked_seconds: number }>;
}
interface Issued {
  employee: Employee;
  link_url: string | null;
  badge_code: string | null;
}

function getKey(): string | null {
  try { return sessionStorage.getItem(KEY_STORE); } catch { return null; }
}
function setKey(v: string | null) {
  try { v ? sessionStorage.setItem(KEY_STORE, v) : sessionStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
}

async function qrSvg(text: string): Promise<string> {
  const QR = await import("qrcode");
  return QR.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}
function svgNode(markup: string): Element {
  // Generated locally by the qrcode library from our own data; parsed as SVG, never as HTML.
  return new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
}

export function start() {
  document.title = `Admin · ${BRAND}`;
  const key = getKey();
  if (!key) return signIn();
  const auth = `Bearer ${key}`;
  const call = <T = any>(method: string, path: string, body?: unknown) =>
    api<T>(method, path, auth, body).catch((e: ApiError) => {
      if (e.status === 401) {
        setKey(null);
        signIn("That API key was not accepted.");
      }
      throw e;
    });

  const fromHash = location.hash.slice(1) as Tab;
  let tab: Tab = TABS.some(([id]) => id === fromHash) ? fromHash : "live";
  // Timers owned by the current view; cleared whenever the view changes.
  let timers: number[] = [];
  let generation = 0;
  const clearTimers = () => { generation++; timers.forEach((t) => window.clearInterval(t)); timers = []; };
  const errMsg = (e: unknown) => (e as Error).message;
  let issued: Issued | null = null;
  let pairing: { name: string; url: string } | null = null;
  const body = h("div");
  const shell = () => {
    clearTimers();
    mount(
      h("div", { class: "admin" },
        h("div", { class: "admin-head" },
          h("h1", { style: "margin:0" }, brand("Admin")),
          h("button", { class: "btn btn-quiet", onclick: () => { setKey(null); location.reload(); } }, "Sign out"),
        ),
        h("div", { class: "tabs", role: "tablist", "aria-label": "Sections" },
          ...TABS.map(([id, label]) => h("button", { role: "tab", "aria-selected": String(tab === id), onclick: () => { tab = id; history.replaceState(null, "", `#${id}`); shell(); } }, label)),
        ),
        body,
      ),
    );
    void views[tab]();
  };
  const fail = (e: unknown) => body.replaceChildren(h("div", { class: "notice error", role: "alert" }, h("p", {}, (e as Error).message)));

  async function credentialsPanel(i: Issued) {
    const panel = h("section", { class: "panel notice ok", "aria-live": "polite" },
      h("h2", {}, `Credentials for ${i.employee.display_name}`),
      h("p", { class: "small" }, "Shown once. Send the link to the person privately; print the badge for the kiosk. Issuing new ones makes these stop working."),
    );
    if (i.link_url) {
      const link = i.link_url;
      panel.append(h("div", { class: "secret", style: "margin-bottom:1rem" },
        svgNode(await qrSvg(link)),
        h("div", {}, h("strong", {}, "Personal link"), h("br"), h("code", {}, link), h("br"),
          h("button", { class: "btn btn-sm", style: "margin-top:.5rem", onclick: async () => {
            try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch { toast("Couldn't copy. Select the link and copy it instead.", "error"); }
          } }, "Copy link"))));
    }
    if (i.badge_code) {
      const code = i.badge_code;
      const badgeQr = await qrSvg(`shiftbadge:${code}`);
      panel.append(h("div", { class: "secret" },
        svgNode(badgeQr),
        h("div", {}, h("strong", {}, "Kiosk badge code"), h("br"), h("code", {}, code), h("br"),
          h("button", { class: "btn btn-sm", style: "margin-top:.5rem", onclick: () => printBadges([{ name: i.employee.display_name, code, svg: badgeQr }]) }, "Print badge"))));
    }
    panel.append(h("button", { class: "btn btn-quiet", onclick: () => { issued = null; shell(); } }, "Done"));
    return panel;
  }

  const views: Record<Tab, () => Promise<void>> = {
    async live() {
      const mine = generation;
      const stats = h("div", { class: "stats" });
      const onShift = h("div");
      const offShift = h("div");
      const updated = h("span", { class: "muted small", role: "status" });
      let data: Overview | null = null;
      let loadedAt = 0;
      let skewMs = 0;
      const since = (iso: string) => hms((Date.now() + skewMs - new Date(iso).getTime()) / 1000);
      const elapsed: Array<[HTMLElement, string]> = [];
      const tick = () => { for (const [el, iso] of elapsed) el.textContent = since(iso); };
      const draw = () => {
        if (!data) return;
        const d = data;
        const stat = (cls: string, label: string, value: string, dot = false) =>
          h("div", { class: `stat ${cls}` }, h("div", { class: "label" }, dot && h("span", { class: "live-dot", "aria-hidden": "true" }), label), h("div", { class: "value" }, value));
        // Today's total keeps growing for people who are working; extrapolate between refreshes.
        const working = d.counts.IN;
        const worked = d.today.worked_seconds + working * (Date.now() - loadedAt) / 1000;
        stats.replaceChildren(
          stat("IN", "On shift", String(d.counts.IN), true),
          stat("BREAK", "On break", String(d.counts.BREAK)),
          stat("OUT", "Clocked out", String(d.counts.OUT)),
          stat("", "Worked today", hm(worked)),
          stat("", "Punches today", String(d.today.punches)),
        );
        elapsed.length = 0;
        const active = d.people.filter((p) => p.state !== "OUT");
        onShift.replaceChildren(
          h("h2", { class: "section-title" }, "Working now"),
          active.length === 0 ? h("div", { class: "panel empty" }, "No one is on shift right now.") :
          h("div", { class: "people-grid" }, ...active.map((p) => {
            const el = h("div", { class: "elapsed" }, since(p.since!));
            elapsed.push([el, p.since!]);
            return h("div", { class: `person ${p.state}` },
              h("strong", {}, p.display_name),
              h("span", { class: `pill ${p.state}` }, STATE_TEXT[p.state]),
              el,
              h("div", { class: "muted small" }, `${p.state === "BREAK" ? "Break started" : "Since"} ${new Date(p.since!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${hm(p.today_worked_seconds)} today`),
            );
          })),
        );
        const rest = d.people.filter((p) => p.state === "OUT");
        offShift.replaceChildren(
          h("h2", { class: "section-title" }, "Clocked out"),
          rest.length === 0 ? h("p", { class: "muted" }, "Everyone is on shift.") :
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Name"), h("th", { scope: "col" }, "Last punch"), h("th", { scope: "col", class: "num" }, "Worked today"))),
            h("tbody", {}, ...rest.map((p) => h("tr", {},
              h("td", {}, p.display_name),
              h("td", { class: "small muted" }, p.since ? new Date(p.since).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "Never"),
              h("td", { class: "num" }, p.today_worked_seconds ? hm(p.today_worked_seconds) : "—"),
            ))),
          )),
        );
        tick();
      };
      const refresh = async () => {
        try {
          data = await call<Overview>("GET", "/api/v1/overview");
          loadedAt = Date.now();
          skewMs = new Date(data.server_time).getTime() - Date.now();
          updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
          draw();
        } catch (e) {
          if (!data) fail(e);
          else updated.textContent = `Couldn't refresh: ${errMsg(e)}`;
        }
      };
      body.replaceChildren(
        h("div", { class: "toolbar" },
          h("div", {}, h("h2", { style: "margin:0" }, fmtDate(new Date())), updated),
          h("button", { class: "btn btn-sm", onclick: () => void refresh() }, "Refresh"),
        ),
        stats, onShift, offShift,
      );
      await refresh();
      if (generation !== mine) return;
      timers.push(window.setInterval(tick, 1000));
      timers.push(window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, LIVE_REFRESH_MS));
    },

    async people() {
      try {
        const { employees } = await call<{ employees: Employee[] }>("GET", "/api/v1/employees");
        const name = h("input", { type: "text", id: "n", required: true, maxlength: "120" }) as HTMLInputElement;
        const ref = h("input", { type: "text", id: "r", maxlength: "120", placeholder: "Optional" }) as HTMLInputElement;
        const add = h("form", { class: "panel", onsubmit: async (ev: Event) => {
          ev.preventDefault();
          try {
            issued = await call<Issued>("POST", "/api/v1/employees", { display_name: name.value, external_ref: ref.value.trim() || null });
            toast(`Added ${issued.employee.display_name}`);
            shell();
          } catch (e) { toast(errMsg(e), "error"); }
        } },
          h("h2", {}, "Add a person"),
          h("div", { class: "inline-form" },
            h("div", {}, h("label", { for: "n" }, "Name"), name),
            h("div", {}, h("label", { for: "r" }, "ID in your main system"), ref),
            h("div", {}, h("button", { class: "btn btn-primary", type: "submit" }, "Add and create link")),
          ),
        );
        const toggle = (e: Employee, field: "link_enabled" | "kiosk_enabled" | "active", label: string) =>
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: e[field], onchange: async (ev: Event) => {
            const box = ev.target as HTMLInputElement;
            try { await call("PATCH", `/api/v1/employees/${e.id}`, { [field]: box.checked }); toast(`${label} ${box.checked ? "on" : "off"} for ${e.display_name}`); }
            catch (err) { box.checked = !box.checked; toast(errMsg(err), "error"); }
          } }), label);
        const rotate = async (e: Employee, which: { link?: boolean; badge?: boolean }, what: string) => {
          if (!confirm(`Issue a new ${what} for ${e.display_name}? The current one stops working immediately.`)) return;
          try {
            issued = await call<Issued>("POST", `/api/v1/employees/${e.id}/credentials`, which);
            shell();
          } catch (err) { toast(errMsg(err), "error"); }
        };
        const search = h("input", { type: "search", id: "ps", placeholder: "Search by name or ID", autocomplete: "off" }) as HTMLInputElement;
        const count = h("span", { class: "muted small", role: "status" });
        const rows = employees.map((e) => [e, h("tr", { style: e.active ? undefined : "opacity:.6" },
              h("td", {}, h("strong", {}, e.display_name)),
              h("td", {}, h("span", { class: `pill ${e.state}` }, STATE_TEXT[e.state])),
              h("td", { class: "small" }, e.external_ref ?? "—"),
              h("td", {}, toggle(e, "link_enabled", "Personal link"), toggle(e, "kiosk_enabled", "Kiosk badge"), toggle(e, "active", "Active")),
              h("td", {}, h("div", { class: "btn-row" },
                h("button", { class: "btn btn-sm", onclick: () => rotate(e, { link: true }, "personal link") }, "Link"),
                h("button", { class: "btn btn-sm", onclick: () => rotate(e, { badge: true }, "badge code") }, "Badge"))),
            )] as const);
        const filter = () => {
          const q = search.value.trim().toLowerCase();
          let shown = 0;
          for (const [e, tr] of rows) {
            const hit = !q || e.display_name.toLowerCase().includes(q) || (e.external_ref ?? "").toLowerCase().includes(q);
            tr.hidden = !hit;
            if (hit) shown++;
          }
          count.textContent = q ? `${shown} of ${employees.length} shown` : `${employees.length} ${employees.length === 1 ? "person" : "people"}`;
        };
        search.addEventListener("input", filter);
        filter();
        body.replaceChildren(
          ...(issued ? [await credentialsPanel(issued)] : []),
          add,
          employees.length === 0 ? h("div", { class: "panel empty" }, "No one yet. Add your first person above.") : h("div", {},
            h("div", { class: "toolbar" }, h("div", {}, h("label", { for: "ps", class: "sr" }, "Search people"), search), count),
            h("div", { class: "table-wrap" }, h("table", {},
              h("thead", {}, h("tr", {}, ...["Name", "Status", "Main-system ID", "Access", "New credentials"].map((t) => h("th", { scope: "col" }, t)))),
              h("tbody", {}, ...rows.map(([, tr]) => tr)),
            )),
          ),
        );
      } catch (e) { fail(e); }
    },

    async kiosks() {
      try {
        const { kiosks } = await call<{ kiosks: Array<{ id: string; name: string; active: boolean; last_seen_at: string | null }> }>("GET", "/api/v1/kiosks");
        const name = h("input", { type: "text", id: "kn", required: true, maxlength: "80", placeholder: "Front desk tablet" }) as HTMLInputElement;
        const pairPanel = pairing ? h("section", { class: "panel notice ok" },
          h("h2", {}, `Pair "${pairing.name}"`),
          h("p", { class: "small" }, "Open this link on the tablet once (or scan the code with its camera). It's shown only now."),
          h("div", { class: "secret" }, svgNode(await qrSvg(pairing.url)), h("code", {}, pairing.url)),
          h("button", { class: "btn btn-quiet", onclick: () => { pairing = null; shell(); } }, "Done"),
        ) : null;
        body.replaceChildren(
          ...(pairPanel ? [pairPanel] : []),
          h("form", { class: "panel", onsubmit: async (ev: Event) => {
            ev.preventDefault();
            try {
              const res = await call<{ pairing_url: string; kiosk: { name: string } }>("POST", "/api/v1/kiosks", { name: name.value });
              pairing = { name: res.kiosk.name, url: res.pairing_url };
              shell();
            } catch (e) { toast(errMsg(e), "error"); }
          } }, h("h2", {}, "Add a kiosk"), h("div", { class: "inline-form" }, h("div", {}, h("label", { for: "kn" }, "Name"), name), h("div", {}, h("button", { class: "btn btn-primary", type: "submit" }, "Create pairing link")))),
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, ...["Kiosk", "Last used", "Status", ""].map((t) => h("th", { scope: "col" }, t)))),
            h("tbody", {}, ...(kiosks.length ? kiosks.map((k) => h("tr", {},
              h("td", {}, k.name),
              h("td", { class: "small" }, k.last_seen_at ? new Date(k.last_seen_at).toLocaleString() : "Never"),
              h("td", {}, h("span", { class: `pill ${k.active ? "IN" : "OUT"}` }, k.active ? "Active" : "Revoked")),
              h("td", {}, k.active && h("button", { class: "btn btn-sm btn-danger", onclick: async () => {
                if (!confirm(`Revoke "${k.name}"? It stops working immediately.`)) return;
                try {
                  await call("POST", `/api/v1/kiosks/${k.id}/revoke`);
                  toast(`Revoked ${k.name}`);
                  shell();
                } catch (e) { toast(errMsg(e), "error"); }
              } }, "Revoke")),
            )) : [h("tr", {}, h("td", { colspan: "4", class: "muted" }, "No kiosks yet."))])),
          )),
        );
      } catch (e) { fail(e); }
    },

    async activity() {
      try {
        const { employees } = await call<{ employees: Employee[] }>("GET", "/api/v1/employees");
        const who = h("select", { id: "aw" },
          h("option", { value: "" }, "Everyone"),
          ...employees.map((e) => h("option", { value: e.id }, e.display_name)),
        ) as HTMLSelectElement;
        const out = h("div");
        const load = async () => {
          try {
            const q = who.value ? `&employee_id=${encodeURIComponent(who.value)}` : "";
            const { events } = await call<{ events: Array<{ id: string; type: string; occurred_at: string; employee: { display_name: string }; source: string }> }>("GET", `/api/v1/events?order=desc&limit=100${q}`);
            out.replaceChildren(h("div", { class: "table-wrap" }, h("table", {},
              h("thead", {}, h("tr", {}, ...["When", "Who", "What", "Where"].map((t) => h("th", { scope: "col" }, t)))),
              h("tbody", {}, ...(events.length ? events.map((e) => h("tr", {},
                h("td", { class: "num" }, new Date(e.occurred_at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })),
                h("td", {}, e.employee.display_name),
                h("td", {}, h("span", { class: `pill ${e.type === "clock_out" ? "OUT" : e.type === "break_start" ? "BREAK" : "IN"}` }, EVENT_TEXT[e.type] ?? e.type)),
                h("td", { class: "small" }, e.source === "kiosk" ? "Kiosk" : e.source === "link" ? "Personal link" : "API"),
              )) : [h("tr", {}, h("td", { colspan: "4", class: "empty" }, "No punches yet."))])),
            )));
          } catch (e) { out.replaceChildren(h("div", { class: "notice error", role: "alert" }, h("p", {}, errMsg(e)))); }
        };
        who.addEventListener("change", () => void load());
        body.replaceChildren(
          h("div", { class: "toolbar" },
            h("div", {}, h("label", { for: "aw" }, "Person"), who),
            h("p", { class: "muted small", style: "margin:0;max-width:28rem" }, "The 100 most recent punches. Times are official server times, shown in your browser's timezone."),
          ),
          out,
        );
        await load();
      } catch (e) { fail(e); }
    },

    async timesheet() {
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const today = iso(new Date());
      const weekAgo = iso(new Date(Date.now() - 6 * 86400_000));
      const from = h("input", { type: "date", id: "f", value: weekAgo }) as HTMLInputElement;
      const to = h("input", { type: "date", id: "t", value: today }) as HTMLInputElement;
      const out = h("div");
      const run = async () => {
        try {
          const res = await call<{ timezone: string; lines: Array<{ display_name: string; date: string; worked_seconds: number }> }>("GET", `/api/v1/timesheet?from=${from.value}&to=${to.value}`);
          const totals = new Map<string, { seconds: number; days: number }>();
          for (const l of res.lines) {
            const t = totals.get(l.display_name) ?? { seconds: 0, days: 0 };
            totals.set(l.display_name, { seconds: t.seconds + l.worked_seconds, days: t.days + 1 });
          }
          const grand = res.lines.reduce((t, l) => t + l.worked_seconds, 0);
          const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
          out.replaceChildren(
            h("p", { class: "muted small" }, `Days are calculated in ${res.timezone}.`),
            res.lines.length === 0 ? h("div", { class: "panel empty" }, "No time recorded in this period.") : h("div", {},
              h("h2", { class: "section-title" }, "Totals"),
              h("div", { class: "table-wrap", style: "margin-bottom:1.5rem" }, h("table", {},
                h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Person"), h("th", { scope: "col", class: "num" }, "Days worked"), h("th", { scope: "col", class: "num" }, "Total"))),
                h("tbody", {}, ...[...totals].map(([n, t]) => h("tr", {}, h("td", {}, h("strong", {}, n)), h("td", { class: "num" }, String(t.days)), h("td", { class: "num" }, hm(t.seconds))))),
                h("tfoot", {}, h("tr", {}, h("td", {}, "Everyone"), h("td", { class: "num" }, String(res.lines.length)), h("td", { class: "num" }, hm(grand)))),
              )),
              h("h2", { class: "section-title" }, "By day"),
              h("div", { class: "table-wrap" }, h("table", {},
                h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Person"), h("th", { scope: "col" }, "Date"), h("th", { scope: "col", class: "num" }, "Worked"))),
                h("tbody", {}, ...res.lines.map((l) => h("tr", {}, h("td", {}, l.display_name), h("td", { class: "num", style: "text-align:left" }, day(l.date)), h("td", { class: "num" }, hm(l.worked_seconds))))),
              )),
            ),
          );
        } catch (e) { out.replaceChildren(h("div", { class: "notice error" }, h("p", {}, (e as Error).message))); }
      };
      const download = async () => {
        const res = await fetch(`/api/v1/timesheet?from=${from.value}&to=${to.value}&format=csv`, { headers: { authorization: auth } });
        if (!res.ok) return toast("Download failed. Check the dates and try again.", "error");
        const url = URL.createObjectURL(await res.blob());
        h("a", { href: url, download: `timesheet_${from.value}_${to.value}.csv` }).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      const preset = (label: string, f: Date, t: Date) => h("button", { class: "btn btn-sm btn-quiet", type: "button", onclick: () => { from.value = iso(f); to.value = iso(t); void run(); } }, label);
      const now = new Date();
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
      const lastMonday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
      const lastSunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 1);
      body.replaceChildren(
        h("form", { class: "panel", onsubmit: (ev: Event) => { ev.preventDefault(); void run(); } },
          h("div", { class: "inline-form" },
            h("div", {}, h("label", { for: "f" }, "From"), from),
            h("div", {}, h("label", { for: "t" }, "To"), to),
            h("div", { class: "btn-row" }, h("button", { class: "btn btn-primary", type: "submit" }, "Show"), h("button", { class: "btn", type: "button", onclick: download }, "Download CSV")),
          ),
          h("div", { class: "btn-row", style: "margin-top:.75rem" },
            h("span", { class: "muted small" }, "Quick ranges:"),
            preset("This week", monday, now),
            preset("Last week", lastMonday, lastSunday),
            preset("This month", new Date(now.getFullYear(), now.getMonth(), 1), now),
            preset("Last 30 days", new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29), now),
          ),
        ),
        out,
      );
      void run();
    },

    async integration() {
      try {
        const status = await call<{ configured: boolean; url: string | null; counts: Array<{ status: string; n: number; last_error: string | null }> }>("GET", "/api/v1/webhooks/status");
        const count = (s: string) => status.counts.find((c) => c.status === s)?.n ?? 0;
        const err = status.counts.find((c) => c.last_error)?.last_error;
        body.replaceChildren(
          h("section", { class: "panel" },
            h("h2", {}, "Webhooks"),
            status.configured
              ? h("p", {}, `Sending every punch to ${status.url}, signed with your webhook secret. Delivered: ${count("delivered")}. Waiting to retry: ${count("pending")}. Gave up: ${count("dead")}.`)
              : h("p", {}, "Not configured. Set WEBHOOK_URL and WEBHOOK_SECRET on the server to push every punch to your main system."),
            err && h("p", { class: "small" }, `Most recent error: ${err}`),
            status.configured && h("button", { class: "btn", onclick: async () => {
              try {
                const r = await call<{ delivered: number; failed: number }>("POST", "/api/v1/webhooks/deliver");
                toast(`Delivered ${r.delivered}, failed ${r.failed}.`, r.failed ? "error" : "ok");
                shell();
              } catch (e) { toast(errMsg(e), "error"); }
            } }, "Retry now"),
          ),
          h("section", { class: "panel" },
            h("h2", {}, "REST API"),
            h("p", {}, "Your main system can pull every punch in order with ", h("code", {}, "GET /api/v1/events?after=<cursor>"), " using this API key, and manage people with the employees endpoints."),
            h("p", {}, h("a", { href: "/api/v1/openapi.yaml", target: "_blank", rel: "noopener" }, "OpenAPI specification")),
          ),
        );
      } catch (e) { fail(e); }
    },
  };

  shell();
}

function signIn(error?: string) {
  const input = h("input", { type: "password", id: "k", autocomplete: "off", required: true, minlength: "32" }) as HTMLInputElement;
  mount(h("div", { class: "solo" },
    h("div", { class: "topbar" }, brand("Admin")),
    h("section", { class: "card" },
    h("h1", {}, "Sign in"),
    error && h("div", { class: "notice error", role: "alert" }, h("p", {}, error)),
    h("form", { onsubmit: (ev: Event) => { ev.preventDefault(); setKey(input.value.trim()); location.reload(); } },
      h("div", { class: "field" }, h("label", { for: "k" }, "API key"), input, h("p", { class: "muted small" }, "Kept only in this browser tab and forgotten when you close it.")),
      h("button", { class: "btn btn-primary", type: "submit" }, "Continue"),
    ),
    ),
  ));
  input.focus();
}

function printBadges(badges: Array<{ name: string; code: string; svg: string }>) {
  const sheet = h("div", { class: "badges" }, ...badges.map((b) => h("div", { class: "badge" }, svgNode(b.svg), h("div", {}, h("strong", {}, b.name), h("code", {}, b.code), h("p", { style: "font-size:8pt;margin-top:2mm" }, "Scan at the kiosk to start or end your shift.")))));
  document.body.append(sheet);
  window.print();
  sheet.remove();
}
