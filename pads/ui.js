// SPDX-License-Identifier: GPL-3.0-only
//
// ChoralRoot Pads: an Orchid-style surface for the ChoralRoot MIDI FX, as a Schwung tool.
// See logic.mjs for the layout. This file is the host side: pads in, LEDs and screen out, and the
// notes sent to the chosen Schwung slot with shadow_send_midi_to_dsp, where ChoralRoot turns them
// into chords.
//
// Controls
//   pads          column 1-2: chord type, columns 3-8: roots in the scale
//   Up / Down     octave
//   jog click     open / close Setup (Slot, Key, Scale, Chord Behaviour, Send To); turn the jog to move, click to edit
//
// Send To
//   Move  the notes go into Move as external MIDI on the slot's channel (cable 2), so the Move track on
//         that channel plays them, can record them in a clip, and its MIDI Out feeds the slot's ChoralRoot.
//         A clip keeps the chord keys (notes 0..7) and the roots, so playing it back rebuilds the chords.
//   Live  the notes go straight to the slot (shadow_send_midi_to_dsp). Move's sequencer never sees them;
//         record the chords in Live with ChoralRoot's USB MIDI Out.
//   Back          close Setup, or leave the tool (everything is released, the slot is put back as it was)

import {
  isPad, padRole, rootNote, chordPress, chordReleaseAll, pendingLabel, localChordName, padColour,
  NOTE_NAMES, SCALES, BEHAVIOURS, ZONE_LOW,
} from '/data/UserData/schwung/modules/tools/choralroot-pads/logic.mjs';

const SETTINGS_PATH = '/data/UserData/schwung/modules/tools/choralroot-pads/settings.json';
const CC_JOG = 14, CC_JOG_CLICK = 3, CC_BACK = 51, CC_UP = 55, CC_DOWN = 54;

let cfg = { slot: 0, key: 0, scale: 'Major', behaviour: 'Momentary', octave: 0, sendTo: 'Move' };
const chord = { held: new Set() };
const pressed = new Set();          // note pads down
const sounding = new Map();         // pad -> root note sent (so its off matches its on)
let fx = null;                      // { comp: 'midi_fx1', ch: 0..15, saved: {mod_low, mod_map, key, scale} }
let shownName = '', notesLine = '', dirty = true, nameAsk = 0, zoneTick = 0;
let setupOpen = false, setupRow = 0, setupEdit = false, needPaint = true;

/* ---------------------------------------------------------------- host --- */
const has = (f) => typeof globalThis[f] === 'function';
function getP(slot, key) { try { return has('shadow_get_param') ? shadow_get_param(slot, key) : null; } catch (e) { return null; } }
/* Writes to the slot. While a tool is open Schwung runs in overtake mode, where shadow_set_param is
 * fire-and-forget over ONE shared slot: back-to-back writes overwrite each other and only the last one lands
 * (schwung shadow_ui.js, shadowSetParamBlocking). So use the blocking shadow_set_param_timeout, which waits
 * for each write to be taken, and on a host without it send one write per tick. */
const SET_TIMEOUT_MS = 200;
const writes = [];                  // [slot, key, value] waiting for a tick (hosts without the blocking call)
function setP(slot, key, v) {
  try {
    if (has('shadow_set_param_timeout')) { shadow_set_param_timeout(slot, key, String(v), SET_TIMEOUT_MS); return; }
    const i = writes.findIndex((w) => w[0] === slot && w[1] === key);
    if (i >= 0) writes.splice(i, 1);
    writes.push([slot, key, String(v)]);
  } catch (e) {}
}
function flushOneWrite() {
  const w = writes.shift();
  if (w) { try { if (has('shadow_set_param')) shadow_set_param(w[0], w[1], w[2]); } catch (e) {} }
}
function send(st, d1, d2) {
  if (cfg.sendTo === 'Move') {
    if (has('move_midi_inject_to_move')) move_midi_inject_to_move([0x20 | (st >> 4), st, d1 & 127, d2 & 127]);
  } else if (has('shadow_send_midi_to_dsp')) shadow_send_midi_to_dsp([st, d1 & 127, d2 & 127]);
}
function led(n, c) { if (has('move_midi_internal_send')) move_midi_internal_send([0x09, 0x90, n, c]); }

function loadCfg() {
  try {
    const raw = has('host_read_file') ? host_read_file(SETTINGS_PATH) : null;
    if (raw) Object.assign(cfg, JSON.parse(raw));
  } catch (e) {}
  if (!SCALES[cfg.scale]) cfg.scale = 'Major';
  if (!BEHAVIOURS.includes(cfg.behaviour)) cfg.behaviour = 'Momentary';
  if (cfg.sendTo !== 'Live') cfg.sendTo = 'Move';
}
function saveCfg() { try { if (has('host_write_file')) host_write_file(SETTINGS_PATH, JSON.stringify(cfg)); } catch (e) {} }

/* Find ChoralRoot in the slot, move its chord zone under the pads' roots, match its key to ours.
 * What it had is kept so leaving puts it back. */
function attach() {
  detach();
  for (const comp of ['midi_fx1', 'midi_fx2']) {
    if (getP(cfg.slot, comp + '_module') !== 'choralroot') continue;
    const rc = parseInt(getP(cfg.slot, 'slot:receive_channel') || '0', 10);
    const saved = {};
    for (const k of ['mod_low', 'mod_map', 'key', 'scale']) saved[k] = getP(cfg.slot, comp + ':' + k);
    fx = { comp, ch: rc >= 1 && rc <= 16 ? rc - 1 : cfg.slot, saved, zoneOk: false, checks: 0 };
    moveZone();
    syncKey();
    return;
  }
}
function moveZone() {
  setP(cfg.slot, fx.comp + ':mod_low', ZONE_LOW);
  setP(cfg.slot, fx.comp + ':mod_map', 'Semitones');
}
/* Reads the zone back: until ChoralRoot says mod_low = 0, the chord pads would play as roots. */
function checkZone() {
  if (!fx || fx.zoneOk || writes.length) return;
  const low = getP(cfg.slot, fx.comp + ':mod_low'), map = getP(cfg.slot, fx.comp + ':mod_map');
  if (String(low) === String(ZONE_LOW) && (map === null || map === 'Semitones')) { fx.zoneOk = true; dirty = true; return; }
  if (++fx.checks <= 5) { moveZone(); syncKey(); }
  dirty = true;
}
function syncKey() {
  if (!fx) return;
  setP(cfg.slot, fx.comp + ':key', NOTE_NAMES[cfg.key]);
  setP(cfg.slot, fx.comp + ':scale', cfg.scale);
}
function detach() {
  releaseAll();
  if (!fx) return;
  writes.length = 0;
  // the zone last: on a host without the blocking call, the last write is the one that lands
  for (const k of ['key', 'scale', 'mod_map', 'mod_low']) {
    const v = fx.saved[k];
    if (v === null || v === undefined || v === '') continue;
    if (has('shadow_set_param_timeout')) setP(cfg.slot, fx.comp + ':' + k, v);
    else { try { if (has('shadow_set_param')) shadow_set_param(cfg.slot, fx.comp + ':' + k, String(v)); } catch (e) {} }
  }
  fx = null;
}

/* ---------------------------------------------------------------- play --- */
function releaseAll() {
  for (const [, note] of sounding) if (fx) send(0x80 | fx.ch, note, 0);
  sounding.clear(); pressed.clear();
  for (const [, z] of chordReleaseAll(chord)) if (fx) send(0x80 | fx.ch, z, 0);
}

function onPad(n, down, vel) {
  if (!fx) return;
  const r = padRole(n);
  if (r.kind === 'chord') {
    for (const [on, z] of chordPress(chord, r, down, cfg.behaviour)) send((on ? 0x90 : 0x80) | fx.ch, z, on ? 100 : 0);
    if (!sounding.size) { shownName = pendingLabel(chord.held); notesLine = ''; }
  } else if (down) {
    const note = rootNote(r.index, cfg.key, cfg.scale, cfg.octave);
    if (note < 0) return;
    pressed.add(n); sounding.set(n, note);
    send(0x90 | fx.ch, note, vel || 100);
    shownName = localChordName(note, chord.held, cfg.key, cfg.scale);
    notesLine = NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
    nameAsk = 3;                                   // ask ChoralRoot for its own name over the next ticks
  } else if (sounding.has(n)) {
    send(0x80 | fx.ch, sounding.get(n), 0);
    sounding.delete(n); pressed.delete(n);
  }
  paintPad(n);
  dirty = true;
}

/* ---------------------------------------------------------------- LEDs --- */
function paintPad(n) { led(n, padColour(n, chord.held, pressed)); }
function paintAll() { for (let n = 68; n <= 99; n++) paintPad(n); }

/* -------------------------------------------------------------- screen --- */
// a 5x7 pixel font for the big chord name (2x), drawn with fill_rect
const G = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17], S: [15, 16, 16, 14, 1, 1, 30],
  U: [17, 17, 17, 17, 17, 17, 14], '#': [10, 31, 10, 31, 10, 0, 0], a: [0, 0, 14, 1, 15, 17, 15],
  b: [16, 16, 22, 25, 17, 17, 30], d: [1, 1, 13, 19, 17, 17, 15], i: [4, 0, 12, 4, 4, 4, 14],
  j: [2, 0, 6, 2, 2, 18, 12], m: [0, 0, 26, 21, 21, 21, 21], s: [0, 0, 15, 16, 14, 1, 30],
  u: [0, 0, 17, 17, 17, 19, 13], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
  '.': [0, 0, 0, 0, 0, 12, 12], '+': [0, 4, 4, 31, 4, 4, 0], '/': [1, 1, 2, 4, 8, 16, 16],
  n: [0, 0, 22, 25, 17, 17, 17], o: [0, 0, 14, 17, 17, 17, 14], T: [31, 4, 4, 4, 4, 4, 4],
  W: [17, 17, 17, 21, 21, 21, 10], Z: [31, 1, 2, 4, 8, 16, 31], '-': [0, 0, 0, 31, 0, 0, 0], ' ': [0, 0, 0, 0, 0, 0, 0],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31],
  3: [30, 1, 1, 14, 1, 1, 30], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14],
  9: [14, 17, 17, 15, 1, 2, 12],
};
function big(text, y, s) {
  const w = text.length * 6 * s - s;
  let x = Math.max(0, Math.floor((128 - w) / 2));
  for (const ch of text) {
    const g = G[ch];
    if (g) for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r] & (16 >> c)) fill_rect(x + c * s, y + r * s, s, s, 1);
    x += 6 * s;
  }
}
const SETUP = ['Slot', 'Key', 'Scale', 'Chord Behaviour', 'Send To'];
function setupValue(i) {
  return [String(cfg.slot + 1), NOTE_NAMES[cfg.key], cfg.scale, cfg.behaviour, cfg.sendTo][i];
}
function draw() {
  clear_screen();
  if (setupOpen) {
    print(2, 2, 'SETUP', 1);
    SETUP.forEach((label, i) => {
      const y = 13 + i * 10, on = i === setupRow;
      if (on) fill_rect(0, y - 1, 128, 10, 1);
      print(4, y, label, on ? 0 : 1);
      const v = (on && setupEdit ? '< ' + setupValue(i) + ' >' : setupValue(i));
      print(124 - text_width(v), y, v, on ? 0 : 1);
    });
    return;
  }
  const top = 'S' + (cfg.slot + 1) + ' ' + NOTE_NAMES[cfg.key] + ' ' + (cfg.scale === 'Major' ? 'MAJ' : 'MIN');
  print(2, 2, top, 1);
  const bh = (cfg.sendTo === 'Move' ? 'MOVE ' : 'LIVE ') + (cfg.behaviour === 'Hold' ? 'HOLD' : 'MOM');
  print(126 - text_width(bh), 2, bh, 1);
  if (!fx) {
    print(4, 24, 'No ChoralRoot in slot ' + (cfg.slot + 1), 1);
    print(4, 36, 'Jog click: Setup', 1);
    return;
  }
  const name = shownName || '--';
  big(name, 22, name.length > 9 ? 2 : 3 * 6 * name.length <= 126 ? 3 : 2);
  print(2, 54, fx.zoneOk ? (notesLine || ' ') : fx.checks > 5 ? 'CHORD ZONE FAILED' : 'linking...', 1);
  const oc = 'OCT ' + (cfg.octave > 0 ? '+' : '') + cfg.octave;
  print(126 - text_width(oc), 54, oc, 1);
}

/* ------------------------------------------------------------ controls --- */
function delta(v) { return v >= 1 && v <= 63 ? 1 : v >= 65 && v <= 127 ? -1 : 0; }
function editSetup(i, d) {
  if (i === 0) { const s = (cfg.slot + d + 4) % 4; detach(); cfg.slot = s; attach(); }
  if (i === 1) { releaseAll(); cfg.key = (cfg.key + d + 12) % 12; syncKey(); }
  if (i === 2) { releaseAll(); cfg.scale = cfg.scale === 'Major' ? 'Minor' : 'Major'; syncKey(); }
  if (i === 3) { releaseAll(); cfg.behaviour = cfg.behaviour === 'Hold' ? 'Momentary' : 'Hold'; }
  if (i === 4) { releaseAll(); cfg.sendTo = cfg.sendTo === 'Move' ? 'Live' : 'Move'; }
  saveCfg(); needPaint = true;
}
function leave() {
  detach();
  for (let n = 68; n <= 99; n++) led(n, 0);
  if (has('host_pad_block')) host_pad_block(false);
  saveCfg();
  if (has('host_exit_module')) host_exit_module();
  else if (has('host_return_to_menu')) host_return_to_menu();
}

globalThis.onMidiMessageInternal = function (m) {
  if (!m || m.length < 3) return;
  const st = m[0] & 0xF0, d1 = m[1], d2 = m[2];
  if (st === 0xB0) {
    if (d1 === CC_BACK && d2 > 0) { if (setupOpen) { setupOpen = false; setupEdit = false; dirty = true; } else leave(); return; }
    if (d1 === CC_JOG_CLICK && d2 > 0) {
      if (!setupOpen) { releaseAll(); needPaint = true; setupOpen = true; setupEdit = false; } else setupEdit = !setupEdit;
      dirty = true; return;
    }
    if (d1 === CC_JOG && setupOpen) {
      const d = delta(d2);
      if (setupEdit) editSetup(setupRow, d); else setupRow = (setupRow + d + SETUP.length) % SETUP.length;
      dirty = true; return;
    }
    if ((d1 === CC_UP || d1 === CC_DOWN) && d2 > 0) {
      const o = Math.max(-2, Math.min(2, cfg.octave + (d1 === CC_UP ? 1 : -1)));
      if (o !== cfg.octave) { cfg.octave = o; saveCfg(); dirty = true; }
      return;
    }
    return;
  }
  if (!isPad(d1) || setupOpen) return;
  if (st === 0x90 && d2 > 0) onPad(d1, true, d2);
  else if (st === 0x80 || st === 0x90) onPad(d1, false, 0);
};

globalThis.init = function () {
  loadCfg();
  if (has('host_pad_block')) host_pad_block(true);      // the pads are ours while the tool is open
  attach();
  needPaint = true; dirty = true;
};

globalThis.tick = function () {
  if (needPaint) { needPaint = false; paintAll(); }
  flushOneWrite();
  if (fx && !fx.zoneOk && (++zoneTick % 4) === 0) checkZone();
  if (nameAsk > 0 && fx) {                              // ChoralRoot's own (Orchid) name, once it has played
    nameAsk--;
    const n = getP(cfg.slot, fx.comp + ':chord');
    if (n && n !== '-') { shownName = n; dirty = true; nameAsk = 0; }
  }
  if (dirty) { dirty = false; draw(); }
};
