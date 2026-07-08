// Online mode — speaks the platform room protocol. The server (logic.js) is the referee;
// this client renders the latest state message and sends actions.
import { Chess } from "chess.js";
import { STR } from "./strings.js";
import { SFX } from "./audio.js";

export class OnlineGame {
  constructor(board3d, ui, callbacks) {
    this.b3d = board3d;
    this.ui = ui;
    this.onExit = callbacks.onExit;
    this.left = false;
    this.mirror = new Chess();
    this.selected = null;
    this.view = null;
    this.status = "connecting";
    this.myColor = null;
    this.serverOffset = 0;
    this.askedConfig = false;
    this.answeredDraw = null;
    this.flagSentAt = 0;
    this.lastTickSecond = null;
    this.overShown = false;
    this.firstView = true;

    const params = new URLSearchParams(location.search);
    let room = params.get("room");
    if (!room) {
      room = Math.random().toString(36).slice(2, 8);
      params.set("room", room);
      history.replaceState(null, "", location.pathname + "?" + params);
    }
    this.room = room;

    let playerId = sessionStorage.getItem("mp-player-id");
    if (!playerId) {
      playerId = "p-" + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem("mp-player-id", playerId);
    }
    this.playerId = playerId;

    this.b3d.onSquareTap = (sq) => this._tap(sq);
    this.b3d.syncFromBoard(this.mirror.board());
    this.b3d.setLastMove(null, null);
    this.b3d.setCheck(null);
    this.b3d.clearHints();
    this.b3d.viewSide("w", false);
    ui.showGame({ bottom: { name: STR.hud.you, color: "w" }, top: { name: STR.hud.opponent, color: "b" } });
    ui.setMoveList([]);
    ui.setCaptured({ w: [], b: [] });
    ui.setClocks(null, null, null);
    ui.setStatus(STR.online.connecting);
    ui.showInvite(location.href);

    this._connect();
    this._loop = setInterval(() => this._clockLoop(), 100);
  }

  destroy() {
    this.left = true;
    clearInterval(this._loop);
    if (this.ws) try { this.ws.close(); } catch { /* noop */ }
    this.b3d.onSquareTap = null;
    this.ui.hideInvite();
    // leave the room out of the URL when returning to the menu
    const params = new URLSearchParams(location.search);
    params.delete("room");
    history.replaceState(null, "", location.pathname + (params.size ? "?" + params : ""));
  }

  _connect() {
    // On the Higgsfield host the room kernel lives under the page's own path.
    // Anywhere else (Vercel, localhost) the kernel allows cross-origin sockets,
    // so point at the platform deployment directly.
    const PLATFORM_HOST = "timely-ibis-513.higgsfield.gg";
    let wsUrl;
    if (/(^|\.)higgsfield\.gg$/.test(location.hostname)) {
      const base = location.pathname.replace(/\/+$/, "");
      wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + base + "/ws/" + this.room;
    } else {
      wsUrl = "wss://" + PLATFORM_HOST + "/ws/" + this.room;
    }
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => this._send({ type: "join", playerId: this.playerId });
    this.ws.onclose = () => {
      if (this.left) return;
      this.ui.setStatus(STR.online.disconnected);
      setTimeout(() => { if (!this.left) this._connect(); }, 1500);
    };
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "error") { this.ui.toast(msg.error); return; }
      if (msg.type === "state") this._render(msg);
    };
  }

  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  _act(action) { this._send({ type: "action", action }); }

  _render(s) {
    this.status = s.status;
    if (s.status === "waiting") {
      this.ui.setStatus(STR.online.waiting);
      this.ui.showInvite(location.href);
      return;
    }
    this.ui.hideInvite();
    const v = s.view;
    if (!v) return;
    this.view = v;
    this.seated = s.seats.includes(s.you);
    this.serverOffset = Date.now() - (v.serverNow || Date.now());
    const newColor = v.white === s.you ? "w" : v.black === s.you ? "b" : null;
    if (newColor !== this.myColor || this.firstView) {
      this.myColor = newColor;
      this.b3d.viewSide(newColor || "w", !this.firstView);
      const mine = newColor || "w";
      const opp = mine === "w" ? "b" : "w";
      this.ui.showGame({
        bottom: { name: newColor ? STR.hud.you : STR.hud.spectating, color: mine },
        top: { name: STR.hud.opponent, color: opp },
      });
      if (newColor) this.ui.toast(newColor === "w" ? STR.online.youAreWhite : STR.online.youAreBlack);
      this.firstView = false;
    }

    this._syncMoves(v);

    if (v.phase === "config") {
      if (this.myColor === "w" && !this.askedConfig && s.status === "playing") {
        this.askedConfig = true;
        this.ui.askTimeControl((tcKey) => this._act({ t: "config", tc: tcKey }));
      }
      this.ui.setStatus(this.myColor === "w" ? STR.online.chooseTime : STR.online.waitConfig);
      return;
    }
    this.askedConfig = false;

    // draw offers
    if (v.drawOffer && v.drawOffer !== this.myColor && this.myColor && this.answeredDraw !== v.drawOffer + this.mirror.history().length) {
      this.answeredDraw = v.drawOffer + this.mirror.history().length;
      this.ui.askDrawOffer(
        () => this._act({ t: "draw-accept" }),
        () => this._act({ t: "draw-decline" }));
    }

    if (s.status === "over") {
      if (!this.overShown) {
        this.overShown = true;
        SFX.end();
        this.b3d.clearHints();
        const r = s.result || {};
        const result = r.draw ? { draw: true, reason: r.reason }
          : { winner: r.winner === v.white ? "w" : "b", reason: r.reason };
        this.ui.showGameOver(result, this.myColor, () => { this.overShown = false; this._send({ type: "reset" }); }, this.onExit);
      }
      return;
    }
    this.overShown = false;

    const turn = this.mirror.turn();
    if (!this.myColor) this.ui.setStatus(STR.hud.spectating);
    else this.ui.setStatus(turn === this.myColor ? STR.hud.yourTurn : STR.hud.theirTurn);
    if (this.mirror.inCheck()) this.ui.setStatus(this.ui.statusText() + " — " + STR.hud.check);
  }

  _syncMoves(v) {
    const local = this.mirror.history().length;
    if (v.moves.length === local) return;
    if (v.moves.length === local + 1) {
      const mv = this.mirror.move(v.moves[v.moves.length - 1]);
      this.b3d.animateMove(mv);
      this.b3d.setLastMove(mv.from, mv.to);
      if (this.mirror.isCheckmate()) SFX.end();
      else if (mv.promotion) SFX.promote();
      else if (mv.flags.includes("k") || mv.flags.includes("q")) SFX.castle();
      else if (mv.captured) SFX.capture();
      else SFX.move();
      if (this.mirror.inCheck() && !this.mirror.isCheckmate()) SFX.check();
    } else {
      // reconnect / reset / desync: full rebuild
      this.mirror = new Chess();
      for (const m of v.moves) this.mirror.move(m);
      this.b3d.syncFromBoard(this.mirror.board());
      const h = this.mirror.history({ verbose: true });
      const last = h[h.length - 1];
      this.b3d.setLastMove(last ? last.from : null, last ? last.to : null);
    }
    this._syncCheckHighlight();
    this.ui.setMoveList(this.mirror.history());
    const captured = { w: [], b: [] };
    for (const m of this.mirror.history({ verbose: true })) {
      if (m.captured) captured[m.color === "w" ? "b" : "w"].push(m.captured);
    }
    this.ui.setCaptured(captured);
    this.selected = null;
    this.b3d.clearHints();
  }

  _syncCheckHighlight() {
    if (!this.mirror.inCheck()) { this.b3d.setCheck(null); return; }
    const color = this.mirror.turn();
    const board = this.mirror.board();
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const c = board[r][f];
      if (c && c.type === "k" && c.color === color) { this.b3d.setCheck("abcdefgh"[f] + (8 - r)); return; }
    }
  }

  _myTurn() {
    return this.status === "playing" && this.view && this.view.phase === "playing"
      && this.myColor && this.mirror.turn() === this.myColor;
  }

  _tap(sq) {
    if (!this._myTurn()) return;
    const piece = this.mirror.get(sq);
    if (this.selected) {
      const moves = this.mirror.moves({ square: this.selected, verbose: true }).filter(m => m.to === sq);
      if (moves.length) {
        const from = this.selected;
        if (moves.some(m => m.promotion)) {
          this.ui.askPromotion(this.mirror.turn(), (promo) => {
            if (promo) this._act({ t: "move", from, to: sq, promotion: promo });
            this._deselect();
          });
        } else {
          this._act({ t: "move", from, to: sq });
          this._deselect();
        }
        return;
      }
    }
    if (piece && piece.color === this.myColor) {
      this.selected = sq;
      this.b3d.setSelected(sq);
      const ms = this.mirror.moves({ square: sq, verbose: true });
      this.b3d.showMoves(ms.filter(m => !m.captured).map(m => m.to), ms.filter(m => m.captured).map(m => m.to));
    } else {
      this._deselect();
    }
  }

  _deselect() { this.selected = null; this.b3d.clearHints(); }

  _clockLoop() {
    const v = this.view;
    if (!v || this.status !== "playing" || v.phase !== "playing" || !v.tc) {
      if (v && !v.tc) this.ui.setClocks(null, null, null);
      return;
    }
    const now = Date.now() - this.serverOffset;
    const turn = this.mirror.turn();
    const clocks = { w: v.clock.w, b: v.clock.b };
    if (v.clock.lastAt !== null) clocks[turn] = Math.max(0, clocks[turn] - (now - v.clock.lastAt));
    this.ui.setClocks(clocks, turn, this.myColor || "w");

    if (this.myColor && turn === this.myColor && clocks[turn] <= 10500) {
      const secs = Math.ceil(clocks[turn] / 1000);
      if (secs !== this.lastTickSecond) { this.lastTickSecond = secs; SFX.tick(); }
    }
    // claim the win when the opponent's clock hits zero
    const opp = this.myColor === "w" ? "b" : "w";
    if (this.myColor && turn === opp && clocks[opp] <= 0 && Date.now() - this.flagSentAt > 3000) {
      this.flagSentAt = Date.now();
      this._act({ t: "flag" });
    }
  }

  // toolbar (main.js wraps resign in a confirm dialog)
  resign() { if (this.myColor) this._act({ t: "resign" }); }
  offerDraw() { if (this.myColor) { this._act({ t: "draw-offer" }); this.ui.toast(STR.hud.drawOfferSent); } }
  undo() { /* no takebacks online */ }
  flip() {
    this._flipped = !this._flipped;
    const base = this.myColor || "w";
    this.b3d.viewSide(this._flipped ? (base === "w" ? "b" : "w") : base);
  }
}
