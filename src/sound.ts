/**
 * All sound is synthesized with the Web Audio API: no audio files, no licensing.
 * Browsers only allow audio after a user gesture, so call initAudio() from a click.
 */

export const audioSettings = { volume: 0.7, muted: false };

let ctx: AudioContext | null = null;
let master: GainNode;
let sfxBus: GainNode;
let musicBus: GainNode;
let noise: AudioBuffer;
let ambience: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
let clangTimer = 0;
let music: { timer: number; next: number; beat: number } | null = null;
let intensity = 0;

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return;
  }
  try {
    ctx = new AudioContext();
  } catch {
    return;
  }
  master = ctx.createGain();
  master.connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.55;
  musicBus.connect(master);
  noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  applyVolume();
}

export function applyVolume() {
  if (!ctx) return;
  master.gain.setTargetAtTime(audioSettings.muted ? 0 : audioSettings.volume, ctx.currentTime, 0.05);
}

/** A sound that keeps playing until stopped (e.g. the rising Volley tone). */
export interface Voice {
  stop: () => void;
}
const SILENT: Voice = { stop: () => {} };

function tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0, bus: GainNode = sfxBus) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.02, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(bus);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function burst(filter: BiquadFilterType, f0: number, f1: number, dur: number, peak: number, delay = 0, q = 1, bus: GainNode = sfxBus) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const s = ctx.createBufferSource();
  s.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.03, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f);
  f.connect(g);
  g.connect(bus);
  s.start(t, Math.random());
  s.stop(t + dur + 0.05);
}

export type Sfx =
  | 'hit'
  | 'miss'
  | 'slash'
  | 'parried'
  | 'bannerTick'
  | 'charge'
  | 'duelSignal'
  | 'duelWin'
  | 'duelLose'
  | 'catch'
  | 'horn'
  | 'captured'
  | 'lost'
  | 'send'
  | 'retreat'
  | 'victory'
  | 'defeat'
  | 'click'
  | 'ram'
  | 'gate'
  | 'sizzle';

export function sfx(name: Sfx) {
  if (!ctx || audioSettings.muted) return;
  switch (name) {
    case 'hit':
      tone('triangle', 880, 880, 0.12, 0.25);
      tone('triangle', 1320, 1320, 0.2, 0.2, 0.06);
      break;
    case 'miss':
      tone('sine', 140, 60, 0.3, 0.45);
      burst('lowpass', 600, 200, 0.25, 0.25);
      break;
    case 'slash':
      burst('highpass', 1500, 6000, 0.18, 0.35);
      break;
    case 'parried':
      tone('square', 1600, 1200, 0.08, 0.12);
      tone('triangle', 2400, 1800, 0.25, 0.12, 0.01);
      burst('bandpass', 3000, 2000, 0.15, 0.2, 0, 4);
      break;
    case 'bannerTick':
      tone('sine', 660, 660, 0.06, 0.06);
      break;
    case 'charge':
      // War horn over a drum roll.
      for (let i = 0; i < 6; i++) tone('sine', 120, 50, 0.18, 0.5, i * 0.07);
      tone('sawtooth', 196, 196, 0.5, 0.12, 0.05);
      tone('sawtooth', 294, 294, 0.6, 0.12, 0.2);
      tone('sawtooth', 392, 392, 0.7, 0.1, 0.35);
      break;
    case 'duelSignal':
      tone('square', 1400, 1400, 0.09, 0.2);
      burst('highpass', 4000, 8000, 0.08, 0.3);
      break;
    case 'duelWin':
      tone('triangle', 523, 523, 0.15, 0.25);
      tone('triangle', 784, 784, 0.25, 0.25, 0.1);
      tone('triangle', 1047, 1047, 0.4, 0.22, 0.2);
      break;
    case 'duelLose':
      tone('sawtooth', 220, 110, 0.5, 0.18);
      break;
    case 'catch':
      tone('triangle', 990 + Math.random() * 200, 990, 0.1, 0.2);
      break;
    case 'horn':
      tone('sawtooth', 146.8, 146.8, 0.45, 0.14);
      tone('sawtooth', 196, 196, 0.6, 0.12, 0.35);
      burst('lowpass', 400, 300, 0.6, 0.05, 0.1);
      break;
    case 'captured':
      [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.25, 0.18, i * 0.08));
      break;
    case 'lost':
      [392, 311, 262].forEach((f, i) => tone('sawtooth', f, f * 0.98, 0.35, 0.12, i * 0.14));
      break;
    case 'send':
      tone('sine', 180, 120, 0.1, 0.25);
      tone('sine', 180, 120, 0.1, 0.2, 0.12);
      break;
    case 'retreat':
      tone('sawtooth', 330, 220, 0.35, 0.1);
      break;
    case 'victory':
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone('triangle', f, f, 0.5, 0.2, i * 0.12));
      break;
    case 'defeat':
      [294, 277, 262, 196].forEach((f, i) => tone('sawtooth', f, f * 0.97, 0.6, 0.12, i * 0.2));
      break;
    case 'click':
      tone('square', 900, 900, 0.03, 0.05);
      break;
    case 'ram':
      // A heavy thud on the gate.
      tone('sine', 90, 40, 0.25, 0.6);
      burst('lowpass', 500, 150, 0.2, 0.35);
      break;
    case 'gate':
      // Splintering wood.
      burst('bandpass', 900, 300, 0.5, 0.4, 0, 2);
      tone('sawtooth', 120, 50, 0.45, 0.2, 0.02);
      break;
    case 'sizzle':
      burst('highpass', 3000, 6000, 0.12, 0.12);
      break;
  }
}

/** Volley: a tone that rises as the ring closes, peaking at the hit moment. */
export function volleyTone(hitAt: number): Voice {
  if (!ctx || audioSettings.muted) return SILENT;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(300, t);
  o.frequency.exponentialRampToValueAtTime(900, t + hitAt);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + hitAt);
  o.connect(g);
  g.connect(sfxBus);
  o.start(t);
  o.stop(t + hitAt + 0.5);
  const c = ctx;
  return {
    stop: () => {
      g.gain.cancelScheduledValues(c.currentTime);
      g.gain.setTargetAtTime(0.0001, c.currentTime, 0.02);
      o.stop(c.currentTime + 0.1);
    },
  };
}

/** Parry: a whoosh that sweeps up as the spear closes in. */
export function spearWhoosh(dur: number): Voice {
  if (!ctx || audioSettings.muted) return SILENT;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource();
  s.buffer = noise;
  s.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 3;
  f.frequency.setValueAtTime(300, t);
  f.frequency.exponentialRampToValueAtTime(2500, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.25, t + dur);
  s.connect(f);
  f.connect(g);
  g.connect(sfxBus);
  s.start(t);
  s.stop(t + dur + 0.3);
  const c = ctx;
  return {
    stop: () => {
      g.gain.cancelScheduledValues(c.currentTime);
      g.gain.setTargetAtTime(0.0001, c.currentTime, 0.02);
      s.stop(c.currentTime + 0.1);
    },
  };
}

/** Battle ambience: crowd rumble plus random metal clangs while the battle view is open. */
export function setBattleAmbience(on: boolean) {
  if (!ctx) return;
  if (on && !ambience) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.gain.setTargetAtTime(0.12, ctx.currentTime, 0.3);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(sfxBus);
    src.start();
    ambience = { src, gain, filter };
    const clang = () => {
      if (!ambience || !ctx) return;
      if (!audioSettings.muted) {
        const f = 1800 + Math.random() * 1600;
        tone('square', f, f * 0.8, 0.07, 0.02 + Math.random() * 0.03);
      }
      clangTimer = window.setTimeout(clang, 180 + Math.random() * 600);
    };
    clang();
  } else if (!on && ambience) {
    const a = ambience;
    a.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.2);
    a.src.stop(ctx.currentTime + 1);
    ambience = null;
    clearTimeout(clangTimer);
  }
}

/** War drums: tempo and weight grow with the number of battles you are fighting. */
export function setMusic(on: boolean) {
  if (!ctx) return;
  if (on && !music) {
    music = { timer: 0, next: ctx.currentTime + 0.1, beat: 0 };
    const schedule = () => {
      if (!music || !ctx) return;
      const bpm = 84 + intensity * 14;
      const step = 60 / bpm / 2;
      while (music.next < ctx.currentTime + 0.25) {
        const b = music.beat % 8;
        const delay = music.next - ctx.currentTime;
        if (b === 0 || b === 4) tone('sine', 110, 45, 0.35, 0.45, delay, musicBus);
        if (intensity >= 1 && (b === 2 || b === 6)) tone('sine', 160, 90, 0.2, 0.25, delay, musicBus);
        if (intensity >= 2 && b % 2 === 1) burst('bandpass', 2500, 1800, 0.05, 0.06, delay, 2, musicBus);
        if (intensity >= 3 && (b === 3 || b === 7)) tone('sine', 200, 120, 0.15, 0.2, delay, musicBus);
        music.next += step;
        music.beat++;
      }
      music.timer = window.setTimeout(schedule, 100);
    };
    schedule();
  } else if (!on && music) {
    clearTimeout(music.timer);
    music = null;
  }
}

export function setIntensity(n: number) {
  intensity = Math.max(0, Math.min(3, n));
}

/** For debugging: whether the audio engine is running ('none' before the first click). */
export function audioState(): string {
  return ctx ? ctx.state : 'none';
}
