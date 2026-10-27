# Doodle Dimension

Open https://slurms602.github.io/Rush-2049/?track=doodle-dimension and select
**Single Race → Marina (Track 1)**. To play with friends, host from the main menu
with **Online**, send the invite link, set PLAYERS to 2–4, and have each player
accept Just Play. Each player supplies their own game and BIOS.

The 7,243-foot layout and scenery draw from the owner's `track.jpg`: cream paper,
thick ink, blue grids, grinning creatures, a shark lagoon and acid-colored bubbles.
`track.json` is editable; the builder emits collision, six checkpoints, forward and
reverse AI paths, eight gold and eight silver coins, meshes and textures.

`SOUNDTRACK.STR` is converted from the supplied `track.webm` to native stereo
44.1 kHz PCM16. It plays through the Dreamcast's normal music mixer, with no
browser music player. During this custom boot, all 18 native music selections
share the replacement stream, including menu music. Original mode restores the
original music. Only one copy of the audio occupies patched disc sectors.
The file and alias list form part of the verified online track fingerprint.

See ../../tools/trackbuilder/README.md for rebuilding. The root image and video
are source references; generated assets contain no original game or BIOS data.

Validation of version 2: fresh-boot forward lap completed without falls or resets;
325/330 measured solid-road samples retained four-tire pavement contact. Native
emulator audio was captured and correlated against the supplied soundtrack.
Private runtime evidence is under `/tmp/rush-doodle-native-driving/` on the build
machine and is not part of this published package.
