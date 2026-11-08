// SPDX-License-Identifier: GPL-3.0-only
// node tests/pads_find.test.mjs: ChoralRoot Pads finds ChoralRoot in whichever slot / MIDI FX position holds it
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = resolve(import.meta.dirname, '..', 'pads');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok: ' + m); };

async function load(params, tag) {
  const dir = mkdtempSync(join(tmpdir(), 'crpads-find-'));
  writeFileSync(join(dir, 'logic.mjs'), readFileSync(join(here, 'logic.mjs')));
  writeFileSync(join(dir, 'ui.mjs'), readFileSync(join(here, 'ui.js'), 'utf8')
    .replace("'/data/UserData/schwung/modules/tools/choralroot-pads/logic.mjs'", "'./logic.mjs'"));
  const out = { sent: [], screen: [] };
  Object.assign(globalThis, {
    shadow_get_param: (s, k) => params[s + ':' + k] ?? (k.endsWith('_module') ? '' : null),
    shadow_set_param: (s, k, v) => { params[s + ':' + k] = v; return true; },
    shadow_set_param_timeout: (s, k, v) => { params[s + ':' + k] = v; return true; },
    shadow_send_midi_to_dsp: (m) => { out.sent.push(m); return true; },
    move_midi_inject_to_move: (p) => { out.sent.push(p.slice(1)); return true; },
    move_midi_internal_send() {}, host_pad_block() {}, host_exit_module() {},
    host_read_file: () => null, host_write_file: () => true,
    clear_screen() { out.screen.length = 0; }, print(x, y, t) { out.screen.push(t); }, fill_rect() {},
    text_width: (t) => t.length * 5,
  });
  await import(pathToFileURL(join(dir, 'ui.mjs')) + '?' + tag);
  return out;
}

// 1. ChoralRoot is in slot 3, MIDI FX 2, written "ChoralRoot"; the tool starts on slot 1
{
  const p = { '2:midi_fx_count': '2', '2:midi_fx1_module': 'arp', '2:midi_fx2_module': 'ChoralRoot',
    '2:slot:receive_channel': '3', '2:midi_fx2:mod_low': '48', '2:midi_fx2:key': 'Off' };
  const out = await load(p, 'a');
  init(); tick();
  ok(p['2:midi_fx2:mod_low'] === '0', 'found in slot 3, MIDI FX 2 (any case), zone moved there');
  ok(out.screen.some((t) => t.startsWith('S3 ')), 'the screen says S3');
  out.sent.length = 0;
  onMidiMessageInternal([0x90, 92, 100]);
  ok(out.sent.length === 1 && out.sent[0][0] === 0x92, 'notes go out on the slot receive channel (3)');
  onMidiMessageInternal([0x80, 92, 0]);
}

// 2. nothing anywhere: the screen says what slot 1 holds; ChoralRoot added later is picked up
{
  const p = { '0:midi_fx1_module': 'arp' };
  const out = await load(p, 'b');
  init(); tick();
  ok(out.screen.includes('No ChoralRoot found') && out.screen.includes('S1 MIDI FX: arp'), 'not found: shows S1 MIDI FX: arp');
  p['0:midi_fx2_module'] = 'choralroot'; p['0:midi_fx2:mod_low'] = '48';
  for (let i = 0; i < 45; i++) tick();
  ok(p['0:midi_fx2:mod_low'] === '0', 'ChoralRoot loaded while the tool is open is found within a second');
}
console.log(`\nALL PASS (${n})`);
