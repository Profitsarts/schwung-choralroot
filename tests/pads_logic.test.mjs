// SPDX-License-Identifier: GPL-3.0-only
// node tests/pads_logic.test.mjs: the pads' layout and chord-pad behaviour
import assert from 'node:assert/strict';
import * as L from '../pads/logic.mjs';

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok: ' + m); };

// layout A: column 1 top to bottom MIN MAJ SUS DIM, column 2 6 7 maj7 9 (top row = pads 92..99)
const col = (c) => [3, 2, 1, 0].map((r) => L.padRole(68 + r * 8 + c).id);
ok(col(0).join() === 'MIN,MAJ,SUS,DIM', 'column 1 = ' + col(0).join(' '));
ok(col(1).join() === '6,7,maj7,9', 'column 2 = ' + col(1).join(' '));
// each chord pad sends ChoralRoot's zone note for that mod (cr_mod_t DIM MIN MAJ SUS 6 m7 M7 9 = 0..7)
ok(L.padRole(92).zoneNote === L.ZONE_LOW + 1 && L.padRole(68).zoneNote === L.ZONE_LOW + 0, 'MIN -> zone 1, DIM -> zone 0');
ok(L.padRole(69).zoneNote === L.ZONE_LOW + 7 && L.padRole(85).zoneNote === L.ZONE_LOW + 5, '9 -> zone 7, 7 -> zone 5 (m7)');

// 24 note pads, scale notes rising from bottom-left, none repeated, all above the chord zone
const roots = [];
for (let p = 68; p <= 99; p++) { const r = L.padRole(p); if (r.kind === 'note') roots.push(L.rootNote(r.index, 0, 'Major', 0)); }
ok(roots.length === 24, '24 note pads');
ok(new Set(roots).size === 24, 'no note repeats on the grid');
ok(L.rootNote(L.padRole(70).index, 0, 'Major', 0) === 48, 'bottom-left note pad is C3 (48)');
ok(L.rootNote(L.padRole(71).index, 0, 'Major', 0) === 50, 'next pad is D3');
ok(L.rootNote(L.padRole(78).index, 0, 'Major', 0) === 50 + 9, 'second row starts on A3 (degree 6)');
ok(roots.every((x) => x > L.ZONE_LOW + 7), 'roots never fall in the chord zone');
ok(L.rootNote(0, 9, 'Minor', -2) === 48 - 24 + 9, 'A minor two octaves down starts on A1');

// Momentary: on while down; Hold: a press toggles, a release does nothing
const st = { held: new Set() }, MIN = L.padRole(92);
ok(JSON.stringify(L.chordPress(st, MIN, true, 'Momentary')) === JSON.stringify([[1, MIN.zoneNote]]), 'momentary down = on');
ok(JSON.stringify(L.chordPress(st, MIN, false, 'Momentary')) === JSON.stringify([[0, MIN.zoneNote]]), 'momentary up = off');
ok(L.chordPress(st, MIN, true, 'Hold')[0][0] === 1 && L.chordPress(st, MIN, false, 'Hold').length === 0, 'hold: press on, release nothing');
ok(st.held.has('MIN'), 'hold keeps MIN held');
ok(L.chordPress(st, MIN, true, 'Hold')[0][0] === 0 && !st.held.has('MIN'), 'hold: second press releases');
L.chordPress(st, MIN, true, 'Hold'); L.chordPress(st, L.padRole(85), true, 'Hold');
const rel = L.chordReleaseAll(st);
ok(rel.length === 2 && rel.every((e) => e[0] === 0) && st.held.size === 0, 'release all frees every held chord pad');

// names: key mode (no chord pad) gives the scale's own triad, chord pads override and combine
const H = (...a) => new Set(a);
ok(L.localChordName(48, H(), 0, 'Major') === 'C', 'C in C major = C');
ok(L.localChordName(50, H(), 0, 'Major') === 'Dm', 'D in C major = Dm');
ok(L.localChordName(59, H(), 0, 'Major') === 'Bdim', 'B in C major = Bdim');
ok(L.localChordName(57, H('MIN', '7'), 0, 'Major') === 'Am7', 'MIN + 7 = Am7');
ok(L.localChordName(48, H('MAJ', 'maj7'), 0, 'Major') === 'Cmaj7', 'MAJ + maj7 = Cmaj7');
ok(L.localChordName(57, H('MIN', '7', '9'), 0, 'Major') === 'Am9', 'MIN + 7 + 9 = Am9');
ok(L.pendingLabel(H('7', 'MIN')) === '. MIN 7', 'pending label lists chord pads in pad order');

// LEDs: held chord pads light up, pressed note pads flash
ok(L.padColour(92, H('MIN'), new Set()) === L.LED.chordOn, 'held chord pad lit');
ok(L.padColour(70, H(), new Set([70])) === L.LED.hit, 'pressed note pad lit');
ok(L.padColour(70, H(), new Set()) === L.LED.root, 'tonic pad white');

console.log(`\nALL PASS (${n})`);
