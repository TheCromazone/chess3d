// First visit: pick a name and say how well you play, which seeds your ratings and suggests a bot
// (chess.com asks the same question when you sign up).
import { h } from "../ui/dom.js";
import { openModal } from "../ui/components.js";
import { getProfile, updateProfile } from "../store.js";
import { BOTS } from "../bots.js";

const LEVELS = [
  { id: "new", label: "New to chess", sub: "I'm learning how the pieces move", rating: 400, go: "#/learn" },
  { id: "beginner", label: "Beginner", sub: "I know the rules and play casually", rating: 800, go: "#/bots" },
  { id: "intermediate", label: "Intermediate", sub: "I know basic tactics and openings", rating: 1200, go: "#/bots" },
  { id: "advanced", label: "Advanced", sub: "I play in clubs or tournaments", rating: 1700, go: "#/bots" },
];

export function maybeWelcome(app) {
  const p = getProfile();
  if (p.onboarded || p.stats.games > 0) return;
  let level = LEVELS[1];
  const name = h("input.input", { value: p.name, maxlength: "16", "aria-label": "Display name" });
  const list = h("div.rows", ...LEVELS.map(l => {
    const b = h(`button.row${l === level ? ".on" : ""}`, { onclick: () => { level = l; list.querySelectorAll(".row").forEach(x => x.style.borderColor = ""); b.style.borderColor = "var(--accent)"; } },
      h("span.rt", h("b", l.label), h("small", l.sub)));
    if (l === level) b.style.borderColor = "var(--accent)";
    return b;
  }));
  const m = openModal({
    title: "Welcome to Chess 3D",
    sub: "Two quick questions so we can match you with the right bots and puzzles.",
    onClose: () => updateProfile(pr => { pr.onboarded = true; }),
    body: [
      h("div.field", h("label", "Your name"), name),
      h("div.field", h("div.lbl", "How well do you play?"), list),
      h("button.btn.primary.big.block", {
        onclick: () => {
          const n = name.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
          updateProfile(pr => {
            if (n) pr.name = n;
            pr.onboarded = true;
            pr.level = level.id;
            for (const k of ["bots", "bullet", "blitz", "rapid"]) if (!pr.ratings[k].n) pr.ratings[k].r = level.rating;
            if (!pr.ratings.puzzle.n) pr.ratings.puzzle.r = Math.max(600, level.rating + 200);
          });
          m.close();
          app.go(level.go);
        },
      }, "Let's play"),
    ],
  });
}

// the bot closest to a rating, for "suggested opponent" copy
export function suggestedBot(rating) {
  return [...BOTS].filter(b => b.category !== "Engine").sort((a, b) => Math.abs(a.elo - rating) - Math.abs(b.elo - rating))[0];
}
