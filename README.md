# Rush 2049 Online

San Francisco Rush 2049 (Dreamcast) in the browser, with online multiplayer for up to four
players. It's a Dreamcast emulator (Flycast compiled to WebAssembly, running in EmulatorJS)
plus lockstep netplay: every player runs their own copy of the game, and only controller
inputs travel between browsers. Nothing is installed, and no game files are hosted here.

Other Dreamcast games boot too, but online play has only been tested with Rush 2049.

## Custom tracks

Choose a circuit with the **Tracks** button, or open its link:

- [Chemical Circuit](https://slurms602.github.io/Rush-2049/?track=chemical-circuit):
  blue steel roads, orange pipe gantries, purple chemical pools, linked esses,
  three elevated crossovers and two wing jumps. The industrial artwork is original,
  inspired by the atmosphere of Sonic's Chemical Plant Zone.
- [Neon Skyway](https://slurms602.github.io/Rush-2049/?track=neon-skyway):
  a floating technical circuit with alternating turns, braking corners and a wing jump.

For either custom circuit, select **Single Race → Marina (Track 1)** in the game.
The selected circuit temporarily uses Marina's slot for that boot. Its files download
automatically; your game image is never modified. **Play original tracks** restores
the original disc content. Changing circuits restarts the game.

For friends, reach the game's main menu before hosting, then use **Online → Host an
online game**. The invite link includes the custom track selection. Each friend still
needs their own game and BIOS. Players with different track files cannot join the same
match. Set **PLAYERS** to 2–4 in the game's START GAME menu and accept **Just Play** on
each controller before selecting the race.

The custom mode uses Marina's slot; its original name and preview remain in the
game menu. A true seventh menu entry and a browser track editor are still future work.
Editable layouts and generated files are in [tracks/chemical-circuit/](tracks/chemical-circuit/)
and [tracks/neon-skyway/](tracks/neon-skyway/).
To build your own version, see the [track builder](tools/trackbuilder/README.md).

## What each player needs

- **Their own copy of the game**, the same disc image as the host. A `.gdi` set or a
  `.chd` made from it both work; scene rips (`.cdi`) usually differ from the original disc
  and will drift out of sync.
- **The Dreamcast BIOS**: `dc_boot.bin` and `dc_flash.bin`. Online play needs the real
  BIOS on every machine (the built-in replacement BIOS behaves differently).
- A desktop browser (Chrome, Edge or Firefox) and a controller or keyboard.

Files are read in your browser and never uploaded. Tick "Remember this game" and the
browser keeps a private copy, so next time it boots straight away.

## Playing online

1. **Host:** open the site, pick the game and BIOS files, press Start. Reach the game's
   main menu, then click **Online** in
   the top-right corner, then **Host an online game**, and send the link it shows to your
   friends.
2. **Friends:** open the link, pick their game and BIOS files, press Start. They join the
   room automatically.
3. A couple of seconds after a friend's game connects, the match starts by itself: everyone's
   game jumps to the host's current screen, and from then on all copies run in lockstep.
   Friends who join later are brought in the same way.

The input delay (at least 2 frames) follows everyone's ping during play; the host can also set
it with − / + in the Online panel. The panel shows each player's ping, whether the link is
direct or relayed, their fps and how long their PC takes per frame (it needs to stay under
16.7 ms). If a copy drifts out of sync, or a player stops responding for 5 seconds, the host's
game state is re-sent automatically. Everyone needs the same version of the page: if the
panel says a copy is out of date, reload with Ctrl+F5.

In a split-screen race each player sees only their own view, enlarged to fill the window
(the "Show all views" button switches back); menus, including the pause menu, show the whole
screen. Rush 2049's multiplayer starts from the START GAME menu: set PLAYERS to 2-4 with the
D-pad, then each player picks "Just Play".

Keep the game tab in front: a hidden tab pauses, and everyone waits for it.

## Controls

| Keys | Dreamcast |
|---|---|
| W A S D | Analog stick (steer) |
| Arrow keys | D-pad |
| J / K / L / I | A / B / X / Y |
| Q / E | L / R triggers (brake / gas) |
| Enter | Start |

Gamepads work automatically.

During a race, **E** accelerates, **Q** brakes and **K** deploys the wings. The **Down
arrow** cycles the camera; **Up arrow** aborts back to the road if you get stuck.

## Hosting the site

It's a static site. GitHub Pages works (free for public repositories); `coi-serviceworker.js`
supplies the cross-origin isolation headers the emulator needs. To run it on your own
machine instead:

```sh
python3 serve.py
```

## How it works

- `myview.js`: finds the split-screen race layout from the black gap between views and shows
  only this player's view (CSS transform + clip on the emulator canvas, 2x internal resolution).
- `netplay.js`: lockstep netplay over WebRTC data channels (PeerJS for connection setup,
  with its free public signalling and TURN servers). Each frame runs only after every
  player's input for that frame has arrived; inputs are sent a few frames ahead (the input
  delay) so the network round trip is hidden. Guests send inputs to each other directly and
  through the host; the first copy to arrive is used. Frames run on the system clock, one
  per display refresh, and the players' clocks are lined up so that everyone has the same
  headroom for late inputs. Every 2 seconds each guest sends a hash of its emulated RAM,
  VRAM and CPU state to the host, which re-sends its save state if they differ.
- `mods.js`: replaces files on the game disc as the emulator reads it (through a hook in the
  core), building the changes from each player's own disc, for custom content.
- `ejs/data/cores/flycast-wasm.data`: a rebuild of the flycast-wasm core that behaves
  identically on fast and slow machines. See [core-build/](core-build/README.md).
- `ejs/data/src/dc-patches.js`: glue between the page and EmulatorJS, including the
  main-loop hooks netplay uses to decide when each frame runs, and the core's audio worklet
  with rate control (online, sound follows the game clock by playing up to 0.5% faster or
  slower).

## Credits and licenses

- [Flycast](https://github.com/flyinghead/flycast) and
  [flycast-wasm](https://github.com/nasomers/flycast-wasm) (WebAssembly port and SH4 JIT
  by Nick Somers): GPLv2, `LICENSE-flycast.txt`.
- [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS): GPLv3, `ejs/LICENSE`.
- [Dreamcast Web](https://github.com/RhysFlores/dreamcast-web) by Rhys Flores: the
  launcher page, EmulatorJS glue, CUE→GDI conversion and libzip shim this is built on.
- [PeerJS](https://peerjs.com): MIT. [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker): MIT.

San Francisco Rush 2049 is © Midway Games. This project includes no game data.
