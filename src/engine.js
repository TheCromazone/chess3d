// Stockfish wrapper: a small async UCI client used for bots, hints, the eval bar,
// engine lines and Game Review. Stockfish 18 lite (single-threaded WASM, GPLv3) runs
// in a Web Worker in the browser; anything that speaks UCI line-by-line works as a
// transport (Node tests use a child process).
//
// Concurrency model (one Engine = one Stockfish process):
//   * Commands are serialized. A new analyze()/setOption()/newGame()/stop() call
//     interrupts the running search (its promise resolves with what it had, flagged
//     {aborted:true}) and cancels analyze() calls that were queued but not started.
//     "Latest request wins", which is what eval bars and hint buttons want.
//   * We never send a new `go` before the previous search's `bestmove` arrives, and
//     every bestmove is matched to its `go` by sequence number, so a stale bestmove
//     produced by `stop` can never resolve the wrong search.
//   * Separate Engine instances own separate workers and are fully independent.
import { createChess, is960Fen } from "./core/chess960.js";

export const STOCKFISH_WORKER_URL = "./stockfish/stockfish-18-lite-single.js";
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const INFO_THROTTLE_MS = 100;   // onInfo at most ~10/s
const STOP_GRACE_MS = 5000;     // bestmove must arrive this soon after `stop`
const MOVETIME_GRACE_MS = 10000; // a movetime search that overruns by this much gets stopped

// Browsers throttle timers in hidden tabs, including inside the Stockfish worker (the
// single-threaded build yields via setTimeout), so a backgrounded engine can be very slow
// without being broken. Watchdogs therefore only fire while the page is visible AND the
// engine has been silent for the whole period; otherwise they re-arm.
const pageHidden = () => typeof document !== "undefined" && document.hidden === true;

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** Where the Stockfish loader will fetch its .wasm from (mirrors the loader's own rule). */
function wasmUrlFor(workerUrl) {
  try {
    const u = new URL(workerUrl, typeof location !== "undefined" ? location.href : undefined);
    if (u.hash.length > 1) return new URL(decodeURIComponent(u.hash.slice(1).split(",")[0]), u).href;
    return u.origin + u.pathname.replace(/\.js$/i, ".wasm");
  } catch { return null; }
}

/**
 * Default browser transport: Stockfish as a Web Worker.
 * A missing .wasm doesn't surface as a Worker error (the loader aborts inside a promise),
 * so if the worker is still silent after `probeMs` we HEAD the .wasm and fail fast on a
 * definite HTTP error. Network errors (offline etc.) just keep waiting for init's timeout.
 */
export function createWorkerTransport(url = STOCKFISH_WORKER_URL, { probeMs = 2500 } = {}) {
  if (typeof Worker === "undefined") throw new Error("Web Workers are not available");
  const worker = new Worker(url);
  let lineCb = () => {};
  let errCb = () => {};
  let heard = false, dead = false;
  worker.onmessage = (e) => {
    heard = true;
    const d = e.data;
    if (typeof d !== "string") return; // download-progress objects etc.
    if (d.indexOf("\n") === -1) lineCb(d);
    else for (const l of d.split("\n")) if (l) lineCb(l);
  };
  worker.onerror = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    errCb(new Error((e && e.message) || "worker failed to load"));
  };
  worker.onmessageerror = () => errCb(new Error("worker message error"));
  const wasm = wasmUrlFor(url);
  const probe = wasm && typeof fetch === "function" && probeMs > 0 ? setTimeout(() => {
    if (heard || dead) return;
    fetch(wasm, { method: "HEAD", cache: "no-store" }).then((r) => {
      if (!heard && !dead && r.status >= 400) errCb(new Error("engine file missing (HTTP " + r.status + " for " + wasm.split("/").pop() + ")"));
    }, () => {});
  }, probeMs) : null;
  return {
    post: (line) => worker.postMessage(line),
    onLine: (cb) => { lineCb = cb; },
    onError: (cb) => { errCb = cb; },
    terminate: () => { dead = true; clearTimeout(probe); worker.terminate(); },
  };
}

function unavailable(msg, cause) {
  const e = new Error("Engine unavailable: " + msg);
  e.code = "ENGINE_UNAVAILABLE";
  if (cause) e.cause = cause;
  return e;
}

// ---------------------------------------------------------------------------
// UCI parsing
// ---------------------------------------------------------------------------

function parseInfo(line) {
  const t = line.split(/\s+/);
  const o = {};
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "string": return null;
      case "depth": o.depth = +t[++i]; break;
      case "seldepth": o.seldepth = +t[++i]; break;
      case "multipv": o.multipv = +t[++i]; break;
      case "nodes": o.nodes = +t[++i]; break;
      case "nps": o.nps = +t[++i]; break;
      case "time": o.time = +t[++i]; break;
      case "hashfull": o.hashfull = +t[++i]; break;
      case "currmove": case "currmovenumber": case "tbhits": case "cpuload": case "sbhits": i++; break;
      case "wdl": o.wdl = [+t[i + 1], +t[i + 2], +t[i + 3]]; i += 3; break;
      case "score": {
        const kind = t[++i], v = +t[++i];
        if (kind === "cp") o.cp = v; else if (kind === "mate") o.mate = v;
        if (t[i + 1] === "lowerbound" || t[i + 1] === "upperbound") o.bound = t[++i];
        break;
      }
      case "pv": o.pv = t.slice(i + 1).filter(Boolean); i = t.length; break;
      default: break;
    }
  }
  return o;
}

function parseOption(line, into) {
  // option name UCI_Elo type spin default 1320 min 1320 max 3190
  const m = /^option name (.+?) type (\w+)(.*)$/.exec(line);
  if (!m) return;
  const rest = m[3];
  const info = { type: m[2] };
  const d = / default (\S*)/.exec(rest); if (d) info.default = d[1];
  const mn = / min (-?\d+)/.exec(rest); if (mn) info.min = +mn[1];
  const mx = / max (-?\d+)/.exec(rest); if (mx) info.max = +mx[1];
  into[m[1]] = info;
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Convert a UCI move list to SAN from `fen`, stopping at the first illegal move. */
export function uciLineToSan(fen, ucis, max = Infinity) {
  const out = [];
  let c;
  try { c = createChess(fen); } catch { return out; }
  for (const u of ucis) {
    if (out.length >= max || !UCI_RE.test(u)) break;
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(m.san);
    } catch { break; }
  }
  return out;
}

/** Apply one move given as SAN or UCI to a chess.js instance; returns the verbose move or null. */
export function applyMove(chess, mv) {
  if (!mv) return null;
  const s = String(mv).trim();
  try {
    if (UCI_RE.test(s)) return chess.move({ from: s.slice(0, 2), to: s.slice(2, 4), promotion: s[4] });
    return chess.move(s);
  } catch { return null; }
}

export function moveToUci(m) { return m.from + m.to + (m.promotion || ""); }

function sameFenPosition(a, b) {
  return a.split(" ").slice(0, 4).join(" ") === b.split(" ").slice(0, 4).join(" ");
}

/** Validate a FEN for engine use (Stockfish can crash on illegal positions). */
function preparePosition(fen, history) {
  if (typeof fen !== "string" || !fen.trim()) throw new Error("Invalid FEN: empty");
  fen = fen.trim().replace(/\s+/g, " ");
  let chess;
  try { chess = createChess(fen); } catch (e) { throw new Error("Invalid FEN: " + e.message); }
  const f = fen.split(" ");
  if (f.length < 4) throw new Error("Invalid FEN: missing fields");
  const place = f[0];
  if ((place.match(/K/g) || []).length !== 1 || (place.match(/k/g) || []).length !== 1) {
    throw new Error("Invalid FEN: each side needs exactly one king");
  }
  const ranks = place.split("/");
  if (/[pP]/.test(ranks[0]) || /[pP]/.test(ranks[7])) throw new Error("Invalid FEN: pawn on first/last rank");
  // The side that just moved must not be in check.
  try {
    const flipped = [f[0], f[1] === "w" ? "b" : "w", f[2], "-", "0", "1"].join(" ");
    if (createChess(flipped).inCheck()) throw new Error("x");
  } catch { throw new Error("Invalid FEN: side not to move is in check"); }
  const turn = chess.turn();
  const legal = chess.moves();
  let cmd = "position fen " + fen;
  let chess960 = is960Fen(fen);
  if (history && Array.isArray(history.moves) && history.moves.length) {
    const start = history.startFen || START_FEN;
    try {
      const h = createChess(start);
      const ucis = [];
      let ok = true;
      for (const mv of history.moves) {
        const m = applyMove(h, mv);
        if (!m) { ok = false; break; }
        ucis.push(moveToUci(m));
      }
      if (ok && sameFenPosition(h.fen(), fen)) {
        cmd = (start === START_FEN ? "position startpos" : "position fen " + start) + " moves " + ucis.join(" ");
        if (is960Fen(start)) chess960 = true;
      }
    } catch { /* fall back to plain fen */ }
  }
  return {
    fen, turn, cmd, chess960,
    legalCount: legal.length,
    terminal: legal.length === 0 ? (chess.inCheck() ? "checkmate" : "stalemate") : null,
  };
}

function toWhite(turn, cp, mate) {
  if (mate != null) return { mate: turn === "w" ? mate : -mate };
  return { cp: turn === "w" ? cp : -cp };
}

function terminalResult(pos) {
  const mated = pos.terminal === "checkmate";
  const line = {
    multipv: 1, depth: 0, seldepth: 0,
    cp: mated ? null : 0, mate: mated ? 0 : null,
    pv: [], san: [],
    scoreWhite: mated ? { mate: 0, winner: pos.turn === "w" ? "b" : "w" } : { cp: 0 },
  };
  return { fen: pos.fen, bestmove: null, ponder: null, depth: 0, lines: [line], aborted: false, terminal: pos.terminal };
}

function emptyResult(fen, aborted) {
  return { fen, bestmove: null, ponder: null, depth: 0, lines: [], aborted };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Engine {
  /**
   * @param {object} [o]
   * @param {() => {post(line:string):void, onLine(cb):void, terminate():void, onError?(cb):void}} [o.createTransport]
   * @param {number} [o.hash=16] hash table in MB (kept small so two engines fit on phones)
   * @param {number} [o.initTimeoutMs=30000] reject init() if Stockfish has not answered by then
   */
  constructor({ createTransport, hash = 16, initTimeoutMs = 30000 } = {}) {
    this._createTransport = createTransport || (() => createWorkerTransport());
    this._hash = Math.max(1, Math.min(64, hash | 0 || 16));
    this._initTimeoutMs = initTimeoutMs;
    this._t = null;
    this._gen = 0;
    this._initP = null;
    this._sent = new Map();   // option name -> last value sent
    this._waiters = [];
    this._tail = Promise.resolve();
    this._jobs = new Set();   // analyze jobs queued or running
    this._search = null;
    this._goCount = 0;
    this._bestCount = 0;
    this._crashes = 0;
    this._terminated = false;
    this._lastLineAt = 0;
    /** Parsed `option name ...` lines, e.g. optionInfo.UCI_Elo = {type:"spin", min:1320, max:3190}. */
    this.optionInfo = {};
    this.name = "";
    this.ready = false;
    /** Sticky Error once the engine is unusable (failed to load, crashed repeatedly, terminated). */
    this.error = null;
    /** Optional hook: called with an Error whenever the engine process dies. */
    this.onCrash = null;
  }

  get busy() { return !!this._search; }

  // ---- lifecycle -------------------------------------------------------------

  init() {
    if (this.error) return Promise.reject(this.error);
    if (!this._initP) {
      this._initP = this._doInit();
      this._initP.catch(() => {});
    }
    return this._initP;
  }

  async _doInit() {
    const gen = ++this._gen;
    this._goCount = this._bestCount = 0;
    this._sent.clear();
    let t;
    try {
      t = this._createTransport();
      if (!t || typeof t.post !== "function" || typeof t.onLine !== "function") throw new Error("bad transport");
    } catch (e) {
      throw this._fail(unavailable("could not start Stockfish (" + e.message + ")", e), true);
    }
    this._t = t;
    t.onLine((line) => { if (gen === this._gen) this._onLine(String(line)); });
    if (typeof t.onError === "function") {
      t.onError((err) => {
        if (gen !== this._gen) return;
        const msg = (err && err.message) || String(err);
        this._fail(unavailable(this.ready ? "Stockfish crashed (" + msg + ")" : "Stockfish failed to load (" + msg + ")", err), !this.ready);
      });
    }
    const timeoutMsg = "Stockfish did not start within " + Math.round(this._initTimeoutMs / 1000) + "s";
    this._post("uci");
    await this._waitFor((l) => l === "uciok", this._initTimeoutMs, timeoutMsg, gen);
    this._post("setoption name Hash value " + this._hash);
    this._sent.set("Hash", String(this._hash));
    this._post("isready");
    await this._waitFor((l) => l === "readyok", this._initTimeoutMs, timeoutMsg, gen);
    this.ready = true;
  }

  /** Kill the worker. Pending and future calls reject with "Engine terminated". */
  terminate() {
    if (this._terminated) return;
    this._terminated = true;
    for (const j of this._jobs) j.cancelled = true;
    const e = new Error("Engine terminated");
    e.code = "ENGINE_TERMINATED";
    this._fail(e, true);
  }

  _fail(err, sticky) {
    const wasReady = this.ready;
    this.ready = false;
    this._gen++; // ignore anything the dead transport still says
    const t = this._t;
    this._t = null;
    if (t) { try { t.terminate(); } catch { /* ignore */ } }
    for (const w of this._waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
    const s = this._search;
    if (s) { this._search = null; this._finishTimers(s); s.reject(err); }
    if (!sticky && wasReady && this._crashes < 2) {
      // Crash after a successful start: next call lazily restarts a fresh worker.
      this._crashes++;
      this._initP = null;
    } else if (!this.error) {
      this.error = err;
      this._initP = Promise.reject(err);
      this._initP.catch(() => {});
    }
    if (this.onCrash && err.code !== "ENGINE_TERMINATED") { try { this.onCrash(err); } catch { /* ignore */ } }
    return err;
  }

  // ---- plumbing ----------------------------------------------------------------

  _post(line) {
    if (!this._t) throw this.error || unavailable("not running");
    try { this._t.post(line); } catch (e) { throw this._fail(unavailable("could not talk to Stockfish (" + e.message + ")", e)); }
  }

  _waitFor(match, timeoutMs, timeoutMsg, gen = this._gen) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject, timer: null };
      if (timeoutMs) {
        const started = Date.now();
        const arm = (ms) => {
          w.timer = setTimeout(() => {
            if (this._waiters.indexOf(w) < 0) return;
            if (pageHidden() || Date.now() - Math.max(started, this._lastLineAt) < timeoutMs * 0.9) { arm(timeoutMs); return; }
            this._waiters.splice(this._waiters.indexOf(w), 1);
            const err = unavailable(timeoutMsg || "Stockfish stopped responding");
            if (gen === this._gen) this._fail(err, !this.ready);
            reject(err);
          }, ms);
        };
        arm(timeoutMs);
      }
      this._waiters.push(w);
    });
  }

  _serial(fn) {
    const p = this._tail.then(fn);
    this._tail = p.then(() => {}, () => {});
    return p;
  }

  /** Interrupt the running search and cancel analyses queued behind it. */
  _preempt() {
    for (const j of this._jobs) j.cancelled = true;
    const s = this._search;
    if (s && !s.stopSent) this._sendStop(s);
  }

  _sendStop(s, abort = true) {
    if (abort) s.aborted = true;
    s.stopSent = true;
    try { this._post("stop"); } catch { return; }
    const sentAt = Date.now();
    const arm = () => {
      clearTimeout(s.watchdog);
      s.watchdog = setTimeout(() => {
        if (this._search !== s) return;
        if (pageHidden() || Date.now() - Math.max(sentAt, this._lastLineAt) < STOP_GRACE_MS * 0.9) { arm(); return; }
        this._fail(unavailable("Stockfish stopped responding"));
      }, STOP_GRACE_MS);
    };
    arm();
  }

  _onLine(line) {
    this._lastLineAt = Date.now();
    line = line.trim();
    if (!line) return;
    const s = this._search;
    if (line.startsWith("info ")) {
      // Only lines produced after every earlier `go` has been answered belong to `s`.
      if (s && this._bestCount === s.goIndex - 1) this._onInfo(s, line);
      return;
    }
    if (line.startsWith("bestmove")) {
      this._bestCount++;
      if (s && s.goIndex === this._bestCount) {
        const t = line.split(/\s+/);
        const best = t[1] && t[1] !== "(none)" ? t[1] : null;
        const ponder = t[2] === "ponder" && t[3] ? t[3] : null;
        this._search = null;
        this._finishTimers(s);
        if (s.onInfo && s.dirty) this._emit(s);
        s.done = true;
        s.resolve(this._result(s, best, ponder));
      }
      return; // stale bestmove from a stopped search: ignore
    }
    if (line.startsWith("option name ")) parseOption(line, this.optionInfo);
    else if (line.startsWith("id name ")) this.name = line.slice(8);
    for (let i = 0; i < this._waiters.length; i++) {
      const w = this._waiters[i];
      if (w.match(line)) {
        this._waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(line);
        return;
      }
    }
  }

  _onInfo(s, line) {
    const o = parseInfo(line);
    if (!o || !o.pv || !o.pv.length || (o.cp == null && o.mate == null)) return;
    if (o.nodes != null) s.nodes = o.nodes;
    if (o.time != null) s.time = o.time;
    if (o.nps != null) s.nps = o.nps;
    if (o.bound) return; // aspiration fail-high/low: keep the last exact line
    const k = o.multipv || 1;
    s.lines.set(k, o);
    s.dirty = true;
    if (!s.onInfo || s.timer) return;
    const wait = s.lastEmit + INFO_THROTTLE_MS - Date.now();
    if (wait <= 0) this._emit(s);
    else s.timer = setTimeout(() => { s.timer = null; if (!s.done) this._emit(s); }, wait);
  }

  _emit(s) {
    s.dirty = false;
    s.lastEmit = Date.now();
    try { s.onInfo(this._result(s, null, null, true)); } catch (e) { console.error("onInfo handler threw", e); }
  }

  _finishTimers(s) {
    clearTimeout(s.timer); s.timer = null;
    clearTimeout(s.watchdog); s.watchdog = null;
    clearTimeout(s.overrun); s.overrun = null;
  }

  _result(s, bestmove, ponder, partial = false) {
    const fen = s.pos.fen, turn = s.pos.turn;
    const lines = [...s.lines.values()]
      .sort((a, b) => a.multipv - b.multipv)
      .map((o) => ({
        multipv: o.multipv || 1,
        depth: o.depth || 0,
        seldepth: o.seldepth || 0,
        cp: o.mate != null ? null : o.cp,
        mate: o.mate != null ? o.mate : null,
        pv: o.pv.slice(),
        scoreWhite: toWhite(turn, o.cp, o.mate),
        san: uciLineToSan(fen, o.pv),
        ...(o.wdl ? { wdl: o.wdl } : {}),
      }));
    const r = {
      fen,
      bestmove: bestmove || (lines[0] && lines[0].pv[0]) || null,
      ponder: ponder || (lines[0] && lines[0].pv[1]) || null,
      depth: lines[0] ? lines[0].depth : 0,
      lines,
      aborted: !!s.aborted,
      nodes: s.nodes || 0,
      nps: s.nps || 0,
      time: s.time || 0,
    };
    if (partial) r.partial = true;
    return r;
  }

  // ---- public API ------------------------------------------------------------

  /**
   * Set a UCI option (cached: unchanged values are not resent). Interrupts a running search.
   * Strength options are managed per call by analyze({elo}); prefer that over UCI_LimitStrength.
   */
  setOption(name, value) {
    if (this._terminated) return Promise.reject(this.error);
    this._preempt();
    return this._serial(async () => {
      await this.init();
      const v = value === undefined || value === null ? "" : String(value);
      if (this._sent.get(name) === v && v !== "") return;
      this._post(v === "" ? "setoption name " + name : "setoption name " + name + " value " + v);
      if (v !== "") this._sent.set(name, v);
      this._post("isready");
      await this._waitFor((l) => l === "readyok", 20000, "Stockfish stopped responding");
    });
  }

  /** Call when a new game starts (clears hash/history heuristics). Interrupts a running search. */
  newGame() {
    if (this._terminated) return Promise.reject(this.error);
    this._preempt();
    return this._serial(async () => {
      await this.init();
      this._post("ucinewgame");
      this._post("isready");
      await this._waitFor((l) => l === "readyok", 20000, "Stockfish stopped responding");
    });
  }

  /** Stop the current search (if any); resolves once the engine is idle. */
  stop() {
    this._preempt();
    return this._serial(() => {});
  }

  /**
   * Analyze a position.
   * @param {string} fen
   * @param {object} [o]
   * @param {number} [o.depth] stop at this depth
   * @param {number} [o.movetime] stop after this many ms
   * @param {number} [o.nodes] stop after this many nodes
   *   (several limits = whichever comes first; none = infinite until stop()/next call)
   * @param {number} [o.multipv=1]
   * @param {string[]} [o.searchMoves] restrict the root to these moves (UCI or SAN)
   * @param {number|null} [o.elo] play at limited strength (UCI_LimitStrength + UCI_Elo);
   *   omitted/null = full strength. Lets one engine serve both a bot and hints safely.
   * @param {{startFen?:string, moves:string[]}} [o.history] the game so far (SAN or UCI);
   *   when it leads to `fen`, it is sent as `position ... moves ...` so Stockfish sees repetitions.
   * @param {(r:object)=>void} [onInfo] throttled (<=10/s) partial results while searching
   * @returns {Promise<{fen, bestmove, ponder, depth, lines, aborted, nodes, nps, time, terminal?}>}
   */
  analyze(fen, o = {}, onInfo) {
    if (this._terminated) return Promise.reject(this.error);
    let pos;
    try { pos = preparePosition(fen, o.history); } catch (e) { return Promise.reject(e); }
    this._preempt();
    const job = { cancelled: false };
    this._jobs.add(job);
    const run = async () => {
      if (this._terminated) throw this.error;
      if (job.cancelled) return emptyResult(pos.fen, true);
      if (pos.terminal) return terminalResult(pos);
      await this.init();
      if (job.cancelled) return emptyResult(pos.fen, true);
      return this._startSearch(pos, o, onInfo, job);
    };
    const p = this._serial(run);
    p.then(() => this._jobs.delete(job), () => this._jobs.delete(job));
    return p;
  }

  async _startSearch(pos, o, onInfo, job) {
    const multipv = Math.max(1, Math.min(64, o.multipv | 0 || 1));
    const setOpt = (name, v) => {
      v = String(v);
      if (this._sent.get(name) === v) return false;
      this._post("setoption name " + name + " value " + v);
      this._sent.set(name, v);
      return true;
    };
    let changed = setOpt("MultiPV", multipv);
    // Chess960 positions carry rook-file castling rights; castling is then sent as king-takes-rook
    changed = setOpt("UCI_Chess960", pos.chess960 ? "true" : "false") || changed;
    const info = this.optionInfo.UCI_Elo || {};
    if (o.elo != null && isFinite(o.elo)) {
      const elo = Math.round(Math.max(info.min ?? 1320, Math.min(info.max ?? 3190, o.elo)));
      changed = setOpt("UCI_LimitStrength", "true") || changed;
      changed = setOpt("UCI_Elo", elo) || changed;
    } else {
      changed = setOpt("UCI_LimitStrength", "false") || changed;
    }
    if (changed) {
      this._post("isready");
      await this._waitFor((l) => l === "readyok", 20000, "Stockfish stopped responding");
      if (job.cancelled) return emptyResult(pos.fen, true); // superseded while syncing options
    }
    let go = "go";
    const depth = o.depth | 0, movetime = o.movetime | 0, nodes = o.nodes | 0;
    if (depth > 0) go += " depth " + depth;
    if (nodes > 0) go += " nodes " + nodes;
    if (movetime > 0) go += " movetime " + movetime;
    if (!(depth > 0) && !(nodes > 0) && !(movetime > 0)) go += " infinite";
    if (Array.isArray(o.searchMoves) && o.searchMoves.length) {
      const c = createChess(pos.fen);
      const ucis = [];
      for (const mv of o.searchMoves) {
        const m = applyMove(c, mv);
        if (m) { ucis.push(moveToUci(m)); c.undo(); }
      }
      if (ucis.length) go += " searchmoves " + ucis.join(" ");
    }
    return new Promise((resolve, reject) => {
      const s = {
        pos, resolve, reject, onInfo: typeof onInfo === "function" ? onInfo : null,
        lines: new Map(), aborted: false, stopSent: false, done: false,
        dirty: false, lastEmit: 0, timer: null, watchdog: null, overrun: null,
        nodes: 0, nps: 0, time: 0, goIndex: 0,
      };
      this._post(pos.cmd);
      s.goIndex = ++this._goCount;
      this._search = s;
      this._post(go);
      if (movetime > 0) {
        const arm = (ms) => {
          s.overrun = setTimeout(() => {
            if (this._search !== s || s.stopSent) return;
            if (pageHidden()) { arm(MOVETIME_GRACE_MS); return; } // throttled, not stuck
            this._sendStop(s, false); // just enforcing the movetime limit: not an abort
          }, ms);
        };
        arm(movetime + MOVETIME_GRACE_MS);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Score helpers (scoreWhite = {cp} or {mate}; mate>0 = White mates; {mate:0, winner} = game over)
// ---------------------------------------------------------------------------

/** Lichess win% (0-100) for `forColor`. Mate for that side = 100, against = 0. */
export function winPercent(scoreWhite, forColor = "w") {
  let w = 50;
  if (scoreWhite) {
    if (scoreWhite.mate != null) {
      if (scoreWhite.mate === 0) w = scoreWhite.winner === "w" ? 100 : scoreWhite.winner === "b" ? 0 : 50;
      else w = scoreWhite.mate > 0 ? 100 : 0;
    } else if (scoreWhite.cp != null && isFinite(scoreWhite.cp)) {
      const cp = Math.max(-1000, Math.min(1000, scoreWhite.cp));
      w = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    }
  }
  return forColor === "b" ? 100 - w : w;
}

/** "+1.34", "-0.50", "0.00", "M3", "-M2"; finished games give "1-0" / "0-1". */
export function formatScore(scoreWhite) {
  if (!scoreWhite) return "0.00";
  if (scoreWhite.mate != null) {
    if (scoreWhite.mate === 0) return scoreWhite.winner === "w" ? "1-0" : scoreWhite.winner === "b" ? "0-1" : "#";
    return (scoreWhite.mate > 0 ? "M" : "-M") + Math.abs(scoreWhite.mate);
  }
  const cp = scoreWhite.cp || 0;
  if (Math.abs(cp) < 0.5) return "0.00";
  return (cp > 0 ? "+" : "-") + (Math.abs(cp) / 100).toFixed(2);
}

/** White's share of an eval bar, 0..1. Mate = exactly 1/0; otherwise kept within [0.02, 0.98]. */
export function evalBarFraction(scoreWhite) {
  if (!scoreWhite) return 0.5;
  if (scoreWhite.mate != null) {
    if (scoreWhite.mate === 0) return scoreWhite.winner === "w" ? 1 : scoreWhite.winner === "b" ? 0 : 0.5;
    return scoreWhite.mate > 0 ? 1 : 0;
  }
  const cp = scoreWhite.cp || 0;
  const f = 1 / (1 + Math.exp(-0.004 * cp));
  return Math.max(0.02, Math.min(0.98, f));
}

// ---------------------------------------------------------------------------
// Static position helpers (material, attacks, static exchange evaluation).
// Shared by bots.js (human-like blunders) and review.js (hangs / sacrifices).
// ---------------------------------------------------------------------------

export const PIECE_VALUE = { p: 100, n: 300, b: 310, r: 500, q: 900, k: 20000 };
export const PIECE_NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

const sqIdx = (sq) => (sq.charCodeAt(0) - 97) + (sq.charCodeAt(1) - 49) * 8;

/** 64-array (a1 = 0, h8 = 63) of {type,color}|null from a chess.js instance. */
export function boardArray(chess) {
  const b = new Array(64).fill(null);
  const rows = chess.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = rows[r][f];
    if (p) b[(7 - r) * 8 + f] = { type: p.type, color: p.color };
  }
  return b;
}

/** Material (sum of piece values, kings excluded) per color, from a FEN's placement field. */
export function materialFromFen(fen) {
  const m = { w: 0, b: 0 };
  const place = fen.split(" ")[0];
  for (const ch of place) {
    const lower = ch.toLowerCase();
    if (lower === "k" || !(lower in PIECE_VALUE)) continue;
    if (ch === lower) m.b += PIECE_VALUE[lower]; else m.w += PIECE_VALUE[lower];
  }
  return m;
}

const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Squares (indices) of `color` pieces attacking square index `to` on board array `b`. */
export function attackersOf(b, to, color) {
  const out = [];
  const tf = to & 7, tr = to >> 3;
  const at = (f, r) => (f < 0 || f > 7 || r < 0 || r > 7 ? undefined : b[r * 8 + f]);
  const pr = color === "w" ? tr - 1 : tr + 1;
  for (const df of [-1, 1]) {
    const p = at(tf + df, pr);
    if (p && p.color === color && p.type === "p") out.push(pr * 8 + tf + df);
  }
  for (const [df, dr] of KNIGHT_D) {
    const p = at(tf + df, tr + dr);
    if (p && p.color === color && p.type === "n") out.push((tr + dr) * 8 + tf + df);
  }
  for (const [df, dr] of KING_D) {
    const p = at(tf + df, tr + dr);
    if (p && p.color === color && p.type === "k") out.push((tr + dr) * 8 + tf + df);
  }
  for (const [dirs, kinds] of [[DIAG, "bq"], [ORTH, "rq"]]) {
    for (const [df, dr] of dirs) {
      let f = tf + df, r = tr + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const p = b[r * 8 + f];
        if (p) { if (p.color === color && kinds.includes(p.type)) out.push(r * 8 + f); break; }
        f += df; r += dr;
      }
    }
  }
  return out;
}

function leastValuable(b, sqs) {
  let best = -1, bv = Infinity;
  for (const s of sqs) { const v = PIECE_VALUE[b[s].type]; if (v < bv) { bv = v; best = s; } }
  return best;
}

/**
 * Static exchange evaluation of the capture from->to on board array `b`, in centipawns,
 * from the capturing side's point of view (ignores pins beyond the first capture).
 * `targetValue` overrides the captured value (en passant).
 */
export function seeCapture(board, from, to, targetValue) {
  const b = board.slice();
  const mover = b[from];
  if (!mover) return 0;
  const gain = [targetValue != null ? targetValue : b[to] ? PIECE_VALUE[b[to].type] : 0];
  let onSquare = PIECE_VALUE[mover.type];
  b[to] = mover; b[from] = null;
  let side = mover.color === "w" ? "b" : "w";
  let d = 0;
  for (;;) {
    const att = leastValuable(b, attackersOf(b, to, side));
    if (att < 0) break;
    if (b[att].type === "k") {
      const t2 = b.slice(); t2[to] = t2[att]; t2[att] = null;
      if (attackersOf(t2, to, side === "w" ? "b" : "w").length) break;
    }
    d++;
    gain[d] = onSquare - gain[d - 1];
    onSquare = PIECE_VALUE[b[att].type];
    b[to] = b[att]; b[att] = null;
    side = side === "w" ? "b" : "w";
    if (d > 32) break;
  }
  while (d > 0) { gain[d - 1] = -Math.max(-gain[d - 1], gain[d]); d--; }
  return gain[0];
}

/** SEE of a chess.js verbose move made from the position in `chess` (0 for quiet moves). */
export function seeMove(chess, m, board = boardArray(chess)) {
  if (!m.captured) return 0;
  const ep = m.flags && m.flags.includes("e");
  return seeCapture(board, sqIdx(m.from), sqIdx(m.to), ep ? PIECE_VALUE.p : undefined);
}

/** Best material the side to move can win right now by a single capture sequence (>= 0). */
export function bestCaptureGain(chess) {
  const board = boardArray(chess);
  let best = 0, move = null;
  for (const m of chess.moves({ verbose: true })) {
    if (!m.captured) continue;
    const g = seeMove(chess, m, board);
    if (g > best) { best = g; move = m; }
  }
  return { gain: best, move };
}

/** SEE of the opponent capturing on `square` right now (the piece there is en prise if > 0). */
export function enPriseLoss(chess, square) {
  const board = boardArray(chess);
  let worst = 0;
  for (const m of chess.moves({ verbose: true })) {
    if (m.to !== square || !m.captured) continue;
    worst = Math.max(worst, seeMove(chess, m, board));
  }
  return worst;
}
