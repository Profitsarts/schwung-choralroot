/* SPDX-License-Identifier: GPL-3.0-only
 *
 * ChoralRoot for Schwung: the ChoralRoot FM-1 chord / performance engine (vendor/choralroot/cr_engine.c,
 * Quixotic7, GPL-3.0-only) wrapped as a Schwung MIDI FX (midi_fx_api_v1).
 *
 *   in : note on / off from Move's pads or an external keyboard. Eight notes (the "chord zone", from
 *        mod_low up) are the chord block DIM MIN MAJ SUS / 6 m7 M7 9; every other note is a root.
 *   out: the voiced chord (stream MAIN), optionally the bass (stream BASS) and the raw chord (stream RAW),
 *        each on its own MIDI channel, scheduled by cr_tick (strum, slop, arp, pattern, harp).
 *        usb_out = Copy / Only also sends those generated notes out of Move's external MIDI port (cable 2:
 *        USB-A devices and a computer on USB-C, "Ableton Move Standalone Port"), so Live can record them.
 *
 * Realtime rules (Schwung docs/MODULES.md "There is no control thread"): every entry point runs on the SPI
 * audio callback. Nothing here allocates after create_instance, does I/O or logs.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host/midi_fx_api_v1.h"
#include "host/plugin_api_v1.h"
#include "cr_engine.h"

/* ------------------------------------------------------------------ queue --- */
#define QN 512                                   /* power of two */
typedef struct { uint8_t b[3]; } qmsg_t;

typedef enum { MAP_SEMI = 0, MAP_WHITE = 1 } modmap_t;
typedef enum { USB_OFF = 0, USB_COPY = 1, USB_ONLY = 2 } usbout_t;
#define XN 512                                   /* power of two; USB-MIDI packets waiting for the host ring */
enum { PERF_OFF = 0 };                           /* perform enum: 0 Off, 1..5 = CR_PM_* + 1 */
enum { BASS_OFF = 0 };                           /* bass enum: 0 Off, 1..4 = CR_BASS_* + 1 */

typedef struct {
    cr_t cr;
    qmsg_t q[QN];
    uint32_t qh, qt;                             /* head (read), tail (write) */
    uint32_t q_dropped;

    /* external (USB) out: the host ring is 64 packets and drops the newest when full, so we keep our own
     * queue and only advance it on a packet the host accepted. A dropped note-off would hang in Live. */
    uint8_t xq[XN][4];
    uint32_t xh, xt;
    uint32_t x_dropped;
    int usb_out;
    uint64_t samples;
    int sr;

    /* routing */
    uint8_t in_ch;                               /* channel of the last note in (0..15) */
    int ch_bass, ch_raw;                         /* 0 = same as main, else 1..16 */
    int raw_on;

    /* settings mirrored for get_param / state */
    int mod_low, mod_map;
    int voicing, playstyle, perform, key, scale, bass, bass_oct, sticky, transpose;
    int sync_bpm, last_bpm;
    uint8_t zone_held[128];                      /* a zone note that went down as a mod (so its up is too) */
} inst_t;

static const host_api_v1_t *g_host;

/* ------------------------------------------------------------- helpers --- */
static void q_push(inst_t *in, uint8_t s, uint8_t d1, uint8_t d2)
{
    if (in->qt - in->qh >= QN) { in->q_dropped++; return; }
    qmsg_t *m = &in->q[in->qt & (QN - 1)];
    m->b[0] = s; m->b[1] = d1; m->b[2] = d2;
    in->qt++;
}

static int q_drain(inst_t *in, uint8_t out[][3], int lens[], int n, int max)
{
    while (n < max && in->qh != in->qt) {
        qmsg_t *m = &in->q[in->qh & (QN - 1)];
        out[n][0] = m->b[0]; out[n][1] = m->b[1]; out[n][2] = m->b[2];
        lens[n] = 3; n++; in->qh++;
    }
    return n;
}

static void x_push(inst_t *in, uint8_t s, uint8_t d1, uint8_t d2)
{
    uint8_t *p;
    if (in->xt - in->xh >= XN) { in->x_dropped++; return; }
    p = in->xq[in->xt & (XN - 1)];
    p[0] = (uint8_t)((2 << 4) | (s >> 4));       /* cable 2 (external), CIN = status high nibble */
    p[1] = s; p[2] = d1; p[3] = d2;
    in->xt++;
}

/* hand queued packets to the host until it refuses one; the rest wait for the next call */
static void x_flush(inst_t *in)
{
    if (!g_host || !g_host->midi_send_external) { in->xh = in->xt; return; }
    while (in->xh != in->xt) {
        if (g_host->midi_send_external(in->xq[in->xh & (XN - 1)], 4) <= 0) break;
        in->xh++;
    }
}

/* every generated message goes through here: to the next slot, to USB, or both */
static void emit(inst_t *in, uint8_t s, uint8_t d1, uint8_t d2)
{
    if (in->usb_out != USB_ONLY) q_push(in, s, d1, d2);
    if (in->usb_out != USB_OFF)  x_push(in, s, d1, d2);
}

static uint8_t stream_ch(const inst_t *in, cr_stream_t s)
{
    if (s == CR_STREAM_BASS && in->ch_bass) return (uint8_t)(in->ch_bass - 1);
    if (s == CR_STREAM_RAW && in->ch_raw) return (uint8_t)(in->ch_raw - 1);
    return in->in_ch;
}

/* The engine keeps a per-stream registry and pairs every off with its on, so a channel change while a note
 * sounds could strand it: we record the channel each note-on used. */
typedef struct { uint8_t ch[CR_NSTREAM][128]; } chmap_t;
static chmap_t *chmap_of(inst_t *in);

static void cb_on(void *ud, cr_stream_t s, uint8_t note, uint8_t vel)
{
    inst_t *in = (inst_t *)ud;
    uint8_t ch = stream_ch(in, s);
    chmap_of(in)->ch[s][note & 127] = ch;
    emit(in, (uint8_t)(0x90 | ch), note & 127, vel ? vel : 1);
}

static void cb_off(void *ud, cr_stream_t s, uint8_t note)
{
    inst_t *in = (inst_t *)ud;
    uint8_t ch = chmap_of(in)->ch[s][note & 127];
    emit(in, (uint8_t)(0x80 | ch), note & 127, 0);
}

static void cb_all(void *ud, cr_stream_t s)
{
    inst_t *in = (inst_t *)ud;
    emit(in, (uint8_t)(0xB0 | stream_ch(in, s)), 123, 0);
}

/* the chord zone: returns 0..7 (cr_mod_t) or -1 */
static int zone_mod(const inst_t *in, int note)
{
    static const int white_pc[7] = { 0, 2, 4, 5, 7, 9, 11 };
    if (in->mod_map == MAP_SEMI) {
        int d = note - in->mod_low;
        return (d >= 0 && d < CR_NMOD) ? d : -1;
    }
    /* eight consecutive white keys from mod_low (snapped up to a white key) */
    int start = in->mod_low, i, k = 0, n;
    while (start < 128) {
        int pc = start % 12, w = 0;
        for (i = 0; i < 7; i++) if (white_pc[i] == pc) w = 1;
        if (w) break;
        start++;
    }
    for (n = start; n < 128 && k < CR_NMOD; n++) {
        int pc = n % 12, w = 0;
        for (i = 0; i < 7; i++) if (white_pc[i] == pc) w = 1;
        if (!w) continue;
        if (n == note) return k;
        k++;
    }
    return -1;
}

/* ------------------------------------------------------------- settings --- */
static const char *PLAYSTYLE[] = { "Simple", "Advanced", "Free" };
static const char *PERFORM[]   = { "Off", "Strum", "Slop", "Arp", "Pattern", "Harp" };
static const char *KEYS[]      = { "Off", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
static const char *SCALES[]    = { "Major", "Minor" };
static const char *BASS[]      = { "Off", "Chords", "Unison", "Single", "Solo" };
static const char *ONOFF[]     = { "Off", "On" };
static const char *USBOUT[]    = { "Off", "Copy", "Only" };
static const char *MODMAP[]    = { "Semitones", "White keys" };
static const char *DIV[]       = { "2/1", "1/1", "1/2", "1/2T", "1/4", "1/4T",
                                   "1/8", "1/8T", "1/16", "1/16T", "1/32", "1/32T" };
static const char *DIR[]       = { "Up", "Down", "UpDown", "DownUp", "Played", "Random" };
#define NE(a) ((int)(sizeof(a) / sizeof((a)[0])))

static int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

/* an enum value from the host: its option index ("2", what the chain writes) or its label */
static int parse_enum(const char *val, const char **opts, int n, int cur)
{
    int i;
    char *end;
    long v;
    if (!val) return cur;
    for (i = 0; i < n; i++) if (strcmp(val, opts[i]) == 0) return i;
    v = strtol(val, &end, 10);
    if (end != val) return clampi((int)v, 0, n - 1);
    return cur;
}

static int parse_int(const char *val, int lo, int hi, int cur)
{
    char *end;
    double v;
    if (!val) return cur;
    v = strtod(val, &end);
    if (end == val) return cur;
    return clampi((int)(v < 0 ? v - 0.5 : v + 0.5), lo, hi);
}

static int cur_pmode(const inst_t *in) { return in->perform > 0 ? in->perform - 1 : CR_PM_STRUM; }

static void apply_voicing(inst_t *in, int v)
{
    v = clampi(v, -12, 12);
    cr_voicing_step(&in->cr, v - in->cr.voicing);
    in->voicing = in->cr.voicing;
}

static void apply_bass_oct(inst_t *in, int v)
{
    v = clampi(v, -2, 4);
    cr_bass_voicing_step(&in->cr, v - in->cr.bass_voicing);
    in->bass_oct = in->cr.bass_voicing;
}

static void apply_key(inst_t *in)
{
    cr_set_key(&in->cr, in->key > 0, (uint8_t)(in->key > 0 ? in->key - 1 : 0),
               in->scale ? CR_SCALE_MINOR : CR_SCALE_MAJOR);
}

static void apply_perform(inst_t *in)
{
    if (in->perform == PERF_OFF) cr_set_perform(&in->cr, 0);
    else { cr_set_perform_mode(&in->cr, (cr_pmode_t)(in->perform - 1)); cr_set_perform(&in->cr, 1); }
}

static void apply_bass(inst_t *in)
{
    if (in->bass == BASS_OFF) cr_set_bass(&in->cr, 0);
    else { cr_set_bass_mode(&in->cr, (cr_bassmode_t)(in->bass - 1)); cr_set_bass(&in->cr, 1); }
}

static void set_one(inst_t *in, const char *key, const char *val);

/* minimal reader for our own flat state object: {"k":v,"k2":"s",...} */
static void apply_state(inst_t *in, const char *json)
{
    const char *p = json;
    char k[32], v[32];
    while (p && *p) {
        const char *ks = strchr(p, '"'), *ke, *vs, *ve;
        size_t kl, vl;
        if (!ks) break;
        ke = strchr(ks + 1, '"');
        if (!ke) break;
        vs = ke + 1;
        while (*vs == ' ' || *vs == ':') vs++;
        if (*vs == '"') { vs++; ve = strchr(vs, '"'); if (!ve) break; p = ve + 1; }
        else { ve = vs; while (*ve && *ve != ',' && *ve != '}') ve++; p = ve; }
        kl = (size_t)(ke - ks - 1); vl = (size_t)(ve - vs);
        if (kl < sizeof k && vl < sizeof v && strncmp(ks + 1, "state", kl) != 0) {
            memcpy(k, ks + 1, kl); k[kl] = 0;
            memcpy(v, vs, vl); v[vl] = 0;
            set_one(in, k, v);
        }
    }
}

static void set_one(inst_t *in, const char *key, const char *val)
{
    int pm = cur_pmode(in);
    if (!strcmp(key, "voicing"))        apply_voicing(in, parse_int(val, -12, 12, in->voicing));
    else if (!strcmp(key, "playstyle")) { in->playstyle = parse_enum(val, PLAYSTYLE, NE(PLAYSTYLE), in->playstyle);
                                          cr_set_playstyle(&in->cr, (cr_playstyle_t)in->playstyle); }
    else if (!strcmp(key, "perform"))   { in->perform = parse_enum(val, PERFORM, NE(PERFORM), in->perform); apply_perform(in); }
    else if (!strcmp(key, "key"))       { in->key = parse_enum(val, KEYS, NE(KEYS), in->key); apply_key(in); }
    else if (!strcmp(key, "scale"))     { in->scale = parse_enum(val, SCALES, NE(SCALES), in->scale); apply_key(in); }
    else if (!strcmp(key, "bass"))      { in->bass = parse_enum(val, BASS, NE(BASS), in->bass); apply_bass(in); }
    else if (!strcmp(key, "bass_oct"))  apply_bass_oct(in, parse_int(val, -2, 4, in->bass_oct));
    else if (!strcmp(key, "sticky"))    { in->sticky = parse_enum(val, ONOFF, 2, in->sticky); cr_set_sticky(&in->cr, in->sticky); }
    else if (!strcmp(key, "transpose")) { in->transpose = parse_int(val, -24, 24, in->transpose);
                                          cr_set_transpose(&in->cr, in->transpose); }
    else if (!strcmp(key, "mod_low"))   in->mod_low = parse_int(val, 0, 120, in->mod_low);
    else if (!strcmp(key, "mod_map"))   in->mod_map = parse_enum(val, MODMAP, NE(MODMAP), in->mod_map);
    else if (!strcmp(key, "raw"))       { in->raw_on = parse_enum(val, ONOFF, 2, in->raw_on);
                                          cr_set_stream(&in->cr, CR_STREAM_RAW, in->raw_on); }
    else if (!strcmp(key, "ch_bass"))   in->ch_bass = parse_int(val, 0, 16, in->ch_bass);
    else if (!strcmp(key, "ch_raw"))    in->ch_raw = parse_int(val, 0, 16, in->ch_raw);
    else if (!strcmp(key, "usb_out"))   { int u = parse_enum(val, USBOUT, NE(USBOUT), in->usb_out);
                                          /* release what sounds under the old routing, so neither the slot
                                           * nor Live is left with a hanging note */
                                          if (u != in->usb_out) { cr_panic(&in->cr); in->usb_out = u; } }
    else if (!strcmp(key, "sync_bpm"))  in->sync_bpm = parse_enum(val, ONOFF, 2, in->sync_bpm);
    else if (!strcmp(key, "bpm"))       cr_set_tempo(&in->cr, parse_int(val, 20, 300, in->cr.bpm));
    /* the current perform mode's parameters */
    else if (!strcmp(key, "rate"))      cr_set_param(&in->cr, (cr_pmode_t)pm, CR_P_RATE, parse_int(val, 1, 1000, cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_RATE)));
    else if (!strcmp(key, "div"))       cr_set_param(&in->cr, (cr_pmode_t)pm, CR_P_DIV, parse_enum(val, DIV, NE(DIV), cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_DIV)));
    else if (!strcmp(key, "dir"))       cr_set_param(&in->cr, (cr_pmode_t)pm, CR_P_DIR, parse_enum(val, DIR, NE(DIR), cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_DIR)));
    else if (!strcmp(key, "range"))     cr_set_param(&in->cr, (cr_pmode_t)pm, CR_P_RANGE, parse_int(val, 1, 4, cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_RANGE)));
    else if (!strcmp(key, "gate"))      cr_set_param(&in->cr, (cr_pmode_t)pm, CR_P_GATE, parse_int(val, 1, 200, cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_GATE)));
    else if (!strcmp(key, "swing"))     cr_set_param(&in->cr, (cr_pmode_t)pm, CR_P_SWING, parse_int(val, 50, 90, cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_SWING)));
    else if (!strcmp(key, "pattern"))   cr_set_param(&in->cr, (cr_pmode_t)pm, CR_P_PATTERN, parse_int(val, 1, CR_NPATTERN, cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_PATTERN)));
    else if (!strcmp(key, "amount"))    cr_set_param(&in->cr, (cr_pmode_t)pm, CR_P_AMOUNT, parse_int(val, 0, 100, cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_AMOUNT)));
    else if (!strcmp(key, "panic"))     cr_panic(&in->cr);
    else if (!strcmp(key, "state"))     apply_state(in, val);
}

/* --------------------------------------------------------------- API --- */
typedef struct { inst_t in; chmap_t map; } box_t;
static chmap_t *chmap_of(inst_t *in) { return &((box_t *)in)->map; }

static void *fx_create(const char *module_dir, const char *config_json)
{
    box_t *b = (box_t *)calloc(1, sizeof *b);
    inst_t *in;
    cr_out_t out;
    (void)module_dir;
    if (!b) return NULL;
    in = &b->in;
    memset(&out, 0, sizeof out);
    out.note_on = cb_on; out.note_off = cb_off; out.all_off = cb_all; out.ud = in;
    cr_init(&in->cr, &out);
    cr_seed(&in->cr, 0x43524D56u);
    in->sr = 44100;
    in->mod_low = 48;                            /* C3: C3..G3 = DIM MIN MAJ SUS 6 m7 M7 9 */
    in->mod_map = MAP_SEMI;
    in->sync_bpm = 1;
    in->bass = BASS_OFF; apply_bass(in);
    in->raw_on = 0; cr_set_stream(&in->cr, CR_STREAM_RAW, 0);
    in->playstyle = in->cr.playstyle;
    if (config_json && *config_json) apply_state(in, config_json);
    return in;
}

static void fx_destroy(void *instance) { free(instance); }

static int fx_process_midi(void *instance, const uint8_t *msg, int len,
                           uint8_t out[][3], int lens[], int max)
{
    inst_t *in = (inst_t *)instance;
    uint8_t st, ty;
    if (!in || !msg || len < 1) return 0;
    st = msg[0]; ty = st & 0xF0;

    if ((ty == 0x90 || ty == 0x80) && len >= 3) {
        int note = msg[1] & 127, vel = msg[2] & 127;
        int down = (ty == 0x90 && vel > 0);
        int m;
        if (down) in->in_ch = st & 0x0F;
        m = zone_mod(in, note);
        if (m >= 0 && (down || in->zone_held[note])) {
            in->zone_held[note] = (uint8_t)down;
            cr_mod(&in->cr, (cr_mod_t)m, down);
        } else {
            cr_key(&in->cr, (uint8_t)note, (uint8_t)(vel ? vel : 64), down);
        }
        x_flush(in);
        return q_drain(in, out, lens, 0, max);
    }
    if (ty == 0xB0 && len >= 3 && (msg[1] == 123 || msg[1] == 120)) {
        cr_panic(&in->cr);
        x_flush(in);
        return q_drain(in, out, lens, 0, max);
    }
    /* everything else (CC, pitch bend, aftertouch, clock) passes through */
    if (max < 1) return 0;
    out[0][0] = msg[0]; out[0][1] = len > 1 ? msg[1] : 0; out[0][2] = len > 2 ? msg[2] : 0;
    lens[0] = len > 3 ? 3 : len;
    return 1;
}

static int fx_tick(void *instance, int frames, int sample_rate,
                   uint8_t out[][3], int lens[], int max)
{
    inst_t *in = (inst_t *)instance;
    if (!in) return 0;
    if (sample_rate > 0) in->sr = sample_rate;
    in->samples += (uint64_t)(frames > 0 ? frames : 0);
    if (in->sync_bpm && g_host && g_host->get_bpm) {
        float f = g_host->get_bpm();
        int bpm = (int)(f + 0.5f);
        if (bpm >= 20 && bpm <= 300 && bpm != in->last_bpm) {
            in->last_bpm = bpm;
            cr_set_tempo(&in->cr, bpm);
        }
    }
    cr_tick(&in->cr, (uint32_t)(in->samples * 1000u / (uint64_t)in->sr));
    x_flush(in);
    return q_drain(in, out, lens, 0, max);
}

static void fx_set_param(void *instance, const char *key, const char *val)
{
    inst_t *in = (inst_t *)instance;
    if (!in || !key) return;
    set_one(in, key, val);
}

static int fx_get_param(void *instance, const char *key, char *buf, int n)
{
    inst_t *in = (inst_t *)instance;
    int pm;
    if (!in || !key || !buf || n < 1) return -1;
    pm = cur_pmode(in);
    if (!strcmp(key, "voicing"))   return snprintf(buf, n, "%d", in->voicing);
    if (!strcmp(key, "playstyle")) return snprintf(buf, n, "%s", PLAYSTYLE[in->playstyle]);
    if (!strcmp(key, "perform"))   return snprintf(buf, n, "%s", PERFORM[in->perform]);
    if (!strcmp(key, "key"))       return snprintf(buf, n, "%s", KEYS[in->key]);
    if (!strcmp(key, "scale"))     return snprintf(buf, n, "%s", SCALES[in->scale]);
    if (!strcmp(key, "bass"))      return snprintf(buf, n, "%s", BASS[in->bass]);
    if (!strcmp(key, "bass_oct"))  return snprintf(buf, n, "%d", in->bass_oct);
    if (!strcmp(key, "sticky"))    return snprintf(buf, n, "%s", ONOFF[in->sticky]);
    if (!strcmp(key, "transpose")) return snprintf(buf, n, "%d", in->transpose);
    if (!strcmp(key, "mod_low"))   return snprintf(buf, n, "%d", in->mod_low);
    if (!strcmp(key, "mod_map"))   return snprintf(buf, n, "%s", MODMAP[in->mod_map]);
    if (!strcmp(key, "raw"))       return snprintf(buf, n, "%s", ONOFF[in->raw_on]);
    if (!strcmp(key, "ch_bass"))   return snprintf(buf, n, "%d", in->ch_bass);
    if (!strcmp(key, "ch_raw"))    return snprintf(buf, n, "%d", in->ch_raw);
    if (!strcmp(key, "sync_bpm"))  return snprintf(buf, n, "%s", ONOFF[in->sync_bpm]);
    if (!strcmp(key, "usb_out"))   return snprintf(buf, n, "%s", USBOUT[in->usb_out]);
    if (!strcmp(key, "bpm"))       return snprintf(buf, n, "%d", in->cr.bpm);
    if (!strcmp(key, "rate"))      return snprintf(buf, n, "%d", cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_RATE));
    if (!strcmp(key, "div"))       return snprintf(buf, n, "%s", DIV[clampi(cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_DIV), 0, NE(DIV) - 1)]);
    if (!strcmp(key, "dir"))       return snprintf(buf, n, "%s", DIR[clampi(cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_DIR), 0, NE(DIR) - 1)]);
    if (!strcmp(key, "range"))     return snprintf(buf, n, "%d", cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_RANGE));
    if (!strcmp(key, "gate"))      return snprintf(buf, n, "%d", cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_GATE));
    if (!strcmp(key, "swing"))     return snprintf(buf, n, "%d", cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_SWING));
    if (!strcmp(key, "pattern"))   return snprintf(buf, n, "%d", cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_PATTERN));
    if (!strcmp(key, "amount"))    return snprintf(buf, n, "%d", cr_get_param(&in->cr, (cr_pmode_t)pm, CR_P_AMOUNT));
    if (!strcmp(key, "chord")) {                 /* the shown chord, Orchid naming: "Cm 7 9" */
        cr_chord_info_t ci;
        cr_chord_info(&in->cr, &ci);
        if (!ci.valid) return snprintf(buf, n, "-");
        return snprintf(buf, n, "%s%s%s%s", ci.root, ci.qual, ci.sup[0] ? " " : "", ci.sup);
    }
    if (!strcmp(key, "state"))
        return snprintf(buf, n,
            "{\"voicing\":%d,\"playstyle\":%d,\"perform\":%d,\"key\":%d,\"scale\":%d,\"bass\":%d,"
            "\"bass_oct\":%d,\"sticky\":%d,\"transpose\":%d,\"mod_low\":%d,\"mod_map\":%d,\"raw\":%d,"
            "\"ch_bass\":%d,\"ch_raw\":%d,\"sync_bpm\":%d,\"usb_out\":%d}",
            in->voicing, in->playstyle, in->perform, in->key, in->scale, in->bass, in->bass_oct,
            in->sticky, in->transpose, in->mod_low, in->mod_map, in->raw_on, in->ch_bass, in->ch_raw,
            in->sync_bpm, in->usb_out);
    return -1;
}

static midi_fx_api_v1_t g_api = {
    .api_version = MIDI_FX_API_VERSION,
    .create_instance = fx_create,
    .destroy_instance = fx_destroy,
    .process_midi = fx_process_midi,
    .tick = fx_tick,
    .set_param = fx_set_param,
    .get_param = fx_get_param,
};

midi_fx_api_v1_t *move_midi_fx_init(const host_api_v1_t *host)
{
    g_host = host;
    return &g_api;
}
