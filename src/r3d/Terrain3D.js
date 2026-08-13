/**
 * Safari Simulator 3D — Terrain.
 *
 * The elevation field the tile world already computed, turned into actual relief. The
 * 2D build used that field to decide how to *shade* its benches; here it drives a mesh,
 * so the escarpments the herds path around are escarpments you can see over.
 *
 * Three surfaces:
 *
 *   Ground   one heightfield mesh, vertex-coloured from the same substrate rules the
 *            2D painter used, with pool basins carved into it.
 *   Water    a separate translucent surface at the uncarved height, so pools are
 *            volumes rather than paint.
 *   Overlay  a small data texture, sampled by world position inside the ground
 *            material, carrying what changes during a run: grazed-down pasture and
 *            burn scars. That is why grazing and fire keep working untouched — they
 *            write to the simulation, and the ground reads it.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Config, R3D } = Safari;

    /** Ground samples per tile. Three is enough to resolve a terraced riser. */
    const RES = 3;

    /** How far the map edge drops away, so the reserve has a rim rather than an edge. */
    const SKIRT = 6;

    /* ------------------------------------------------------------------ *
     * Palette
     * ------------------------------------------------------------------ */

    const GROUND = {
        lush: R3D.col('#5f8535'),
        grass: R3D.col('#82953f'),
        dry: R3D.col('#b3a55e'),
        dirt: R3D.col('#a8804c'),
        sand: R3D.col('#d0b787'),
        rock: R3D.col('#9a9184'),
        rockDark: R3D.col('#6d6558'),
        shore: R3D.col('#94824f'),
        bed: R3D.col('#5f5c3f')
    };

    const WORN = R3D.col('#9d8556');
    const BURNT = R3D.col('#2b2521');

    const _c = new THREE.Color();
    const _c2 = new THREE.Color();

    /**
     * Ground albedo at a point, before lighting.
     *
     * The same rules the 2D terrain painter used — substrate by moisture, rock by
     * height, a shoreline band around standing water — but evaluated per vertex and
     * blended rather than classified, so boundaries are organic curves and not tile
     * edges.
     *
     * @returns {THREE.Color} A scratch colour; copy it before the next call.
     */
    function groundColor(world, tx, ty) {
        const m = world.moistureAt(tx, ty);
        const grain = world.grainAt(tx, ty);
        const h = world.heightAt(tx, ty);
        const water = world.waterAt(tx, ty);

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

        // A drawn-down shoreline and then the bed itself.
        if (water > 0) {
            _c.lerp(GROUND.shore, MathUtils.clamp01(water * 3.5));
            _c.lerp(GROUND.bed, MathUtils.clamp01((water - 0.18) * 2.2));
        } else {
            const damp = MathUtils.smoothstep(0, 0.08,
                world.waterAt(tx + 1.2, ty) + world.waterAt(tx - 1.2, ty) +
                world.waterAt(tx, ty + 1.2) + world.waterAt(tx, ty - 1.2));
            if (damp > 0) _c.lerp(GROUND.shore, damp * 0.45);
        }

        // A touch of per-vertex variation so large flats are never one flat colour.
        const v = 1 + (grain - 0.5) * 0.14;
        _c.multiplyScalar(v);
        return _c;
    }

    /* ------------------------------------------------------------------ *
     * Terrain
     * ------------------------------------------------------------------ */

    class Terrain3D {
        /**
         * @param {Safari.TileWorld} world
         * @param {THREE.Scene} scene
         */
        constructor(world, scene) {
            this.world = world;
            this.scene = scene;
            this.size = world.size;

            this._buildOverlay();
            this._buildGround();
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

        _buildGround() {
            const w = this.world;
            const n = this.size;
            const verts = n * RES + 1;
            const step = 1 / RES;

            const positions = new Float32Array(verts * verts * 3);
            const normals = new Float32Array(verts * verts * 3);
            const colors = new Float32Array(verts * verts * 3);
            const indices = [];

            for (let j = 0; j < verts; j++) {
                const tz = j * step;
                for (let i = 0; i < verts; i++) {
                    const tx = i * step;
                    const k = (j * verts + i) * 3;

                    positions[k] = tx;
                    positions[k + 1] = R3D.surfaceY(w, tx, tz);
                    positions[k + 2] = tz;

                    // Analytic normal from the same surface function, which keeps the
                    // carved pool basins shaded correctly without a smoothing pass.
                    const d = step;
                    const ex = R3D.surfaceY(w, tx + d, tz) - R3D.surfaceY(w, tx - d, tz);
                    const ez = R3D.surfaceY(w, tx, tz + d) - R3D.surfaceY(w, tx, tz - d);
                    const nx = -ex, ny = 2 * d, nz = -ez;
                    const len = Math.hypot(nx, ny, nz) || 1;
                    normals[k] = nx / len;
                    normals[k + 1] = ny / len;
                    normals[k + 2] = nz / len;

                    const c = groundColor(w, tx, tz);
                    colors[k] = c.r;
                    colors[k + 1] = c.g;
                    colors[k + 2] = c.b;
                }
            }

            for (let j = 0; j < verts - 1; j++) {
                for (let i = 0; i < verts - 1; i++) {
                    const a = j * verts + i;
                    const b = a + 1;
                    const c = a + verts;
                    const d = c + 1;
                    indices.push(a, c, b, b, c, d);
                }
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            geo.setIndex(indices);
            geo.computeBoundingSphere();

            this.groundMaterial = this._groundMaterial();
            this.ground = new THREE.Mesh(geo, this.groundMaterial);
            this.ground.receiveShadow = true;
            this.ground.name = 'ground';
            this.scene.add(this.ground);

            this._buildSkirt();
        }

        /**
         * The ground material, patched to sample the overlay.
         *
         * Everything that changes about the ground during a run rides in through here,
         * which is the same trick the fog of war used in Iron Dominion 3D: leave the
         * simulation writing to its own arrays, and let the material read them.
         */
        _groundMaterial() {
            const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
            const n = this.size;

            mat.userData.uniforms = {
                uOverlay: { value: this.overlay },
                uOverlayScale: { value: 1 / n },
                uWorn: { value: WORN },
                uBurnt: { value: BURNT }
            };

            mat.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, mat.userData.uniforms);

                shader.vertexShader = 'varying vec2 vGroundXZ;\n' + shader.vertexShader
                    .replace('#include <begin_vertex>',
                        '#include <begin_vertex>\n' +
                        'vGroundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');

                shader.fragmentShader =
                    'varying vec2 vGroundXZ;\n' +
                    'uniform sampler2D uOverlay;\n' +
                    'uniform float uOverlayScale;\n' +
                    'uniform vec3 uWorn;\n' +
                    'uniform vec3 uBurnt;\n' + shader.fragmentShader
                        .replace('#include <color_fragment>',
                            '#include <color_fragment>\n' +
                            'vec4 groundOv = texture2D(uOverlay, vGroundXZ * uOverlayScale);\n' +
                            'diffuseColor.rgb = mix(diffuseColor.rgb, uWorn, groundOv.r * 0.75);\n' +
                            'diffuseColor.rgb = mix(diffuseColor.rgb, uBurnt, groundOv.g * 0.85);');
            };
            // Force a distinct program from any other Lambert material in the scene.
            mat.customProgramCacheKey = () => 'safari-ground';
            return mat;
        }

        /**
         * A wall around the reserve, dropping away from the boundary.
         *
         * Without it the map ends in a paper-thin edge you can see the sky through from
         * any low camera angle, which reads as a bug rather than as a boundary.
         */
        _buildSkirt() {
            const w = this.world;
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
                const top = R3D.surfaceY(w, x, z);
                positions.push(x, top, z, x, top - SKIRT, z);
                normals.push(nx, 0, nz, nx, 0, nz);
                colors.push(edge.r, edge.g, edge.b, deep.r, deep.g, deep.b);
            };

            // Four runs around the perimeter, each emitting a top and bottom vertex.
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
         * Only quads with water at a corner are emitted, so the mesh is a few hundred
         * triangles rather than the whole map, and the shoreline is the real edge of
         * the water field rather than a painted boundary.
         */
        _buildWater() {
            const w = this.world;
            const n = this.size;
            const step = 1 / RES;
            const verts = n * RES + 1;

            const positions = [];
            const colors = [];
            const indices = [];
            const map = new Int32Array(verts * verts).fill(-1);

            const shallow = R3D.col('#5f9fae');
            const deep = R3D.col('#245c70');

            const vertexAt = (i, j) => {
                const key = j * verts + i;
                if (map[key] >= 0) return map[key];
                const tx = i * step, tz = j * step;
                const idx = positions.length / 3;
                // The surface sits at the uncarved ground height: the basin below it is
                // what `surfaceY` removed, so the two meet exactly at the shoreline.
                positions.push(tx, R3D.groundY(w, tx, tz) + 0.015, tz);

                /*
                 * Alpha per vertex, so the water fades out rather than ending on a quad
                 * boundary. Without it the mesh has to stop somewhere, and wherever that
                 * is reads as a staircase — the shoreline is a smooth curve through a
                 * grid, and only transparency can express that.
                 */
                const depth = R3D.waterCarve(w, tx, tz);
                const d = MathUtils.clamp01(depth * 1.9);
                _c.copy(shallow).lerp(deep, d);
                colors.push(_c.r, _c.g, _c.b, MathUtils.clamp01(depth * 14));
                map[key] = idx;
                return idx;
            };

            const wet = (i, j) => R3D.waterCarve(w, i * step, j * step) > 0.004;

            // One ring of dry quads beyond the water, so the fade has somewhere to
            // happen instead of being clipped by the last wet vertex.
            const near = (i, j) => {
                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        if (wet(i + di, j + dj)) return true;
                    }
                }
                return false;
            };

            for (let j = 0; j < verts - 1; j++) {
                for (let i = 0; i < verts - 1; i++) {
                    if (!near(i, j) && !near(i + 1, j) && !near(i, j + 1) && !near(i + 1, j + 1)) {
                        continue;
                    }
                    const a = vertexAt(i, j);
                    const b = vertexAt(i + 1, j);
                    const c = vertexAt(i, j + 1);
                    const d = vertexAt(i + 1, j + 1);
                    indices.push(a, c, b, b, c, d);
                }
            }

            if (this.water) {
                this.scene.remove(this.water);
                this.water.geometry.dispose();
            }
            if (!indices.length) {
                this.water = null;
                return;
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            // Four components: the fourth is the shoreline fade.
            geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
            geo.setIndex(indices);
            geo.computeVertexNormals();
            geo.computeBoundingSphere();

            if (!this.waterMaterial) this.waterMaterial = this._waterMaterial();
            this.water = new THREE.Mesh(geo, this.waterMaterial);
            this.water.renderOrder = 1;
            this.scene.add(this.water);
        }

        /** Translucent, specular, and rippling — the ripple is a vertex displacement. */
        _waterMaterial() {
            const mat = new THREE.MeshPhongMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.86,
                // Enough sheen for the sun to walk across a pool at dusk, not enough to
                // blow the near shore out to white when the camera drops to the water.
                shininess: 60,
                specular: R3D.col('#6e8f9c'),
                depthWrite: false,
                side: THREE.DoubleSide
            });

            mat.userData.uniforms = { uTime: { value: 0 } };
            mat.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, mat.userData.uniforms);
                shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader
                    .replace('#include <begin_vertex>',
                        '#include <begin_vertex>\n' +
                        'float rip = sin(position.x * 3.1 + uTime * 1.7) * 0.5 +\n' +
                        '            sin(position.z * 2.6 - uTime * 1.3) * 0.5;\n' +
                        'transformed.y += rip * 0.018;\n' +
                        'objectNormal = normalize(objectNormal + vec3(\n' +
                        '   cos(position.x * 3.1 + uTime * 1.7) * 0.09, 0.0,\n' +
                        '   cos(position.z * 2.6 - uTime * 1.3) * 0.07));\n' +
                        'vNormal = normalize(normalMatrix * objectNormal);');
            };
            mat.customProgramCacheKey = () => 'safari-water';
            return mat;
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
            if (this.waterMaterial) {
                this.waterMaterial.userData.uniforms.uTime.value += dt;
            }

            this._overlayTimer -= dt;
            if (this._overlayTimer <= 0) {
                this._overlayTimer = 0.25;
                this.updateOverlay(now, burnt);
            }

            /*
             * A drought lowers every pool, which changes the shoreline. Rebuilding the
             * surface is a few hundred triangles and only happens when the drawdown has
             * actually moved, so the pools visibly shrink across a drought and refill
             * afterwards without the terrain being regenerated.
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
