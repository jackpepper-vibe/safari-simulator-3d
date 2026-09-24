/**
 * Safari Simulator 3D — Terrain.
 *
 * The elevation field the tile world already computed, turned into actual relief. The
 * 2D build used that field to decide how to *shade* its benches; here it drives a mesh,
 * so the escarpments the herds path around are escarpments you can see over.
 *
 * Three surfaces:
 *
 *   Ground   one heightfield mesh over the shaped relief (see Relief3D), vertex-coloured
 *            from the substrate rules the 2D painter used, with ambient occlusion baked
 *            in from the heightfield and from everything standing on it. Its material
 *            adds what a vertex grid a third of a tile across cannot carry: mottling,
 *            grain, a bump that catches low sun, and bare rock on anything steep.
 *   Water    one level surface per pool, clipped exactly to where the shaped ground is
 *            below it, and shaded as water rather than as tinted glass — depth-absorbed
 *            colour, a sky reflection that strengthens at grazing angles, a sun glint,
 *            and a lick of foam at the edge.
 *   Overlay  a small data texture, sampled by world position inside the ground
 *            material, carrying what changes during a run: grazed-down pasture and
 *            burn scars. That is why grazing and fire keep working untouched — they
 *            write to the simulation, and the ground reads it.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Config, R3D, Relief3D, Shading3D, Vegetation } = Safari;

    /** Ground samples per tile. Shared with the relief, vertex for vertex. */
    const RES = Relief3D.RES;

    /** How far the map edge drops away, so the reserve has a rim rather than an edge. */
    const SKIRT = 6;

    /* ------------------------------------------------------------------ *
     * Palette
     * ------------------------------------------------------------------ */

    const GROUND = {
        lush: R3D.col('#5b7d33'),
        grass: R3D.col('#7f9140'),
        dry: R3D.col('#b09f5c'),
        dirt: R3D.col('#a07a4a'),
        sand: R3D.col('#c9b083'),
        rock: R3D.col('#948b7e'),
        rockDark: R3D.col('#6a6255'),
        shore: R3D.col('#7f6f48'),
        bed: R3D.col('#4f4b35')
    };

    const WORN = R3D.col('#9a8155');
    const BURNT = R3D.col('#2b2521');
    const CLIFF = R3D.col('#8a7d6c');
    const CLIFF_DARK = R3D.col('#5e5448');

    /** Contact shadow radius under each kind of prop, in tiles at scale 1. */
    const PROP_SHADE = [];
    PROP_SHADE[Vegetation.PROP.ACACIA] = { radius: 1.35, depth: 0.34 };
    PROP_SHADE[Vegetation.PROP.BUSH] = { radius: 0.75, depth: 0.42 };
    PROP_SHADE[Vegetation.PROP.ROCK] = { radius: 0.62, depth: 0.40 };
    PROP_SHADE[Vegetation.PROP.MOUND] = { radius: 0.36, depth: 0.30 };

    const _c = new THREE.Color();
    const _c2 = new THREE.Color();

    /**
     * Ground albedo at a grid point, before lighting.
     *
     * The same rules the 2D terrain painter used — substrate by moisture, rock by
     * height, a shoreline band around standing water — but evaluated per vertex and
     * blended rather than classified, so boundaries are organic curves and not tile
     * edges. The shoreline and the bed are read from the shaped relief rather than from
     * the raw water field, so the wet band sits exactly at the waterline the pool is
     * drawn with.
     *
     * @param {Relief3D} relief
     * @returns {THREE.Color} A scratch colour; copy it before the next call.
     */
    function groundColor(world, relief, i, j) {
        const tx = i / RES, ty = j / RES;
        const m = world.moistureAt(tx, ty);
        const grain = world.grainAt(tx, ty);
        const h = world.heightAt(tx, ty);

        /*
         * Moisture drives the substrate ramp, jittered by the fine grain field so the
         * plain is mottled rather than banded.
         *
         * The ramp is biased upward against the raw field. Savanna is dry country, but
         * the first pass put the crossover at the middle of a field whose median *is*
         * the middle, which made two thirds of the reserve bare sand — a desert with
         * zebras on it. Pushing the thresholds down turns the same field into grassland
         * with dry ground in it, which is what the moisture map was describing.
         */
        const mm = MathUtils.clamp01(m + (grain - 0.5) * 0.16);

        if (mm < 0.22) _c.copy(GROUND.sand);
        else if (mm < 0.32) _c.copy(GROUND.sand).lerp(GROUND.dirt, (mm - 0.22) / 0.10);
        else if (mm < 0.42) _c.copy(GROUND.dirt).lerp(GROUND.dry, (mm - 0.32) / 0.10);
        else if (mm < 0.58) _c.copy(GROUND.dry).lerp(GROUND.grass, (mm - 0.42) / 0.16);
        else _c.copy(GROUND.grass).lerp(GROUND.lush, MathUtils.clamp01((mm - 0.58) / 0.24));

        /*
         * High ground weathers to bare rock, streaked by the grain field.
         *
         * The rock band starts lower than the gameplay threshold does. Seen in
         * perspective, a rise that is sand right up to its crown reads as a dune, and
         * the reserve grew a desert where it should have kopjes; bringing the stone
         * down the flanks is what makes them read as outcrops.
         */
        const rockLevel = Config.terrain.relief.rockLevel * Config.terrain.relief.maxHeight;
        const rocky = MathUtils.smoothstep(rockLevel * 0.42, rockLevel * 0.95, h);
        if (rocky > 0) {
            _c2.copy(GROUND.rock).lerp(GROUND.rockDark, MathUtils.clamp01(grain * 1.2));
            _c.lerp(_c2, rocky);
        }

        // The bed under the full pool, and a damp band up the bank above it.
        const pool = relief.poolAt(i, j);
        if (pool >= 0) {
            const below = relief.levels[pool] - relief.at(i, j);
            if (below > 0) {
                _c.lerp(GROUND.shore, MathUtils.clamp01(below * 12));
                _c.lerp(GROUND.bed, MathUtils.clamp01((below - 0.08) * 4));
            } else {
                _c.lerp(GROUND.shore, MathUtils.clamp01(1 + below * 5) * 0.55);
            }
        }

        // A touch of per-vertex variation so large flats are never one flat colour.
        _c.multiplyScalar(1 + (grain - 0.5) * 0.14);
        return _c;
    }

    /* ------------------------------------------------------------------ *
     * Terrain
     * ------------------------------------------------------------------ */

    class Terrain3D {
        /**
         * @param {Safari.TileWorld} world
         * @param {THREE.Scene} scene
         * @param {Array<object>} [props] Standing props, for their contact shadows.
         */
        constructor(world, scene, props) {
            this.world = world;
            this.scene = scene;
            this.size = world.size;
            this.relief = Relief3D.of(world);

            this._buildOverlay();
            this._buildGround(props || []);
            this._buildWater();

            this._drawdown = world.drawdown || 0;
            this._overlayTimer = 0;
        }

        /* -------------------------------------------------------------- *
         * The dynamic overlay
         * -------------------------------------------------------------- */

        /**
         * One texel per tile, carrying what a run changes about the ground.
         *
         * R  how far the pasture has been grazed down, 0 standing to 1 stripped.
         * G  burnt, 0 or 1.
         *
         * A texture rather than re-colouring vertices because the ground is a single
         * 67,000-vertex buffer: rewriting a colour attribute every time a zebra takes a
         * mouthful would push the whole thing back across the bus several times a
         * second, while this is seven thousand bytes.
         */
        _buildOverlay() {
            const n = this.size;
            this.overlayData = new Uint8Array(n * n * 4);
            this.overlay = new THREE.DataTexture(this.overlayData, n, n, THREE.RGBAFormat);
            this.overlay.minFilter = THREE.LinearFilter;
            this.overlay.magFilter = THREE.LinearFilter;
            this.overlay.wrapS = THREE.ClampToEdgeWrapping;
            this.overlay.wrapT = THREE.ClampToEdgeWrapping;
            this.overlay.needsUpdate = true;
        }

        /**
         * Refresh the overlay from the simulation.
         *
         * Cheap enough to do wholesale: the reserve is 86 tiles square, so this is one
         * pass over seven thousand texels a few times a second, against the alternative
         * of tracking which tiles changed.
         */
        updateOverlay(now, burnt) {
            const w = this.world;
            const n = this.size;
            const data = this.overlayData;

            for (let ty = 0; ty < n; ty++) {
                for (let tx = 0; tx < n; tx++) {
                    const k = ty * n + tx;
                    const fert = w.fertility[k];
                    let worn = 0;
                    if (fert > 0.05) {
                        // Only pasture can look grazed; bare sand always looked like this.
                        worn = MathUtils.clamp01(1 - w.grazeAt(tx, ty, now) / fert) *
                            MathUtils.clamp01(fert * 2.2);
                    }
                    data[k * 4] = (worn * 255) | 0;
                    data[k * 4 + 1] = (burnt && burnt.has(k)) ? 255 : 0;
                }
            }
            this.overlay.needsUpdate = true;
        }

        /* -------------------------------------------------------------- *
         * Ground
         * -------------------------------------------------------------- */

        _buildGround(props) {
            const w = this.world;
            const relief = this.relief;
            const V = relief.verts;
            const step = 1 / RES;

            const positions = new Float32Array(V * V * 3);
            const normals = new Float32Array(V * V * 3);
            const colors = new Float32Array(V * V * 3);
            const indices = new Uint32Array((V - 1) * (V - 1) * 6);

            const ao = this._occlusion(props);

            for (let j = 0; j < V; j++) {
                for (let i = 0; i < V; i++) {
                    const k = (j * V + i) * 3;
                    positions[k] = i * step;
                    positions[k + 1] = relief.at(i, j);
                    positions[k + 2] = j * step;

                    // Central differences over the shaped grid, which keeps carved pool
                    // beds and raised banks shaded correctly without a smoothing pass.
                    const il = Math.max(0, i - 1), ir = Math.min(V - 1, i + 1);
                    const jl = Math.max(0, j - 1), jr = Math.min(V - 1, j + 1);
                    const ex = (relief.at(ir, j) - relief.at(il, j)) / ((ir - il) * step);
                    const ez = (relief.at(i, jr) - relief.at(i, jl)) / ((jr - jl) * step);
                    const len = Math.hypot(ex, 1, ez);
                    normals[k] = -ex / len;
                    normals[k + 1] = 1 / len;
                    normals[k + 2] = -ez / len;

                    const c = groundColor(w, relief, i, j);
                    const o = ao[j * V + i];
                    colors[k] = c.r * o;
                    colors[k + 1] = c.g * o;
                    colors[k + 2] = c.b * o;
                }
            }

            let q = 0;
            for (let j = 0; j < V - 1; j++) {
                for (let i = 0; i < V - 1; i++) {
                    const a = j * V + i;
                    const b = a + 1;
                    const c = a + V;
                    const d = c + 1;
                    indices[q++] = a; indices[q++] = c; indices[q++] = b;
                    indices[q++] = b; indices[q++] = c; indices[q++] = d;
                }
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            geo.setIndex(new THREE.BufferAttribute(indices, 1));
            geo.computeBoundingSphere();

            this.groundMaterial = this._groundMaterial();
            this.ground = new THREE.Mesh(geo, this.groundMaterial);
            this.ground.receiveShadow = true;
            this.ground.name = 'ground';
            this.scene.add(this.ground);

            this._buildSkirt();
        }

        /**
         * Ambient occlusion, baked per grid point.
         *
         * Two sources, multiplied. The heightfield's own: how much of the sky each point
         * can see past the relief around it, which darkens the foot of every scarp and
         * the floor of every gully. And contact shade under everything standing on the
         * ground — a bush without the dark patch under it is floating, however well its
         * shadow is drawn, because the shadow moves with the sun and the patch does not.
         *
         * @returns {Float32Array} Multipliers, 1 fully open.
         */
        _occlusion(props) {
            const relief = this.relief;
            const V = relief.verts;
            const ao = new Float32Array(V * V);

            const DIRS = 8;
            const REACH = [2, 5, 10];   // in grid samples
            for (let j = 0; j < V; j++) {
                for (let i = 0; i < V; i++) {
                    const h = relief.at(i, j);
                    let occ = 0;
                    for (let d = 0; d < DIRS; d++) {
                        const a = (d / DIRS) * MathUtils.TAU;
                        const cx = Math.cos(a), cz = Math.sin(a);
                        let horizon = 0;
                        for (const r of REACH) {
                            const si = MathUtils.clamp(Math.round(i + cx * r), 0, V - 1);
                            const sj = MathUtils.clamp(Math.round(j + cz * r), 0, V - 1);
                            const rise = (relief.at(si, sj) - h) / (r / RES);
                            if (rise > horizon) horizon = rise;
                        }
                        occ += Math.atan(horizon) / (Math.PI / 2);
                    }
                    ao[j * V + i] = 1 - MathUtils.clamp01(occ / DIRS) * 0.85;
                }
            }

            for (const p of props) {
                const shade = PROP_SHADE[p.type];
                if (!shade) continue;
                const radius = shade.radius * p.scale;
                const i0 = Math.max(0, Math.floor((p.x - radius) * RES));
                const i1 = Math.min(V - 1, Math.ceil((p.x + radius) * RES));
                const j0 = Math.max(0, Math.floor((p.y - radius) * RES));
                const j1 = Math.min(V - 1, Math.ceil((p.y + radius) * RES));
                for (let j = j0; j <= j1; j++) {
                    for (let i = i0; i <= i1; i++) {
                        const d = Math.hypot(i / RES - p.x, j / RES - p.y) / radius;
                        if (d >= 1) continue;
                        const f = 1 - d;
                        ao[j * V + i] *= 1 - shade.depth * f * f;
                    }
                }
            }
            return ao;
        }

        /**
         * The ground material: the vertex colours, finished per pixel.
         *
         * Everything that changes about the ground during a run rides in through the
         * overlay, which is the same trick the fog of war used in Iron Dominion 3D:
         * leave the simulation writing to its own arrays, and let the material read
         * them. On top of that sits the detail the vertex grid cannot hold, all sampled
         * in world space from the one shared noise texture.
         */
        _groundMaterial() {
            const mat = new THREE.MeshPhongMaterial({
                vertexColors: true,
                specular: new THREE.Color(0, 0, 0),
                shininess: 1
            });
            mat.extensions = { derivatives: true };

            Shading3D.patch(mat, 'ground', {
                uniforms: {
                    uOverlay: { value: this.overlay },
                    uOverlayScale: { value: 1 / this.size },
                    uWorn: { value: WORN },
                    uBurnt: { value: BURNT },
                    uCliff: { value: CLIFF },
                    uCliffDark: { value: CLIFF_DARK }
                },
                vertexHead: 'varying vec3 vGroundW;\nvarying vec3 vGroundN;',
                vertex: [[
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\n' +
                    'vGroundW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n' +
                    'vGroundN = normalize(mat3(modelMatrix) * objectNormal);'
                ]],
                fragmentHead: [
                    'varying vec3 vGroundW;',
                    'varying vec3 vGroundN;',
                    'uniform sampler2D uOverlay;',
                    'uniform float uOverlayScale;',
                    'uniform vec3 uWorn;',
                    'uniform vec3 uBurnt;',
                    'uniform vec3 uCliff;',
                    'uniform vec3 uCliffDark;',
                    // Height of the ground's fine relief, for the bump: the grain, and
                    // the bedding planes on a cliff. One texture read.
                    'float groundRelief(vec4 b, float cliff) {',
                    '  return b.g * 0.5 + b.b * cliff * 0.9;',
                    '}',
                    // The overlay, read through a noise-warped, two-tap footprint so a
                    // grazed or burnt patch has a ragged organic edge, not a tile's.
                    'vec4 groundOverlay(vec2 p, vec4 d) {',
                    '  vec2 q = p + (d.rg - 0.5) * 1.8;',
                    '  return 0.5 * (texture2D(uOverlay, (q + vec2(0.45, 0.2)) * uOverlayScale) +',
                    '                texture2D(uOverlay, (q - vec2(0.45, 0.2)) * uOverlayScale));',
                    '}'
                ].join('\n'),
                fragment: [
                    ['#include <color_fragment>', [
                        '#include <color_fragment>',
                        'vec2 gp = vGroundW.xz;',
                        'vec4 d1 = detailAt(gp * 0.035);',
                        'vec4 d2 = detailAt(gp * 0.11);',
                        'vec4 d3 = detailAt(gp * 0.029 + 0.37);',
                        // Broad patches, then a finer grain; nothing finer than the eye
                        // can resolve at play distance, or it shimmers as the camera moves.
                        'diffuseColor.rgb *= 0.86 + 0.26 * d1.r;',
                        'diffuseColor.rgb *= 0.93 + 0.12 * d2.g;',
                        'diffuseColor.rgb *= 0.95 + 0.08 * d3.g;',
                        // Faces too steep to hold soil are bare, bedded rock.
                        'float slope = 1.0 - clamp(vGroundN.y, 0.0, 1.0);',
                        'float cliff = smoothstep(0.34, 0.58, slope + (d2.g - 0.5) * 0.18);',
                        // Bedding: thin dark partings between broad pale beds, their
                        // spacing and weight wandering with the noise so the face never
                        // reads as a barber's pole.
                        'float bed = vGroundW.y * 7.0 + d1.r * 5.0 + d2.b * 1.5;',
                        'float parting = smoothstep(0.82, 0.97, abs(sin(bed)));',
                        'vec3 rockCol = mix(uCliff, uCliffDark, parting * (0.35 + 0.4 * d2.g));',
                        'diffuseColor.rgb = mix(diffuseColor.rgb, rockCol * (0.88 + 0.24 * d2.b), cliff);',
                        'vec4 groundOv = groundOverlay(gp, d2);',
                        'float worn = smoothstep(0.1, 0.8, groundOv.r);',
                        'diffuseColor.rgb = mix(diffuseColor.rgb, uWorn * (0.9 + 0.2 * d2.g), worn * 0.7);',
                        'diffuseColor.rgb = mix(diffuseColor.rgb, uBurnt * (0.85 + 0.3 * d2.g),',
                        '    smoothstep(0.15, 0.6, groundOv.g) * 0.88);'
                    ].join('\n')],
                    ['#include <normal_fragment_maps>', [
                        '#include <normal_fragment_maps>',
                        // Bump from the relief's gradient, taken in world space by
                        // finite differences, so a low sun rakes across the grain of the
                        // ground. Screen-space derivatives would be cheaper and come out
                        // as a visible grid of 2x2 pixel blocks.
                        '{',
                        // Forward differences from the centre sample the colour pass
                        // already took: two extra reads rather than four.
                        '  float e = 0.22;',
                        '  float h0 = groundRelief(d2, cliff);',
                        '  float gx = groundRelief(detailAt((gp + vec2(e, 0.0)) * 0.11), cliff) - h0;',
                        '  float gz = groundRelief(detailAt((gp + vec2(0.0, e)) * 0.11), cliff) - h0;',
                        '  vec3 bumped = normalize(vGroundN - vec3(gx, 0.0, gz) * (0.5 / e));',
                        '  normal = normalize((viewMatrix * vec4(bumped, 0.0)).xyz);',
                        '}'
                    ].join('\n')]
                ]
            });
            return mat;
        }

        /**
         * A wall around the reserve, dropping away from the boundary.
         *
         * The horizon beyond now covers the edge from every angle the camera reaches,
         * but the wall stays as the backstop under it: a gap anywhere between the two
         * shows sky through the world, which reads as a bug rather than as distance.
         */
        _buildSkirt() {
            const relief = this.relief;
            const n = this.size;
            const edge = R3D.col('#8a7c63');
            const deep = R3D.col('#4a4136');

            const positions = [];
            const normals = [];
            const colors = [];
            const indices = [];
            const step = 1 / RES;
            const count = n * RES + 1;

            const emit = (x, z, nx, nz) => {
                const top = relief.heightAt(x, z);
                positions.push(x, top, z, x, top - SKIRT, z);
                normals.push(nx, 0, nz, nx, 0, nz);
                colors.push(edge.r, edge.g, edge.b, deep.r, deep.g, deep.b);
            };

            const runs = [
                { fx: (t) => t, fz: () => 0, nx: 0, nz: -1 },
                { fx: () => n, fz: (t) => t, nx: 1, nz: 0 },
                { fx: (t) => n - t, fz: () => n, nx: 0, nz: 1 },
                { fx: () => 0, fz: (t) => n - t, nx: -1, nz: 0 }
            ];

            for (const run of runs) {
                const base = positions.length / 3;
                for (let i = 0; i < count; i++) {
                    const t = i * step;
                    emit(run.fx(t), run.fz(t), run.nx, run.nz);
                }
                for (let i = 0; i < count - 1; i++) {
                    const a = base + i * 2;
                    indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
                }
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
            geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
            geo.setIndex(indices);
            geo.computeBoundingSphere();

            this.skirt = new THREE.Mesh(geo, R3D.solidMaterial());
            this.scene.add(this.skirt);
        }

        /* -------------------------------------------------------------- *
         * Water
         * -------------------------------------------------------------- */

        /**
         * The pool surfaces.
         *
         * **Water is level.** Each pool has one height (see Relief3D), and the surface is
         * cut from the terrain grid exactly where the shaped ground lies below it: every
         * grid triangle is clipped against the level, so the shoreline is the true
         * contour of the bank rather than a staircase of whole quads. The depth at each
         * corner rides along as an attribute, which is all the shader needs to fade the
         * edge, colour the deep water and throw foam on the shallows.
         */
        _buildWater() {
            const relief = this.relief;
            const V = relief.verts;
            const step = 1 / RES;

            const positions = [];
            const depths = [];

            // Scratch polygon for clipping one triangle.
            const px = new Float32Array(4), pz = new Float32Array(4), pd = new Float32Array(4);

            const emitTri = (level, ax, az, ad, bx, bz, bd, cx, cz, cd) => {
                // Sutherland–Hodgman against depth > 0, on a single triangle.
                const inX = [ax, bx, cx], inZ = [az, bz, cz], inD = [ad, bd, cd];
                let count = 0;
                for (let e = 0; e < 3; e++) {
                    const i0 = e, i1 = (e + 1) % 3;
                    const d0 = inD[i0], d1 = inD[i1];
                    if (d0 > 0) {
                        px[count] = inX[i0]; pz[count] = inZ[i0]; pd[count] = d0; count++;
                    }
                    if ((d0 > 0) !== (d1 > 0)) {
                        const t = d0 / (d0 - d1);
                        px[count] = inX[i0] + (inX[i1] - inX[i0]) * t;
                        pz[count] = inZ[i0] + (inZ[i1] - inZ[i0]) * t;
                        pd[count] = 0;
                        count++;
                    }
                }
                // Fan out in the input's order, which is the ground's upward winding.
                for (let k = 1; k + 1 < count; k++) {
                    positions.push(px[0], level, pz[0], px[k], level, pz[k],
                        px[k + 1], level, pz[k + 1]);
                    depths.push(pd[0], pd[k], pd[k + 1]);
                }
            };

            for (let j = 0; j < V - 1; j++) {
                for (let i = 0; i < V - 1; i++) {
                    let pool = relief.poolAt(i, j);
                    if (pool < 0) pool = relief.poolAt(i + 1, j + 1);
                    if (pool < 0) continue;
                    const level = relief.levelOf(pool);

                    // Only inside the bank's crest; beyond it is dry land by definition.
                    const depth = (ii, jj) => relief.holds(ii, jj)
                        ? level - relief.at(ii, jj) : -0.05;
                    const da = depth(i, j);
                    const db = depth(i + 1, j);
                    const dc = depth(i, j + 1);
                    const dd = depth(i + 1, j + 1);
                    if (da <= 0 && db <= 0 && dc <= 0 && dd <= 0) continue;

                    const x0 = i * step, x1 = (i + 1) * step;
                    const z0 = j * step, z1 = (j + 1) * step;
                    emitTri(level, x0, z0, da, x0, z1, dc, x1, z0, db);
                    emitTri(level, x1, z0, db, x0, z1, dc, x1, z1, dd);
                }
            }

            if (this.water) {
                this.scene.remove(this.water);
                this.water.geometry.dispose();
                this.water = null;
            }
            if (!positions.length) return;

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geo.setAttribute('aDepth', new THREE.Float32BufferAttribute(depths, 1));
            geo.computeBoundingSphere();

            if (!this.waterMaterial) this.waterMaterial = this._waterMaterial();
            this.water = new THREE.Mesh(geo, this.waterMaterial);
            this.water.renderOrder = 1;
            this.scene.add(this.water);
        }

        /**
         * Water, shaded as water.
         *
         * A custom shader rather than a patched Phong: nearly everything that makes water
         * look like water is view-dependent — how much sky it reflects, where the sun
         * glints — and none of it is diffuse lighting. It reads the hour's sky and the
         * key light, set each frame by `setLighting`.
         */
        _waterMaterial() {
            const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
                uZenith: { value: new THREE.Color() },
                uHorizon: { value: new THREE.Color() },
                uSunDir: { value: new THREE.Vector3(0, 1, 0) },
                uSunColor: { value: new THREE.Color() },
                uLight: { value: 1 },
                uShallow: { value: R3D.col('#4f8f94') },
                uDeep: { value: R3D.col('#173f4c') }
            }]);
            // The shared clock and detail texture are referenced, not merged, so they
            // stay live.
            uniforms.uTime = Shading3D.SHARED.uTime;
            uniforms.uWind = Shading3D.SHARED.uWind;
            uniforms.uDetail = Shading3D.SHARED.uDetail;
            Shading3D.detailTexture();

            return new THREE.ShaderMaterial({
                uniforms,
                transparent: true,
                depthWrite: false,
                fog: true,
                extensions: { derivatives: true },
                vertexShader: [
                    Shading3D.GLSL_COMMON,
                    'attribute float aDepth;',
                    'varying float vDepth;',
                    'varying vec3 vWorld;',
                    '#include <fog_pars_vertex>',
                    'void main() {',
                    '  vDepth = aDepth;',
                    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
                    '  wp.y += (sin(wp.x * 1.7 + uTime * 1.1) + sin(wp.z * 1.3 - uTime * 0.9)) * 0.005;',
                    '  vWorld = wp.xyz;',
                    '  vec4 mvPosition = viewMatrix * wp;',
                    '  gl_Position = projectionMatrix * mvPosition;',
                    '  #include <fog_vertex>',
                    '}'
                ].join('\n'),
                fragmentShader: [
                    Shading3D.GLSL_COMMON,
                    'uniform vec3 uZenith;',
                    'uniform vec3 uHorizon;',
                    'uniform vec3 uSunDir;',
                    'uniform vec3 uSunColor;',
                    'uniform float uLight;',
                    'uniform vec3 uShallow;',
                    'uniform vec3 uDeep;',
                    'varying float vDepth;',
                    'varying vec3 vWorld;',
                    '#include <fog_pars_fragment>',

                    // Two broad swells crossing at an angle: a pool is wind-ruffled, not
                    // boiling. The detail texture's grain channel, sampled large.
                    'float ripple(vec2 p) {',
                    '  float t = uTime * (0.5 + uWind * 0.4);',
                    '  return detailAt(p * 0.045 + vec2(t * 0.004, t * 0.0025)).g * 0.6 +',
                    '         detailAt(p.yx * 0.07 - vec2(t * 0.006, -t * 0.004)).g * 0.4;',
                    '}',

                    'void main() {',
                    '  vec2 p = vWorld.xz;',
                    '  float e = 0.12;',
                    '  float hx = ripple(p + vec2(e, 0.0)) - ripple(p - vec2(e, 0.0));',
                    '  float hz = ripple(p + vec2(0.0, e)) - ripple(p - vec2(0.0, e));',
                    '  float strength = 0.05 + uWind * 0.04;',
                    '  vec3 n = normalize(vec3(-hx * strength / e, 1.0, -hz * strength / e));',

                    '  vec3 v = normalize(cameraPosition - vWorld);',
                    '  float cosV = max(dot(n, v), 0.0);',
                    '  float fresnel = 0.03 + 0.97 * pow(1.0 - cosV, 5.0);',

                    '  vec3 r = reflect(-v, n);',
                    '  vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.6, r.y));',
                    '  float spec = pow(max(dot(r, uSunDir), 0.0), 320.0) * 5.0 +',
                    '               pow(max(dot(r, uSunDir), 0.0), 24.0) * 0.18;',

                    // Light is absorbed with depth: shallows show the bed, deep water
                    // goes dark teal.
                    '  float absorb = 1.0 - exp(-vDepth * 4.5);',
                    '  vec3 body = mix(uShallow, uDeep, absorb) * uLight;',
                    '  vec3 col = mix(body, sky, fresnel) + uSunColor * spec;',

                    // A thin lick of foam where the water meets the bank.
                    '  float edge = 1.0 - smoothstep(0.0, 0.05, vDepth);',
                    '  float froth = smoothstep(0.5, 0.8, detailAt(p * 0.35 + uTime * 0.01).b);',
                    '  col = mix(col, vec3(0.80, 0.80, 0.74) * uLight, edge * froth * 0.35);',

                    '  float alpha = clamp(0.45 + absorb * 0.5 + fresnel * 0.4, 0.0, 0.96);',
                    '  alpha *= smoothstep(0.0, 0.025, vDepth);',
                    '  gl_FragColor = vec4(col, alpha);',
                    '  #include <tonemapping_fragment>',
                    '  #include <encodings_fragment>',
                    '  #include <fog_fragment>',
                    '}'
                ].join('\n')
            });
        }

        /**
         * Hand the water the hour's sky and key light.
         *
         * @param {object} light The sampled `LightingState`.
         * @param {THREE.Vector3} keyDir Direction toward the key light (sun or moon).
         * @param {THREE.Color} keyColor The key light's colour times its intensity.
         */
        setLighting(light, keyDir, keyColor) {
            if (!this.waterMaterial) return;
            const u = this.waterMaterial.uniforms;
            const top = light.sky[0].c;
            const low = light.sky[light.sky.length - 1].c;
            u.uZenith.value.setRGB(top.r / 255, top.g / 255, top.b / 255).convertSRGBToLinear();
            u.uHorizon.value.setRGB(low.r / 255, low.g / 255, low.b / 255).convertSRGBToLinear();
            u.uSunDir.value.copy(keyDir);
            u.uSunColor.value.copy(keyColor);
            u.uLight.value = 0.25 + light.sunStrength * 0.85;
        }

        /* -------------------------------------------------------------- *
         * Frame
         * -------------------------------------------------------------- */

        /**
         * @param {number} dt Real seconds.
         * @param {number} now Simulated seconds, for grass regrowth.
         * @param {Set<number>} [burnt] Burnt tile indices.
         */
        update(dt, now, burnt) {
            this._overlayTimer -= dt;
            if (this._overlayTimer <= 0) {
                this._overlayTimer = 0.25;
                this.updateOverlay(now, burnt);
            }

            /*
             * A drought lowers every pool, which changes the shoreline. The surface is
             * re-cut from the same shaped ground, so the pools visibly shrink down their
             * banks across a drought and refill afterwards.
             */
            const draw = this.world.drawdown || 0;
            if (Math.abs(draw - this._drawdown) > 0.015) {
                this._drawdown = draw;
                this._buildWater();
            }
        }

        dispose() {
            for (const m of [this.ground, this.skirt, this.water]) {
                if (!m) continue;
                this.scene.remove(m);
                m.geometry.dispose();
            }
            this.overlay.dispose();
        }
    }

    Terrain3D.RES = RES;
    Terrain3D.groundColor = groundColor;
    Safari.Terrain3D = Terrain3D;

})(window.Safari, window.THREE);
