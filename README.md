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

En la página Setup, después de los 8 knobs, está **USB MIDI Out** (ver abajo).

## Con Ableton Live

Basta un cable USB-C **de datos** entre el Move y el ordenador. En Live el Move aparece como
**"Ableton Move Standalone Port"**. Es el único de sus puertos USB-C que llega a Schwung.

**Live → Move:** una pista MIDI de Live con *MIDI To* = Move Standalone Port, en el canal del slot
(1-4). ChoralRoot convierte sus notas en acordes y suena el sinte del slot. Los patches ya llevan
`"input": "both"`.

**Move → Live (USB MIDI Out):** Setup → USB MIDI Out.

| Valor | Qué hace |
| --- | --- |
| Off | Por defecto. Las notas generadas solo van al sinte del slot. |
| Copy | Las notas van al sinte **y** salen por USB, en los mismos canales. |
| Only | Solo salen por USB. El sinte del slot calla, para tocar un instrumento de Live. |

En Live, en una pista MIDI: *MIDI From* = Move Standalone Port, monitor In o Auto, y graba.

- Salen las notas **generadas** (acorde, bajo, raw, strum, arp…), no las teclas que tocas.
- La salida externa de Move es compartida, así que también llega a lo que tengas en el USB-A.
- **Evita bucles:** no devuelvas esa misma pista de Live al Move. Si Live envía y recibe del Move,
  usa canales distintos para cada dirección.
- Al cambiar USB MIDI Out se sueltan todas las notas, para que no se quede ninguna colgada.

## ChoralRoot Pads (tool estilo Orchid)

Un segundo módulo, de tipo **Tool**: convierte los 32 pads del Move en una superficie estilo Orchid
para tocar el ChoralRoot de un slot. Ábrelo desde el menú Tools de la Shadow UI.

| Pads | Qué hacen |
| --- | --- |
| Columna 1, de arriba abajo | MIN, MAJ, SUS, DIM: el tipo de tríada |
| Columna 2, de arriba abajo | 6, 7, maj7, 9: añaden una nota encima y se combinan con la columna 1 |
| Columnas 3 a 8 | 24 notas de la escala, de abajo a la izquierda hacia arriba, sin repetir |

Si no pulsas ningún pad de acorde, cada nota da el acorde de la escala (Key Mode).

- **Pantalla:** el acorde en el centro (nombre de ChoralRoot), tonalidad, modo y octava.
- **Arriba / Abajo:** octava.
- **Clic del jog:** Setup, con **Slot** (1-4), **Key**, **Scale**, **Chord Behaviour** y **Send To**. *Momentary*
  suena mientras mantienes el pad; *Hold* fija el pad con un toque y lo suelta con otro.
  Gira el jog para moverte, haz clic para editar y pulsa Back para cerrar.
- **Back:** sale del tool. Suelta todas las notas y deja ChoralRoot como estaba.

**Send To** decide por dónde van las notas:

| Send To | Camino | Grabar |
| --- | --- | --- |
| **Move** (por defecto) | Entran en el Move como MIDI externo, por el canal del slot. La pista del Move en ese canal las toca y, con su MIDI Out, las pasa al ChoralRoot del slot. | En el **secuenciador del Move**. El clip guarda las teclas de acorde (notas 0-7) y las raíces, y al reproducirlo ChoralRoot rehace los acordes. |
| **Live** | Van directas al slot de Schwung. El Move no las ve. | En **Live**, con USB MIDI Out = Copy u Only en ChoralRoot. |

Para **Move**, la pista tiene que recibir MIDI externo en el canal del slot y sacar su MIDI Out por
ese mismo canal (la configuración de 4 pistas con canales 1-4).

El slot elegido tiene que llevar ChoralRoot como MIDI FX. Mientras el tool está abierto, mueve la
zona de acordes de ChoralRoot a las notas 0-7 y le pone la misma tonalidad. Al salir lo restaura.

Abajo a la izquierda pone **linking...** hasta que ChoralRoot confirma que su zona de acordes ya está en
0-7 (tarda una fracción de segundo). Si pone **CHORD ZONE FAILED**, las columnas de acorde no van a
funcionar: sal con Back y vuelve a abrir el tool.

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

## Limitaciones conocidas (v0.3.1)

- En los layouts isomórficos de Move (4as) la misma nota aparece en varios pads, así que la zona de acordes
  también suena en otros pads. Funciona mejor con un teclado externo o con un layout donde las notas no se
  repitan, o con ChoralRoot Pads.
- No hay pantalla propia todavía: solo las páginas de knobs.
- ChoralRoot Pads está probado con un host simulado que imita el modo overtake de Schwung, conectado al
  motor ChoralRoot real compilado para el ordenador (`tests/pads_e2e.test.mjs`), todavía no en un Move real.
- Los chord pads y el looper de ChoralRoot no están portados.

## Licencia

**GPL-3.0-only** (ver `LICENSE`).
- `vendor/choralroot/cr_engine.c/.h` es una copia sin cambios del motor de ChoralRoot FM-1 (Quixotic7; a su vez,
  un port de choralroot para monome grid). El commit de origen está en `vendor/choralroot/UPSTREAM_COMMIT`.
- `src/host/*.h` son las cabeceras del API de plugins de Schwung (MIT, Charles Vestal).
- Si distribuyes este módulo, tienes que acompañarlo de su código fuente bajo la misma licencia.
