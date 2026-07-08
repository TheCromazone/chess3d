// Procedural WebAudio SFX (generated assets blocked: workspace out of credits).
// Levels follow the audio mix law: SFX ~-10 dBFS region, nothing near clipping.
let ctx = null;
let master = null;
let enabled = true;

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function unlockAudio() { ensure(); }
export function setSound(on) { enabled = on; }
export function soundOn() { return enabled; }

function noiseBuffer(dur) {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.max(1, Math.floor(sr * dur)), sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function thump(at, freq, dur, gain) {
  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(freq, at);
  o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.55), at + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  o.connect(g); g.connect(master);
  o.start(at); o.stop(at + dur + 0.02);
}

function click(at, freqCenter, dur, gain) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(dur);
  const f = ctx.createBiquadFilter();
  f.type = "bandpass"; f.frequency.value = freqCenter; f.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(at); src.stop(at + dur + 0.02);
}

function chime(at, freq, dur, gain) {
  const o = ctx.createOscillator();
  o.type = "sine"; o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  o.connect(g); g.connect(master);
  o.start(at); o.stop(at + dur + 0.05);
}

function play(fn) {
  if (!enabled) return;
  if (!ensure()) return;
  fn(ctx.currentTime + 0.01);
}

export const SFX = {
  move()    { play(t => { click(t, 1400, 0.05, 0.5); thump(t, 150, 0.1, 0.6); }); },
  capture() { play(t => { click(t, 900, 0.06, 0.7); thump(t, 120, 0.12, 0.8); thump(t + 0.055, 95, 0.1, 0.5); }); },
  castle()  { play(t => { click(t, 1400, 0.05, 0.4); thump(t, 150, 0.09, 0.5); click(t + 0.12, 1400, 0.05, 0.4); thump(t + 0.12, 140, 0.09, 0.5); }); },
  check()   { play(t => { chime(t, 880, 0.28, 0.25); chime(t + 0.02, 662, 0.3, 0.15); }); },
  promote() { play(t => { chime(t, 523, 0.16, 0.2); chime(t + 0.09, 659, 0.16, 0.2); chime(t + 0.18, 784, 0.24, 0.22); }); },
  start()   { play(t => { chime(t, 523, 0.2, 0.2); chime(t + 0.12, 784, 0.3, 0.2); }); },
  end()     { play(t => { chime(t, 784, 0.25, 0.22); chime(t + 0.16, 523, 0.45, 0.22); }); },
  tick()    { play(t => { click(t, 2100, 0.03, 0.28); }); },
  illegal() { play(t => { thump(t, 110, 0.09, 0.3); }); },
};
