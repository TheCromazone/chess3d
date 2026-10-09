// Full-page screens: profile (ratings, stats, archive, achievements) and settings.
import { h, icon, timeAgo, downloadText } from "../ui/dom.js";
import { sparkline, switchRow, segmented, toast, confirmModal, openModal, tcLabel } from "../ui/components.js";
import { getProfile, updateProfile, getGames, ACHIEVEMENTS, getSettings, setSettings, exportAll, importAll, resetAll, getDailyGames } from "../store.js";
import { BOTS } from "../bots.js";
import { BOARD_THEMES as B3, PIECE_THEMES as P3 } from "../board3d.js";
import { BOARD_THEMES as B2, PIECE_THEMES as P2 } from "../board2d.js";
import { MoveTree } from "../core/tree.js";
import { createChess } from "../core/chess960.js";
import { registered as socialOn, leave as leaveSocial, api as socialApi } from "../net/social.js";
import { accountSection } from "./account.js";

const EMOJIS = ["♞", "♛", "♜", "♝", "♚", "♟", "🦁", "🦊", "🐺", "🦉", "🐉", "🐙", "🦅", "🐢", "🎩", "👑", "⚡", "🔥", "🌙", "🍀"];
const BGS = ["#2f6b4f", "#6b4a2f", "#3b4f7a", "#7a3b4f", "#5a4f2a", "#2a5a5a", "#5a2a6b", "#6b2a2a"];

export class ProfilePage {
  constructor(app) { this.app = app; this.filter = "all"; }
  mount() { this.render(); }
  destroy() {}
  render() {
    const p = getProfile();
    const games = getGames();
    const R = p.ratings;
    const avatar = h("button.avatar.lg", { style: { background: p.avatar.bg }, "aria-label": "Change avatar", onclick: () => this.editProfile() }, p.avatar.emoji);
    const page = h("div.page",
      h("div.page-head", avatar,
        h("div", h("h1", p.name), h("p", `Joined ${new Date(p.created).toLocaleDateString()}. ${plural(p.stats.games, "game")} played.`)),
        h("div", { style: { marginLeft: "auto", display: "flex", gap: "8px" } },
          h("button.btn.small", { onclick: () => this.app.go("#/insights") }, icon("analysis", 16), "Insights"),
          h("button.btn.small", { onclick: () => this.app.go("#/settings"), "aria-label": "Settings" }, icon("settings", 16), "Settings"),
          h("button.btn.small", { onclick: () => this.editProfile() }, icon("edit", 16), "Edit profile"))));
    const stat = (ic, label, slot, extra) => h("div.stat", h("div.lbl", icon(ic, 16), label), h("div.val", String(slot.r)), extra || h("div.note", plural(slot.n, label === "Puzzles" ? "puzzle" : "game")), sparkline(slot.hist));
    page.append(h("section", h("h2", "Ratings"), h("div.stat-grid",
      stat("bolt", "Bullet", R.bullet), stat("fire", "Blitz", R.blitz), stat("clock", "Rapid", R.rapid),
      stat("robot", "Vs bots", R.bots), stat("puzzle", "Puzzles", R.puzzle),
      h("div.stat", h("div.lbl", icon("bolt", 16), "Puzzle Rush"), h("div.val", String(Math.max(p.rush["3"], p.rush["5"], p.rush.survival))), h("div.note", `3 min ${p.rush["3"]} · 5 min ${p.rush["5"]} · Survival ${p.rush.survival}`)))));
    const s = p.stats;
    const winRate = s.games ? Math.round((s.wins / s.games) * 100) : 0;
    page.append(h("section", h("h2", "Stats"), h("div.stat-grid",
      h("div.stat", h("div.lbl", "Games"), h("div.val", String(s.games))),
      h("div.stat", h("div.lbl", "Won"), h("div.val", { style: { color: "var(--accent)" } }, String(s.wins)), h("div.note", `${winRate}% win rate`)),
      h("div.stat", h("div.lbl", "Lost"), h("div.val", String(s.losses))),
      h("div.stat", h("div.lbl", "Drawn"), h("div.val", String(s.draws))),
      h("div.stat", h("div.lbl", "Puzzles solved"), h("div.val", String(p.puzzles.solved)), h("div.note", `Best streak ${p.puzzles.bestStreak}`)),
      h("div.stat", h("div.lbl", "Daily streak"), h("div.val", String(p.daily.streak)), h("div.note", "days in a row")))));

    // openings insight (from the archive)
    const byOpening = new Map();
    for (const g of games) {
      if (!g.opening || !g.myColor) continue;
      const fam = g.opening.replace(/^[A-E]\d\d\s+/, "").split(":")[0].trim();
      const key = `${fam}|${g.myColor}`;
      const e = byOpening.get(key) || { fam, color: g.myColor, n: 0, w: 0, d: 0, l: 0 };
      e.n++;
      const winner = g.result === "1-0" ? "w" : g.result === "0-1" ? "b" : null;
      if (!winner) e.d++; else if (winner === g.myColor) e.w++; else e.l++;
      byOpening.set(key, e);
    }
    const top = [...byOpening.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    if (top.length) {
      const bar = (e) => h("div", { style: { display: "flex", height: "8px", borderRadius: "4px", overflow: "hidden", background: "var(--panel-3)", minWidth: "120px" } },
        h("span", { style: { width: `${(e.w / e.n) * 100}%`, background: "var(--accent-2)" } }),
        h("span", { style: { width: `${(e.d / e.n) * 100}%`, background: "#6b6259" } }),
        h("span", { style: { width: `${(e.l / e.n) * 100}%`, background: "#a3291f" } }));
      page.append(h("section", h("h2", "Openings you play"), h("div.table-wrap", h("table.table",
        h("thead", h("tr", h("th", "Opening"), h("th", "As"), h("th", "Games"), h("th", "Won / drawn / lost"), h("th", ""))),
        h("tbody", ...top.map(e => h("tr", h("td", h("b", e.fam)), h("td", e.color === "w" ? "White" : "Black"), h("td", String(e.n)),
          h("td", `${e.w} / ${e.d} / ${e.l}`), h("td", bar(e)))))))));
    }

    // archive
    const seg = segmented([{ value: "all", label: "All" }, { value: "bot", label: "Bots" }, { value: "online", label: "Online" }, { value: "local", label: "Pass and play" }], this.filter, (v) => { this.filter = v; this.render(); });
    const list = games.filter(g => this.filter === "all" || g.mode === this.filter);
    const table = h("table.table", h("thead", h("tr", h("th", ""), h("th", "Players"), h("th", "Result"), h("th", "Accuracy"), h("th", "Moves"), h("th", "Date"), h("th", ""))));
    const tb = h("tbody");
    for (const g of list.slice(0, 100)) {
      const me = g.myColor;
      let res = "draw", sym = "½";
      if (g.result === "1-0" || g.result === "0-1") {
        const winner = g.result === "1-0" ? "w" : "b";
        if (me) { res = winner === me ? "win" : "loss"; sym = winner === me ? "+" : "−"; } else { res = "win"; sym = winner === "w" ? "W" : "B"; }
      }
      const acc = g.accuracy ? `${(g.accuracy.w ?? 0).toFixed(0)} / ${(g.accuracy.b ?? 0).toFixed(0)}` : "–";
      const tr = h("tr.click", { onclick: () => this.app.go(`#/review/${g.id}`) },
        h("td", h(`span.res.${res}`, sym)),
        h("td", h("div", h("b", g.white.name), g.white.rating ? h("span.muted", ` (${g.white.rating})`) : null), h("div", h("b", g.black.name), g.black.rating ? h("span.muted", ` (${g.black.rating})`) : null)),
        h("td", h("div", g.result), h("small.muted", g.reason)),
        h("td", acc),
        h("td", String(Math.ceil(g.moves.length / 2))),
        h("td", h("div", timeAgo(g.date)), h("small.muted", tcLabel(g.tc))),
        h("td", h("div", { style: { display: "flex", gap: "4px" } },
          h("button.btn.small", { onclick: (e) => { e.stopPropagation(); this.app.go(`#/review/${g.id}`); } }, "Review"),
          h("button.btn.small.ghost", { "aria-label": "Download PGN", onclick: (e) => { e.stopPropagation(); downloadText(`chess3d-${g.id}.pgn`, gamePgn(g)); } }, icon("download", 16)))));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    page.append(h("section", h("h2", "Game archive"), seg, h("div", { style: { overflowX: "auto", marginTop: "10px" } }, list.length ? table : h("p.note", "No games yet. Finished games show up here so you can review them."))));

    // friends: people you've played online or by daily game, with your record and a rematch challenge
    const friends = new Map();
    for (const g of games) {
      if ((g.mode !== "online") || !g.myColor) continue;
      const opp = g.myColor === "w" ? g.black : g.white;
      if (!opp || !opp.name || opp.name === "Opponent") continue;
      const f = friends.get(opp.name) || { name: opp.name, rating: opp.rating, w: 0, d: 0, l: 0, last: 0 };
      const winner = g.result === "1-0" ? "w" : g.result === "0-1" ? "b" : null;
      if (!winner) f.d++; else if (winner === g.myColor) f.w++; else f.l++;
      f.last = Math.max(f.last, g.date || 0);
      if (opp.rating) f.rating = opp.rating;
      friends.set(opp.name, f);
    }
    for (const e of getDailyGames()) {
      if (!e.opponent || friends.has(e.opponent)) continue;
      friends.set(e.opponent, { name: e.opponent, rating: null, w: 0, d: 0, l: 0, last: e.updated || e.created, daily: true });
    }
    const fl = [...friends.values()].sort((a, b) => b.last - a.last);
    page.append(h("section", h("div.section-head", h("h2", "People you've played"),
      h("button.btn.small", { onclick: () => this.app.go("#/social") }, icon("users", 16), socialOn() ? "Friends and messages" : "Find friends")),
      fl.length ? h("div.rows", ...fl.slice(0, 20).map(f => h("div.row", { style: { cursor: "default" } },
        h("span.ri", icon("users", 20)),
        h("span.rt", h("b", f.name, f.rating ? h("span.muted", ` ${f.rating}`) : null),
          h("small", `${f.w} won, ${f.d} drawn, ${f.l} lost. Last played ${timeAgo(f.last)}`)),
        h("div", { style: { display: "flex", gap: "6px" } },
          h("button.btn.small", { onclick: () => this.app.go("#/friend"), title: "Create a live game link to send them" }, icon("bolt", 16), "Live"),
          h("button.btn.small", { onclick: () => this.app.go("#/daily"), title: "Start a daily game and send them the link" }, icon("calendar", 16), "Daily")))))
        : h("p.note", "People you play online or in daily games show up here, with your record against them. To add friends, message them and see when they're online, open Social.")));

    // leaderboard: where you stand among the bots
    const ladder = [...BOTS.filter(b => b.category !== "Engine").map(b => ({ name: b.name, rating: b.elo, avatar: b.avatar })), { name: p.name, rating: R.bots.r, avatar: p.avatar, me: true }]
      .sort((a, b) => b.rating - a.rating);
    const myRank = ladder.findIndex(x => x.me) + 1;
    const around = ladder.slice(Math.max(0, myRank - 4), myRank + 3);
    page.append(h("section", h("h2", `Bot ladder: you're #${myRank} of ${ladder.length}`),
      h("table.table", h("tbody", ...around.map(x => h("tr", { style: x.me ? { background: "rgba(52,210,123,.08)" } : null },
        h("td", String(ladder.indexOf(x) + 1)),
        h("td", h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, h("div.avatar.sm", { style: { background: x.avatar?.bg || "#3a2e24" } }, x.avatar?.emoji || "♟"), h("b", x.name))),
        h("td", String(x.rating)))))),
      h("p.note", "Beat bots rated above you in rated games to climb.")));

    // achievements
    const got = Object.keys(p.achievements).length;
    page.append(h("section", h("h2", `Achievements (${got}/${ACHIEVEMENTS.length})`), h("div.ach-grid",
      ...ACHIEVEMENTS.map(a => h(`div.ach${p.achievements[a.id] ? ".got" : ""}`, h("span.ai", a.icon), h("div", h("b", a.name), h("small", a.desc)))))));
    this.app.pageMode(page);
  }

  editProfile() {
    const p = getProfile();
    let emoji = p.avatar.emoji, bg = p.avatar.bg;
    const name = h("input.input", { value: p.name, maxlength: "16", "aria-label": "Display name" });
    const emojiGrid = h("div.palette", ...EMOJIS.map(e => h(`button${e === emoji ? ".on" : ""}`, { onclick: (ev) => { emoji = e; emojiGrid.querySelectorAll("button").forEach(b => b.classList.remove("on")); ev.currentTarget.classList.add("on"); } }, e)));
    const bgGrid = h("div.palette", ...BGS.map(c => h(`button${c === bg ? ".on" : ""}`, { style: { background: c }, "aria-label": c, onclick: (ev) => { bg = c; bgGrid.querySelectorAll("button").forEach(b => b.classList.remove("on")); ev.currentTarget.classList.add("on"); } }, "")));
    const m = openModal({
      title: "Edit profile",
      body: [h("div.field", h("label", "Display name (letters, numbers, _)"), name), h("div.field", h("div.lbl", "Avatar"), emojiGrid), h("div.field", h("div.lbl", "Color"), bgGrid),
        h("button.btn.primary.block", {
          onclick: async () => {
            const n = name.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
            if (!n) { toast("Pick a name with letters or numbers."); return; }
            // with a profile, names are unique across players
            if (socialOn() && n.toLowerCase() !== p.name.toLowerCase()) {
              try {
                const r = await socialApi("GET", "/names?n=" + encodeURIComponent(n));
                if (!r.valid) { toast("Names need 2 to 16 letters, numbers or _."); return; }
                if (!r.available) { toast(`${n} is taken. Try another name.`); return; }
              } catch (e) { toast(e.message); return; }
            }
            updateProfile(pr => { pr.name = n; pr.avatar = { emoji, bg }; });
            m.close(); this.render();
          },
        }, "Save")],
    });
  }
}

function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

export function gamePgn(g) {
  const tree = MoveTree.fromMoves(g.moves, g.startFen);
  return tree.toPgn({ White: g.white.name, Black: g.black.name, Result: g.result, WhiteElo: g.white.rating || "?", BlackElo: g.black.rating || "?", TimeControl: g.tc, Termination: g.reason, Date: new Date(g.date).toISOString().slice(0, 10).replace(/-/g, ".") });
}

// ---------- settings ----------
export class SettingsPage {
  constructor(app) { this.app = app; }
  mount() {
    // settings sit beside a sample position so theme changes preview live on the real board
    const c = createChess();
    let last = null;
    for (const m of ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"]) last = c.move(m);
    this.sample = c;
    this.app.board.syncFromBoard(c.board());
    this.app.board.viewSide("w", false);
    this.app.board.setLastMove(last.from, last.to);
    this.app.board.setSelected("f3");
    this.app.board.showMoves(["g5", "h4", "d4", "g1"], ["e5"]);
    this.app.board.setArrows([{ from: "f3", to: "g5", color: "rgba(91,143,214,.8)" }]);
    this.render();
  }
  onBoardSwap() { this.mount(); }
  destroy() {}
  render() {
    const s = getSettings();
    const set = (patch) => { setSettings(patch); this.render(); };
    const is3d = s.view !== "2d";
    const boards = is3d ? B3 : B2, pieces = is3d ? P3 : P2;
    const curBoard = is3d ? s.boardTheme3d : s.boardTheme2d, curPiece = is3d ? s.pieceTheme3d : s.pieceTheme2d;
    const chips = (items, cur, key) => h("div.theme-grid", ...items.map(t => h(`button.theme-chip${t.id === cur ? ".on" : ""}`, { onclick: () => set({ [key]: t.id }) },
      h("span.sw", { style: { background: t.swatch, backgroundSize: "cover", backgroundPosition: "center" } }), t.name)));
    const page = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
      h("section.settings-sec", h("h2", "Appearance"),
        segmented([{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "Match device" }], s.appearance || "dark", (v) => setSettings({ appearance: v }))),
      h("section.settings-sec", h("h2", "Board"),
        h("div.field", h("div.lbl", "Board style"), segmented([{ value: "3d", label: "3D board" }, { value: "2d", label: "2D board" }], s.view, (v) => set({ view: v }))),
        is3d ? h("div.field", h("div.lbl", "3D camera"), segmented([{ value: "3d", label: "Free orbit" }, { value: "top", label: "Top-down" }], s.cameraMode, (v) => set({ cameraMode: v }))) : null,
        h("div.field", h("div.lbl", "Board theme"), chips(boards, curBoard, is3d ? "boardTheme3d" : "boardTheme2d")),
        h("div.field", h("div.lbl", "Pieces"), chips(pieces, curPiece, is3d ? "pieceTheme3d" : "pieceTheme2d")),
        switchRow("Coordinates", null, s.coords, (v) => setSettings({ coords: v })),
        h("div.field", h("div.lbl", "Piece animation"), segmented([{ value: 0, label: "None" }, { value: 120, label: "Fast" }, { value: 220, label: "Normal" }, { value: 380, label: "Slow" }], s.animMs, (v) => setSettings({ animMs: v })))),
      h("section.settings-sec", h("h2", "Gameplay"),
        switchRow("Show legal moves", "Dots on the squares a selected piece can reach", s.showLegal, (v) => setSettings({ showLegal: v })),
        switchRow("Highlight last move", null, s.highlightLast, (v) => setSettings({ highlightLast: v })),
        switchRow("Drag pieces", "Click-to-move always works too", s.dragMoves, (v) => setSettings({ dragMoves: v })),
        switchRow("Premoves", "Queue a move while your opponent thinks", s.premoves, (v) => setSettings({ premoves: v })),
        switchRow("Always promote to queen", null, s.autoQueen, (v) => setSettings({ autoQueen: v })),
        switchRow("Confirm resignation", null, s.confirmResign, (v) => setSettings({ confirmResign: v })),
        switchRow("Low-time warning", "Ticks and a red clock under 20 seconds", s.lowTimeWarning, (v) => setSettings({ lowTimeWarning: v })),
        switchRow("Evaluation bar in analysis", null, s.evalBarInAnalysis, (v) => setSettings({ evalBarInAnalysis: v })),
        h("div.field", h("div.lbl", "Move notation"), segmented([{ value: "figurine", label: "Figurine ♘f3" }, { value: "san", label: "Letters Nf3" }], s.notation, (v) => setSettings({ notation: v })))),
      h("section.settings-sec", h("h2", "Sound"),
        switchRow("Sound effects", null, s.sound, (v) => setSettings({ sound: v }))),
      accountSection(this),
      h("section.settings-sec", h("h2", "Your data"),
        h("p.note", "Your profile, ratings and games live in this browser (and in your cloud backup once you have a profile). You can also keep a backup file: it includes your profile key."),
        h("div.btn-row",
          h("button.btn", { onclick: () => downloadText("chess3d-backup.json", exportAll(), "application/json") }, icon("download", 18), "Export"),
          h("button.btn", { onclick: () => this.importFile() }, icon("upload", 18), "Import"),
          h("button.btn.danger", {
            onclick: async () => {
              if (!(await confirmModal({ title: "Erase all data?", sub: socialOn() ? "Your profile, ratings and game archive are deleted from this device, and your social profile from the server." : "Your profile, ratings and game archive will be deleted from this device.", yes: "Erase", danger: true }))) return;
              if (socialOn()) await leaveSocial().catch(() => {});
              resetAll(); toast("All data erased"); this.render();
            },
          }, icon("trash", 18), "Erase"))),
      h("section.settings-sec", h("h2", "About"),
        h("p.note", { html: "Chess 3D. Engine: <a href=\"https://github.com/nmrugg/stockfish.js\" target=\"_blank\" rel=\"noopener\">Stockfish.js 18</a> (GPLv3, <a href=\"./stockfish/COPYING.txt\" target=\"_blank\">license</a>). Puzzles and opening names: <a href=\"https://database.lichess.org/\" target=\"_blank\" rel=\"noopener\">lichess.org open database</a> (CC0). 2D piece sets: see <a href=\"./assets/pieces/LICENSES.md\" target=\"_blank\">credits</a>." })));
    const scroll = this.app.side.querySelector(".side-body");
    const y = scroll ? scroll.scrollTop : 0;
    this.app.panel({ title: "Settings", body: [h("p.note", "Saved on this device. The board shows your choices as you make them."), page] });
    const nb = this.app.side.querySelector(".side-body");
    if (nb) nb.scrollTop = y;
  }

  importFile() {
    const inp = h("input", { type: "file", accept: "application/json,.json" });
    inp.addEventListener("change", async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try { importAll(await f.text()); toast("Backup imported"); this.render(); } catch (e) { toast(e.message || "Couldn't read that file."); }
    });
    inp.click();
  }
}
void updateProfile;
