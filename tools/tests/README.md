# Custom track checks

Run the format, download-integrity, installation and room-compatibility checks from the
repository root:

```sh
python3 -m unittest discover -s tools/tests -p 'test_*.py'
node --test tools/tests/custom-tracks.test.js
```

The runtime checks use Playwright with Chromium and a local `serve.py` configured with
the owner's US v1.001 GDI and real BIOS. The driving check also needs Python with the
track builder dependencies. Keep output outside the repository: screenshots, logs and
save states may contain private game data.

```sh
node tools/tests/custom-track-drive.cjs http://localhost:8080/ /tmp/rush-driving
node tools/tests/custom-track-online.cjs http://localhost:8080/ /tmp/rush-online
```

The driving bot steers from the car's wheel positions in actual Dreamcast RAM. It must
complete a forward lap, cross the gap and remain at road altitude without respawning.
Review its screenshots to check rendering; position assertions cannot prove that a car
body is visible.

The online check opens two isolated browser contexts and connects them over WebRTC.
It reaches the main menu before sharing the first state, navigates both controllers
into a race, checks pause/resume and individual-view cropping, and requires matching
track fingerprints, no state-hash differences and no automatic resync. It also checks
that both cars are inside the elevated circuit's bounds. This does not cover four real
clients or a complete online race with human inputs.
