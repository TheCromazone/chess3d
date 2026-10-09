// Social: friends with online status, direct messages and challenges, clubs with their own chat,
// and the global leaderboard. Data lives on the game server (net/social.js); no sign-in needed.
import { h, icon, timeAgo, copyText } from "../ui/dom.js";
import { openModal, toast, confirmModal, segmented, tcPicker, tcLabel, switchRow } from "../ui/components.js";
import { userAvatar, presenceText, notice } from "../ui/people.js";
import { getProfile } from "../store.js";
import { OnlineGame } from "../modes/online-game.js";
import { DAILY_PACES } from "../modes/daily.js";
import { gamePgn } from "./pages.js";
import { signInModal } from "./account.js";
import { SFX } from "../audio.js";
import * as S from "../net/social.js";

const TABS = [
  { id: "friends", label: "Friends" },
  { id: "messages", label: "Messages" },
  { id: "clubs", label: "Clubs" },
  { id: "leaderboard", label: "Leaderboard" },
];
const CAT_LABEL = { blitz: "Blitz", bullet: "Bullet", rapid: "Rapid", puzzle: "Puzzles", bots: "Vs bots" };
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
  S.onSocial((st) => app.setNavBadge("social", st.unread + st.requests));
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
      clubs: () => (this.view.club ? this._club(tok, this.view.club) : this._clubs(tok)), leaderboard: () => this._leaderboard(tok) };
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
    this.body.replaceChildren(codeCard, this._searchBox(), lists);

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
      body: [h("div.profile-pop", userAvatar(u, ".lg"), grid), actions, remove, kick, h("div.lbl.note", "Recent games"), games],
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
          }, "Leave club"))));
    addMsgs(d.messages);
    list.scrollTop = list.scrollHeight;
    this.poll = setInterval(pull, 5000);
  }

  // ---------- leaderboard ----------
  async _leaderboard(tok) {
    const seg = segmented(S.CATS.map(c => ({ value: c, label: CAT_LABEL[c] })), lbCat, (v) => { lbCat = v; this._leaderboard(++this.tok); });
    const scope = segmented([{ value: "all", label: "Everyone" }, { value: "friends", label: "Friends" }], lbScope, (v) => { lbScope = v; this._leaderboard(++this.tok); });
    const box = h("div.lb-box", h("p.note", "Loading the leaderboard…"));
    this.body.replaceChildren(h("div.lb-controls", scope, seg), box);
    const path = `/leaderboard?cat=${lbCat}`;
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
    let list = d.top, meLine;
    if (lbScope === "friends") {
      // you and your friends, whatever the number of games
      const me = S.socialState().me;
      list = [...friends.friends, ...(me ? [me] : [])].sort((a, b) => b.ratings[lbCat].r - a.ratings[lbCat].r);
      const rank = list.findIndex(u => u.id === S.myId()) + 1;
      meLine = friends.friends.length
        ? h("div.status-line.good", icon("trophy", 18), h("span", `You're #${rank} of ${list.length} among your friends.`))
        : h("div.status-line", icon("users", 18), h("span", "Add friends to compare your ratings with theirs."));
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
        h("td.num", String(u.ratings[lbCat].r)),
        h("td.num.wide-only", String(u.ratings[lbCat].n)),
        h("td", action));
    });
    box.replaceChildren(meLine,
      list.length ? h("div.table-wrap", h("table.table.lb-table",
        h("thead", h("tr", h("th", "#"), h("th", "Player"), h("th", "Rating"), h("th.wide-only", unit[0].toUpperCase() + unit.slice(1)), h("th", ""))),
        h("tbody", ...rows)))
        : h("p.note", "Nobody is ranked here yet. Be the first."),
      h("p.note", lbScope === "friends" ? "Ratings come from each player's own device and aren't verified by the server."
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
