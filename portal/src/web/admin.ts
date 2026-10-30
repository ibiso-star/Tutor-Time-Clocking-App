import { api, ApiError, EVENT_TEXT, h, hm, mount, STATE_TEXT, type State } from "./lib";

const KEY_STORE = "shift.admin";
type Tab = "people" | "kiosks" | "activity" | "timesheet" | "integration";

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
  document.title = "Admin · Shift";
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

  let tab: Tab = (location.hash.slice(1) as Tab) || "people";
  let issued: Issued | null = null;
  let pairing: { name: string; url: string } | null = null;
  const body = h("div");
  const shell = () => {
    const tabs: Array<[Tab, string]> = [["people", "People"], ["kiosks", "Kiosks"], ["activity", "Activity"], ["timesheet", "Timesheet"], ["integration", "Integration"]];
    mount(
      h("div", { class: "admin" },
        h("div", { class: "admin-head" },
          h("h1", {}, "Shift admin"),
          h("button", { class: "btn btn-quiet", onclick: () => { setKey(null); location.reload(); } }, "Sign out"),
        ),
        h("div", { class: "tabs", role: "tablist" },
          ...tabs.map(([id, label]) => h("button", { role: "tab", "aria-selected": String(tab === id), onclick: () => { tab = id; history.replaceState(null, "", `#${id}`); shell(); } }, label)),
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
          h("button", { class: "btn", style: "margin-top:.5rem", onclick: (ev: Event) => { void navigator.clipboard?.writeText(link); (ev.target as HTMLButtonElement).textContent = "Copied"; } }, "Copy link"))));
    }
    if (i.badge_code) {
      const code = i.badge_code;
      const badgeQr = await qrSvg(`shiftbadge:${code}`);
      panel.append(h("div", { class: "secret" },
        svgNode(badgeQr),
        h("div", {}, h("strong", {}, "Kiosk badge code"), h("br"), h("code", {}, code), h("br"),
          h("button", { class: "btn", style: "margin-top:.5rem", onclick: () => printBadges([{ name: i.employee.display_name, code, svg: badgeQr }]) }, "Print badge"))));
    }
    panel.append(h("button", { class: "btn btn-quiet", onclick: () => { issued = null; shell(); } }, "Done"));
    return panel;
  }

  const views: Record<Tab, () => Promise<void>> = {
    async people() {
      try {
        const { employees } = await call<{ employees: Employee[] }>("GET", "/api/v1/employees");
        const name = h("input", { type: "text", id: "n", required: true, maxlength: "120" }) as HTMLInputElement;
        const ref = h("input", { type: "text", id: "r", maxlength: "120", placeholder: "Optional" }) as HTMLInputElement;
        const add = h("form", { class: "panel", onsubmit: async (ev: Event) => {
          ev.preventDefault();
          try {
            issued = await call<Issued>("POST", "/api/v1/employees", { display_name: name.value, external_ref: ref.value.trim() || null });
            shell();
          } catch (e) { alert((e as Error).message); }
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
            try { await call("PATCH", `/api/v1/employees/${e.id}`, { [field]: box.checked }); }
            catch (err) { box.checked = !box.checked; alert((err as Error).message); }
          } }), label);
        const rotate = async (e: Employee, which: { link?: boolean; badge?: boolean }, what: string) => {
          if (!confirm(`Issue a new ${what} for ${e.display_name}? The current one stops working immediately.`)) return;
          issued = await call<Issued>("POST", `/api/v1/employees/${e.id}/credentials`, which);
          shell();
        };
        body.replaceChildren(
          ...(issued ? [await credentialsPanel(issued)] : []),
          add,
          employees.length === 0 ? h("p", { class: "muted" }, "No one yet. Add your first person above.") :
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, ...["Name", "Status", "Main-system ID", "Access", "New credentials"].map((t) => h("th", { scope: "col" }, t)))),
            h("tbody", {}, ...employees.map((e) => h("tr", { style: e.active ? undefined : "opacity:.6" },
              h("td", {}, h("strong", {}, e.display_name)),
              h("td", {}, h("span", { class: `pill ${e.state}` }, STATE_TEXT[e.state])),
              h("td", { class: "small" }, e.external_ref ?? "—"),
              h("td", {}, toggle(e, "link_enabled", "Personal link"), toggle(e, "kiosk_enabled", "Kiosk badge"), toggle(e, "active", "Active")),
              h("td", {}, h("div", { class: "btn-row" },
                h("button", { class: "btn", onclick: () => rotate(e, { link: true }, "personal link") }, "Link"),
                h("button", { class: "btn", onclick: () => rotate(e, { badge: true }, "badge code") }, "Badge"))),
            ))),
          )),
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
            const res = await call<{ pairing_url: string; kiosk: { name: string } }>("POST", "/api/v1/kiosks", { name: name.value });
            pairing = { name: res.kiosk.name, url: res.pairing_url };
            shell();
          } }, h("h2", {}, "Add a kiosk"), h("div", { class: "inline-form" }, h("div", {}, h("label", { for: "kn" }, "Name"), name), h("div", {}, h("button", { class: "btn btn-primary", type: "submit" }, "Create pairing link")))),
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, ...["Kiosk", "Last used", "Status", ""].map((t) => h("th", { scope: "col" }, t)))),
            h("tbody", {}, ...(kiosks.length ? kiosks.map((k) => h("tr", {},
              h("td", {}, k.name),
              h("td", { class: "small" }, k.last_seen_at ? new Date(k.last_seen_at).toLocaleString() : "Never"),
              h("td", {}, k.active ? "Active" : "Revoked"),
              h("td", {}, k.active && h("button", { class: "btn btn-danger", onclick: async () => {
                if (!confirm(`Revoke "${k.name}"? It stops working immediately.`)) return;
                await call("POST", `/api/v1/kiosks/${k.id}/revoke`);
                shell();
              } }, "Revoke")),
            )) : [h("tr", {}, h("td", { colspan: "4", class: "muted" }, "No kiosks yet."))])),
          )),
        );
      } catch (e) { fail(e); }
    },

    async activity() {
      try {
        const { events } = await call<{ events: Array<{ id: string; type: string; occurred_at: string; employee: { display_name: string }; source: string }> }>("GET", "/api/v1/events?order=desc&limit=100");
        body.replaceChildren(
          h("p", { class: "muted small" }, "The 100 most recent punches. Times are official server times, shown in your browser's timezone."),
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, ...["When", "Who", "What", "Where"].map((t) => h("th", { scope: "col" }, t)))),
            h("tbody", {}, ...(events.length ? events.map((e) => h("tr", {},
              h("td", { class: "num" }, new Date(e.occurred_at).toLocaleString()),
              h("td", {}, e.employee.display_name),
              h("td", {}, EVENT_TEXT[e.type] ?? e.type),
              h("td", { class: "small" }, e.source === "kiosk" ? "Kiosk" : e.source === "link" ? "Personal link" : "API"),
            )) : [h("tr", {}, h("td", { colspan: "4", class: "muted" }, "No punches yet."))])),
          )),
        );
      } catch (e) { fail(e); }
    },

    async timesheet() {
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
      const from = h("input", { type: "date", id: "f", value: weekAgo }) as HTMLInputElement;
      const to = h("input", { type: "date", id: "t", value: today }) as HTMLInputElement;
      const out = h("div");
      const run = async () => {
        try {
          const res = await call<{ timezone: string; lines: Array<{ display_name: string; date: string; worked_seconds: number }> }>("GET", `/api/v1/timesheet?from=${from.value}&to=${to.value}`);
          out.replaceChildren(
            h("p", { class: "muted small" }, `Days are calculated in ${res.timezone}.`),
            h("div", { class: "table-wrap" }, h("table", {},
              h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Person"), h("th", { scope: "col" }, "Date"), h("th", { scope: "col", class: "num" }, "Worked"))),
              h("tbody", {}, ...(res.lines.length ? res.lines.map((l) => h("tr", {}, h("td", {}, l.display_name), h("td", { class: "num" }, l.date), h("td", { class: "num" }, hm(l.worked_seconds))))
                : [h("tr", {}, h("td", { colspan: "3", class: "muted" }, "No time recorded in this period."))])),
            )),
          );
        } catch (e) { out.replaceChildren(h("div", { class: "notice error" }, h("p", {}, (e as Error).message))); }
      };
      const download = async () => {
        const res = await fetch(`/api/v1/timesheet?from=${from.value}&to=${to.value}&format=csv`, { headers: { authorization: auth } });
        if (!res.ok) return alert("Download failed.");
        const url = URL.createObjectURL(await res.blob());
        h("a", { href: url, download: `timesheet_${from.value}_${to.value}.csv` }).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      body.replaceChildren(
        h("form", { class: "panel", onsubmit: (ev: Event) => { ev.preventDefault(); void run(); } },
          h("div", { class: "inline-form" },
            h("div", {}, h("label", { for: "f" }, "From"), from),
            h("div", {}, h("label", { for: "t" }, "To"), to),
            h("div", { class: "btn-row" }, h("button", { class: "btn btn-primary", type: "submit" }, "Show"), h("button", { class: "btn", type: "button", onclick: download }, "Download CSV")),
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
            status.configured && h("button", { class: "btn", onclick: async () => { const r = await call<{ delivered: number; failed: number }>("POST", "/api/v1/webhooks/deliver"); alert(`Delivered ${r.delivered}, failed ${r.failed}.`); shell(); } }, "Retry now"),
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
    h("h1", {}, "Shift admin"),
    error && h("div", { class: "notice error", role: "alert" }, h("p", {}, error)),
    h("form", { onsubmit: (ev: Event) => { ev.preventDefault(); setKey(input.value.trim()); location.reload(); } },
      h("div", { class: "field" }, h("label", { for: "k" }, "API key"), input, h("p", { class: "muted small" }, "Kept only in this browser tab and forgotten when you close it.")),
      h("button", { class: "btn btn-primary", type: "submit" }, "Continue"),
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
