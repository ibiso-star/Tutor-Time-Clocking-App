import { h, mount } from "./lib";

const path = location.pathname.replace(/\/+$/, "") || "/";

if (path === "/s") import("./personal").then((m) => m.start());
else if (path === "/kiosk") import("./kiosk").then((m) => m.start());
else if (path === "/admin") import("./admin").then((m) => m.start());
else {
  document.title = "Shift";
  mount(
    h("div", { class: "solo" },
      h("h1", {}, "Shift"),
      h("p", {}, "Open the personal link your manager sent you to start or end a shift, or use the tablet at work."),
      h("p", { class: "muted small" }, "Lost your link? Ask your manager for a new one."),
    ),
  );
}
