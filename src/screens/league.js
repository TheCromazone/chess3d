// Leagues, like chess.com's: eight tiers from Wood to Legend. Each week you're grouped with up to 49
// other players of your tier, earn trophies from rated games against random opponents and from arenas,
// and the top of the division moves up a tier when the week ends (nobody moves down). The game server
// keeps the divisions and reads each result from the game room (server/social.ts).
import { Chess } from "chess.js";
import { h, icon } from "../ui/dom.js";
import { userAvatar } from "../ui/people.js";
import { OnlineGame } from "../modes/online-game.js";
import * as S from "../net/social.js";

export const LEAGUE_TIERS = ["Wood", "Stone", "Bronze", "Silver", "Crystal", "Elite", "Champion", "Legend"];

// "2 days 5 h", "5 h 20 min", "12 min"
function untilText(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000)), hrs = Math.floor(m / 60), days = Math.floor(hrs / 24);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ${hrs % 24} h`;
  return hrs >= 1 ? `${hrs} h ${m % 60} min` : `${m} min`;
}

export function tierBadge(tier, size = "") {
  return h(`span.tier-badge${size}`, { "data-tier": String(tier), title: `${LEAGUE_TIERS[tier]} league` }, h("span", LEAGUE_TIERS[tier]));
}

export class LeagueScreen {
  constructor(app) { this.app = app; }

  mount() {
    this.app.setLobby(true);
    this.app.board.syncFromBoard(new Chess().board());
    this.app.board.viewSide("w", false);
    if (this.app.board.setIdle) this.app.board.setIdle(true);
    this.render(null);
    this.load();
    this.t = setInterval(() => this.load(), 30000);
  }
  destroy() { this.dead = true; clearInterval(this.t); if (this.app.board.setIdle) this.app.board.setIdle(false); }

  async load() {
    if (!S.registered()) return;
    try { const d = await S.api("GET", "/league"); if (!this.dead) this.render(d); }
    catch (e) { if (!this.dead) this.render(null, e); }
  }

  play() { this.app.launch(() => new OnlineGame(this.app, { kind: "pool", tcKey: "10+0" }), "#/online"); }

  render(d, err) {
    const body = [];
    if (!S.registered()) {
      body.push(h("div.card",
        h("h3", "Turn on Social to join a league"),
        h("p.note", "Leagues group you with other players each week, so they use your social profile: a key saved on this device, no sign-up."),
        h("button.btn.primary", { onclick: () => this.app.go("#/social"), style: { marginTop: "10px" } }, icon("users", 18), "Open Social")));
    } else if (err) body.push(h("div.status-line.bad", icon("close", 16), h("span", err.message)));
    else if (!d) body.push(h("p.note", "Loading your league…"));
    else body.push(...this._league(d));
    this.app.strips(null, null);
    this.app.panel({
      title: "League", back: "#/", body,
      foot: d && S.registered() ? h("button.btn.primary.big.block", { onclick: () => this.play() }, icon("bolt", 18), d.division ? "Play a rated game" : "Play to join this week's league") : null,
    });
  }

  _league(d) {
    const out = [];
    const div = d.division;
    const tier = div ? div.tier : d.tier;
    const mine = div && div.standings.find((r) => r.me);
    out.push(h("div.card.league-head",
      tierBadge(tier, ".lg"),
      h("div.league-sum",
        h("b", `${LEAGUE_TIERS[tier]} league`),
        h("small", `This week ends in ${untilText(d.ends - Date.now())}`),
        mine ? h("small", `${mine.points} troph${mine.points === 1 ? "y" : "ies"}, #${mine.place} of ${div.standings.length}`) : null)));
    // where you are on the ladder
    out.push(h("div.tier-ladder", { role: "list", "aria-label": "League tiers" },
      ...LEAGUE_TIERS.map((name, i) => h(`span.tier-step${i < tier ? ".done" : i === tier ? ".now" : ""}`, { role: "listitem", "data-tier": String(i), "aria-current": i === tier ? "step" : null }, name))));
    if (d.last && d.last.settled) {
      const moved = d.last.promoted;
      out.push(h(`div.status-line${moved ? ".good" : ""}`, icon("trophy", 16),
        h("span", `Last week you finished #${d.last.place} of ${d.last.size} in ${LEAGUE_TIERS[d.last.tier]}${moved ? `, and moved up to ${LEAGUE_TIERS[Math.min(7, d.last.tier + 1)]}.` : "."}`)));
    }
    if (!div) {
      out.push(h("p.note", `Play a rated game against a random opponent to join this week's ${LEAGUE_TIERS[tier]} league. You'll be grouped with up to 49 players of your tier.`));
    } else {
      const promote = div.promote;
      const rows = [];
      for (const r of div.standings) {
        rows.push(h(`tr${r.me ? ".me" : ""}${promote && r.place <= promote ? ".up" : ""}`,
          h("td.rank", String(r.place)),
          h("td", h("div.arena-player", userAvatar(r, ".sm"), h("b", r.name))),
          h("td.num", h("b", String(r.points))),
          h("td.num.wide-only", String(r.games))));
        if (promote && r.place === promote && div.standings.length > promote) {
          rows.push(h("tr.promo-line", h("td", { colspan: "4" }, h("span", `Top ${promote} move up to ${LEAGUE_TIERS[Math.min(7, div.tier + 1)]}`))));
        }
      }
      out.push(h("div.table-wrap", h("table.table.arena-table.league-table",
        h("thead", h("tr", h("th", "#"), h("th", "Player"), h("th", "Trophies"), h("th.wide-only", "Games"))),
        h("tbody", ...rows))));
      if (!promote) out.push(h("p.note", "Legend is the top league: there's nowhere higher to go."));
    }
    const P = d.points;
    out.push(h("details.league-how",
      h("summary", "How trophies work"),
      h("ul",
        h("li", `Win a rated game against a random opponent: ${P.rapid[0]} trophies in rapid, ${P.blitz[0]} in blitz, ${P.bullet[0]} in bullet. A draw earns ${P.rapid[1]}, ${P.blitz[1]} or ${P.bullet[1]}.`),
        h("li", `Arena games earn ${d.arenaFactor === 2 ? "double" : `${d.arenaFactor}×`}.`),
        h("li", `Up to ${d.perOpponent} scoring games against the same opponent a day count. Games under a minute a side, aborted games, and games against players without Social don't.`),
        h("li", "When the week ends (Sunday, 19:00 UTC) the top of each division moves up a tier. Nobody moves down."))));
    return out;
  }
}
