# Safari Simulator 3D — Project Notes

Inherits the global guidelines in `../CLAUDE.md` (commercial-grade code, always commit
and push after changes, bypass-permissions bash).

A fork of `../animal-game`, which is the same game rendered in three-quarter isometric.
The simulation is shared ancestry and should stay recognisable between the two; the
presentation layer is what diverged. **If you fix a gameplay bug here, check whether the
2D original has it too** — and prefer a fix that applies cleanly to both.

## Shape of the code

Classic scripts under one `Safari` namespace, loaded in dependency order by
`index.html`. No build tooling, and it runs from `file://`. Three.js is **vendored** at
`vendor/three.min.js` (r128) rather than pulled from a CDN: the screenshot harness loads
the page over `file://` with no network at all.

The division that matters is between the simulation and the drawing, not the file
order. `index.html` loads core and config, then the world (`TileWorld`, `Vegetation`,
`TimeSystem`, `Weather`), then the **3D presentation layer** (`src/r3d/`, marked by
`<!-- ===== 3D PRESENTATION LAYER ===== -->`), then the 2D portrait art, then the rest
of the simulation (`src/sim/` — animals, pathing, vehicles, the ranger, relocation,
events, goals, ecology), then the shell. That works because modules only resolve each
other when called, not when loaded; within `src/r3d/` the order is still a dependency
order (`R3D` → `Shading3D` → `Relief3D` → `Surface3D` → `Terrain3D` → `Horizon3D` → …).

The presentation layer only ever *reads* simulation state. Keeping that one-way is what
made the port tractable. If you find yourself wanting to write to `ecology.animals` or
to the tile world from `src/r3d/`, the design has gone wrong.

`src/sim/` keeps the 2D build's `Iso*` filenames and class names. The prefix means
*tile space*, not *isometric*, and holding the names identical is what lets a gameplay
change be diffed straight across to `../animal-game/src/iso/`.

Syntax-check every module without a browser:

```
for f in $(find src -name '*.js'); do node -e "new Function(require('fs').readFileSync('$f','utf8'))" || echo "$f"; done
```

## Things that will bite you

**Coordinates.** Tile `x` → world **X**, tile `y` → world **Z**, elevation → world **Y**.
One tile is one world unit; `R3D.HEIGHT` is world units per elevation level (relief is
exaggerated about threefold against the 2D build, or an 86-tile reserve looks flat in
perspective). Species rigs are authored in isometric screen pixels — `R3D.PX` converts,
and a tile is 45.25 of those.

**The camera looks north.** Yaw 0 sits on +Z looking −Z, so smaller tile `y` is
up-screen — the same orientation as the 2D game and the minimap. A model authored
nose-along-+X is oriented with `rotation.y = -facing`, because simulation headings
increase from +X toward +Z. Getting this backwards mirrors the reserve and is not
obvious from a screenshot.

**Colour space.** The renderer writes sRGB, so Three treats material and vertex colours
as already linear. Every hex in this project is picked by eye as sRGB and **must** go
through `R3D.col()`. Custom shaders are worse: they get no colour management at all, so
any hand-written fragment shader must end with `#include <tonemapping_fragment>` and
`#include <encodings_fragment>`. Missing those on the sky dome made three in the
afternoon look like dusk, and it was not obvious until the dome was measured.

**The frame is finished by `PostFX3D`.** The scene renders into a multisampled half-float
target with the renderer's tone mapping set to **none**; the full-screen pass applies
exposure (`LightingState.exposure`), a filmic curve, the hour's split-tone grade,
saturation, a vignette and dither. So materials must write *unmapped linear light* —
don't set `toneMappingExposure` or a tone-mapping mode anywhere else. If the device can't
render to half-float, the pass disables itself and the renderer falls back to linear tone
mapping straight to the screen. The pass also owns **dynamic resolution**: `adapt(dt)`
drops the render scale (to 0.6 at worst) when real frames run past ~21 ms and raises it
again when there is headroom, with a ceiling that stops it oscillating. The game is
fill-rate bound on integrated graphics, so this is what holds the frame rate there.

**Materials are extended in one way: `Shading3D.patch()`.** It splices GLSL against
Three's own `#include` anchors (throwing if an anchor is missing), keys the program cache,
and shares live uniforms — `uTime`, `uWind` and the tileable detail-noise texture
`uDetail` — by reference. `Shading3D.tick()` advances them once a frame. Every surface
takes its fine grain from that one noise texture, sampled in *world* space (the hides use
body space), so nothing ships a texture file. Built-in materials are Phong with a black or
near-black specular, not Lambert: in r128 Lambert is lit per vertex, which faceted every
coarse mesh and made per-pixel detail impossible.

**Ground state rides in as a texture.** `Terrain3D` keeps one texel per tile carrying
grazed-ness and burn, sampled by world position inside both the ground material and the
grass material. That is why grazing and fire keep working untouched — the simulation
writes its own arrays and the ground reads them. Any new material that should respond to
grazing has to sample the same overlay.

**The drawn ground is `Relief3D`, and water is shaped into it.** `R3D.surfaceY` samples a
grid (three points per tile, vertex-for-vertex with the terrain mesh) built once per
world; `R3D.groundY` is the simulation's raw elevation. Anything standing on the ground
uses `surfaceY`, which is why a hippo in a pool is submerged for free and no code
special-cases wading. Nothing in the simulation reads the relief.

Each pool is a flood-filled region of wet tiles with **one level: its spill height**, a
low percentile of the dry rim tiles around it. The ground is then shaped to hold that
level: the bed is cut down inside the footprint, and outside it a levee is raised by
distance from the footprint so the ground stands at the lip by the **crest** a tile out,
then falls away gently. Water is only drawn where `relief.holds(i, j)` — inside the crest
— and each grid triangle is clipped against the level, so the shoreline is the true
contour. Three earlier attempts failed, in order: a sheet at the ground under each vertex
(tilted pools, "lakes with mountains in them"); the level from the uncarved ground (a
basin depth too high, a film over every flat acre); the carve-weighted mean of the
ground (above the rim on every sloping pool, tile-edged sheets across the plain). The
smoke test asserts that every bank crest stands above its waterline. The relief is shaped
from the **undrawn** water field; a drought lowers `levelOf(pool)`, not the ground, so
shorelines recede down the banks.

**Shared geometry outlives a reserve.** Species rigs and item models are cached across
runs. `Scene3D.dispose()` must skip anything flagged `geometry.userData.shared` or
skinned, or the second run draws nothing. There is one `WebGLRenderer` for the life of
the page for the same class of reason: a context per reserve exhausts the browser's
supply within a dozen runs.

**Draw calls.** Everything is vertex-coloured and merged, with a handful of shared
materials: `R3D.solidMaterial()` for built things, the patched skinned material for every
animal, and one each for foliage, rock, grass, ground, horizon and water. One instanced
mesh per prop kind and variant, one for all the grass, one skinned mesh per animal.
Adding a per-object material would quietly undo that. The shadow map is refreshed at most
every other frame (`Scene3D._scheduleShadows`), and immediately whenever the view jumps.

**Foliage is cards over a core.** Bushes and acacia crowns are a polygonised inner mass
(textured from the atlas's solid swatch) wrapped in alpha-tested leaf cards from
`Shading3D.foliageTexture()`. Cards take the *clump's* normal, not their own, so a crown
shades as one volume. Anything alpha-tested that casts a shadow needs the matching
`customDepthMaterial` (map + alphaTest), or its shadow is a heap of squares.

**Hides are painted per pixel.** Markings are not vertex colours any more: every animal
vertex carries `aMark` (mark colour, kind) and `aMarkPos` (normalised body position,
frequency), and the shader patched onto the skinned material in
`Creature3D.hideMaterial()` draws zebra bands, giraffe cells, fawn dapples, tiger stripes,
leg bands and countershading from them. A plain `material.clone()` drops the patch — use
`Creature3D.cloneMaterial()` for the fading and ghost copies.

**Vehicles are animated from the outside.** The simulation moves a point with a heading
and speed; `Models3D.Vehicle3D` differentiates that frame to frame to put each wheel on
the ground, spring the body, squat, dive, lean and steer. It needs the real frame `dt`
(`Scene3D._frameDt`). Driving itself (`IsoVehicle.drive`) is rate-limited by speed, slows
for bends, and follows routes that `_straighten` has pulled taut with the same clearance
they were planned with.

**Bodies are implicit surfaces.** `Surface3D` builds a distance field from blended
primitives and polygonises it with surface nets. Anything that is one continuous mass on
a real animal belongs in the field, not in a separate mesh — intersecting ellipsoids
leave creases that read as visible seams from any angle the camera can reach. Two things
to know: the polygoniser writes in *field space* and ignores the builder's transform
stack, and quad winding is derived from the gradient normals rather than from the sign
of the crossing, because getting it wrong per axis silently culls half the faces and the
animal comes out full of holes.

**Anything that sits on the skin gets projected onto it.** `Field.project` casts a ray
from a point known to be *inside* the animal until it meets the surface; eyes, ears and
the crocodile's scutes are all placed that way. Positions worked out by arithmetic from
the rig end up buried, because the blend inflates the surface above the primitives it
was measured from — that is exactly how the crocodile came to have an armoured tail and
a bare back. Start the ray anywhere that might be outside and it finds no crossing at
all, and the feature hangs in the air beside the animal.

**A silhouette is made of masses, not spikes.** The lion's mane is a ring of overlapping
lumps *in the field* with short tufts over them. Built as long radiating strands it read
as a sea urchin; built as a smooth ruff it read as a bigger head. Both are worth
remembering when adding a feature whose whole job is to be recognised at distance.

**Faces need a jaw.** Barrel-neck-head-muzzle in a single blend is a monotonic taper
and every species comes out with the same snout. `Creature3D` adds a jaw ellipsoid on a
tight blend, paints nostrils and a mouth line onto the skin, and places eyes and ears by
`Field.project` — a ray cast from the *middle of the skull* outward. Start that ray
anywhere else and it can begin outside the surface, where it finds no crossing and the
feature ends up hanging in the air beside the head.

**The hippo's rig is authored for this build, not the 2D one.** `IsoSpecies.hippo` is the
one species that has diverged from `../animal-game`: its neck was thicker than its head,
which a flat projection hides and a blended surface does not. If a rig ever produces a
cone, check that the widths *increase* toward the muzzle.

**Trees are simulation state.** `Vegetation` owns the prop scatter and the foliage the
browsers eat, and lives in `src/world/`. `Flora3D` reads that list; it must never
scatter its own, or the trees the giraffes are eating and the trees you can see will be
different trees. Acacia crowns are a separate instanced mesh from their trunks purely so
browsing can scale them.

**The camera has a floor.** A free orbit pitched low near a rise puts the eye inside the
hill and the reserve turns inside out. `CameraRig._place` lifts the eye above
`surfaceY`; anything that repositions the camera has to go through it.

## Verification

Screenshots and a smoke test. Do not describe a visual change as done by reasoning when
you can capture it.

```
node scripts/shot.mjs            reserve, play, zebra, dusk, night, station
node scripts/shot.mjs dusk 18.4  one shot, at a given hour
node scripts/smoke.mjs           picking, orders, gait, footing, overlay, pools, driving,
                                 hides, second run
```

`scripts/shot.mjs` launches Chromium on the **real GPU** (ANGLE/D3D11 on Windows). The
shared `C:/Claude/Tools/shot/shot.mjs` launches with no flags and renders on SwiftShader,
which is slow and does not look like the game — the post pass, alpha-to-coverage and
shadow filtering all come out differently — so judge visuals with the project's script,
or a copy of it with the same launch arguments.

`window.SS3D` is the test hook — `begin({animals, hour, speed})`, `hour(h)`,
`cam(tx, ty, dist, yaw, pitch)`, `find(species, dist)`, `spawn`, `step(n, dt)`,
`draw()`, `play()`, `bare()`.

Performance is measured the same way, on the GPU, with `--disable-gpu-vsync
--disable-frame-rate-limit` and a 1-pixel `gl.readPixels` after each `draw()` to sync.
On this machine's Iris Xe at 1600×900 a stocked reserve renders in roughly 23–27 ms at
full resolution and ~18 ms at a 0.75 render scale; the numbers are noisy by ±2 ms, so
compare runs, not single samples.

`scripts/smoke.mjs` is the one that matters after touching input: the fork rewrote every
path between the pointer and the simulation, and none of it shows up in a screenshot. It
stops the game's ticker before asserting anything — the page's own frame loop used to
race it, and a run that reached its tenure mid-test made the shell ignore clicks, which
failed the input checks for a reason that had nothing to do with input. Any new check
should advance the world with `S.step()` and assert on what it asked for, not on a
snapshot of an animal that may have moved on.

## What is still 2D on purpose

- **Dock portraits.** `src/render/` holds `Painter`, `IsoCreatureArt`, `IsoSolid` and
  `IsoVehicleArt` solely so the dock can call `makePortrait`. They are good art doing a
  real job at 66 pixels; rendering thumbnails from the meshes would be more unified and
  less good.
- **Condition bars.** Drawn on `#overlay` over the render. Foreshortening them with the
  ground would be more immersive and harder to read.
- **The interface.** `styles/main.css` is carried over from the 2D build unchanged so
  interface changes diff across; this fork's additions live in `styles/three.css`.

`node_modules/` and `package-lock.json` are gitignored. `vendor/` is not: the vendored
Three.js is part of the app. `shots/` holds the committed reference captures that
`scripts/shot.mjs` writes; they are tracked in git but kept off Vercel by `.vercelignore`.

## Publishing

- **GitHub:** `jackpepper-vibe/safari-simulator-3d`
- **Vercel:** project `animal-game-3d`, live at https://animal-game-3d.vercel.app

The two names differ. Leave them as they are: renaming the Vercel project does not move
its `*.vercel.app` domain. The Vercel
project is Git-connected, so pushing to `main` deploys to production and nothing needs
a manual `vercel deploy`. There is no build step (`vercel.json` serves the repo root
as-is). After a deploy, check the live page's `<title>` is "Safari Simulator 3D": the
account's SSO protection returns a login page with status 200 on non-production URLs.
