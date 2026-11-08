// SPDX-License-Identifier: GPL-3.0-only
// node tests/pads_e2e.test.mjs build/fx_cli
// End to end, without a Move: pads/ui.js runs against a fake Schwung host that behaves like overtake mode
// (shadow_set_param is fire-and-forget over ONE shared slot: only the last write before the host drains it
// lands), and every parameter write and MIDI message it makes is played into the real ChoralRoot MIDI FX,
// built for this machine (tests/fx_cli.c). It checks that the two chord columns really change the chord.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cli = process.argv[2] || 'build/fx_cli';
const here = resolve(import.meta.dirname, '..', 'pads');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok: ' + m); };

async function run(blocking) {
  const dir = mkdtempSync(join(tmpdir(), 'crpads-e2e-'));
  writeFileSync(join(dir, 'logic.mjs'), readFileSync(join(here, 'logic.mjs')));
  writeFileSync(join(dir, 'ui.mjs'), readFileSync(join(here, 'ui.js'), 'utf8')
    .replace("'/data/UserData/schwung/modules/tools/choralroot-pads/logic.mjs'", "'./logic.mjs'"));

  // the slot: ChoralRoot as MIDI FX 1, its own defaults (chord zone at C3 = 48), receive channel 1
  const fxp = { mod_low: '48', mod_map: 'Semitones', key: 'Off', scale: 'Major' };
  const script = [];
  const apply = (k, v) => { const key = k.replace(/^midi_fx1:/, ''); fxp[key] = v; script.push(`set ${key} ${v}`); };
  let pending = null;                                     // the ONE shared write slot of overtake mode
  const host = {
    shadow_get_param: (s, k) => {
      if (s !== 0) return null;
      if (k === 'midi_fx1_module') return 'choralroot';
      if (k === 'slot:receive_channel') return '1';
      if (k.startsWith('midi_fx1:')) return fxp[k.slice(9)] ?? null;
      return null;
    },
    shadow_set_param: (s, k, v) => { if (s === 0) pending = [k, v]; return true; },
    shadow_send_midi_to_dsp: (m) => { script.push(`midi ${m[0]} ${m[1]} ${m[2]}`); return true; },
    move_midi_inject_to_move: (p) => { script.push(`midi ${p[1]} ${p[2]} ${p[3]}`); return true; },
    move_midi_internal_send() {}, host_pad_block() {}, host_exit_module() {},
    host_read_file: () => null, host_write_file: () => true,
    clear_screen() {}, print() {}, fill_rect() {}, text_width: (t) => t.length * 5,
  };
  if (blocking) host.shadow_set_param_timeout = (s, k, v) => { if (s === 0) apply(k, v); return true; };
  for (const f of ['shadow_set_param_timeout']) delete globalThis[f];
  Object.assign(globalThis, host);
  await import(pathToFileURL(join(dir, 'ui.mjs')) + '?' + blocking);
  const hostTick = () => { if (pending) { apply(...pending); pending = null; } tick(); };
  const pad = (p, down) => onMidiMessageInternal([down ? 0x90 : 0x80, p, down ? 100 : 0]);
  const tag = blocking ? '[blocking writes] ' : '[one write per tick] ';

  init(); for (let i = 0; i < 20; i++) hostTick();
  ok(fxp.mod_low === '0' && fxp.key === 'C', tag + 'ChoralRoot zone moved to 0..7 and key = C, read back');

  const chords = [
    { name: 'MIN', pads: [92], want: [0, 3, 7], not: [4] },
    { name: 'MAJ', pads: [84], want: [0, 4, 7], not: [3] },
    { name: 'MAJ + 7', pads: [84, 85], want: [0, 4, 7, 10], not: [] },
    { name: 'MIN + maj7', pads: [92, 77], want: [0, 3, 11], not: [] },
    { name: 'SUS', pads: [76], want: [0, 5, 7], not: [3, 4] },
  ];
  const marks = [];
  for (const c of chords) {
    for (const p of c.pads) pad(p, true);
    script.push('mark ' + c.name); pad(70, true);       // root C3
    script.push('tick 4', 'get chord');
    pad(70, false); for (const p of c.pads) pad(p, false);
    script.push('tick 40');
    hostTick();
    marks.push(c);
  }
  const out = execFileSync(cli, { input: script.filter((l) => !l.startsWith('mark')).join('\n') + '\n' }).toString();
  // split the FX output by "get chord" answers: each chord's notes come before its answer
  const parts = out.split(/^get chord (.*)$/m);
  for (let i = 0; i < chords.length; i++) {
    const c = chords[i], seg = parts[i * 2], name = parts[i * 2 + 1];
    const on = [...seg.matchAll(/^out (\d+) (\d+) (\d+)$/gm)].filter((m) => (m[1] & 0xF0) === 0x90 && +m[3] > 0).map((m) => +m[2]);
    const pcs = new Set(on.map((x) => x % 12));
    ok(on.length >= 3 && c.want.every((p) => pcs.has(p)) && c.not.every((p) => !pcs.has(p)),
      `${tag}${c.name} + C3 plays ${[...pcs].sort((a, b) => a - b).join(',')} (chord "${name}")`);
    ok(on.every((x) => x >= 8), tag + c.name + ': no chord-pad note leaks out as a sound');
  }
  // a note pad on C3..G3 (the ChoralRoot default zone) must sound, not act as a chord key
  const offs = [...out.matchAll(/^out (\d+) (\d+) (\d+)$/gm)];
  ok(offs.length > 0, tag + 'ChoralRoot answered');
  onMidiMessageInternal([0xB0, 51, 127]);                // Back: leave
  for (let i = 0; i < 4; i++) hostTick();
  ok(fxp.mod_low === '48', tag + 'leaving gives ChoralRoot its zone back (C3)');
}

await run(true);
await run(false);
console.log(`\nALL PASS (${n})`);
