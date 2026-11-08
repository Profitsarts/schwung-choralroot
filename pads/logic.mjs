// SPDX-License-Identifier: GPL-3.0-only
//
// ChoralRoot Pads: the pure part (no host calls), so it can be tested with node.
//
// Layout A, as approved on the mockup. Pads are notes 68..99, bottom-left to top-right, 4 rows of 8.
//   column 1, top to bottom: MIN  MAJ  SUS  DIM      (the triad)
//   column 2, top to bottom: 6    7    maj7 9        (a note on top; they combine with column 1)
//   columns 3..8: 24 scale notes (Chromatic: two octaves of semitones), rising from bottom-left row by row, no repeats.
//
// The pads do not run a chord engine of their own. They play the ChoralRoot MIDI FX in a Schwung slot:
// a chord pad sends that slot's chord-zone note, a note pad sends a root. ZONE_LOW moves the chord
// zone to MIDI 0..7, below every root, so roots and chord keys never meet.

export const PAD_LO = 68, PAD_HI = 99;
export const ZONE_LOW = 0;

// cr_engine's chord block order (cr_mod_t): DIM MIN MAJ SUS 6 m7 M7 9 -> zone offsets 0..7
export const MOD = { DIM: 0, MIN: 1, MAJ: 2, SUS: 3, SIX: 4, SEV: 5, MAJ7: 6, NINE: 7 };

// [column][row from top]
const CHORD_GRID = [
  [{ id: 'MIN', mod: MOD.MIN }, { id: 'MAJ', mod: MOD.MAJ }, { id: 'SUS', mod: MOD.SUS }, { id: 'DIM', mod: MOD.DIM }],
  [{ id: '6', mod: MOD.SIX }, { id: '7', mod: MOD.SEV }, { id: 'maj7', mod: MOD.MAJ7 }, { id: '9', mod: MOD.NINE }],
];
export const CHORD_ORDER = ['MIN', 'MAJ', 'SUS', 'DIM', '6', '7', 'maj7', '9'];

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = { Major: [0, 2, 4, 5, 7, 9, 11], Minor: [0, 2, 3, 5, 7, 8, 10],
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
export const SCALE_ORDER = ['Major', 'Minor', 'Chromatic'];
export const SCALE_SHORT = { Major: 'MAJ', Minor: 'MIN', Chromatic: 'CHR' };
export const BEHAVIOURS = ['Momentary', 'Hold'];

export function isPad(n) { return n >= PAD_LO && n <= PAD_HI; }

/** row 0 = bottom, col 0 = left */
export function padPos(n) { const i = n - PAD_LO; return { row: Math.floor(i / 8), col: i % 8 }; }

/** what a pad is: { kind: 'chord', id, mod, zoneNote } or { kind: 'note', index } */
export function padRole(n) {
  const { row, col } = padPos(n);
  if (col < 2) {
    const c = CHORD_GRID[col][3 - row];
    return { kind: 'chord', id: c.id, mod: c.mod, zoneNote: ZONE_LOW + c.mod, col };
  }
  return { kind: 'note', index: row * 6 + (col - 2) };
}

/** the root a note pad plays. key 0..11, octave shift -2..+2; index 0 is the key's root in octave 3 (C3 = 48) */
export function rootNote(index, key, scale, octave) {
  const sc = SCALES[scale] || SCALES.Major;
  const n = 48 + 12 * octave + key + 12 * Math.floor(index / sc.length) + sc[index % sc.length];
  return n > 127 ? -1 : n < ZONE_LOW + 8 ? -1 : n;
}

/** Hold (toggle) or Momentary. Returns the note events for the zone: [[on 1|0, zoneNote]] */
export function chordPress(state, role, down, behaviour) {
  const ev = [];
  if (behaviour === 'Hold') {
    if (!down) return ev;
    if (state.held.has(role.id)) { state.held.delete(role.id); ev.push([0, role.zoneNote]); return ev; }
    // one per column: a new triad replaces the held triad, a new extension the held extension
    for (const c of CHORD_GRID[role.col] || []) {
      if (c.id !== role.id && state.held.has(c.id)) { state.held.delete(c.id); ev.push([0, ZONE_LOW + c.mod]); }
    }
    state.held.add(role.id); ev.push([1, role.zoneNote]);
    return ev;
  }
  if (down && !state.held.has(role.id)) { state.held.add(role.id); ev.push([1, role.zoneNote]); }
  if (!down && state.held.has(role.id)) { state.held.delete(role.id); ev.push([0, role.zoneNote]); }
  return ev;
}

/** releases everything a chord state holds */
export function chordReleaseAll(state) {
  const ev = [];
  for (const id of CHORD_ORDER) {
    if (!state.held.has(id)) continue;
    const r = CHORD_GRID.flat().find((c) => c.id === id);
    ev.push([0, ZONE_LOW + r.mod]);
  }
  state.held.clear();
  return ev;
}

/** "· MIN 7": what is armed, before a root */
export function pendingLabel(held) {
  const ids = CHORD_ORDER.filter((id) => held.has(id));
  return ids.length ? '. ' + ids.join(' ') : '';
}

/** A readable local name, used until (or if) the slot's ChoralRoot reports its own. */
export function localChordName(root, held, key, scale) {
  const sc = SCALES[scale] || SCALES.Major;
  let name = '';
  const triad = ['MIN', 'MAJ', 'SUS', 'DIM'].some((t) => held.has(t));
  if (!triad && sc.length === 7) {
    // Key mode: the scale's own triad on that degree (Chromatic has no Key mode: ChoralRoot plays the root alone)
    const pc = ((root - key) % 12 + 12) % 12, deg = sc.indexOf(pc);
    if (deg >= 0) {
      const at = (k) => { const i = deg + k; return sc[i % 7] + 12 * Math.floor(i / 7) - sc[deg]; };
      const t = at(2), f = at(4);
      name = t === 3 ? (f === 6 ? 'dim' : 'm') : '';
    }
  }
  if (held.has('MAJ')) name = '';
  if (held.has('MIN')) name = 'm';
  if (held.has('DIM')) name = 'dim';
  if (held.has('SUS')) name += 'sus4';
  if (held.has('6')) name += '6';
  if (held.has('7')) name += '7';
  if (held.has('maj7')) name += name.endsWith('m') ? '(maj7)' : 'maj7';
  if (held.has('9')) name += (held.has('7') || held.has('maj7')) ? '9' : 'add9';
  if (held.has('7') && held.has('9')) name = name.replace('79', '9');
  return NOTE_NAMES[root % 12] + name;
}

/** LED colour index (Move palette) for each pad, given what is held and pressed */
export const LED = { chordA: 3, chordB: 6, chordOn: 8, root: 120, scale: 15, hit: 5, off: 0 };
export function padColour(n, held, pressed, scale) {
  const r = padRole(n);
  if (r.kind === 'chord') {
    if (held.has(r.id)) return LED.chordOn;
    return padPos(n).col === 0 ? LED.chordA : LED.chordB;
  }
  if (pressed.has(n)) return LED.hit;
  return r.index % (SCALES[scale] || SCALES.Major).length === 0 ? LED.root : LED.scale;
}
