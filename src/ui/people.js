// Player chips for social features: avatar with an online dot, presence text, and the
// pop-up notices used for incoming challenges and messages.
import { h, timeAgo } from "./dom.js";

export function userAvatar(u, size = "") {
  const a = (u && u.avatar) || { emoji: "♟", bg: "#3a2e24" };
  const status = u && u.status && u.status !== "offline" ? u.status : null;
  return h("span.av-wrap",
    h(`div.avatar${size}`, { style: { background: a.bg } }, a.emoji),
    status ? h(`span.presence.${status}`, { title: status === "playing" ? "Playing now" : "Online" }) : null);
}

export function presenceText(u) {
  if (!u) return "";
  if (u.status === "playing") return "Playing now";
  if (u.online) return "Online";
  return u.lastSeen ? `Last seen ${timeAgo(u.lastSeen)}` : "Offline";
}

// Notices sit at the top of the screen and can carry buttons, unlike toasts.
// actions: [{ label, primary?, onClick }]; a click on any action closes the notice.
export function notice({ avatar, title, text, actions = [], ms = 12000 }) {
  let root = document.getElementById("notice-root");
  if (!root) { root = h("div", { id: "notice-root", "aria-live": "polite" }); document.body.appendChild(root); }
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 220); };
  const el = h("div.notice",
    avatar || null,
    h("div.notice-text", h("b", title), text ? h("span", text) : null),
    h("div.notice-actions", ...actions.map(a => h(`button.btn.small${a.primary ? ".primary" : ""}`, { onclick: () => { close(); a.onClick(); } }, a.label)),
      h("button.notice-x", { "aria-label": "Dismiss", onclick: close }, "×")));
  root.appendChild(el);
  while (root.children.length > 3) root.firstChild.remove();
  if (ms) setTimeout(close, ms);
  return { close };
}
