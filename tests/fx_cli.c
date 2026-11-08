/* SPDX-License-Identifier: GPL-3.0-only */
/* A line-driven ChoralRoot MIDI FX, for the end-to-end Pads test (tests/pads_e2e.test.mjs).
 *   set <key> <value>   -> set_param
 *   get <key>           -> prints "get <key> <value>"
 *   midi <st> <d1> <d2> -> process_midi (decimal), prints "out <st> <d1> <d2>" for each note it plays
 *   tick <n>            -> n audio blocks of 128 frames, prints what they play */
#include <stdio.h>
#include <string.h>
#include "host/midi_fx_api_v1.h"
#include "host/plugin_api_v1.h"

midi_fx_api_v1_t *move_midi_fx_init(const host_api_v1_t *host);
static float get_bpm(void) { return 120.0f; }
static void dump(uint8_t o[][3], int n) { for (int i = 0; i < n; i++) printf("out %d %d %d\n", o[i][0], o[i][1], o[i][2]); }

int main(void)
{
    host_api_v1_t h; memset(&h, 0, sizeof h);
    h.sample_rate = 44100; h.frames_per_block = 128; h.get_bpm = get_bpm;
    midi_fx_api_v1_t *api = move_midi_fx_init(&h);
    void *fx = api->create_instance(".", NULL);
    uint8_t o[MIDI_FX_MAX_OUT_MSGS][3]; int l[MIDI_FX_MAX_OUT_MSGS];
    char line[512], a[128], b[256];
    while (fgets(line, sizeof line, stdin)) {
        int st, d1, d2, n;
        if (sscanf(line, "set %127s %255[^\n]", a, b) == 2) api->set_param(fx, a, b);
        else if (sscanf(line, "get %127s", a) == 1) { b[0] = 0; api->get_param(fx, a, b, sizeof b); printf("get %s %s\n", a, b); }
        else if (sscanf(line, "midi %d %d %d", &st, &d1, &d2) == 3) {
            uint8_t m[3] = { (uint8_t)st, (uint8_t)d1, (uint8_t)d2 };
            dump(o, api->process_midi(fx, m, 3, o, l, MIDI_FX_MAX_OUT_MSGS));
        } else if (sscanf(line, "tick %d", &n) == 1) while (n-- > 0) dump(o, api->tick(fx, 128, 44100, o, l, MIDI_FX_MAX_OUT_MSGS));
        fflush(stdout);
    }
    api->destroy_instance(fx);
    return 0;
}
