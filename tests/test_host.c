/* SPDX-License-Identifier: GPL-3.0-only */
/* Host test: drives the MIDI FX through its API as Schwung's chain does (process_midi, tick per 128 frames). */
#include <stdio.h>
#include <string.h>
#include "host/midi_fx_api_v1.h"
#include "host/plugin_api_v1.h"

midi_fx_api_v1_t *move_midi_fx_init(const host_api_v1_t *host);
static float bpm = 120.0f;
static float get_bpm(void) { return bpm; }

static int fails, ons, offs, maxburst;
static void count(uint8_t o[][3], int n, int verbose, const char *tag)
{
    int i;
    if (n > maxburst) maxburst = n;
    for (i = 0; i < n; i++) {
        int t = o[i][0] & 0xF0;
        if (t == 0x90 && o[i][2]) ons++;
        else if (t == 0x80 || t == 0x90) offs++;
        if (verbose) printf("  %s %02X %3d %3d\n", tag, o[i][0], o[i][1], o[i][2]);
    }
}
#define CHECK(c, ...) do { if (!(c)) { fails++; printf("FAIL: " __VA_ARGS__); printf("\n"); } else printf("ok: " __VA_ARGS__), printf("\n"); } while (0)

int main(void)
{
    host_api_v1_t h; memset(&h, 0, sizeof h);
    h.sample_rate = 44100; h.frames_per_block = 128; h.get_bpm = get_bpm;
    midi_fx_api_v1_t *api = move_midi_fx_init(&h);
    void *fx = api->create_instance(".", NULL);
    uint8_t o[MIDI_FX_MAX_OUT_MSGS][3]; int l[MIDI_FX_MAX_OUT_MSGS], n, i;
    char buf[256];

    /* 1. MAJ held (C3+2 = 50) + root C4 (60) -> a C major chord */
    uint8_t mod_on[3] = {0x90, 50, 100}, mod_off[3] = {0x80, 50, 0};
    uint8_t r_on[3] = {0x90, 60, 100}, r_off[3] = {0x80, 60, 0};
    n = api->process_midi(fx, mod_on, 3, o, l, MIDI_FX_MAX_OUT_MSGS); count(o, n, 1, "mod");
    CHECK(n == 0, "a modifier alone sounds nothing (got %d)", n);
    n = api->process_midi(fx, r_on, 3, o, l, MIDI_FX_MAX_OUT_MSGS); count(o, n, 1, "on ");
    CHECK(n >= 3, "root + MAJ -> chord notes (%d)", n);
    api->get_param(fx, "chord", buf, sizeof buf); printf("  chord: %s\n", buf);
    CHECK(buf[0] == 'C', "chord name starts with C (%s)", buf);
    n = api->process_midi(fx, r_off, 3, o, l, MIDI_FX_MAX_OUT_MSGS); count(o, n, 1, "off");
    for (i = 0; i < 50; i++) { n = api->tick(fx, 128, 44100, o, l, MIDI_FX_MAX_OUT_MSGS); count(o, n, 1, "tik"); }
    api->process_midi(fx, mod_off, 3, o, l, MIDI_FX_MAX_OUT_MSGS);
    CHECK(ons == offs, "every on has its off (%d / %d)", ons, offs);

    /* 2. MIN + m7 + 9 -> name */
    uint8_t m1[3] = {0x90, 49, 100}, m2[3] = {0x90, 53, 100}, m3[3] = {0x90, 55, 100};
    api->process_midi(fx, m1, 3, o, l, 16); api->process_midi(fx, m2, 3, o, l, 16); api->process_midi(fx, m3, 3, o, l, 16);
    uint8_t a_on[3] = {0x90, 57, 90};
    n = api->process_midi(fx, a_on, 3, o, l, 16); count(o, n, 1, "Am9");
    api->get_param(fx, "chord", buf, sizeof buf); printf("  chord: %s\n", buf);
    CHECK(strstr(buf, "A") == buf && strchr(buf, 'm'), "A minor family (%s)", buf);
    api->set_param(fx, "panic", "1");
    n = api->tick(fx, 128, 44100, o, l, 16); count(o, n, 0, "");
    for (i = 0; i < 10; i++) { n = api->tick(fx, 128, 44100, o, l, 16); count(o, n, 0, ""); }
    uint8_t mo[3];
    for (i = 48; i < 56; i++) { mo[0] = 0x80; mo[1] = (uint8_t)i; mo[2] = 0; api->process_midi(fx, mo, 3, o, l, 16); }
    uint8_t a_off[3] = {0x80, 57, 0}; api->process_midi(fx, a_off, 3, o, l, 16);

    /* 3. Strum: notes spread over ticks */
    api->set_param(fx, "perform", "Strum");
    api->set_param(fx, "rate", "60");
    api->get_param(fx, "perform", buf, sizeof buf); CHECK(!strcmp(buf, "Strum"), "perform = %s", buf);
    api->process_midi(fx, mod_on, 3, o, l, 16);
    n = api->process_midi(fx, r_on, 3, o, l, 16);
    int first = n, later = 0;
    for (i = 0; i < 200; i++) { n = api->tick(fx, 128, 44100, o, l, 16); later += n; count(o, n, 0, ""); }
    CHECK(first < 3 && later >= 2, "strum spreads the chord (now %d, later %d)", first, later);
    api->process_midi(fx, r_off, 3, o, l, 16); api->process_midi(fx, mod_off, 3, o, l, 16);
    for (i = 0; i < 400; i++) { n = api->tick(fx, 128, 44100, o, l, 16); count(o, n, 0, ""); }

    /* 4. Arp with enum written as index, synced to 140 BPM */
    bpm = 140.0f;
    api->set_param(fx, "perform", "3");
    api->get_param(fx, "perform", buf, sizeof buf); CHECK(!strcmp(buf, "Arp"), "perform index 3 = %s", buf);
    ons = offs = 0;
    api->process_midi(fx, mod_on, 3, o, l, 16); api->process_midi(fx, r_on, 3, o, l, 16);
    for (i = 0; i < 345; i++) { n = api->tick(fx, 128, 44100, o, l, 16); count(o, n, 0, ""); }   /* ~1 s */
    CHECK(ons >= 4, "arp steps in 1 s at 140 BPM: %d", ons);
    api->process_midi(fx, r_off, 3, o, l, 16); api->process_midi(fx, mod_off, 3, o, l, 16);
    for (i = 0; i < 400; i++) { n = api->tick(fx, 128, 44100, o, l, 16); count(o, n, 0, ""); }
    CHECK(ons == offs, "arp: every on has its off (%d / %d)", ons, offs);

    /* 5. state round trip + passthrough */
    api->set_param(fx, "voicing", "3"); api->set_param(fx, "key", "D"); api->set_param(fx, "bass", "Unison");
    api->get_param(fx, "state", buf, sizeof buf); printf("  state: %s\n", buf);
    void *fx2 = api->create_instance(".", buf);
    char b2[256]; api->get_param(fx2, "state", b2, sizeof b2);
    CHECK(!strcmp(buf, b2), "state round trip");
    uint8_t pb[3] = {0xE0, 0, 64};
    n = api->process_midi(fx, pb, 3, o, l, 16);
    CHECK(n == 1 && o[0][0] == 0xE0, "pitch bend passes through");
    printf("max burst %d (limit %d)\n", maxburst, MIDI_FX_MAX_OUT_MSGS);
    CHECK(maxburst <= MIDI_FX_MAX_OUT_MSGS, "never more than %d per call", MIDI_FX_MAX_OUT_MSGS);
    api->destroy_instance(fx); api->destroy_instance(fx2);
    printf(fails ? "\n%d FAILED\n" : "\nALL PASS\n", fails);
    return fails != 0;
}
