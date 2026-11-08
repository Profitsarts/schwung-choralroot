// SPDX-License-Identifier: GPL-3.0-only
// node tests/pads_ui.test.mjs: drives pads/ui.js against a fake Schwung host
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = resolve(import.meta.dirname, '..', 'pads');
const dir = mkdtempSync(join(tmpdir(), 'crpads-'));
writeFileSync(join(dir, 'logic.mjs'), readFileSync(join(here, 'logic.mjs')));
writeFileSync(join(dir, 'ui.mjs'), readFileSync(join(here, 'ui.js'), 'utf8')
  .replace("'/data/UserData/schwung/modules/tools/choralroot-pads/logic.mjs'", "'./logic.mjs'"));

// fake host: slot 0 has ChoralRoot as MIDI FX 1, receive channel 1
const params = { '0:midi_fx1_module': 'choralroot', '0:slot:receive_channel': '1', '0:midi_fx1:mod_low': '48',
  '0:midi_fx1:mod_map': 'Semitones', '0:midi_fx1:key': 'Off', '0:midi_fx1:scale': 'Major' };
const sent = [], injected = [], leds = {}; let blocked = null, exited = false, files = {};
Object.assign(globalThis, {
  shadow_get_param: (s, k) => params[s + ':' + k] ?? null,
  shadow_set_param: (s, k, v) => { params[s + ':' + k] = v; return true; },
  shadow_set_param_timeout: (s, k, v) => { params[s + ':' + k] = v; return true; },
  shadow_send_midi_to_dsp: (m) => { sent.push(m); return true; },
  move_midi_inject_to_move: (p) => { injected.push(p); sent.push(p.slice(1)); return true; },
  move_midi_internal_send: (m) => { leds[m[2]] = m[3]; },
  host_pad_block: (b) => { blocked = b; },
  host_exit_module: () => { exited = true; },
  host_read_file: (p) => files[p] ?? null, host_write_file: (p, c) => { files[p] = c; return true; },
  clear_screen() {}, print() {}, fill_rect() {}, text_width: (t) => t.length * 5,
});
await import(pathToFileURL(join(dir, 'ui.mjs')));

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok: ' + m); };
const pad = (p, down) => onMidiMessageInternal([down ? 0x90 : 0x80, p, down ? 100 : 0]);
const cc = (c, v) => onMidiMessageInternal([0xB0, c, v]);

init(); tick();
ok(blocked === true, 'pads are taken from Move while open');
ok(params['0:midi_fx1:mod_low'] === '0', 'ChoralRoot chord zone moved to 0..7');
ok(params['0:midi_fx1:key'] === 'C', 'ChoralRoot key set to the pads key');
ok(leds[92] !== undefined && leds[99] !== undefined, 'all pads painted');

// Send To = Move (the default): notes go into Move as cable-2 external MIDI on the slot's channel
sent.length = 0;
pad(92, true); pad(70, true); pad(70, false); pad(92, false);
ok(JSON.stringify(injected) === JSON.stringify([[0x29, 0x90, 1, 100], [0x29, 0x90, 48, 100], [0x28, 0x80, 48, 0], [0x28, 0x80, 1, 0]]),
  'Send To Move: cable-2 packets into Move, MIN zone + C3, channel 1');

// Send To = Live: straight to the slot
cc(3, 127); for (let i = 0; i < 4; i++) cc(14, 1); cc(3, 127); cc(14, 1); cc(3, 127); cc(51, 127);
injected.length = 0;
// Momentary: MIN down, root C3 (pad 70), up
sent.length = 0;
pad(92, true); pad(70, true); pad(70, false); pad(92, false);
ok(JSON.stringify(sent) === JSON.stringify([[0x90, 1, 100], [0x90, 48, 100], [0x80, 48, 0], [0x80, 1, 0]]) && injected.length === 0,
  'Send To Live, momentary: zone MIN on, C3 on, C3 off, zone MIN off, channel 1, nothing into Move');

// Hold: Setup -> Chord Behaviour -> Hold
cc(3, 127);                                  // open setup
cc(14, 127);                                  // the cursor is still on Send To (row 4): one step up to Chord Behaviour
cc(3, 127); cc(14, 1); cc(3, 127); cc(51, 127); // edit, toggle, stop editing, close
sent.length = 0;
pad(92, true); pad(92, false);
ok(JSON.stringify(sent) === JSON.stringify([[0x90, 1, 100]]), 'hold: one tap latches MIN');
pad(92, true);
ok(JSON.stringify(sent.at(-1)) === JSON.stringify([0x80, 1, 0]), 'hold: second tap releases MIN');

// leaving releases everything and puts ChoralRoot back
pad(85, true); pad(71, true); sent.length = 0;
cc(51, 127);
ok(sent.some((m) => m[0] === 0x80 && m[1] === 50) && sent.some((m) => m[0] === 0x80 && m[1] === 5), 'leaving sends the offs');
ok(params['0:midi_fx1:mod_low'] === '48' && params['0:midi_fx1:key'] === 'Off', 'ChoralRoot settings restored');
ok(blocked === false && exited, 'pads given back and tool exited');
ok(JSON.parse(Object.values(files)[0]).behaviour === 'Hold', 'settings saved');
console.log(`\nALL PASS (${n})`);
