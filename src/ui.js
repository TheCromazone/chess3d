// DOM overlay: menu, HUD, modals, toasts. All text comes from strings.js.
import { STR } from "./strings.js";
import { SFX, setSound, soundOn, unlockAudio } from "./audio.js";

const GLYPH = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛" };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

const $ = (id) => document.getElementById(id);

function fmtClock(ms) {
  if (ms === null || ms === undefined) return "--:--";
  ms = Math.max(0, ms);
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1);
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export class UI {
  constructor() {
    this._status = "";
    this._toastTimer = null;
    $("btn-sound").addEventListener("click", () => {
      setSound(!soundOn());
      $("btn-sound").textContent = soundOn() ? "🔊" : "🔇";
      if (soundOn()) SFX.move();
    });
    addEventListener("pointerdown", () => unlockAudio(), { once: true });
  }

  // ---------- menu ----------
  showMenu(onStart) {
    this._closeModal();
    this.hideInvite();
    $("menu").style.display = "flex";
    $("hud").style.display = "none";
    $("menu-main").style.display = "flex";
    $("menu-options").style.display = "none";

    let mode = null;
    const open = (m) => {
      mode = m;
      $("menu-main").style.display = "none";
      $("menu-options").style.display = "flex";
      $("opt-side-row").style.display = m === "ai" ? "" : "none";
      $("opt-level-row").style.display = m === "ai" ? "" : "none";
      $("online-hint").style.display = m === "online" ? "" : "none";
      $("opt-time-row").style.display = m === "online" ? "none" : "";
    };
    $("mode-ai").onclick = () => open("ai");
    $("mode-local").onclick = () => open("local");
    $("mode-online").onclick = () => open("online");
    $("opt-back").onclick = () => { $("menu-main").style.display = "flex"; $("menu-options").style.display = "none"; };
    $("opt-start").onclick = () => {
      const side0 = this._segValue("seg-side");
      const side = side0 === "random" ? (Math.random() < 0.5 ? "w" : "b") : side0;
      onStart({
        mode,
        side,
        level: Number(this._segValue("seg-level")),
        tcKey: this._segValue("seg-time"),
      });
    };
  }

  _segValue(id) { return $(id).querySelector(".on").dataset.v; }

  hideMenu() { $("menu").style.display = "none"; $("hud").style.display = ""; }

  // ---------- HUD ----------
  showGame(names) {
    this.hideMenu();
    this._names = names;
    $("top-name").textContent = names.top.name;
    $("bottom-name").textContent = names.bottom.name;
    $("top-dot").className = "cdot " + (names.top.color === "w" ? "cw" : "cb");
    $("bottom-dot").className = "cdot " + (names.bottom.color === "w" ? "cw" : "cb");
  }

  setStatus(t) { this._status = t; $("status").textContent = t; }
  statusText() { return this._status; }
  hintTurn() {}

  setMoveList(san) {
    const el = $("moves");
    let html = "";
    for (let i = 0; i < san.length; i += 2) {
      html += `<span class="mvnum">${i / 2 + 1}.</span><span class="mv">${san[i]}</span>`;
      if (san[i + 1]) html += `<span class="mv">${san[i + 1]}</span>`;
    }
    el.innerHTML = html;
    el.scrollLeft = el.scrollWidth;
    el.scrollTop = el.scrollHeight;
  }

  setCaptured(captured) {
    // tray next to a player shows the pieces that player has captured
    const bottomColor = this._names ? this._names.bottom.color : "w";
    const topColor = bottomColor === "w" ? "b" : "w";
    const sum = (arr) => arr.reduce((a, t) => a + VALUE[t], 0);
    const diff = sum(captured[topColor]) - sum(captured[bottomColor]); // bottom player's material lead
    const renderTray = (el, types, glyphClass, lead) => {
      const sorted = [...types].sort((a, b) => VALUE[a] - VALUE[b]);
      el.innerHTML = sorted.map(t => `<span class="${glyphClass}">${GLYPH[t]}</span>`).join("")
        + (lead > 0 ? `<span class="lead">+${lead}</span>` : "");
    };
    renderTray($("bottom-captured"), captured[topColor], topColor === "w" ? "gw" : "gb", diff);
    renderTray($("top-captured"), captured[bottomColor], bottomColor === "w" ? "gw" : "gb", -diff);
  }

  setClocks(clocks, active, bottomColor) {
    const be = $("bottom-clock"), te = $("top-clock");
    if (!clocks) { be.style.display = te.style.display = "none"; return; }
    be.style.display = te.style.display = "";
    const topColor = bottomColor === "w" ? "b" : "w";
    be.textContent = fmtClock(clocks[bottomColor]);
    te.textContent = fmtClock(clocks[topColor]);
    be.classList.toggle("active", active === bottomColor);
    te.classList.toggle("active", active === topColor);
    be.classList.toggle("low", clocks[bottomColor] <= 10500 && clocks[bottomColor] > 0);
    te.classList.toggle("low", clocks[topColor] <= 10500 && clocks[topColor] > 0);
  }

  // ---------- modals ----------
  _modal(html) {
    $("modal-card").innerHTML = html;
    $("modal").style.display = "flex";
  }
  _closeModal() { $("modal").style.display = "none"; }

  askPromotion(color, cb) {
    const g = color === "w" ? { q: "♕", r: "♖", b: "♗", n: "♘" } : { q: "♛", r: "♜", b: "♝", n: "♞" };
    this._modal(`<h3>${STR.promo.title}</h3><div class="promo-row">
      ${["q", "r", "b", "n"].map(t => `<button class="promo" data-t="${t}">${g[t]}<small>${STR.promo[t]}</small></button>`).join("")}
    </div>`);
    $("modal-card").querySelectorAll(".promo").forEach(b =>
      b.addEventListener("click", () => { this._closeModal(); cb(b.dataset.t); }));
  }

  askConfirmResign(cb) {
    this._modal(`<h3>${STR.hud.confirmResign}</h3><div class="btn-row">
      <button id="m-yes" class="danger">${STR.hud.yes}</button><button id="m-no">${STR.hud.no}</button></div>`);
    $("m-yes").onclick = () => { this._closeModal(); cb(); };
    $("m-no").onclick = () => this._closeModal();
  }

  askDraw(cb) {
    this._modal(`<h3>${STR.hud.drawOffered}</h3><div class="btn-row">
      <button id="m-yes">${STR.hud.accept}</button><button id="m-no">${STR.hud.decline}</button></div>`);
    $("m-yes").onclick = () => { this._closeModal(); cb(); };
    $("m-no").onclick = () => this._closeModal();
  }

  askDrawOffer(onAccept, onDecline) {
    this._modal(`<h3>${STR.hud.drawOffered}</h3><div class="btn-row">
      <button id="m-yes">${STR.hud.accept}</button><button id="m-no">${STR.hud.decline}</button></div>`);
    $("m-yes").onclick = () => { this._closeModal(); onAccept(); };
    $("m-no").onclick = () => { this._closeModal(); onDecline(); };
  }

  askTimeControl(cb) {
    const t = STR.menu.times;
    this._modal(`<h3>${STR.online.chooseTime}</h3><div class="tc-grid">
      ${Object.keys(t).map(k => `<button class="tc" data-k="${k}">${t[k]}</button>`).join("")}
    </div>`);
    $("modal-card").querySelectorAll(".tc").forEach(b =>
      b.addEventListener("click", () => { this._closeModal(); cb(b.dataset.k); }));
  }

  showGameOver(result, youAre, onRematch, onExit) {
    const reasonMap = {
      checkmate: STR.over.checkmate, stalemate: STR.over.stalemate,
      resignation: STR.over.resignation, timeout: STR.over.timeout,
      "timeout-draw": STR.over.material, agreement: STR.over.agreement,
      threefold: STR.over.threefold, fifty: STR.over.fifty, material: STR.over.material,
    };
    let title;
    if (result.draw) title = STR.over.draw;
    else if (youAre) title = result.winner === youAre ? STR.over.youWin : STR.over.youLose;
    else title = result.winner === "w" ? STR.over.whiteWins : STR.over.blackWins;
    const sub = reasonMap[result.reason] || "";
    this._modal(`<h2>${title}</h2><p class="sub">${sub}</p><div class="btn-row">
      <button id="m-rematch" class="primary">${STR.over.rematch}</button>
      <button id="m-menu">${STR.over.menu}</button></div>`);
    $("m-rematch").onclick = () => { this._closeModal(); onRematch(); };
    $("m-menu").onclick = () => { this._closeModal(); onExit(); };
  }

  // ---------- online invite ----------
  showInvite(url) {
    $("invite").style.display = "flex";
    $("invite-label").textContent = STR.online.invite;
    $("invite-link").value = url;
    $("invite-copy").textContent = STR.online.copy;
    $("invite-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(url); } catch {
        $("invite-link").select(); document.execCommand("copy");
      }
      $("invite-copy").textContent = STR.online.copied;
      setTimeout(() => { $("invite-copy").textContent = STR.online.copy; }, 1500);
    };
  }
  hideInvite() { $("invite").style.display = "none"; }

  toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.style.opacity = "0"; }, 2400);
  }
}
