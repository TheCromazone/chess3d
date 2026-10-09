// Account without a password: this device's key is the account. Sign in on another device with a
// one-time code (or the recovery key), keep a cloud backup of profile, ratings, settings and games,
// and sign out here or everywhere else. Used by the Social join card and the Settings page.
import { h, icon, timeAgo, copyText } from "../ui/dom.js";
import { openModal, toast, confirmModal, switchRow } from "../ui/components.js";
import * as S from "../net/social.js";

function reloadSoon(msg) {
  toast(msg);
  setTimeout(() => location.reload(), 900);
}

// on a device without a profile: "I already have one"
export function signInModal() {
  let mode = "code";
  const input = h("input.input", { maxlength: "11", placeholder: "Code from your other device", "aria-label": "Sign-in code", autocapitalize: "characters", autocomplete: "off", spellcheck: "false" });
  const key = h("textarea.input.prose", { rows: "3", placeholder: "Paste your recovery key", "aria-label": "Recovery key", spellcheck: "false", hidden: true });
  const switcher = h("button.btn.small.ghost", {
    onclick: () => {
      mode = mode === "code" ? "key" : "code";
      input.hidden = mode !== "code"; key.hidden = mode !== "key";
      switcher.textContent = mode === "code" ? "Use a recovery key instead" : "Use a code instead";
      hint.textContent = mode === "code" ? codeHint : keyHint;
    },
  }, "Use a recovery key instead");
  const codeHint = "On a device where you're signed in, open Settings, choose \"Sign in on another device\" and enter the code here.";
  const keyHint = "Your recovery key is in Settings on a device where you're signed in.";
  const hint = h("p.note", codeHint);
  const go = h("button.btn.primary.block", {
    onclick: async () => {
      go.disabled = true;
      try {
        const restored = mode === "code" ? await S.claimLink(input.value) : await S.useRecoveryKey(key.value);
        m.close();
        reloadSoon(restored ? "Signed in. Your games and ratings are restored." : "Signed in.");
      } catch (e) { toast(e.message); go.disabled = false; }
    },
  }, "Sign in");
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
  const m = openModal({
    title: "Sign in to your profile",
    sub: "Your games, ratings and settings on this device will be replaced by the ones in your profile.",
    body: [hint, input, key, go, switcher],
  });
  input.focus();
}

export function linkDeviceModal() {
  const codeEl = h("div.friend-code", "…");
  const left = h("p.note", "");
  let timer = null;
  const m = openModal({
    title: "Sign in on another device",
    sub: "On the other device, open Social, choose \"I already have a profile\" and enter this code. It works once, for 10 minutes.",
    body: [h("div.link-code", codeEl), left, h("button.btn.block", { onclick: async () => { if (await copyText(codeEl.textContent.replace(/\s/g, ""))) toast("Code copied"); } }, icon("copy", 18), "Copy code")],
    onClose: () => clearInterval(timer),
  });
  S.backupNow().catch(() => {});        // so the other device gets everything up to now
  S.makeLinkCode().then((r) => {
    codeEl.textContent = S.fmtCode(r.code);
    const tick = () => {
      const ms = r.expires - Date.now();
      if (ms <= 0) { left.textContent = "This code has expired. Close and make a new one."; codeEl.style.opacity = ".4"; clearInterval(timer); return; }
      left.textContent = `Expires in ${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
    };
    tick();
    timer = setInterval(tick, 1000);
  }).catch((e) => { m.close(); toast(e.message); });
}

export function recoveryKeyModal() {
  const k = S.recoveryKey();
  openModal({
    title: "Recovery key",
    sub: "With this key you can get back into your profile on any device, even if you lose this one. Keep it somewhere private: anyone with it can use your profile.",
    body: [h("code.recovery-key", k),
      h("button.btn.block", { onclick: async () => { if (await copyText(k.replace(/\s/g, ""))) toast("Recovery key copied"); } }, icon("copy", 18), "Copy key")],
  });
}

// a switch for notifications when the app is closed; it reflects the browser's real subscription
function pushSwitch() {
  const row = switchRow("Notifications when Chess 3D is closed", "Challenges, messages, friend requests and your move in daily games", false, async (on) => {
    try {
      if (on) { await S.enablePush(); toast("Notifications are on"); } else { await S.disablePush(); toast("Notifications are off"); }
    } catch (e) {
      toast(e.message);
      row.setAttribute("aria-checked", "false");
    }
  });
  S.pushEnabled().then((on) => row.setAttribute("aria-checked", String(on)));
  return row;
}

// the Settings section
export function accountSection(page) {
  if (!S.registered()) {
    return h("section.settings-sec", h("h2", "Account"),
      h("p.note", "You don't need an account to play. Turn on Social to get a profile: friends, messages, clubs, arenas and the leaderboard, plus a cloud backup that lets you sign in on your other devices. There's no email or password."),
      h("div.btn-row",
        h("button.btn.primary", { onclick: () => page.app.go("#/social") }, icon("users", 18), "Turn on Social"),
        h("button.btn", { onclick: () => signInModal() }, icon("key", 18), "I already have a profile")));
  }
  const devices = h("span", "");
  const backed = h("span", "");
  const showBackup = () => { const t = S.lastBackup(); backed.textContent = t ? `Last backed up ${timeAgo(t)}.` : "Not backed up yet."; };
  showBackup();
  S.api("GET", "/devices").then((d) => { devices.textContent = d.devices === 1 ? " Signed in on this device only." : ` Signed in on ${d.devices} devices.`; }).catch(() => {});
  return h("section.settings-sec", h("h2", "Account"),
    h("p.note", `Your friend code is ${S.fmtCode(S.myCode())}.`, devices, " Your name, avatar, ratings, recent games and online status are visible to other players."),
    h("div.btn-row",
      h("button.btn", { onclick: () => linkDeviceModal() }, icon("link", 18), "Sign in on another device"),
      h("button.btn", { onclick: () => recoveryKeyModal() }, icon("key", 18), "Recovery key")),
    S.pushSupported() ? pushSwitch() : null,
    h("p.note", "Your profile, ratings, settings and games are backed up to your profile automatically. ", backed),
    h("div.btn-row",
      h("button.btn", {
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await S.backupNow(true); toast("Backed up"); showBackup(); } catch (err) { toast(err.message); }
          e.currentTarget.disabled = false;
        },
      }, icon("upload", 18), "Back up now"),
      h("button.btn", {
        onclick: async () => {
          if (!(await confirmModal({ title: "Sign out of other devices?", sub: "Every other device signed in to your profile is signed out, and you get a new recovery key.", yes: "Sign out others" }))) return;
          try { await S.signOutOthers(); toast("Other devices signed out"); page.render(); } catch (err) { toast(err.message); }
        },
      }, "Sign out of other devices")),
    h("div.btn-row",
      h("button.btn.ghost", {
        onclick: async () => {
          if (!(await confirmModal({ title: "Sign out of this device?", sub: "Your profile stays. To sign back in you'll need a code from another device or your recovery key, so copy the key first if this is your only device.", yes: "Sign out", danger: true }))) return;
          try { await S.backupNow(); } catch { /* keep going */ }
          S.signOutHere();
          toast("Signed out");
          page.render();
        },
      }, "Sign out of this device"),
      h("button.btn.danger", {
        onclick: async () => {
          if (!(await confirmModal({ title: "Delete your profile?", sub: "Your friends, messages, club memberships, shared games and cloud backup are deleted from the server, and you leave the leaderboard. Games and ratings on this device stay.", yes: "Delete", danger: true }))) return;
          try { await S.leave(); toast("Profile deleted"); page.render(); } catch (err) { toast(err.message); }
        },
      }, icon("trash", 18), "Delete profile")));
}
