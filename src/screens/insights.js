// Insights: what your archive says about your play (accuracy trend, phases, colours, time controls).
import { h, icon } from "../ui/dom.js";
import { sparkline, clsDot, CLS } from "../ui/components.js";
import { getGames, getCachedReview, timeClass } from "../store.js";

const PHASES = ["opening", "middlegame", "endgame"];

function phaseOf(ply, fen) {
  if (ply < 20) return "opening";
  const V = { q: 9, r: 5, b: 3, n: 3 };
  let mat = 0;
  for (const ch of fen.split(" ")[0]) { const v = V[ch.toLowerCase()]; if (v) mat += v; }
  return mat <= 26 ? "endgame" : "middlegame";
}

export class InsightsPage {
  constructor(app) { this.app = app; }
  destroy() {}
  mount() {
    const games = getGames().filter(g => g.myColor);
    const page = h("div.page", h("div.page-head", h("h1", "Insights"), h("p", "What your games say about your play. Review games to unlock accuracy and phase stats.")));
    if (!games.length) {
      page.append(h("div.card", h("h3", "No games yet"), h("p.note", "Play a few games against the bots or online, then come back.")), h("button.btn.primary", { onclick: () => this.app.go("#/bots"), style: { alignSelf: "flex-start" } }, "Play a bot"));
      this.app.pageMode(page);
      return;
    }
    const res = (g) => { const w = g.result === "1-0" ? "w" : g.result === "0-1" ? "b" : null; return !w ? 0.5 : w === g.myColor ? 1 : 0; };
    const pct = (arr) => arr.length ? Math.round((arr.reduce((a, x) => a + x, 0) / arr.length) * 100) + "%" : "–";

    // accuracy trend (oldest → newest)
    const reviewed = games.filter(g => g.accuracy && g.accuracy[g.myColor] != null).reverse();
    const accs = reviewed.map(g => g.accuracy[g.myColor]);
    const avgAcc = accs.length ? (accs.reduce((a, x) => a + x, 0) / accs.length).toFixed(1) : "–";
    const recent = accs.slice(-5), older = accs.slice(0, -5);
    const trend = recent.length && older.length ? (recent.reduce((a, x) => a + x, 0) / recent.length) - (older.reduce((a, x) => a + x, 0) / older.length) : null;

    // by colour and time class
    const byColor = { w: games.filter(g => g.myColor === "w").map(res), b: games.filter(g => g.myColor === "b").map(res) };
    const classes = {};
    for (const g of games) { const c = timeClass(g.tc) || "unlimited"; (classes[c] = classes[c] || []).push(res(g)); }

    // phase accuracy + mistake profile from cached full reviews
    const phase = { opening: [], middlegame: [], endgame: [] };
    const mistakes = { inaccuracy: 0, mistake: 0, miss: 0, blunder: 0, brilliant: 0, great: 0 };
    let reviewedGames = 0;
    for (const g of games) {
      const r = getCachedReview(g.id);
      if (!r || !r.plies) continue;
      reviewedGames++;
      for (const p of r.plies) {
        if (p.color !== g.myColor) continue;
        phase[phaseOf(p.ply, p.fenBefore)].push(p.accuracy);
        if (p.classification in mistakes) mistakes[p.classification]++;
      }
    }
    const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "–");

    page.append(h("section", h("h2", "Accuracy"), h("div.stat-grid",
      h("div.stat", h("div.lbl", icon("star", 16), "Average accuracy"), h("div.val", String(avgAcc)), h("div.note", `${accs.length} reviewed game${accs.length === 1 ? "" : "s"}`), sparkline(reviewed.map((g, i) => [i, g.accuracy[g.myColor]]))),
      h("div.stat", h("div.lbl", "Recent trend"), h("div.val", { style: { color: trend === null ? "" : trend >= 0 ? "var(--accent)" : "var(--down)" } }, trend === null ? "–" : (trend >= 0 ? "+" : "") + trend.toFixed(1)), h("div.note", "Last 5 reviewed vs earlier")),
      ...PHASES.map(ph => h("div.stat", h("div.lbl", ph[0].toUpperCase() + ph.slice(1)), h("div.val", String(avg(phase[ph]))), h("div.note", "Accuracy in this phase"))))));
    if (!reviewedGames) page.append(h("p.note", "Phase accuracy and the mistake profile come from games you've reviewed recently."));

    page.append(h("section", h("h2", "Results"), h("div.stat-grid",
      h("div.stat", h("div.lbl", "As White"), h("div.val", pct(byColor.w)), h("div.note", `Score from ${byColor.w.length} game${byColor.w.length === 1 ? "" : "s"}`)),
      h("div.stat", h("div.lbl", "As Black"), h("div.val", pct(byColor.b)), h("div.note", `Score from ${byColor.b.length} game${byColor.b.length === 1 ? "" : "s"}`)),
      ...Object.entries(classes).map(([c, arr]) => h("div.stat", h("div.lbl", c[0].toUpperCase() + c.slice(1)), h("div.val", pct(arr)), h("div.note", `Score from ${arr.length} game${arr.length === 1 ? "" : "s"}`))))));

    if (reviewedGames) {
      const per = (n) => (n / reviewedGames).toFixed(1);
      page.append(h("section", h("h2", "Per reviewed game"), h("div.stat-grid",
        ...Object.keys(mistakes).map(k => h("div.stat", h("div.lbl", clsDot(k, 16), CLS[k].label), h("div.val", per(mistakes[k])), h("div.note", "per game"))))));
    }
    page.append(h("button.btn", { onclick: () => this.app.go("#/profile"), style: { alignSelf: "flex-start" } }, icon("back", 18), "Back to profile"));
    this.app.pageMode(page);
  }
}
