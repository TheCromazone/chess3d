// Entry point: routes → screens. The App owns the board, panel and navigation.
import { startI18n } from "./i18n.js";
import { App } from "./app.js";
import { HomeScreen, BotsScreen, FriendScreen, LocalScreen } from "./screens/play.js";
import { ProfilePage, SettingsPage } from "./screens/pages.js";
import { BotGame } from "./modes/bot-game.js";
import { OnlineGame } from "./modes/online-game.js";
import { AnalysisScreen } from "./modes/analysis.js";
import { ReviewScreen } from "./modes/review.js";
import { PuzzleScreen, RushScreen } from "./modes/puzzles.js";
import { LearnPage, LessonScreen, DrillScreen, OpeningTrainer } from "./modes/learn.js";
import { WatchPage, ReplayScreen, BotTV } from "./modes/watch.js";
import { LichessTV } from "./modes/lichess-tv.js";
import { EventScreen, BroadcastGame } from "./modes/events.js";
import { VisionTrainer, SoloChess } from "./modes/trainers.js";
import { VoteChess } from "./modes/vote-chess.js";
import { SwissLobby } from "./screens/swiss.js";
import { VariantReplay } from "./modes/variant-replay.js";
import { ArenaScreen } from "./modes/arena.js";
import { DailyScreen, watchDaily } from "./modes/daily.js";
import { InsightsPage } from "./screens/insights.js";
import { maybeWelcome } from "./screens/welcome.js";
import { BattleScreen } from "./modes/battle.js";
import { SocialScreen, startSocial } from "./screens/social.js";
import { ArenasScreen, ArenaLobby } from "./screens/arenas.js";
import { LeagueScreen } from "./screens/league.js";
import { DailyTourScreen } from "./screens/daily-tour.js";
import { ZhGame, ZhSetup, BughouseLobby, VariantsScreen } from "./modes/zh-game.js";
import { VxPlay, VxSetup } from "./modes/vx-game.js";
import { FourPlayerGame, FourPlayerSetup } from "./modes/fp-game.js";
import { VX_VARIANTS } from "./core/vx.js";
import { getResume, setSettings } from "./store.js";
import { unlockAudio } from "./audio.js";
import { loadOpenings } from "./openings.js";

const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

const routes = [
  { pattern: /^#\/?$/, nav: "play", make: (app) => new HomeScreen(app) },
  { pattern: /^#\/bots$/, nav: "play", make: (app) => new BotsScreen(app) },
  { pattern: /^#\/friend$/, nav: "play", make: (app) => new FriendScreen(app) },
  { pattern: /^#\/local$/, nav: "play", make: (app) => new LocalScreen(app) },
  {
    pattern: /^#\/game$/, nav: "play", make: (app) => {
      const r = getResume();
      if (r && r.kind === "bot") return new BotGame(app, { botId: r.botId, myColor: r.myColor, tcKey: r.tcKey, assisted: r.assisted, resume: r, id: r.id, startFen: r.startFen, variant: r.variant });
      return new HomeScreen(app);
    },
  },
  {
    pattern: /^#\/online$/, nav: "play", make: (app) => {
      const q = new URLSearchParams(location.search);
      if (q.get("room")) return new OnlineGame(app, { kind: "friend", room: q.get("room"), tcKey: q.get("tc") || "10+0" });
      return new HomeScreen(app);
    },
  },
  { pattern: /^#\/puzzles$/, nav: "puzzles", make: (app) => new PuzzleScreen(app, { mode: "rated" }) },
  { pattern: /^#\/puzzles\/daily$/, nav: "puzzles", make: (app) => new PuzzleScreen(app, { mode: "daily" }) },
  { pattern: /^#\/puzzles\/rush$/, nav: "puzzles", make: (app) => new RushScreen(app) },
  { pattern: /^#\/puzzles\/battle$/, nav: "puzzles", make: (app) => new BattleScreen(app) },
  { pattern: /^#\/puzzles\/solo$/, nav: "puzzles", make: (app) => new SoloChess(app) },
  { pattern: /^#\/vision$/, nav: "learn", make: (app) => new VisionTrainer(app) },
  { pattern: /^#\/vote\/(vc_[a-z0-9]+)$/, nav: "social", make: (app, m) => new VoteChess(app, m[1]) },
  { pattern: /^#\/arena$/, nav: "play", make: (app) => new ArenaScreen(app) },
  { pattern: /^#\/arenas$/, nav: "play", make: (app) => new ArenasScreen(app) },
  { pattern: /^#\/league$/, nav: "play", make: (app) => new LeagueScreen(app) },
  { pattern: /^#\/dailytour\/(dt_[a-z0-9]+)$/, nav: "play", make: (app, m) => new DailyTourScreen(app, m[1]) },
  { pattern: /^#\/swiss\/(sw-\d+)$/, nav: "play", make: (app, m) => new SwissLobby(app, m[1]) },
  { pattern: /^#\/variants$/, nav: "play", make: (app) => new VariantsScreen(app) },
  { pattern: /^#\/crazyhouse(?:\/play)?$/, nav: "play", make: (app) => new ZhSetup(app) },
  {
    pattern: /^#\/crazyhouse\/online$/, nav: "play", make: (app) => {
      const q = new URLSearchParams(location.search);
      return q.get("room") ? new ZhGame(app, { mode: "online", room: q.get("room"), tcKey: q.get("tc") || "3+0" }) : new ZhSetup(app);
    },
  },
  { pattern: /^#\/variant\/([a-z0-9]+)(?:\/play)?$/, nav: "play", make: (app, m) => (VX_VARIANTS[m[1]] ? new VxSetup(app, m[1]) : new VariantsScreen(app)) },
  {
    pattern: /^#\/variant\/([a-z0-9]+)\/online$/, nav: "play", make: (app, m) => {
      const q = new URLSearchParams(location.search);
      if (!VX_VARIANTS[m[1]]) return new VariantsScreen(app);
      return q.get("room") ? new VxPlay(app, { variant: m[1], mode: "online", room: q.get("room"), tcKey: q.get("tc") || "3+0" }) : new VxSetup(app, m[1]);
    },
  },
  { pattern: /^#\/fourplayer(?:\/play)?$/, nav: "play", make: (app) => new FourPlayerSetup(app) },
  {
    pattern: /^#\/fourplayer\/online$/, nav: "play", make: (app) => {
      const q = new URLSearchParams(location.search);
      return q.get("room") ? new FourPlayerGame(app, { mode: "online", room: q.get("room"), tcKey: q.get("tc") || "5+0", rules: q.get("rules") === "teams" ? "teams" : "ffa" }) : new FourPlayerSetup(app);
    },
  },
  { pattern: /^#\/bughouse$/, nav: "play", make: (app) => new BughouseLobby(app, null) },
  { pattern: /^#\/bughouse\/([a-z0-9]{4,16})(?:\/play)?(?:\?.*)?$/, nav: "play", make: (app, m) => new BughouseLobby(app, m[1]) },
  { pattern: /^#\/arenas\/(ar-\d+)$/, nav: "play", make: (app, m) => new ArenaLobby(app, m[1]) },
  { pattern: /^#\/daily$/, nav: "play", make: (app) => new DailyScreen(app) },
  { pattern: /^#\/puzzles\/theme\/([\w-]+)$/, nav: "puzzles", make: (app, m) => new PuzzleScreen(app, { mode: "rated", theme: m[1] }) },
  { pattern: /^#\/learn$/, nav: "learn", make: (app) => new LearnPage(app) },
  { pattern: /^#\/lesson\/([\w-]+)$/, nav: "learn", make: (app, m) => new LessonScreen(app, m[1]) },
  { pattern: /^#\/drill\/([\w-]+)$/, nav: "learn", make: (app, m) => new DrillScreen(app, m[1]) },
  { pattern: /^#\/opening\/([\w-]+)$/, nav: "learn", make: (app, m) => new OpeningTrainer(app, m[1]) },
  { pattern: /^#\/watch$/, nav: "watch", make: (app) => new WatchPage(app) },
  { pattern: /^#\/watch\/tv(?:\/([a-z0-9]+))?$/, nav: "watch", make: (app, m) => new LichessTV(app, m[1]) },
  { pattern: /^#\/watch\/([\w-]+)$/, nav: "watch", make: (app, m) => new ReplayScreen(app, m[1]) },
  { pattern: /^#\/tv$/, nav: "watch", make: (app) => new BotTV(app) },
  { pattern: /^#\/vgame\/([a-z0-9]+)$/, nav: "profile", make: (app, m) => new VariantReplay(app, m[1]) },
  { pattern: /^#\/event\/([A-Za-z0-9]{8})(?:\/([A-Za-z0-9]{8}))?$/, nav: "watch", make: (app, m) => new EventScreen(app, m[1], m[2] || null) },
  { pattern: /^#\/event\/([A-Za-z0-9]{8})\/([A-Za-z0-9]{8})\/(\d{1,3})$/, nav: "watch", make: (app, m) => new BroadcastGame(app, m[1], m[2], Number(m[3])) },
  { pattern: /^#\/analysis$/, nav: "analysis", make: (app) => new AnalysisScreen(app) },
  { pattern: /^#\/analysis\/fen\/(.+)$/, nav: "analysis", make: (app, m) => new AnalysisScreen(app, { fen: dec(m[1]) }) },
  { pattern: /^#\/analysis\/pgn\/(.+)$/, nav: "analysis", make: (app, m) => new AnalysisScreen(app, { pgn: dec(m[1]) }) },
  { pattern: /^#\/analysis\/([\w]+)$/, nav: "analysis", make: (app, m) => new AnalysisScreen(app, { gameId: m[1] }) },
  { pattern: /^#\/review\/([\w]+)$/, nav: "analysis", make: (app, m) => new ReviewScreen(app, m[1]) },
  { pattern: /^#\/social$/, nav: "social", make: (app) => new SocialScreen(app) },
  { pattern: /^#\/social\/(friends|messages|clubs|forums|blogs|coaches|leaderboard)$/, nav: "social", make: (app, m) => new SocialScreen(app, { tab: m[1] }) },
  { pattern: /^#\/social\/topic\/(t_[a-z0-9]+)$/, nav: "social", make: (app, m) => new SocialScreen(app, { tab: "forums", topic: m[1] }) },
  { pattern: /^#\/social\/blog\/(b_[a-z0-9]+)$/, nav: "social", make: (app, m) => new SocialScreen(app, { tab: "blogs", blog: m[1] }) },
  { pattern: /^#\/social\/chat\/(u_[a-z0-9]+)$/, nav: "social", make: (app, m) => new SocialScreen(app, { tab: "messages", chat: m[1] }) },
  { pattern: /^#\/social\/club\/(c_[a-z0-9]+)$/, nav: "social", make: (app, m) => new SocialScreen(app, { tab: "clubs", club: m[1] }) },
  { pattern: /^#\/social\/match\/(cm_[a-z0-9]+)$/, nav: "social", make: (app, m) => new SocialScreen(app, { tab: "clubs", match: m[1] }) },
  { pattern: /^#\/social\/add\/([0-9A-Za-z]{8})$/, nav: "social", make: (app, m) => new SocialScreen(app, { tab: "friends", add: m[1] }) },
  { pattern: /^#\/profile$/, nav: "profile", make: (app) => new ProfilePage(app) },
  { pattern: /^#\/insights$/, nav: "profile", make: (app) => new InsightsPage(app) },
  { pattern: /^#\/settings$/, nav: "settings", make: (app) => new SettingsPage(app) },
];

// invite links from older builds carry only ?room=
if (new URLSearchParams(location.search).get("room") && !location.hash && !/^zh-/.test(new URLSearchParams(location.search).get("room"))) {
  history.replaceState(null, "", location.pathname + location.search + "#/online");
}

const app = new App(routes);
startI18n();
addEventListener("pointerdown", () => unlockAudio(), { once: true });
app.start();
// friends, messages and challenges: presence heartbeat and notices (only once social is turned on)
startSocial(app);
// daily games: a notice when it's your move (checked every few minutes while the app is open)
watchDaily(app);
// the opening book (~460 KB) isn't needed for first paint; screens that use it load it on demand
(window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => loadOpenings());

// first visit: a short welcome that seeds ratings (skipped for invite links and automated checks)
{
  const q = new URLSearchParams(location.search);
  if (!q.get("room") && !q.has("dev")) setTimeout(() => maybeWelcome(app), 600);
}

// installable + offline (bots, puzzles, analysis and review all run locally)
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost") && !new URLSearchParams(location.search).has("nosw")) {
  addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

// dev-only hook (?dev=1) for automated checks
if (new URLSearchParams(location.search).has("dev")) {
  window.__test = {
    app,
    board: () => app.board,
    ctrl: () => app.controller,
    tap: (sq) => app.board.onSquareTap && app.board.onSquareTap(sq),
    settings: (patch) => setSettings(patch),
    fen: () => { const c = app.controller; return c && (c.chess ? c.chess.fen() : c.node ? c.node.fen : null); },
  };
}
