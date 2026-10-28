# Doodle Dimension

Open https://slurms602.github.io/Rush-2049/?track=doodle-dimension and select
**Single Race → Marina (Track 1)**. To play with friends, host from the main menu
with **Online**, send the invite link, set PLAYERS to 2–4, and have each player
accept Just Play. Each player supplies their own game and BIOS.

The 7,243-foot layout reinterprets the owner's `track.jpg` as a midnight cartoon
raceway: quiet charcoal asphalt, a restrained teal/plum palette, subdued wave
patterns, a sculpted grinning mouth gateway, shark fins and curved grid arches.
Bright paper grids and giant repeating sky bubbles have been removed so the
road stays readable at speed. Color and contrast live mostly in the scenery,
road edges and small warm-metal accents.

Two optional wing jumps use the same pavement as the main circuit:

- **Shark’s Wake:** branch left after the opening grid arches, cross the inside
  of the lagoon bend and follow a broad curved landing deck back to the road.
- **Paperfold:** branch left on the descent before the final return bends and
  glide over the infield to the folded landing deck.

Small wing signs and sculpted guide fins mark the forks and flight corridors.
There are no green overlays, painted shortcut carpets or green landing posts.
Both routes skip bends without bypassing any of the six required checkpoints;
AI cars use the continuous main route. Carry speed and deploy wings (**K**).
`track.json` defines the editable layout, decks, openings and checkpoint gates.

`SOUNDTRACK.STR` is converted from the supplied `track.webm` to native stereo
44.1 kHz PCM16. It plays through the Dreamcast's normal music mixer, with no
browser music player. During this custom boot, all 18 native music selections
share the replacement stream, including menu music. Original mode restores the
original music. Only one copy of the audio occupies patched disc sectors.
The file and alias list form part of the verified online track fingerprint.

See ../../tools/trackbuilder/README.md for rebuilding. The root image and video
are source references; generated assets contain no original game or BIOS data.

Version 3 validation includes the native file/memory budgets, collision contact
planes, shortcut checkpoint legality and the absence of the green FLYMARK
texture. Fresh-boot driving tests cover the main route and both flying routes.

Fresh-boot validation completed the main lap and a lap using both shortcuts with
no falls or resets; the native HUD advanced to lap 2/3. Four-tire pavement contact
away from the intended jumps was 349/354 samples on the main route and 266/269
on the shortcut route. Finish crossings measured 3,880 driving frames for the
main lap and 3,713 for both shortcuts (about 2.8 seconds saved at 60 Hz).
Private evidence: `/tmp/rush-doodle-v3-main-c/` and
`/tmp/rush-doodle-v3-shortcuts-c/` on the build machine.
Two real browser clients also completed race entry, pause/resume and 4,446
lockstep frames with matching track fingerprints, zero desyncs and no automatic
resync. Evidence: `/tmp/rush-doodle-v3-online/` (private build-machine output).
