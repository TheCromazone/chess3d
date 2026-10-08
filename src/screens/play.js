// Play hub, bot picker, friend / pass-and-play setup.
import { Chess } from "chess.js";
import { h, icon, todayStr } from "../ui/dom.js";
import { tcPicker, tcLabel, segmented, switchRow, openModal, ONLINE_TIME_CONTROLS } from "../ui/components.js";
import { getProfile, getResume, setResume, getGames, getDailyGames, getSettings } from "../store.js";
import { BOTS } from "../bots.js";
import { BotGame, LocalGame, findBot } from "../modes/bot-game.js";
import { OnlineGame } from "../modes/online-game.js";
import { VARIANTS } from "../modes/base-game.js";

let variant = "standard";
function variantField() {
  const note = h("p.note", (VARIANTS.find(v => v.value === variant) || {}).desc || "");
  return h("div.field", h("div.lbl", "Variant"),
    segmented(VARIANTS.map(v => ({ value: v.value, label: v.label })), variant, (v) => { variant = v; note.textContent = (VARIANTS.find(x => x.value === v) || {}).desc || ""; }), note);
}

let lastOnlineTc = "10+0";
let lastBotTc = "inf";

function idleBoard(app) {
  app.board.syncFromBoard(new Chess().board());
  app.board.viewSide("w", false);
  if (app.board.setIdle) app.board.setIdle(true);
}

function meStrip() {
  const p = getProfile();
  return { name: p.name, rating: p.ratings.bots.r, avatar: p.avatar };
}

// ---------- home ----------
export class HomeScreen {
  constructor(app) { this.app = app; }
  mount() {
    const app = this.app;
    idleBoard(app);
    const p = getProfile();
    app.strips(null, null);
    const tcBtn = h("button.tc-current", { "aria-label": "Time control" }, icon("clock", 18), h("span", tcLabel(lastOnlineTc)), icon("chevron", 16));
    tcBtn.addEventListener("click", () => {
      const m = openModal({ title: "Time control", body: tcPicker(lastOnlineTc, (k) => { lastOnlineTc = k; tcBtn.querySelector("span").textContent = tcLabel(k); m.close(); }, { allowUnlimited: false, allowCustom: false, groups: ONLINE_TIME_CONTROLS }) });
    });
    const resume = getResume();
    const resumeBot = resume && resume.kind === "bot" ? findBot(resume.botId) : null;
    const daily = p.daily.solved[todayStr()];
    const rows = h("div.rows",
      resumeBot ? row("resume", `Continue vs ${resumeBot.name}`, `${resume.moves.length} moves played · ${tcLabel(resume.tcKey)}`, () => {
        app.launch(() => new BotGame(app, { botId: resume.botId, myColor: resume.myColor, tcKey: resume.tcKey, assisted: resume.assisted, resume, id: resume.id, startFen: resume.startFen, variant: resume.variant }), "#/game");
      }, h("span.badge", "Saved")) : null,
      row("robot", "Play bots", "16 personalities from 250 to 3200", () => app.go("#/bots")),
      row("link", "Play a friend", "Send an invite link", () => app.go("#/friend")),
      row("trophy", "Arenas", "Live tournaments every 30 minutes, or against the bots", () => app.go("#/arenas")),
      row("calendar", "Daily chess", dailyLine(), () => app.go("#/daily")),
      row("users", "Pass and play", "Two players, one screen", () => app.go("#/local")),
      row("puzzle", daily ? "Daily puzzle solved" : "Daily puzzle", daily ? "Come back tomorrow for a new one" : "A fresh puzzle every day", () => app.go("#/puzzles/daily"), daily ? h("span.badge", "✓") : null),
    );
    app.panel({
      title: "",
      body: [
        h("div", h("div.hero-title", "Play chess"), h("p.hero-sub", getSettings().view === "2d" ? "Against friends, bots and the world, with Stockfish at your side." : "On a real 3D board, with Stockfish at your side.")),
        tcBtn,
        h("button.btn.primary.big.block", { onclick: () => app.launch(() => new OnlineGame(app, { kind: "pool", tcKey: lastOnlineTc }), "#/online") }, "Play online"),
        rows,
        h("div.quick-stats",
          h("div", h("small", "Bots"), h("b", String(p.ratings.bots.r))),
          h("div", h("small", "Puzzles"), h("b", String(p.ratings.puzzle.r))),
          h("div", h("small", "Rush best"), h("b", String(Math.max(p.rush["3"], p.rush["5"], p.rush.survival))))),
        recentGames(app),
      ],
    });
    if (resume && !resumeBot) setResume(null);
  }
  destroy() { if (this.app.board.setIdle) this.app.board.setIdle(false); }
}

function dailyLine() {
  const g = getDailyGames();
  const mine = g.filter(e => e.status === "playing" && e.turn && e.turn === e.myColor).length;
  if (mine) return `Your move in ${mine} game${mine === 1 ? "" : "s"}`;
  return g.length ? `${g.length} game${g.length === 1 ? "" : "s"} in progress` : "Play friends at your own pace";
}

function recentGames(app) {
  const games = getGames().slice(0, 4);
  if (!games.length) return null;
  const list = h("div.rows");
  for (const g of games) {
    const me = g.myColor;
    const winner = g.result === "1-0" ? "w" : g.result === "0-1" ? "b" : null;
    const res = !winner ? "draw" : me ? (winner === me ? "win" : "loss") : "win";
    const sym = !winner ? "½" : me ? (winner === me ? "+" : "−") : (winner === "w" ? "W" : "B");
    const opp = me ? (me === "w" ? g.black : g.white) : g.black;
    list.appendChild(h("button.row", { onclick: () => app.go(`#/review/${g.id}`), style: { minHeight: "48px", padding: "8px 12px" } },
      h(`span.res.${res}`, sym),
      h("span.rt", h("b", me ? `vs ${opp.name}` : `${g.white.name} vs ${g.black.name}`),
        h("small", `${g.result} ${g.reason}${g.accuracy && me ? `, ${Math.round(g.accuracy[me])}% accuracy` : ""}`)),
      h("span.rv", "Review")));
  }
  return h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
      h("b", { style: { fontSize: "14px" } }, "Recent games"),
      h("a", { href: "#/profile", style: { fontSize: "13px", fontWeight: "600" } }, "All games")),
    list);
}

function row(ic, title, sub, onClick, right) {
  return h("button.row", { onclick: onClick }, h("span.ri", icon(ic, 20)), h("span.rt", h("b", title), h("small", sub)), right || h("span.rv", icon("chevron", 18)));
}

// ---------- bots ----------
let selectedBot = null;
let botColor = "w";
let assisted = true;
let coach = false;
let evalBar = false;

export class BotsScreen {
  constructor(app) { this.app = app; }
  mount() {
    const app = this.app;
    app.setLobby(true);
    idleBoard(app);
    if (app.board.setIdle) app.board.setIdle(false);
    const p = getProfile();
    if (!selectedBot) {
      // suggest the strongest bot a little above the player's bot rating
      const target = p.ratings.bots.r + 100;
      selectedBot = [...BOTS].sort((a, b) => Math.abs(a.elo - target) - Math.abs(b.elo - target))[0].id;
    }
    const hero = h("div.card");
    const grid = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });
    const renderHero = () => {
      const b = findBot(selectedBot);
      hero.innerHTML = "";
      hero.append(...[h("div.bot-hero",
        h("div.avatar.lg", { style: { background: b.avatar.bg } }, b.avatar.emoji),
        h("div", h("h3", b.name, " ", b.country || ""), h("div.rating", `${b.elo}`), h("p.note", b.style))),
        h("p", { style: { marginTop: "10px", fontSize: "14px", color: "var(--ink-2)" } }, b.bio),
        p.botsBeaten[b.id] ? h("p.note", { style: { color: "var(--accent)", marginTop: "6px", fontWeight: "700" } }, "✓ You've beaten this bot") : null].filter(Boolean));
      app.strips({ name: b.name, rating: b.elo, avatar: b.avatar, flag: b.country }, meStrip());
    };
    const cats = [...new Set(BOTS.map(b => b.category))];
    for (const cat of cats) {
      const g = h("div.bot-grid");
      for (const b of BOTS.filter(x => x.category === cat)) {
        const chip = h(`button.bot-chip${b.id === selectedBot ? ".on" : ""}`, { "aria-label": `${b.name}, rated ${b.elo}`, title: `${b.name} (${b.elo})` },
          h("div.avatar", { style: { background: b.avatar.bg } }, b.avatar.emoji), h("small", String(b.elo)));
        chip.addEventListener("click", () => {
          selectedBot = b.id;
          grid.querySelectorAll(".bot-chip").forEach(c => c.classList.remove("on"));
          chip.classList.add("on");
          renderHero();
        });
        g.appendChild(chip);
      }
      grid.append(h("div.cat-title", cat), g);
    }
    renderHero();
    const tcBtn = h("button.tc-current", icon("clock", 18), h("span", tcLabel(lastBotTc)), icon("chevron", 16));
    tcBtn.addEventListener("click", () => {
      const m = openModal({ title: "Time control", body: tcPicker(lastBotTc, (k) => { lastBotTc = k; tcBtn.querySelector("span").textContent = tcLabel(k); m.close(); }) });
    });
    app.panel({
      title: "Play bots", back: "#/",
      body: [
        hero, grid,
        h("div.field", h("div.lbl", "I play as"), segmented([{ value: "w", label: "White" }, { value: "random", label: "Random" }, { value: "b", label: "Black" }], botColor, v => { botColor = v; })),
        h("div.field", h("div.lbl", "Time"), tcBtn),
        variantField(),
        h("p.note", "Rated games move your bot rating. Using hints, takebacks, the coach or the eval bar makes a game unrated."),
        switchRow("Hints and takebacks", null, assisted, v => { assisted = v; }),
        switchRow("Coach", "Live feedback on each of your moves", coach, v => { coach = v; }),
        switchRow("Evaluation bar", "See who's better as you play", evalBar, v => { evalBar = v; }),
      ],
      foot: h("button.btn.primary.big.block", {
        onclick: () => {
          app.launch(() => new BotGame(app, { botId: selectedBot, myColor: botColor, tcKey: lastBotTc, assisted: { hints: assisted, takebacks: assisted, coach, evalBar }, variant }), "#/game");
        },
      }, "Play"),
    });
  }
  destroy() {}
}

// ---------- friend ----------
let friendTc = "10+0";
export class FriendScreen {
  constructor(app) { this.app = app; }
  mount() {
    const app = this.app;
    app.setLobby(true);
    idleBoard(app);
    if (app.board.setIdle) app.board.setIdle(false);
    const pr = getProfile();
    app.strips(null, { name: pr.name, rating: pr.ratings.rapid.r, avatar: pr.avatar });
    app.panel({
      title: "Play a friend", back: "#/",
      body: [
        h("p.note", "Create a private game and send the link. You play White; the game starts when your friend opens it. For a game without a clock, start a daily game instead."),
        tcPicker(friendTc, (k) => { friendTc = k; }, { allowUnlimited: false }),
      ],
      foot: h("button.btn.primary.big.block", { onclick: () => app.launch(() => new OnlineGame(app, { kind: "friend", tcKey: friendTc }), "#/online") }, "Create invite link"),
    });
  }
  destroy() {}
}

// ---------- pass and play ----------
let localTc = "inf";
let autoFlip = false;
export class LocalScreen {
  constructor(app) { this.app = app; }
  mount() {
    const app = this.app;
    app.setLobby(true);
    idleBoard(app);
    if (app.board.setIdle) app.board.setIdle(false);
    app.strips(null, null);
    const wName = h("input.input", { value: getProfile().name, maxlength: "20", "aria-label": "White player name" });
    const bName = h("input.input", { value: "Friend", maxlength: "20", "aria-label": "Black player name" });
    app.panel({
      title: "Pass and play", back: "#/",
      body: [
        h("div.two-col", h("div.field", h("label", "White"), wName), h("div.field", h("label", "Black"), bName)),
        tcPicker(localTc, (k) => { localTc = k; }),
        switchRow("Flip the board after each move", "So each player sees their side", autoFlip, v => { autoFlip = v; }),
        variantField(),
      ],
      foot: h("button.btn.primary.big.block", {
        onclick: () => {
          app.launch(() => new LocalGame(app, { tcKey: localTc, autoFlip, variant, whiteName: wName.value.trim() || "White", blackName: bName.value.trim() || "Black" }), "#/game");
        },
      }, "Start game"),
    });
  }
  destroy() {}
}
