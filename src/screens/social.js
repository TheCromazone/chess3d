// Social: friends with online status, direct messages and challenges, clubs with their own chat,
// and the global leaderboard. Data lives on the game server (net/social.js); no sign-in needed.
import { h, icon, timeAgo, copyText } from "../ui/dom.js";
import { openModal, toast, confirmModal, segmented, tcPicker, tcLabel, switchRow } from "../ui/components.js";
import { userAvatar, presenceText, notice } from "../ui/people.js";
import { getProfile } from "../store.js";
import { OnlineGame } from "../modes/online-game.js";
import { makePlayerId } from "../net/room.js";
import { DAILY_PACES } from "../modes/daily.js";
import { gamePgn } from "./pages.js";
import { signInModal } from "./account.js";
import { SFX } from "../audio.js";
import * as S from "../net/social.js";
import { VARIANT_NAMES } from "../modes/variant-replay.js";

const TABS = [
  { id: "friends", label: "Friends" },
  { id: "messages", label: "Messages" },
  { id: "clubs", label: "Clubs" },
  { id: "forums", label: "Forums" },
  { id: "blogs", label: "Blogs" },
  { id: "coaches", label: "Coaches" },
  { id: "leaderboard", label: "Leaderboard" },
];
const FORUM_LABEL = { general: "General", openings: "Openings", tactics: "Tactics", endgames: "Endgames", help: "Help and feedback" };
let forumCat = null;
const CAT_LABEL = { blitz: "Blitz", bullet: "Bullet", rapid: "Rapid", puzzle: "Puzzles", bots: "Vs bots", rush: "Puzzle Rush" };
const LB_CATS = [...S.CATS, "rush", "variants"];
CAT_LABEL.variants = "Variants";
// the variant boards, in the order of the Variants page
const LB_VARIANTS = ["crazyhouse", "fourplayer", "fourteams", "duck", "fog", "giveaway", "atomic", "horde", "chess960", "koth", "threecheck"];
let lbVariant = "crazyhouse";
let lastTc = "10+0";
let lastPace = "3d";
const isDailyKey = (k) => k === "inf" || /^\d+d$/.test(k || "");
let lbCat = "blitz";
let lbScope = "all";

// ---------- challenges ----------
// mode "live" takes a clock like "5+0"; mode "daily" takes days per move ("3d") or "inf"
export async function sendChallenge(app, user, mode, tc) {
  const room = S.challengeRoom(mode);
  const tcKey = mode === "daily" ? (isDailyKey(tc) ? tc : "inf") : tc;
  await S.api("POST", "/messages", { to: user.id, kind: "challenge", room, tc: tcKey, mode });
  app.launch(() => new OnlineGame(app, { kind: mode === "daily" ? "daily" : "friend", room, tcKey, invitee: user.name }), "#/online");
}

// spectate a friend's live game: the room seats its two players, so a third visitor watches
function watchFriend(app, u) {
  app.launch(() => new OnlineGame(app, { kind: "friend", room: u.watch, tcKey: "10+0", spectate: true }), "#/online");
}

export function acceptChallenge(app, c) {
  app.launch(() => new OnlineGame(app, { kind: c.mode === "daily" ? "daily" : "friend", room: c.room, tcKey: c.mode === "daily" ? (isDailyKey(c.tc) ? c.tc : "inf") : c.tc }), "#/online");
}

// reading a thread marks it seen on the server; refresh the badge afterwards
function markRead(userId, lastId) {
  S.api("GET", `/messages?with=${encodeURIComponent(userId)}&after=${lastId}`).then(() => S.beat()).catch(() => {});
}

function challengeLabel(c) {
  if (c.mode !== "daily") return `a ${tcLabel(c.tc)} game`;
  return /d$/.test(c.tc || "") ? `a daily game (${tcLabel(c.tc)} per move)` : "a daily game";
}

function challengeModal(app, user) {
  let mode = "live", tc = lastTc, days = lastPace;
  const picker = h("div", tcPicker(tc, (v) => { tc = v; }));
  const pacePicker = h("div.field", { hidden: true }, h("div.lbl", "Time per move"), segmented(DAILY_PACES, days, (v) => { days = v; }));
  const send = h("button.btn.primary.block", {
    onclick: async () => {
      send.disabled = true;
      try {
        if (mode === "live") lastTc = tc; else lastPace = days;
        m.close();
        await sendChallenge(app, user, mode, mode === "live" ? tc : days);
      }
      catch (e) { toast(e.message); send.disabled = false; }
    },
  }, icon("bolt", 18), "Send challenge");
  const m = openModal({
    title: `Challenge ${user.name}`,
    sub: user.online ? presenceText(user) : `${user.name} is offline. They'll see the challenge next time they open Chess 3D.`,
    body: [
      segmented([{ value: "live", label: "Live game" }, { value: "daily", label: "Daily game" }], mode, (v) => { mode = v; picker.hidden = v === "daily"; pacePicker.hidden = v !== "daily"; }),
      picker, pacePicker, send,
    ],
  });
}

// ---------- app-wide: nav badge, notices, heartbeat ----------
export function startSocial(app) {
  S.setNotifier((m) => {
    const ctl = app.controller;
    const watching = ctl instanceof SocialScreen && ctl.view.chat === m.sender;
    const from = { name: m.sender_name, id: m.sender };
    if (m.kind === "challenge") {
      const c = S.parseChallenge(m);
      if (!c) return;
      SFX.notify();
      notice({
        avatar: h("span.ri", icon(c.mode === "daily" ? "calendar" : "bolt", 20)),
        title: `${m.sender_name} challenges you`,
        text: `to ${challengeLabel(c)}`,
        ms: c.mode === "daily" ? 15000 : 45000,
        actions: [
          { label: "Accept", primary: true, onClick: () => { markRead(from.id, m.id); acceptChallenge(app, c); } },
          { label: "Decline", onClick: () => { markRead(from.id, m.id); S.api("POST", "/messages", { to: from.id, text: `Declined your challenge to ${challengeLabel(c)}.` }).catch(() => {}); } },
        ],
      });
    } else if (!watching) {
      notice({
        avatar: h("span.ri", icon("chat", 20)),
        title: m.sender_name,
        text: m.body.length > 90 ? m.body.slice(0, 90) + "…" : m.body,
        ms: 8000,
        actions: [{ label: "Reply", onClick: () => app.go(`#/social/chat/${from.id}`) }],
      });
    }
  });
  S.onSocial((st) => {
    app.setNavBadge("social", st.unread + st.requests);
    if (st.signedOut) {
      st.signedOut = false;
      toast("This device was signed out of your profile. Sign in again from Social.");
      if (app.controller instanceof SocialScreen) app.controller.render();
    }
  });
  S.startHeartbeat();
}

// ---------- the page ----------
export class SocialScreen {
  // view: { tab, chat?: userId, club?: clubId, add?: friend code }
  constructor(app, view = {}) {
    this.app = app;
    this.view = { tab: "friends", ...view };
    this.tok = 0;
  }

  mount() {
    this.off = S.onSocial(() => this._counts());
    this.render();
    if (this.view.add && S.registered()) this._addFromLink();
  }

  // opened from a friend's invite link: send the request once, then drop the code from the URL
  _addFromLink() {
    const code = this.view.add;
    this.view.add = null;
    history.replaceState(null, "", location.pathname + location.search + "#/social/friends");
    this.app._lastHash = "#/social/friends";
    if (code !== S.myCode()) this._addByCode(code);
  }
  destroy() { this.dead = true; this.tok++; clearInterval(this.poll); if (this.off) this.off(); }

  render() {
    if (this.dead) return;     // a late async callback after the user moved on
    this.tok++;
    clearInterval(this.poll);
    const page = h("div.page.social");
    page.append(h("div.page-head", h("div", h("h1", "Social"), h("p", "Add friends by code, chat, challenge them, join clubs and see where you rank."))));
    if (!S.registered()) {
      page.append(this._joinCard());
      this.app.pageMode(page);
      return;
    }
    this.tabsEl = h("nav.tabs.page-tabs", { "aria-label": "Social sections" },
      ...TABS.map(t => h(`a.tab${t.id === this.view.tab ? ".on" : ""}`, { href: `#/social/${t.id}`, dataset: { tab: t.id }, "aria-current": t.id === this.view.tab ? "page" : null },
        t.label, h("span.tab-count", { hidden: true }))));
    this.body = h("div.social-body");
    page.append(this.tabsEl, this.body);
    this.app.pageMode(page);
    this._counts();
    const tok = this.tok;
    const run = { friends: () => this._friends(tok), messages: () => (this.view.chat ? this._thread(tok, this.view.chat) : this._conversations(tok)),
      clubs: () => (this.view.club ? this._club(tok, this.view.club) : this._clubs(tok)), leaderboard: () => this._leaderboard(tok),
      forums: () => (this.view.topic ? this._topic(tok, this.view.topic) : this._forums(tok)),
      blogs: () => (this.view.blog ? this._blogPost(tok, this.view.blog) : this._blogs(tok)), coaches: () => this._coaches(tok) };
    if (this.view.match) run.clubs = () => this._match(tok, this.view.match);
    (run[this.view.tab] || run.friends)();
  }

  _live(tok) { return !this.dead && tok === this.tok; }

  _counts() {
    if (!this.tabsEl) return;
    const st = S.socialState();
    const set = (id, n) => {
      const el = this.tabsEl.querySelector(`[data-tab="${id}"] .tab-count`);
      if (el) { el.hidden = !n; el.textContent = String(n); }
    };
    set("friends", st.requests);
    set("messages", st.unread);
  }

  _joinCard() {
    const p = getProfile();
    const btn = h("button.btn.primary.big", {
      onclick: async () => {
        btn.disabled = true;
        try {
          await S.join();
          toast("Social is on. Share your friend code to add friends.");
          if (this.view.add) this._addFromLink();
          this.render();
        } catch (e) { toast(e.message); btn.disabled = false; }
      },
    }, icon("users", 20), this.view.add ? "Turn on social and add friend" : "Turn on social");
    return h("section.card.join-card",
      h("h3", this.view.add ? `Someone sent you their friend code (${S.fmtCode(S.cleanCode(this.view.add))})` : "Play with people you know"),
      h("ul.join-list",
        h("li", icon("users", 18), h("span", "Get a friend code to share, and see when friends are online")),
        h("li", icon("chat", 18), h("span", "Message friends and challenge them to live or daily games")),
        h("li", icon("star", 18), h("span", "Create or join clubs, each with its own chat")),
        h("li", icon("trophy", 18), h("span", "See where you rank on the global leaderboard"))),
      h("p.note", `Other players will see your name (${S.socialName(p.name)}), avatar, ratings, your recent online and bot games, and whether you're online. There's no email or password: a key saved in this browser is your account, your games and ratings are backed up to it, and you can sign in on other devices from Settings.`),
      h("div.join-actions", btn, h("button.btn.ghost", { onclick: () => signInModal() }, icon("key", 18), "I already have a profile")));
  }

  async _addByCode(text) {
    const code = S.cleanCode(text);
    if (code.length !== 8) { toast("Friend codes have 8 letters and numbers."); return false; }
    try {
      const r = await S.api("POST", "/friends/request", { code });
      toast(r.status === "friends" ? "You're now friends" : `Friend request sent to ${r.user.name}`);
      if (this.view.tab === "friends" && !this.dead) this.render();
      return true;
    } catch (e) { toast(e.message); return false; }
  }

  // ---------- friends ----------
  async _friends(tok) {
    const code = S.myCode();
    const link = location.origin + location.pathname + "#/social/add/" + code;
    const input = h("input.input", { placeholder: "Friend code, e.g. K7M2 QX9P", "aria-label": "Friend code to add", maxlength: "11", autocomplete: "off", autocapitalize: "characters", spellcheck: "false" });
    const add = async () => { if (await this._addByCode(input.value)) input.value = ""; };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    const codeCard = h("section.card.code-card",
      h("div.code-side",
        h("div.lbl", "Your friend code"),
        h("div.friend-code", S.fmtCode(code)),
        h("div.btn-row",
          h("button.btn.small", { onclick: async () => { if (await copyText(code)) toast("Code copied"); } }, icon("copy", 16), "Copy code"),
          h("button.btn.small", {
            onclick: async () => {
              if (navigator.share) navigator.share({ title: "Add me on Chess 3D", text: `My Chess 3D friend code is ${S.fmtCode(code)}`, url: link }).catch(() => {});
              else if (await copyText(link)) toast("Invite link copied");
            },
          }, icon("share", 16), navigator.share ? "Share invite" : "Copy invite link"))),
      h("div.code-side",
        h("label.lbl", { for: "add-code" }, "Add a friend"),
        h("div.add-row", Object.assign(input, { id: "add-code" }), h("button.btn.primary", { onclick: add }, icon("plus", 18), "Add"))));
    const lists = h("div.friend-lists", h("p.note", "Loading friends…"));
    const blockedBox = h("div");
    this.body.replaceChildren(codeCard, this._searchBox(), lists, blockedBox);
    S.loadBlocked().then((list) => {
      if (!this._live(tok) || !list.length) return;
      blockedBox.replaceChildren(h("section", h("h2", `Blocked (${list.length})`), h("div.rows",
        ...list.map(u => h("div.row", userAvatar(u), h("span.rt", h("b", u.name), h("small", "Can't add, message or challenge you")),
          h("button.btn.small.ghost", {
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              try { await S.unblock(u.id); toast(`Unblocked ${u.name}`); this.render(); } catch (err) { toast(err.message); }
            },
          }, "Unblock"))))));
    }).catch(() => {});

    const refresh = async () => {
      let d;
      try { d = await S.api("GET", "/friends"); } catch (e) { if (this._live(tok)) lists.replaceChildren(errorLine(e, refresh)); return; }
      if (this._live(tok)) draw(d);
    };
    const draw = (d) => {
      const out = [];
      if (d.incoming.length) {
        out.push(h("section", h("h2", `Friend requests (${d.incoming.length})`), h("div.rows",
          ...d.incoming.map(u => h("div.row", userAvatar(u), h("span.rt", h("b", u.name), h("small", `Blitz ${u.ratings.blitz.r} · ${presenceText(u)}`)),
            h("div.row-actions",
              h("button.btn.small.primary", { onclick: () => this._respond(u, true) }, icon("check", 16), "Accept"),
              h("button.btn.small.ghost", { onclick: () => this._respond(u, false) }, "Decline")))))));
      }
      const online = d.friends.filter(u => u.online).length;
      out.push(h("section", h("h2", d.friends.length ? `Friends (${online} online)` : "Friends"),
        d.friends.length ? h("div.rows", ...d.friends.map(u => this._friendRow(u)))
          : h("p.note", "No friends yet. Share your code above, or add players from the leaderboard.")));
      if (d.outgoing.length) {
        out.push(h("section", h("h2", "Sent requests"), h("div.rows",
          ...d.outgoing.map(u => h("div.row", userAvatar(u), h("span.rt", h("b", u.name), h("small", "Waiting for them to accept")),
            h("button.btn.small.ghost", { onclick: async () => { await S.api("POST", "/friends/remove", { id: u.id }).catch(e => toast(e.message)); refresh(); } }, "Cancel"))))));
      }
      lists.replaceChildren(...out);
    };
    if (S.cached("/friends")) draw(S.cached("/friends"));
    await refresh();
    if (this._live(tok)) this.poll = setInterval(refresh, 20000);
  }

  // find players by name, like chess.com's member search
  _searchBox() {
    const input = h("input.input", { type: "search", placeholder: "Find players by name", "aria-label": "Find players by name", maxlength: "16", autocomplete: "off", spellcheck: "false" });
    const results = h("div.rows.search-results");
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { results.replaceChildren(); return; }
      timer = setTimeout(async () => {
        let d;
        try { d = await S.api("GET", "/search?q=" + encodeURIComponent(q)); } catch (e) { results.replaceChildren(errorLine(e)); return; }
        if (input.value.trim() !== q) return;
        const friends = new Set(((S.cached("/friends") || {}).friends || []).map(f => f.id));
        const list = d.players.filter(u => u.id !== S.myId());
        results.replaceChildren(...(list.length ? list.map(u => h("div.row",
          h("button.row-main", { onclick: () => this._profile(u, friends.has(u.id)), "aria-label": `${u.name}. Open profile` },
            userAvatar(u), h("span.rt", h("b", u.name, h("span.muted", ` ${u.ratings.blitz.r}`)), h("small", friends.has(u.id) ? `Friend, ${presenceText(u).toLowerCase()}` : presenceText(u)))),
          friends.has(u.id) ? null : h("button.btn.small", { onclick: async (e) => { e.currentTarget.disabled = true; await this._addByCode(u.code); }, "aria-label": `Add ${u.name} as a friend` }, icon("plus", 16), h("span.wide-only", "Add"))))
          : [h("p.note", `Nobody's name starts with "${q}".`)]));
      }, 300);
    });
    return h("section.search-sec", input, results);
  }

  _friendRow(u) {
    return h("div.row.friend-row",
      h("button.row-main", { onclick: () => this._profile(u, true), "aria-label": `${u.name}, ${presenceText(u)}. Open profile` },
        userAvatar(u), h("span.rt", h("b", u.name, h("span.muted", ` ${u.ratings.blitz.r}`)), h("small", presenceText(u)))),
      h("div.row-actions",
        u.watch ? h("button.btn.small", { onclick: () => watchFriend(this.app, u), "aria-label": `Watch ${u.name}'s game` }, icon("eye", 16), h("span.wide-only", "Watch")) : null,
        h("button.btn.small.primary", { onclick: () => challengeModal(this.app, u), "aria-label": `Challenge ${u.name}` }, icon("bolt", 16), h("span.wide-only", "Challenge")),
        h("button.btn.small", { onclick: () => this.app.go(`#/social/chat/${u.id}`), "aria-label": `Message ${u.name}` }, icon("chat", 16), h("span.wide-only", "Message"))));
  }

  async _respond(u, accept) {
    try {
      await S.api("POST", "/friends/respond", { id: u.id, accept });
      toast(accept ? `You and ${u.name} are now friends` : "Request declined");
      S.beat();
      this.render();
    } catch (e) { toast(e.message); }
  }

  // extra: { onRemove } when a club owner looks at a member
  _profile(u, isFriend, extra = {}) {
    const R = u.ratings || {};
    const grid = h("div.mini-ratings", ...S.CATS.map(c => h("div", h("small", CAT_LABEL[c]), h("b", String(R[c] ? R[c].r : "–")), h("small", R[c] ? `${R[c].n} ${c === "puzzle" ? "puzzles" : "games"}` : ""))));
    const mine = u.id === S.myId();
    const actions = mine ? null : isFriend
      ? h("div.btn-row",
        h("button.btn.primary", { onclick: () => { m.close(); challengeModal(this.app, u); } }, icon("bolt", 18), "Challenge"),
        h("button.btn", { onclick: () => { m.close(); this.app.go(`#/social/chat/${u.id}`); } }, icon("chat", 18), "Message"))
      : h("button.btn.primary.block", { onclick: async () => { m.close(); await this._addByCode(u.code); } }, icon("plus", 18), "Add friend");
    const remove = isFriend && !mine ? h("button.btn.ghost.block", {
      onclick: async () => {
        if (!(await confirmModal({ title: `Remove ${u.name}?`, sub: "You'll stop seeing each other online and can't message until you're friends again.", yes: "Remove", danger: true }))) return;
        try { await S.api("POST", "/friends/remove", { id: u.id }); m.close(); toast(`Removed ${u.name}`); this.render(); } catch (e) { toast(e.message); }
      },
    }, "Remove friend") : null;
    const blocked = S.isBlockedCode(u.code);
    const blockBtn = mine ? null : h("button.btn.ghost.block", {
      onclick: async () => {
        try {
          if (blocked) { await S.unblock(u.id); toast(`Unblocked ${u.name}`); }
          else {
            if (!(await confirmModal({ title: `Block ${u.name}?`, sub: "They won't be able to add, message or challenge you, you won't be paired with them, and you won't see their posts or chat. Any friendship between you ends.", yes: "Block", danger: true }))) return;
            await S.block({ id: u.id });
            toast(`Blocked ${u.name}`);
          }
          m.close();
          this.render();
        } catch (e) { toast(e.message); }
      },
    }, blocked ? "Unblock" : "Block");
    const kick = extra.onRemove ? h("button.btn.danger.block", {
      onclick: async () => {
        if (!(await confirmModal({ title: `Remove ${u.name} from the club?`, sub: "They leave the club and can't rejoin it.", yes: "Remove", danger: true }))) return;
        m.close();
        extra.onRemove();
      },
    }, "Remove from club") : null;
    // recent games, newest first; each opens on the analysis board
    const games = h("div.profile-games", h("p.note", "Loading recent games…"));
    const m = openModal({
      title: u.name,
      sub: `${presenceText(u)}${u.games ? `, ${u.games} game${u.games === 1 ? "" : "s"} played` : ""}`,
      body: [h("div.profile-pop", userAvatar(u, ".lg"), grid),
        Object.keys(u.variants || {}).length ? h("p.note", "Variants: " + Object.entries(u.variants).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${VARIANT_NAMES[k] || k} ${v.r}`).join(", ")) : null,
        blocked ? h("p.note", "You've blocked this player.") : actions, remove, kick, blockBtn, h("div.lbl.note", "Recent games"), games],
    });
    S.api("GET", `/users/${u.id}/games`).then((d) => {
      if (!d.games.length) { games.replaceChildren(h("p.note", `${u.name} hasn't finished a game since turning on Social.`)); return; }
      games.replaceChildren(...d.games.slice(0, 10).map((g) => {
        const me = g.myColor, winner = g.result === "1-0" ? "w" : g.result === "0-1" ? "b" : null;
        const res = !me ? "draw" : !winner ? "draw" : winner === me ? "win" : "loss";
        const opp = me === "b" ? g.white : g.black;
        return h("button.pg-row", { onclick: () => { m.close(); this.app.go("#/analysis/pgn/" + encodeURIComponent(gamePgn(g))); } },
          h(`span.res.${res}`, res === "win" ? "+" : res === "loss" ? "−" : "½"),
          h("span.rt", h("b", `vs ${opp.name}${opp.rating ? ` (${opp.rating})` : ""}`), h("small", `${g.mode === "bot" ? "Bot game" : "Online"}, ${tcLabel(g.tc)}, ${Math.ceil(g.moves.length / 2)} moves, ${timeAgo(g.date)}`)),
          icon("analysis", 16));
      }));
    }).catch(() => games.replaceChildren(h("p.note", "Couldn't load recent games.")));
  }

  // ---------- messages ----------
  async _conversations(tok) {
    const box = h("div.rows", h("p.note", "Loading messages…"));
    this.body.replaceChildren(box);
    const refresh = async () => {
      let d;
      try { d = await S.api("GET", "/conversations"); } catch (e) { if (this._live(tok)) box.replaceChildren(errorLine(e, refresh)); return; }
      if (this._live(tok)) draw(d);
    };
    const draw = (d) => {
      if (!d.conversations.length) {
        box.replaceChildren(h("p.note", "No friends to message yet. Add friends on the Friends tab, then write to them here."));
        return;
      }
      box.replaceChildren(...d.conversations.map(c => {
        const last = c.last;
        const mine = last && last.sender === S.myId();
        let preview = "No messages yet";
        if (last) {
          const ch = last.kind === "challenge" ? S.parseChallenge(last) : null;
          preview = (mine ? "You: " : "") + (ch ? `Challenge to ${challengeLabel(ch)}` : last.body);
        }
        return h("a.row.convo", { href: `#/social/chat/${c.user.id}` },
          userAvatar(c.user),
          h("span.rt", h("b", c.user.name), h("small", preview)),
          h("span.convo-meta", last ? h("small.muted", timeAgo(last.created)) : null, c.unread ? h("span.count", String(c.unread)) : null));
      }));
    };
    if (S.cached("/conversations")) draw(S.cached("/conversations"));
    await refresh();
    if (this._live(tok)) this.poll = setInterval(refresh, 10000);
  }

  async _thread(tok, uid) {
    let user = null;
    try { user = (await S.api("GET", `/users/${uid}`)).user; } catch (e) { this.body.replaceChildren(errorLine(e, () => this.render())); return; }
    if (!this._live(tok)) return;
    const list = h("div.thread", { role: "log", "aria-label": `Messages with ${user.name}` });
    const input = h("input.input", { placeholder: `Message ${user.name}`, maxlength: "500", "aria-label": "Message", autocomplete: "off" });
    let last = 0, sending = false;
    const pull = async () => {
      let d;
      try { d = await S.api("GET", `/messages?with=${encodeURIComponent(uid)}&after=${last}`); } catch (e) { if (this._live(tok) && !last) list.replaceChildren(errorLine(e, pull)); return; }
      // a poll and a send can overlap: only append what's newer than what's shown
      const fresh = d.messages.filter(m => m.id > last);
      if (!this._live(tok) || !fresh.length) return;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      if (!last) list.querySelector(".thread-empty")?.remove();
      for (const m of fresh) { list.insertBefore(this._bubble(m, user), list.querySelector(".msg.pending")); last = m.id; }
      if (atBottom || list.children.length === fresh.length) list.scrollTop = list.scrollHeight;
      S.beat();
    };
    const send = async () => {
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      input.value = "";
      const temp = pendingBubble(list, text);
      try { await S.api("POST", "/messages", { to: uid, text }); await pull(); }
      catch (e) { toast(e.message); input.value = text; }
      temp.remove();
      list.scrollTop = list.scrollHeight;
      sending = false;
      input.focus();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    list.append(h("p.note.thread-empty", `This is the start of your messages with ${user.name}.`));
    this.body.replaceChildren(h("section.card.thread-card",
      h("div.thread-head",
        h("a.btn.small.ghost", { href: "#/social/messages", "aria-label": "All messages" }, icon("back", 16)),
        userAvatar(user), h("span.rt", h("b", user.name), h("small", presenceText(user))),
        h("button.btn.small.primary", { onclick: () => challengeModal(this.app, user) }, icon("bolt", 16), "Challenge")),
      list,
      h("div.composer", input, h("button.btn.primary", { onclick: send, "aria-label": "Send" }, "Send"))));
    await pull();
    if (!this._live(tok)) return;
    if (matchMedia("(hover: hover)").matches) input.focus();
    this.poll = setInterval(pull, 4000);
  }

  _bubble(m, other) {
    const mine = m.sender === S.myId();
    const when = h("time", { datetime: new Date(m.created).toISOString() }, timeAgo(m.created));
    if (m.kind === "challenge") {
      const c = S.parseChallenge(m);
      if (!c) return h("div.msg", "A challenge that couldn't be read");
      const stale = c.mode !== "daily" && Date.now() - m.created > S.LIVE_CHALLENGE_MS;
      return h(`div.msg.challenge${mine ? ".mine" : ""}`,
        h("div.ch-head", icon(c.mode === "daily" ? "calendar" : "bolt", 18), h("b", mine ? `You challenged ${other.name} to ${challengeLabel(c)}` : `${other.name} challenged you to ${challengeLabel(c)}`)),
        stale ? h("small", "This challenge has expired.")
          : h("button.btn.small" + (mine ? "" : ".primary"), { onclick: () => acceptChallenge(this.app, c) }, mine ? "Open game" : "Accept"),
        when);
    }
    return h(`div.msg${mine ? ".mine" : ""}`, h("span", m.body), when);
  }

  // ---------- clubs ----------
  async _clubs(tok) {
    const box = h("div.club-lists", h("p.note", "Loading clubs…"));
    const actions = h("div.btn-row.club-actions",
      h("button.btn.primary", { onclick: () => this._createClub() }, icon("plus", 18), "Create a club"),
      h("button.btn", { onclick: () => this._joinClubByCode() }, icon("key", 18), "Join with invite code"));
    this.body.replaceChildren(actions, box);
    if (S.cached("/clubs")) this._drawClubs(box, S.cached("/clubs"));
    let d;
    try { d = await S.api("GET", "/clubs"); } catch (e) { if (this._live(tok)) box.replaceChildren(errorLine(e, () => this.render())); return; }
    if (this._live(tok)) this._drawClubs(box, d);
  }

  _drawClubs(box, d) {
    const mineIds = new Set(d.mine.map(c => c.id));
    const clubRow = (c, joined) => h("div.row",
      h("span.ri.club-mark", c.name.slice(0, 1).toUpperCase()),
      h("span.rt", h("b", c.name), h("small", `${c.members} member${c.members === 1 ? "" : "s"}${c.about ? " · " + c.about : ""}`)),
      joined ? h("a.btn.small", { href: `#/social/club/${c.id}` }, "Open")
        : h("button.btn.small.primary", { onclick: async () => { try { await S.api("POST", "/clubs/join", { id: c.id }); this.app.go(`#/social/club/${c.id}`); } catch (e) { toast(e.message); } } }, "Join"));
    const pub = d.public.filter(c => !mineIds.has(c.id));
    box.replaceChildren(
      h("section", h("h2", "Your clubs"), d.mine.length ? h("div.rows", ...d.mine.map(c => clubRow(c, true))) : h("p.note", "You're not in a club yet. Create one for your friends, or join a public club below.")),
      h("section", h("h2", "Public clubs"), pub.length ? h("div.rows", ...pub.map(c => clubRow(c, false))) : h("p.note", "No other public clubs yet.")));
  }

  _createClub() {
    const name = h("input.input", { maxlength: "40", placeholder: "Club name", "aria-label": "Club name" });
    const about = h("textarea.input.prose", { maxlength: "200", rows: "3", placeholder: "What's the club about? (optional)", "aria-label": "About the club" });
    let listed = true;
    const go = h("button.btn.primary.block", {
      onclick: async () => {
        if (name.value.trim().length < 3) { toast("Give the club a name of at least 3 characters."); return; }
        go.disabled = true;
        try {
          const r = await S.api("POST", "/clubs/create", { name: name.value, about: about.value, public: listed });
          m.close();
          toast("Club created. Share its invite code to bring people in.");
          this.app.go(`#/social/club/${r.id}`);
        } catch (e) { toast(e.message); go.disabled = false; }
      },
    }, "Create club");
    const m = openModal({
      title: "Create a club",
      body: [h("div.field", h("label", "Name"), name), h("div.field", h("label", "About"), about),
        switchRow("List in public clubs", "Anyone can find and join it. Otherwise only people with the invite code can.", listed, (v) => { listed = v; }), go],
    });
    name.focus();
  }

  _joinClubByCode() {
    const input = h("input.input", { maxlength: "11", placeholder: "Invite code", "aria-label": "Club invite code", autocapitalize: "characters", spellcheck: "false" });
    const go = h("button.btn.primary.block", {
      onclick: async () => {
        const code = S.cleanCode(input.value);
        if (code.length !== 8) { toast("Club invite codes have 8 letters and numbers."); return; }
        try { const r = await S.api("POST", "/clubs/join", { code }); m.close(); this.app.go(`#/social/club/${r.id}`); } catch (e) { toast(e.message); }
      },
    }, "Join club");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
    const m = openModal({ title: "Join a club", sub: "Ask a member for the club's invite code.", body: [input, go] });
    input.focus();
  }

  async _club(tok, id) {
    let d;
    try { d = await S.api("GET", `/clubs/${id}`); } catch (e) { this.body.replaceChildren(errorLine(e, () => this.app.go("#/social/clubs"))); return; }
    if (!this._live(tok)) return;
    const c = d.club;
    const list = h("div.thread.club-thread", { role: "log", "aria-label": `${c.name} chat` });
    const input = h("input.input", { placeholder: `Message ${c.name}`, maxlength: "500", "aria-label": "Message the club", autocomplete: "off" });
    let last = 0, sending = false;
    const addMsgs = (all) => {
      const msgs = all.filter(m => m.id > last);
      if (!msgs.length) return;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
      if (!last) list.querySelector(".thread-empty")?.remove();
      for (const m of msgs) {
        const mine = m.sender === S.myId();
        list.insertBefore(h(`div.msg${mine ? ".mine" : ""}`, mine ? null : h("b.msg-from", m.sender_name), h("span", m.body), h("time", timeAgo(m.created))), list.querySelector(".msg.pending"));
        last = m.id;
      }
      if (atBottom || list.children.length === msgs.length) list.scrollTop = list.scrollHeight;
    };
    const pull = async () => {
      try { const r = await S.api("GET", `/clubs/${id}/messages?after=${last}`); if (this._live(tok)) addMsgs(r.messages); } catch { /* next poll */ }
    };
    const send = async () => {
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true; input.value = "";
      const temp = pendingBubble(list, text);
      try { await S.api("POST", `/clubs/${id}/messages`, { text }); await pull(); }
      catch (e) { toast(e.message); input.value = text; }
      temp.remove();
      list.scrollTop = list.scrollHeight;
      sending = false; input.focus();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    list.append(h("p.note.thread-empty", "No messages yet. Say hello."));
    const members = d.members.sort((a, b) => (b.online - a.online) || b.ratings.blitz.r - a.ratings.blitz.r);
    const online = members.filter(u => u.online).length;
    this.body.replaceChildren(
      h("div.club-head",
        h("a.btn.small.ghost", { href: "#/social/clubs", "aria-label": "All clubs" }, icon("back", 16)),
        h("div.club-title", h("h2", c.name), c.about ? h("p.note", c.about) : null),
        h("div.club-code", h("small.muted", "Invite code"), h("b", S.fmtCode(c.code)),
          h("button.btn.small", { onclick: async () => { if (await copyText(c.code)) toast("Invite code copied"); }, "aria-label": "Copy invite code" }, icon("copy", 16)))),
      h("div.club-grid",
        h("section.card.thread-card", h("h3", "Club chat"), list, h("div.composer", input, h("button.btn.primary", { onclick: send }, "Send"))),
        h("section.card.members-card", h("h3", `Members (${members.length}, ${online} online)`),
          h("div.member-list", ...members.map(u => h("button.member", {
            onclick: () => this._profile(u, false, c.owner === S.myId() && u.id !== S.myId() ? {
              onRemove: async () => {
                try { await S.api("POST", `/clubs/${id}/remove`, { member: u.id }); toast(`Removed ${u.name}`); this.render(); } catch (e) { toast(e.message); }
              },
            } : {}),
          },
            userAvatar(u, ".sm"), h("span.rt", h("b", u.name), h("small", u.role === "owner" ? "Owner" : presenceText(u))), h("span.muted", String(u.ratings.blitz.r))))),
          h("button.btn.ghost.block", {
            onclick: async () => {
              if (!(await confirmModal({ title: `Leave ${c.name}?`, sub: members.length === 1 ? "You're the last member, so the club and its chat will be deleted." : "You can rejoin with the invite code.", yes: "Leave", danger: true }))) return;
              try { await S.api("POST", "/clubs/leave", { id }); toast(`You left ${c.name}`); this.app.go("#/social/clubs"); } catch (e) { toast(e.message); }
            },
          }, "Leave club"))),
      this._clubMatchesCard(c), this._voteChessCard(c));
    addMsgs(d.messages);
    list.scrollTop = list.scrollHeight;
    this.poll = setInterval(pull, 5000);
  }

  // ---------- club team matches ----------
  _clubMatchesCard(c) {
    const box = h("div.rows", h("p.note", "Loading matches…"));
    const owner = c.owner === S.myId();
    const card = h("section.card.club-matches", h("div.section-head", h("h3", "Team matches"),
      owner ? h("button.btn.small", { onclick: () => this._challengeClub(c) }, icon("plus", 16), "Challenge a club") : null), box);
    const STATUS = { challenge: "Challenge sent", signup: "Sign-ups open", running: "In play", done: "Finished", cancelled: "Cancelled" };
    S.api("GET", `/clubs/${c.id}/matches`).then((d) => {
      box.replaceChildren(...(d.matches.length ? d.matches.map((m) => {
        const incoming = m.status === "challenge" && m.b_club === c.id;
        return h("div.row",
          h("button.row-main", { onclick: () => this.app.go(`#/social/match/${m.id}`) },
            h("span.rt", h("b", `${m.a_name} vs ${m.b_name}`),
              h("small", `${incoming ? "Challenge received" : STATUS[m.status] || m.status}, ${m.tc.replace("d", "")} day${m.tc === "1d" ? "" : "s"} per move${m.status === "running" || m.status === "done" ? `, ${m.a_score2 / 2}–${m.b_score2 / 2}` : `, ${m.a_players} + ${m.b_players} signed up`}`))),
          incoming && owner ? h("div.btn-row",
            h("button.btn.small.primary", { onclick: async () => { try { await S.api("POST", `/matches/${m.id}/accept`, {}); toast("Accepted: sign-ups are open for a day"); this.app.go(`#/social/match/${m.id}`); } catch (e) { toast(e.message); } } }, "Accept"),
            h("button.btn.small.ghost", { onclick: async () => { try { await S.api("POST", `/matches/${m.id}/decline`, {}); toast("Declined"); this.render(); } catch (e) { toast(e.message); } } }, "Decline")) : null);
      }) : [h("p.note", owner ? "No matches yet. Challenge another club to a team match: each member plays an opponent from the other club, one game with each colour." : "No matches yet. The club's owner can challenge other clubs.")]));
    }).catch((e) => box.replaceChildren(errorLine(e)));
    return card;
  }

  _voteChessCard(c) {
    const box = h("div.rows", h("p.note", "Loading…"));
    const owner = c.owner === S.myId();
    const card = h("section.card.club-matches", h("div.section-head", h("h3", "Vote Chess"),
      owner ? h("button.btn.small", { onclick: () => this._challengeClub(c, "votechess") }, icon("plus", 16), "Challenge a club") : null), box);
    S.api("GET", `/clubs/${c.id}/votechess`).then((d) => {
      box.replaceChildren(...(d.games.length ? d.games.map((g) => {
        const incoming = g.status === "challenge" && g.b_club === c.id;
        const status = incoming ? "Challenge received" : g.status === "challenge" ? "Challenge sent" : g.status === "done" ? `Finished, ${g.result}` : `Move ${Math.floor(g.ply / 2) + 1}, ${g.ply % 2 === 0 ? "White" : "Black"} to vote`;
        return h("div.row",
          h("button.row-main", { onclick: () => this.app.go(`#/vote/${g.id}`) }, h("span.rt", h("b", `${g.a_name} vs ${g.b_name}`), h("small", status))),
          incoming && owner ? h("div.btn-row",
            h("button.btn.small.primary", { onclick: async () => { try { await S.api("POST", `/votechess/${g.id}/accept`, {}); this.app.go(`#/vote/${g.id}`); } catch (e) { toast(e.message); } } }, "Accept"),
            h("button.btn.small.ghost", { onclick: async () => { try { await S.api("POST", `/votechess/${g.id}/decline`, {}); this.render(); } catch (e) { toast(e.message); } } }, "Decline")) : null);
      }) : [h("p.note", "One game against another club, where every move is the one your members vote for.")]));
    }).catch((e) => box.replaceChildren(errorLine(e)));
    return card;
  }

  async _challengeClub(c, kind = "matches") {
    let d;
    try { d = await S.api("GET", "/clubs"); } catch (e) { toast(e.message); return; }
    const choices = [...d.public, ...d.mine].filter((x, i, all) => x.id !== c.id && all.findIndex((y) => y.id === x.id) === i);
    if (!choices.length) { toast("There are no other clubs to challenge yet."); return; }
    let opp = choices[0].id, tc = "3d";
    const boards = h("input.input", { type: "number", min: "1", max: "50", value: "10", "aria-label": "Most boards" });
    const go = h("button.btn.primary.block", {
      onclick: async () => {
        go.disabled = true;
        try {
          const r = await S.api("POST", `/clubs/${c.id}/${kind}`, { opponent: opp, tc, boards: Number(boards.value) });
          m.close(); toast("Challenge sent");
          this.app.go(kind === "votechess" ? `#/vote/${r.id}` : `#/social/match/${r.id}`);
        }
        catch (e) { toast(e.message); go.disabled = false; }
      },
    }, "Send challenge");
    const m = openModal({
      title: kind === "votechess" ? "Vote Chess challenge" : "Challenge a club",
      body: [
        h("div.field", h("label", "Club"), h("select.input", { onchange: (e) => { opp = e.target.value; }, "aria-label": "Club to challenge" }, ...choices.map((x) => h("option", { value: x.id }, `${x.name} (${x.members} member${x.members === 1 ? "" : "s"})`)))),
        h("div.field", h("div.lbl", "Time per move"), segmented(["1d", "3d", "7d"].map((v) => ({ value: v, label: `${v.replace("d", "")} day${v === "1d" ? "" : "s"}` })), tc, (v) => { tc = v; })),
        kind === "votechess" ? null : h("div.field", h("label", "Most boards"), boards),
        h("p.note", kind === "votechess" ? "One daily game: your club plays White, and each move is the one most of your members vote for." : "If they accept, members of both clubs have a day to sign up. Players are paired top against top by rating, and each pair plays two daily games, one with each colour."),
        go],
    });
  }

  async _match(tok, mid) {
    let d;
    try { d = await S.api("GET", `/matches/${mid}`); } catch (e) { this.body.replaceChildren(errorLine(e, () => this.app.go("#/social/clubs"))); return; }
    if (!this._live(tok)) return;
    const m = d.match;
    const OUT = { w: "1–0", b: "0–1", draw: "½–½", "w-forfeit": "1–0 forfeit", "b-forfeit": "0–1 forfeit", "double-forfeit": "0–0" };
    const act = async (path, body = {}, msg) => { try { await S.api("POST", `/matches/${mid}/${path}`, body); if (msg) toast(msg); this.render(); } catch (e) { toast(e.message); } };
    const pidFor = () => { const p = getProfile(); return makePlayerId(p.name, p.ratings.rapid.r, S.myCode()); };
    const side = (s) => d.players.filter((p) => p.side === s);
    const status = { challenge: "Waiting for the other club to accept", signup: `Sign-ups close ${new Date(m.starts).toLocaleString()}`, running: "In play", done: "Finished", cancelled: "Cancelled: nobody to pair" }[m.status] || m.status;
    const mine = d.games.filter((g) => g.mine && !g.outcome);
    const actions = [];
    if ((m.status === "signup" || m.status === "challenge") && !d.me.joined) actions.push(h("button.btn.primary", { onclick: () => act("join", { pid: pidFor() }, "Signed up") }, "Sign up to play"));
    if ((m.status === "signup" || m.status === "challenge") && d.me.joined) actions.push(h("button.btn.ghost", { onclick: () => act("leave", {}, "You're off the team sheet") }, "Leave the team sheet"));
    if (m.status === "signup" && d.me.owner) actions.push(h("button.btn", { onclick: () => act("start", {}, "The match has started") }, "Start now"));
    this.body.replaceChildren(
      h("div.club-head", h("a.btn.small.ghost", { href: "#/social/clubs", "aria-label": "Clubs" }, icon("back", 16)),
        h("div.club-title", h("h2", `${m.a_name} vs ${m.b_name}`), h("p.note", `${status}. ${m.tc.replace("d", "")} day${m.tc === "1d" ? "" : "s"} per move, up to ${m.boards} boards.`))),
      m.status === "running" || m.status === "done" ? h("div.card.arena-head", h("div", h("div.note", m.a_name), h("div.big-num", String(m.aScore))), h("div", { style: { textAlign: "right" } }, h("div.note", m.b_name), h("div.big-num", String(m.bScore)))) : null,
      actions.length ? h("div.btn-row", ...actions) : null,
      mine.length ? h("section.card", h("h3", "Your games"), ...mine.map((g) => h("div.row",
        h("span.rt", h("b", `Board ${g.board}: ${g.mine.color === "w" ? "White" : "Black"} against ${g.mine.color === "w" ? g.black.name : g.white.name}`), h("small", "Daily game")),
        h("button.btn.small.primary", { onclick: () => this.app.launch(() => new OnlineGame(this.app, { kind: "daily", room: g.room, tcKey: m.tc, playerId: g.mine.pid, forceColor: g.mine.color }), "#/online") }, "Play")))) : null,
      d.games.length ? h("section.card", h("h3", "Boards"), ...d.games.map((g) => h("div.row.swiss-game",
        h("span.rt", h("b", `${g.board}. ${g.white.name} – ${g.black.name}`), h("small", g.outcome ? OUT[g.outcome] || g.outcome : "In play"))))) : null,
      m.status === "signup" || m.status === "challenge" ? h("div.club-grid",
        ...["a", "b"].map((sd) => h("section.card", h("h3", `${sd === "a" ? m.a_name : m.b_name} (${side(sd).length})`),
          ...(side(sd).length ? side(sd).map((p) => h("div.row", userAvatar(p, ".sm"), h("span.rt", h("b", p.name), h("small", `Rapid ${p.rating ?? "?"}`)))) : [h("p.note", "Nobody yet.")])))) : null);
  }

  // ---------- forums ----------
  async _forums(tok) {
    const cats = segmented([{ value: null, label: "All" }, ...Object.keys(FORUM_LABEL).map(c => ({ value: c, label: FORUM_LABEL[c] }))], forumCat, (v) => { forumCat = v; this._forums(++this.tok); });
    const box = h("div.rows", h("p.note", "Loading topics…"));
    this.body.replaceChildren(h("div.forum-bar", cats, h("button.btn.primary", { onclick: () => this._newTopic() }, icon("plus", 18), "New topic")), box);
    const path = "/forums" + (forumCat ? `?cat=${forumCat}` : "");
    const draw = (d) => {
      box.replaceChildren(...(d.topics.length ? d.topics.map(t => h("a.row.topic-row", { href: `#/social/topic/${t.id}` },
        userAvatar(t.author, ".sm"),
        h("span.rt", h("b", t.title), h("small", `${FORUM_LABEL[t.cat] || t.cat}, by ${t.author.name}, ${t.replies} repl${t.replies === 1 ? "y" : "ies"}, active ${timeAgo(t.lastAt)}`)),
        h("span.rv", icon("chevron", 18))))
        : [h("p.note", "No topics here yet. Start the conversation.")]));
    };
    if (S.cached(path)) draw(S.cached(path));
    try { const d = await S.api("GET", path); if (this._live(tok)) draw(d); }
    catch (e) { if (this._live(tok)) box.replaceChildren(errorLine(e, () => this._forums(++this.tok))); }
  }

  _newTopic() {
    let cat = forumCat || "general";
    const title = h("input.input", { maxlength: "100", placeholder: "Title", "aria-label": "Topic title" });
    const text = h("textarea.input.prose", { maxlength: "4000", rows: "6", placeholder: "What's on your mind?", "aria-label": "First post" });
    const go = h("button.btn.primary.block", {
      onclick: async () => {
        go.disabled = true;
        try { const r = await S.api("POST", "/forums", { cat, title: title.value, body: text.value }); m.close(); this.app.go(`#/social/topic/${r.id}`); }
        catch (e) { toast(e.message); go.disabled = false; }
      },
    }, "Post topic");
    const m = openModal({
      title: "New topic",
      body: [h("div.field", h("div.lbl", "Forum"), segmented(Object.keys(FORUM_LABEL).map(c => ({ value: c, label: FORUM_LABEL[c] })), cat, (v) => { cat = v; })),
        h("div.field", h("label", "Title"), title), h("div.field", h("label", "Post"), text),
        h("p.note", "Be kind. Posts that three players report are hidden."), go],
    });
    title.focus();
  }

  async _topic(tok, id) {
    let d;
    try { d = await S.api("GET", `/forums/${id}`); } catch (e) { this.body.replaceChildren(errorLine(e, () => this.app.go("#/social/forums"))); return; }
    if (!this._live(tok)) return;
    const t = d.topic;
    const actions = (kind, item, mine, del) => h("div.post-actions",
      mine ? h("button.btn.small.ghost", {
        onclick: async () => {
          if (!(await confirmModal({ title: kind === "topic" ? "Delete this topic?" : "Delete this reply?", sub: kind === "topic" ? "The topic and all its replies are removed." : "", yes: "Delete", danger: true }))) return;
          try { await S.api("POST", del, {}); toast("Deleted"); if (kind === "topic") this.app.go("#/social/forums"); else this.render(); } catch (e) { toast(e.message); }
        },
      }, icon("trash", 14), "Delete")
        : h("button.btn.small.ghost", {
          onclick: async (e) => {
            if (!(await confirmModal({ title: "Report this?", sub: "Report posts that are abusive, spam or off-topic. Anything three players report is hidden.", yes: "Report" }))) return;
            try { await S.api("POST", "/report", { kind, id: item }); toast("Thanks, reported"); e.target.closest("button").disabled = true; } catch (err) { toast(err.message); }
          },
        }, icon("flag", 14), "Report"));
    const post = (p, kind, del) => h("article.post",
      h("header", userAvatar(p.author, ".sm"), h("b", p.author.name), h("small.muted", timeAgo(p.created))),
      h("div.post-body", p.body),
      actions(kind, kind === "topic" ? t.id : p.id, p.mine, del));
    const reply = h("textarea.input.prose", { maxlength: "4000", rows: "3", placeholder: "Write a reply", "aria-label": "Reply" });
    const send = h("button.btn.primary", {
      onclick: async () => {
        if (!reply.value.trim()) return;
        send.disabled = true;
        try { await S.api("POST", `/forums/${t.id}`, { body: reply.value }); this.render(); } catch (e) { toast(e.message); send.disabled = false; }
      },
    }, "Post reply");
    this.body.replaceChildren(
      h("div.club-head", h("a.btn.small.ghost", { href: "#/social/forums", "aria-label": "All topics" }, icon("back", 16)),
        h("div.club-title", h("h2", t.title), h("p.note", `${FORUM_LABEL[t.cat] || t.cat}, ${t.replies} repl${t.replies === 1 ? "y" : "ies"}`))),
      h("div.thread-posts", post({ ...t, mine: t.mine }, "topic", `/forums/${t.id}/delete`),
        ...d.posts.map(p => post(p, "post", `/forums/${t.id}/posts/${p.id}/delete`))),
      h("section.card.reply-box", reply, h("div.btn-row.reply-actions", send)));
  }

  // ---------- blogs ----------
  async _blogs(tok) {
    const box = h("div.rows", h("p.note", "Loading posts…"));
    this.body.replaceChildren(h("div.forum-bar", h("p.note.grow", "Articles by players: game stories, opening ideas, study notes."),
      h("button.btn.primary", { onclick: () => this._writeBlog() }, icon("edit", 18), "Write a post")), box);
    const draw = (d) => {
      box.replaceChildren(...(d.posts.length ? d.posts.map((p) => h("a.row.blog-row", { href: `#/social/blog/${p.id}` },
        userAvatar(p.author, ".sm"),
        h("span.rt", h("b", p.title), h("small.blog-excerpt", p.excerpt.replace(/\s+/g, " ")), h("small", `${p.author.name}, ${timeAgo(p.created)}${p.likes ? `, ${p.likes} like${p.likes === 1 ? "" : "s"}` : ""}`)),
        h("span.rv", icon("chevron", 18))))
        : [h("p.note", "No posts yet. Be the first to write one.")]));
    };
    if (S.cached("/blogs")) draw(S.cached("/blogs"));
    try { const d = await S.api("GET", "/blogs"); if (this._live(tok)) draw(d); }
    catch (e) { if (this._live(tok)) box.replaceChildren(errorLine(e, () => this._blogs(++this.tok))); }
  }

  _writeBlog() {
    const title = h("input.input", { maxlength: "120", placeholder: "Title", "aria-label": "Post title" });
    const text = h("textarea.input.prose", { maxlength: "20000", rows: "12", placeholder: "Write your post. Leave a blank line between paragraphs.", "aria-label": "Post" });
    const go = h("button.btn.primary.block", {
      onclick: async () => {
        go.disabled = true;
        try { const r = await S.api("POST", "/blogs", { title: title.value, body: text.value }); m.close(); toast("Published"); this.app.go(`#/social/blog/${r.id}`); }
        catch (e) { toast(e.message); go.disabled = false; }
      },
    }, "Publish");
    const m = openModal({
      title: "New blog post", wide: true,
      body: [h("div.field", h("label", "Title"), title), h("div.field", h("label", "Post"), text),
        h("p.note", "Everyone can read your posts. Posts that three players report are hidden."), go],
    });
    title.focus();
  }

  async _blogPost(tok, id) {
    let d;
    try { d = await S.api("GET", `/blogs/${id}`); } catch (e) { this.body.replaceChildren(errorLine(e, () => this.app.go("#/social/blogs"))); return; }
    if (!this._live(tok)) return;
    const p = d.post;
    let liked = p.liked, likes = p.likes;
    const likeBtn = h(`button.btn.small${liked ? ".primary" : ""}`, {
      "aria-pressed": String(liked),
      onclick: async () => {
        try {
          const r = await S.api("POST", `/blogs/${p.id}/like`, {});
          liked = r.liked; likes += liked ? 1 : -1;
          likeBtn.classList.toggle("primary", liked);
          likeBtn.setAttribute("aria-pressed", String(liked));
          likeBtn.lastChild.textContent = `${likes} like${likes === 1 ? "" : "s"}`;
        } catch (e) { toast(e.message); }
      },
    }, icon("star", 14), h("span", `${likes} like${likes === 1 ? "" : "s"}`));
    const other = p.mine
      ? h("button.btn.small.ghost", {
        onclick: async () => {
          if (!(await confirmModal({ title: "Delete this post?", yes: "Delete", danger: true }))) return;
          try { await S.api("POST", `/blogs/${p.id}/delete`, {}); toast("Deleted"); this.app.go("#/social/blogs"); } catch (e) { toast(e.message); }
        },
      }, icon("trash", 14), "Delete")
      : h("button.btn.small.ghost", {
        onclick: async (e) => {
          if (!(await confirmModal({ title: "Report this post?", sub: "Report posts that are abusive or spam. Anything three players report is hidden.", yes: "Report" }))) return;
          try { await S.api("POST", "/report", { kind: "blog", id: p.id }); toast("Thanks, reported"); e.target.closest("button").disabled = true; } catch (err) { toast(err.message); }
        },
      }, icon("flag", 14), "Report");
    this.body.replaceChildren(
      h("div.club-head", h("a.btn.small.ghost", { href: "#/social/blogs", "aria-label": "All posts" }, icon("back", 16))),
      h("article.blog-post",
        h("h2", p.title),
        h("div.blog-byline", userAvatar(p.author, ".sm"), h("b", p.author.name), h("small.muted", timeAgo(p.created))),
        h("div.blog-body", ...p.body.split(/\n\s*\n/).map((para) => h("p", para))),
        h("div.btn-row.blog-actions", likeBtn, other)));
  }

  // ---------- coaches ----------
  async _coaches(tok) {
    const box = h("div.coach-list", h("p.note", "Loading coaches…"));
    const mineBox = h("div");
    this.body.replaceChildren(
      h("p.note.coach-intro", "Players who give lessons. To book one, add them as a friend and message them; lessons and payment are arranged between you and the coach."),
      mineBox, box);
    let d, friends;
    try { [d, friends] = await Promise.all([S.api("GET", "/coaches"), S.api("GET", "/friends")]); }
    catch (e) { if (this._live(tok)) box.replaceChildren(errorLine(e, () => this._coaches(++this.tok))); return; }
    if (!this._live(tok)) return;
    const friendIds = new Set(friends.friends.map((f) => f.id));
    const mine = d.coaches.find((c) => c.mine);
    mineBox.replaceChildren(h("div.btn-row", h("button.btn", { onclick: () => this._coachForm(mine) }, icon("learn", 18), mine ? "Edit your coach listing" : "Offer lessons"),
      mine ? h("button.btn.ghost", {
        onclick: async () => {
          if (!(await confirmModal({ title: "Take your listing down?", yes: "Remove", danger: true }))) return;
          try { await S.api("POST", "/coaches/remove", {}); toast("Listing removed"); this.render(); } catch (e) { toast(e.message); }
        },
      }, "Remove listing") : null));
    const R = (u, c) => (u.ratings && u.ratings[c] && u.ratings[c].n ? `${CAT_LABEL[c]} ${u.ratings[c].r}` : null);
    box.replaceChildren(...(d.coaches.length ? d.coaches.map((c) => {
      const u = c.user;
      const facts = [c.langs && `Speaks ${c.langs}`, c.topics && `Teaches ${c.topics}`, c.rate].filter(Boolean);
      return h("article.coach-card",
        h("header", userAvatar(u), h("div.coach-name", h("b", `${c.title ? c.title + " " : ""}${u.name}`), h("small", [presenceText(u), R(u, "blitz"), R(u, "rapid")].filter(Boolean).join(", ")))),
        facts.length ? h("div.coach-facts", ...facts.map((f) => h("span", f))) : null,
        h("p.coach-bio", c.bio),
        c.mine ? null : h("div.btn-row",
          friendIds.has(u.id)
            ? h("button.btn.primary", { onclick: () => this.app.go(`#/social/chat/${u.id}`) }, icon("chat", 18), "Message")
            : h("button.btn.primary", { onclick: async (e) => { if (await this._addByCode(u.code)) e.target.closest("button").replaceChildren(icon("check", 18), "Request sent"); } }, icon("plus", 18), "Add friend to message"),
          h("button.btn", { onclick: () => this._profile(u, friendIds.has(u.id)) }, "Profile"),
          h("button.btn.ghost", {
            "aria-label": `Report ${u.name}'s listing`,
            onclick: async (e) => {
              if (!(await confirmModal({ title: "Report this listing?", sub: "Report listings that are fake, abusive or spam. Anything three players report is hidden.", yes: "Report" }))) return;
              try { await S.api("POST", "/report", { kind: "coach", id: u.id }); toast("Thanks, reported"); e.target.closest("button").disabled = true; } catch (err) { toast(err.message); }
            },
          }, icon("flag", 16))));
    }) : [h("p.note", "No coaches listed yet. If you teach, offer lessons here.")]));
  }

  _coachForm(cur) {
    const input = (key, label, max, ph) => { const el = h("input.input", { maxlength: String(max), placeholder: ph, value: cur ? cur[key] : "", "aria-label": label }); return [el, h("div.field", h("label", label), el)]; };
    const [title, titleF] = input("title", "Title (optional)", 40, "e.g. FM, coach, club captain");
    const [langs, langsF] = input("langs", "Languages", 80, "e.g. English, Spanish");
    const [topics, topicsF] = input("topics", "What you teach", 120, "e.g. openings, endgames, beginners");
    const [rate, rateF] = input("rate", "Rate", 60, "e.g. $30 an hour, or free");
    const bio = h("textarea.input.prose", { maxlength: "1500", rows: "6", placeholder: "How you teach, who you work with, your experience.", "aria-label": "About your lessons" }, cur ? cur.bio : "");
    const go = h("button.btn.primary.block", {
      onclick: async () => {
        go.disabled = true;
        try { await S.api("POST", "/coaches", { title: title.value, bio: bio.value, langs: langs.value, topics: topics.value, rate: rate.value }); m.close(); toast(cur ? "Listing updated" : "You're listed as a coach"); this.render(); }
        catch (e) { toast(e.message); go.disabled = false; }
      },
    }, cur ? "Save listing" : "List me as a coach");
    const m = openModal({
      title: cur ? "Your coach listing" : "Offer lessons",
      body: [titleF, h("div.field", h("label", "About your lessons"), bio), langsF, topicsF, rateF,
        h("p.note", "Your name, avatar and ratings show with your listing. Students add you as a friend to get in touch."), go],
    });
  }

  // ---------- leaderboard ----------
  async _leaderboard(tok) {
    const seg = segmented(LB_CATS.map(c => ({ value: c, label: CAT_LABEL[c] })), lbCat, (v) => { lbCat = v; this._leaderboard(++this.tok); });
    const scope = segmented([{ value: "all", label: "Everyone" }, { value: "friends", label: "Friends" }], lbScope, (v) => { lbScope = v; this._leaderboard(++this.tok); });
    const box = h("div.lb-box", h("p.note", "Loading the leaderboard…"));
    this.body.replaceChildren(h("div.lb-controls", scope, seg), box);
    if (lbCat === "variants") {
      box.before(h("div.seg.round-picker.lb-variants", ...LB_VARIANTS.map((v) => h(`button${v === lbVariant ? ".on" : ""}`, { onclick: () => { lbVariant = v; this._leaderboard(++this.tok); } }, VARIANT_NAMES[v] || v))));
    }
    const path = `/leaderboard?cat=${lbCat === "variants" ? lbVariant : lbCat}`;
    if (S.cached(path)) this._drawBoard(box, S.cached(path), S.cached("/friends"));
    let d, friends;
    try { [d, friends] = await Promise.all([S.api("GET", path), S.api("GET", "/friends")]); }
    catch (e) { if (this._live(tok)) box.replaceChildren(errorLine(e, () => this._leaderboard(++this.tok))); return; }
    if (this._live(tok)) this._drawBoard(box, d, friends);
  }

  _drawBoard(box, d, friends) {
    friends = friends || { friends: [], outgoing: [] };
    const friendIds = new Set(friends.friends.map(u => u.id));
    const pendingIds = new Set(friends.outgoing.map(u => u.id));
    const unit = lbCat === "puzzle" ? "puzzles" : "games";
    const rush = lbCat === "rush", variant = lbCat === "variants" ? lbVariant : null;
    const score = (u) => (rush ? u.rush || 0 : variant ? ((u.variants || {})[variant] || { r: 0 }).r : u.ratings[lbCat].r);
    let list = d.top, meLine;
    if (lbScope === "friends") {
      // you and your friends, whatever the number of games
      const me = S.socialState().me;
      list = [...friends.friends, ...(me ? [me] : [])].sort((a, b) => score(b) - score(a));
      const rank = list.findIndex(u => u.id === S.myId()) + 1;
      meLine = friends.friends.length
        ? h("div.status-line.good", icon("trophy", 18), h("span", `You're #${rank} of ${list.length} among your friends.`))
        : h("div.status-line", icon("users", 18), h("span", "Add friends to compare your ratings with theirs."));
    } else if (variant) {
      meLine = d.me.rank
        ? h("div.status-line.good", icon("trophy", 18), h("span", `You're #${d.me.rank} of ${d.total} in ${VARIANT_NAMES[variant]}, with ${d.me.rating}.`))
        : h("div.status-line", icon("trophy", 18), h("span", `Play a rated ${VARIANT_NAMES[variant]} game against a random opponent to get on this board.`));
    } else if (rush) {
      meLine = d.me.rank
        ? h("div.status-line.good", icon("trophy", 18), h("span", `You're #${d.me.rank} of ${d.total} with ${d.me.rating} puzzles.`))
        : h("div.status-line", icon("bolt", 18), h("span", "Play a 5-minute Puzzle Rush to get on this board."));
    } else {
      meLine = d.me.rank
        ? h("div.status-line.good", icon("trophy", 18), h("span", `You're #${d.me.rank} of ${d.total} with ${d.me.rating}.`))
        : h("div.status-line", icon("trophy", 18), h("span", `Play ${d.minGames} rated ${CAT_LABEL[lbCat].toLowerCase()} ${unit} to get ranked (you have ${d.me.games}).`));
    }
    const rows = list.map((u, i) => {
      const me = u.id === S.myId();
      const action = me ? h("span.muted", "You") : friendIds.has(u.id) ? h("span.muted", "Friend")
        : pendingIds.has(u.id) ? h("span.muted", "Requested")
          : h("button.btn.small", { onclick: async (e) => { e.currentTarget.disabled = true; await this._addByCode(u.code); }, "aria-label": `Add ${u.name} as a friend` }, icon("plus", 16), h("span.wide-only", "Add"));
      return h(`tr${me ? ".me" : ""}`,
        h("td.rank", String(i + 1)),
        h("td", h("button.lb-player", { onclick: () => this._profile(u, friendIds.has(u.id)) }, userAvatar(u, ".sm"), h("b", u.name))),
        h("td.num", String(score(u))),
        h("td.num.wide-only", rush ? "" : variant ? String(((u.variants || {})[variant] || { n: 0 }).n) : String(u.ratings[lbCat].n)),
        h("td", action));
    });
    box.replaceChildren(meLine,
      list.length ? h("div.table-wrap", h("table.table.lb-table",
        h("thead", h("tr", h("th", "#"), h("th", "Player"), h("th", rush ? "Best (5 min)" : "Rating"), h("th.wide-only", rush ? "" : unit[0].toUpperCase() + unit.slice(1)), h("th", ""))),
        h("tbody", ...rows)))
        : h("p.note", "Nobody is ranked here yet. Be the first."),
      h("p.note", rush ? "Best 5-minute Puzzle Rush scores, as reported by each player's device, from players active in the last 30 days."
        : lbScope === "friends" ? "Ratings come from each player's own device and aren't verified by the server."
        : `Ratings come from each player's own device and aren't verified by the server. Players need ${d.minGames}+ rated ${unit} and a visit in the last 30 days to be listed.`));
  }
}

// shown at once while a message is on its way; replaced by the server's copy
function pendingBubble(list, text) {
  list.querySelector(".thread-empty")?.remove();
  const el = h("div.msg.mine.pending", h("span", text), h("time", "Sending…"));
  list.append(el);
  list.scrollTop = list.scrollHeight;
  return el;
}

function errorLine(e, retry) {
  return h("div.status-line.bad", icon("close", 16), h("span", e.message || "Something went wrong."), retry ? h("button.btn.small", { onclick: retry, style: { marginLeft: "auto" } }, "Try again") : null);
}
