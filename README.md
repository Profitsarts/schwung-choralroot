# ChoralRoot para Ableton Move (Schwung)

El motor de acordes de [ChoralRoot FM-1](https://github.com/Quixotic7/ChoralRootFM1) (Quixotic7), que funciona al
estilo de un Orchid, convertido en un **MIDI FX de [Schwung](https://github.com/charlesvestal/schwung)** para
Ableton Move. Va delante de cualquier sinte del Signal Chain: una mano toca raíces y ocho notas dan forma al acorde.

> Independiente de Telepathic Instruments, M-VAVE, Ableton y el proyecto Schwung, y sin afiliación con ninguno de ellos.

## Qué hace

- **La zona de acordes** son 8 notas que funcionan como el bloque de acordes: **DIM MIN MAJ SUS / 6 m7 M7 9**.
  Por defecto son C3..G3 en semitonos. También se pueden poner en "White keys", 8 teclas blancas seguidas.
  Se mantienen pulsadas mientras tocas raíces.
- **Raíces:** cualquier otra nota es la raíz del acorde.
- **Voicing** (−12..12), **Key Mode** (tónica y mayor/menor), **Play Style** (Simple / Advanced / Free),
  **Bass** (Chords / Unison / Single / Solo) y **Sticky** (latch).
- **Perform:** Strum, Slop, Arp, Pattern y Harp, sincronizados con el tempo de Move.
- **Streams:** acorde (canal de entrada) y, como opción, bajo y acorde crudo, cada uno en su propio canal.
- `get_param("chord")` devuelve el nombre del acorde con la nomenclatura de ChoralRoot (por ejemplo `Am 7 9`).

## Páginas de knobs

| Página | Knobs 1-8 |
| --- | --- |
| ChoralRoot | Voicing, Perform, Key, Scale, Play Style, Bass, Sticky, Transpose |
| Perform | Rate, Division, Direction, Range, Gate, Swing, Pattern, Slop |
| Setup | Nota baja de la zona, Mapa de la zona, Octava del bajo, Canal del bajo, Raw, Canal raw, Seguir tempo, BPM |

Los parámetros de la página Perform son los del modo Perform activo.

## Compilar y probar

```sh
./scripts/test.sh     # pruebas en el host (cc)
./scripts/build.sh    # dsp.so aarch64 + dist/choralroot-module.tar.gz (gcc cruzado local o Docker)
```

Para instalarlo en el Move a mano, copia `dist/choralroot/` a `/data/UserData/schwung/modules/midi_fx/choralroot/`
(por SFTP a `move.local`). Después, en la Shadow UI, ponlo como MIDI FX delante de un sinte.

## Patches de cadena (listos para tocar)

Un *patch* de Schwung es un JSON que carga una cadena completa en un slot: MIDI FX → sinte → efectos.
Están en `chain_patches/`, y también dentro del tarball, en `choralroot/chain_patches/`.

| Patch | Cadena |
| --- | --- |
| ChoralRoot Poly Dreams | ChoralRoot (Strum) → OB-Xd preset 84 "Poly Dreams OB-Xd" → Freeverb |
| ChoralRoot Arp 80s | ChoralRoot (Arp 1/16, 2 octavas) → OB-Xd preset 0 "80ties Poly" → Freeverb |

**Requisito:** tener **OB-Xd** instalado (Schwung Manager → catálogo). Freeverb viene con Schwung.

**Cómo instalarlos:**
- Con `./scripts/install.sh`, que copia el módulo y los patches por SSH.
- A mano: copia los `.json` a `/data/UserData/schwung/patches/` por SFTP. Schwung Manager no copia patches al instalar un módulo.

**Cómo cargarlos:** en la Shadow UI, entra en un slot y abre el navegador de patches. Gira el jog para elegir y púlsalo para cargar.

## Limitaciones conocidas (v0.1)

- En los layouts isomórficos de Move (4as) la misma nota aparece en varios pads, así que la zona de acordes
  también suena en otros pads. Funciona mejor con un teclado externo o con un layout donde las notas no se
  repitan. Una superficie de pads propia es la fase 2.
- No hay pantalla propia todavía: solo las páginas de knobs.
- Los chord pads y el looper de ChoralRoot no están portados.

## Licencia

**GPL-3.0-only** (ver `LICENSE`).
- `vendor/choralroot/cr_engine.c/.h` es una copia sin cambios del motor de ChoralRoot FM-1 (Quixotic7; a su vez,
  un port de choralroot para monome grid). El commit de origen está en `vendor/choralroot/UPSTREAM_COMMIT`.
- `src/host/*.h` son las cabeceras del API de plugins de Schwung (MIT, Charles Vestal).
- Si distribuyes este módulo, tienes que acompañarlo de su código fuente bajo la misma licencia.
