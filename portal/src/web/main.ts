import { BRAND, brand, h, mount } from "./lib";

const path = location.pathname.replace(/\/+$/, "") || "/";

if (path === "/s") import("./personal").then((m) => m.start());
else if (path === "/kiosk") import("./kiosk").then((m) => m.start());
else if (path === "/admin") import("./admin").then((m) => m.start());
else {
  document.title = BRAND;
  mount(
    h("div", { class: "solo" },
      h("div", { class: "topbar" }, brand()),
      h("section", { class: "card" },
        h("h1", {}, "Clock in with one tap"),
        h("p", {}, "Open the personal link your manager sent you to start or end a shift, or use the tablet at work."),
        h("p", { class: "muted small", style: "margin:0" }, "Lost your link? Ask your manager for a new one. Old links stop working as soon as a new one is issued."),
      ),
    ),
  );
}
