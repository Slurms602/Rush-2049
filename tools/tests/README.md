# Custom track checks

Run the format, download-integrity, installation and room-compatibility checks from the
repository root:

```sh
python3 -m unittest discover -s tools/tests -p 'test_*.py'
node --test tools/tests/*.test.js
```

The runtime checks use Playwright with Chromium and a local `serve.py` configured with
the owner's US v1.001 GDI and real BIOS. The driving check also needs Python with the
track builder dependencies. Keep output outside the repository: screenshots, logs and
save states may contain private game data.

```sh
node tools/tests/custom-track-drive.cjs http://localhost:8080/ /tmp/rush-driving
node tools/tests/custom-track-online.cjs http://localhost:8080/ /tmp/rush-online

# The URL chooses another circuit; both scripts default to Neon Skyway.
node tools/tests/custom-track-drive.cjs 'http://localhost:8080/?track=chemical-circuit' /tmp/rush-chemical-driving
node tools/tests/custom-track-online.cjs 'http://localhost:8080/?track=chemical-circuit' /tmp/rush-chemical-online

# Fly the optional shortcuts instead of following every main-road bend.
RUSH_SHORTCUTS=all node tools/tests/custom-track-drive.cjs 'http://localhost:8080/?track=neon-skyway' /tmp/rush-neon-shortcuts
RUSH_SHORTCUTS=all node tools/tests/custom-track-drive.cjs 'http://localhost:8080/?track=chemical-circuit' /tmp/rush-chemical-shortcuts

# Exercise resolution changes even when Chromium uses a software GPU. Ordinary
# software tests stay at low resolution and miss video reinitialization failures.
RUSH_TEST_HARDWARE_PATH=1 node tools/tests/custom-track-online.cjs 'http://localhost:8080/?track=neon-skyway' /tmp/rush-neon-hardware-online
RUSH_TEST_RESOLUTION_CYCLE=1 RUSH_SHORTCUTS=all node tools/tests/custom-track-drive.cjs 'http://localhost:8080/?track=chemical-circuit' /tmp/rush-chemical-resize

# Longer solo coverage, and Firefox on a Linux machine with software graphics.
RUSH_DRIVE_LAPS=3 node tools/tests/custom-track-drive.cjs 'http://localhost:8080/?track=chemical-circuit' /tmp/rush-chemical-full-race
LIBGL_ALWAYS_SOFTWARE=1 RUSH_TEST_BROWSER=firefox RUSH_TEST_HEADED=1 xvfb-run -a node tools/tests/custom-track-drive.cjs 'http://localhost:8080/?track=neon-skyway' /tmp/rush-firefox
```

The driving bot steers from the car's wheel positions in actual Dreamcast RAM. It must
complete a forward lap, cross the gap and remain at road altitude without respawning.
Every separate gap must be crossed. Its nearest-road lookup includes elevation so it
follows the correct branch at overpasses.
During intentional flight it holds neutral steering to keep the wings level.
Shortcut runs also require real airborne samples and a landing near the intended
rejoin at the correct elevation. Review the final HUD for lap 2/3: a proximity-based
lap counter alone cannot prove that the game's required checkpoints were accepted.
The route targets in `drive_route.py` only steer normal controls; they never set car
positions, velocity, materials or checkpoint state. Three-dimensional discontinuities
detect resets, including a car being returned upward from below the road.
It brakes for upcoming curves and records slip angle, tire materials and suspension
compression. Native material 0 is pavement; material 8 indicates a tire in the air.
Away from the jump and its settling runout, it requires four-tire pavement contact
in at least 95% of moving samples and rejects any flight with all four tires in air.
For private A/B runs, pass a third argument naming a bundle directory containing its
manifest, five files and `track.json`. `RUSH_DRIVE_MODE=grip` retains the original
full-throttle bot for comparisons on the same layout.
Review its screenshots to check rendering; position assertions cannot prove that a car
body is visible. The driving check also samples the central rendered scene during
each frame capture to reject a black 3D view even if car coordinates remain finite.

The online check opens two isolated browser contexts and connects them over WebRTC.
It reaches the main menu before sharing the first state, navigates both controllers
into a race, checks pause/resume and individual-view cropping, and requires matching
track fingerprints, no state-hash differences and no automatic resync. It also checks
that both cars are inside the elevated circuit's bounds. This does not cover four real
clients or a complete online race with human inputs.
Page exceptions (including numeric `Infinity`) and video-driver shutdown messages
fail the online check. Full browser console logs are retained privately for diagnosis.

## Doodle Dimension launch-speed checks

```sh
RUSH_SHORTCUTS=all RUSH_SHORTCUT_THROTTLE=1 node tools/tests/custom-track-drive.cjs 'http://localhost:8080/?track=doodle-dimension' /tmp/rush-doodle-fast
RUSH_SHORTCUTS=all RUSH_SHORTCUT_THROTTLE=0.75 node tools/tests/custom-track-drive.cjs 'http://localhost:8080/?track=doodle-dimension' /tmp/rush-doodle-moderate
```

These runs apply accelerator duty cycles through each approach, launch ramp
and actual flight (full throttle, or a 75% on/off duty cycle for slower coverage;
the emulator controller API exposes digital trigger presses). They never apply brakes there, and keep wings
deployed while airborne. Braking remains available on the ordinary circuit and
after landing. They require an actual airborne sample, a landing in the intended
runway, a complete legal lap with no resets, and a minimum takeoff speed scaled
by the requested throttle. Steering targets report approach/ramp/flight/landing
phases; all car motion still comes from ordinary controls and native physics.
