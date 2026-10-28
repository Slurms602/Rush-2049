# Doodle Dimension

Open https://slurms602.github.io/Rush-2049/?track=doodle-dimension and select
**Single Race → Marina (Track 1)**. To play with friends, host from the main menu
with **Online**, send the invite link, set PLAYERS to 2–4, and have each player
accept Just Play. Each player supplies their own game and BIOS.

The 7,212-foot main circuit uses the original colorful art direction from the
first release: bright blue-and-cream tiles, green/purple bubble skies, giant
illustrated grins, shark murals and grid arches inspired by `track.jpg`.

Two optional wing jumps continue along the incoming racing line:

- **Shark’s Wake:** stay on the diagonal where the opening westbound sweep
  turns away. A gentle takeoff crosses the infield onto a long, 180–200-foot-wide
  landing runway, which rejoins the upper return.
- **Paperfold:** continue down the outside descent as the main road bends
  right. A low takeoff and 200-foot-wide landing runway carry you past the bends,
  then sweep into the extended southern return.

Both decks use the main road’s colorful tile materials. There are no green
shortcut overlays or green landing posts. Flight corridors are kept clear of
murals and bubble props. Both routes retain all required checkpoints; AI cars
use the main circuit. Carry speed and deploy wings (**K**) over the gap.
`track.json` defines the layout, decks, openings and checkpoint gates.

`SOUNDTRACK.STR` is converted from the supplied `track.webm` to native stereo
44.1 kHz PCM16. It plays through the Dreamcast's normal music mixer, with no
browser music player. During this custom boot, all 18 native music selections
share the replacement stream, including menu music. Original mode restores the
original music. Only one copy of the audio occupies patched disc sectors.
The file and alias list form part of the verified online track fingerprint.

See ../../tools/trackbuilder/README.md for rebuilding. The root image and video
are source references; generated assets contain no original game or BIOS data.

Version 4 checks cover native file/memory budgets, collision contact planes,
checkpoint legality, the absence of FLYMARK overlays, and driving through the
launch approaches without braking. Runtime scenarios include full and reduced
shortcut throttle with wings held during flight, plus a complete main-route lap.

Fresh-boot driving completed a main-route lap and both shortcut scenarios with
no falls or resets; the native HUD advanced to lap 2/3. Four-tire pavement contact
away from the jumps was 336/339 samples on the main route, 185/187 at full shortcut
throttle, and 182/184 at 75% accelerator duty. No brakes were applied on either
launch approach. Takeoff speeds were 179/190 ft/s at full throttle and 161/175 ft/s
at reduced throttle (Shark’s Wake/Paperfold). These checks cover those tested
approach speeds with wings deployed, rather than every possible car or input.
Private evidence: `/tmp/rush-doodle-v4-{main,fast,moderate}-i/` on the build machine.

Two real browser clients also completed race entry, pause/resume and 4,420
lockstep frames on the final bundle, with matching fingerprints, zero desyncs
and no automatic resync. Evidence: `/tmp/rush-doodle-v4-online-i-retry/` (private).
