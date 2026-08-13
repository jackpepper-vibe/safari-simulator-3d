/**
 * Safari Simulator 3D — Vegetation and terrain props.
 *
 * Two populations, handled differently because they differ by orders of magnitude — the
 * same split the 2D build made, for the same reason.
 *
 *   Large props (acacias, scrub, boulders, termite mounds) are scattered once by the
 *   rule the 2D painter used, so a given seed still grows its trees in the same places.
 *   Each kind is built in a few variants and drawn as instanced geometry: the whole
 *   reserve's woodland is a handful of draw calls.
 *
 *   Ground cover is tens of thousands of tufts. They are one instanced mesh whose
 *   vertex shader does the work — sway from the wind, and shrinking away where the
 *   ground has been grazed down, sampled from the same overlay texture the terrain
 *   reads. That is what makes a herd's damage visible without anything being rebuilt.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Rng, Config, Vegetation, R3D } = Safari;
    const PROP = Vegetation.PROP;

    /**
     * Trees stand taller here than the 2D art drew them.
     *
     * The isometric build sized an acacia at less than twice a zebra's length, which is
     * a legibility choice that works when everything is seen from one fixed angle. In
     * perspective it just reads as a shrub, so the props are pushed back toward real
     * proportions — an acacia is now something a giraffe browses rather than steps over.
     */
    const PROP_SCALE = 1.8;

    const PAL = {
        trunk: R3D.col('#6b5238'),
        trunkDark: R3D.col('#4a3724'),
        canopy: R3D.col('#5d6b38'),
        canopyLight: R3D.col('#7c8a4a'),
        canopyDark: R3D.col('#39441f'),
        bush: R3D.col('#69713d'),
        bushLight: R3D.col('#868c52'),
        rock: R3D.col('#8f887c'),
        rockLight: R3D.col('#a9a294'),
        rockDark: R3D.col('#5d564c'),
        mound: R3D.col('#a56b45'),
        moundLight: R3D.col('#c98d5f'),
        bladeDry: R3D.col('#bfb069'),
        blade: R3D.col('#8fa14c'),
        bladeLush: R3D.col('#6f9440')
    };

    const _m = new THREE.Matrix4();
    const _pos = new THREE.Vector3();
    const _quat = new THREE.Quaternion();
    const _scale = new THREE.Vector3();
    const _euler = new THREE.Euler();
    const _c = new THREE.Color();

    /* ------------------------------------------------------------------ *
     * Prop geometry
     * ------------------------------------------------------------------ */

    /**
     * An acacia: a short trunk splitting into limbs, under a flat crown.
     *
     * The umbrella silhouette is the one thing that has to survive — it is what says
     * savanna from a kilometre away — so the crown is built as overlapping flattened
     * lobes rather than a ball.
     */
    function acaciaTrunk(rng) {
        const b = new R3D.GeoBuilder();
        const h = 1.02 * PROP_SCALE;
        const spread = 0.72 * PROP_SCALE * rng.range(0.85, 1.15);

        b.color(PAL.trunk);
        b.limb(0, 0, 0, rng.spread(0.05), h * 0.60, rng.spread(0.05),
            0.075 * PROP_SCALE, 0.045 * PROP_SCALE, { radial: 7 });

        // Limbs fan out to carry the crown.
        const limbs = 3 + (rng.next() < 0.5 ? 1 : 0);
        for (let i = 0; i < limbs; i++) {
            const a = (i / limbs) * MathUtils.TAU + rng.spread(0.4);
            const r = spread * rng.range(0.42, 0.62);
            b.limb(rng.spread(0.04), h * 0.60, rng.spread(0.04),
                Math.cos(a) * r, h * rng.range(0.90, 1.02), Math.sin(a) * r,
                0.045 * PROP_SCALE, 0.022 * PROP_SCALE, { radial: 6 });
        }

        return b.build();
    }

    /**
     * The crown, built separately from the trunk it sits on.
     *
     * Two meshes rather than one because the crown is a resource: browsers strip it and
     * it grows back, and the only way an instanced tree can show that is if the part
     * that changes has its own transform. Its geometry is centred on the crown height,
     * so scaling an instance thins the canopy in place instead of sliding it down the
     * trunk.
     */
    function acaciaCrown(rng) {
        const b = new R3D.GeoBuilder();
        const h = 1.02 * PROP_SCALE;
        const spread = 0.72 * PROP_SCALE * rng.range(0.85, 1.15);

        b.color(PAL.canopy);
        const lobes = 4;
        for (let i = 0; i < lobes; i++) {
            const a = (i / lobes) * MathUtils.TAU + rng.spread(0.5);
            const r = spread * rng.range(0.30, 0.55);
            b.push()
                .translate(Math.cos(a) * r, h * (rng.range(0.98, 1.10) - 1.04),
                    Math.sin(a) * r)
                .sphere(spread * rng.range(0.45, 0.62), 0.19 * PROP_SCALE,
                    spread * rng.range(0.45, 0.62), { low: true })
                .pop();
        }
        // A lit cap on top so the crown is not one flat tone from above.
        b.color(PAL.canopyLight);
        b.push().translate(0, h * 0.10, 0)
            .sphere(spread * 0.62, 0.11 * PROP_SCALE, spread * 0.62, { low: true })
            .pop();

        const geo = b.build();
        geo.userData.crownY = h * 1.04;
        return geo;
    }

    /**
     * Scrub: one blended mass rather than a cluster of balls.
     *
     * Same treatment as the animals, for the same reason. A bush built as overlapping
     * spheres reads as overlapping spheres from any angle the camera can now reach, and
     * there are hundreds of them in shot at once.
     */
    function bush(rng) {
        const b = new R3D.GeoBuilder();
        const s = 0.30 * PROP_SCALE;
        // Enough blend to lose the seams, not so much that scrub inflates into a
        // single smooth boulder — a bush should still read as a clump.
        const field = new Safari.Surface3D.Field(s * 0.30);
        const n = 3 + (rng.next() < 0.5 ? 1 : 0);
        for (let i = 0; i < n; i++) {
            const r = s * rng.range(0.55, 1.0);
            field.ellipsoid(0,
                rng.spread(s * 1.1), r * rng.range(0.55, 0.8), rng.spread(s * 1.1),
                r * 1.25, r, r * 1.25);
        }
        b.color(PAL.bush);
        Safari.Surface3D.polygonise(b, field, {
            cell: s * 0.30,
            // Sunlit at the crown, shaded underneath: the one cue that stops a blended
            // mass reading as a green pebble.
            colorFn: (x, y) => _c.copy(PAL.bush)
                .lerp(PAL.bushLight, MathUtils.clamp01(y / (s * 1.4)))
        });
        return b.build();
    }

    /** A boulder: one weathered mass, flattened to sit into the ground. */
    function rock(rng) {
        const b = new R3D.GeoBuilder();
        const s = 0.26 * PROP_SCALE;
        const field = new Safari.Surface3D.Field(s * 0.35);
        const n = 2 + (rng.next() < 0.6 ? 1 : 0);
        for (let i = 0; i < n; i++) {
            const r = s * rng.range(0.6, 1.05);
            field.ellipsoid(0,
                rng.spread(s * 0.7), r * 0.45, rng.spread(s * 0.7),
                r * 1.15, r * 0.78, r);
        }
        b.color(PAL.rock);
        Safari.Surface3D.polygonise(b, field, {
            cell: s * 0.26,
            colorFn: (x, y) => _c.copy(PAL.rockDark)
                .lerp(PAL.rockLight, MathUtils.clamp01(0.35 + y / (s * 1.6)))
        });
        return b.build();
    }

    /**
     * A termite mound: a clay spire, distinctly redder than the dust around it.
     *
     * Not scaled up with the trees. A mound is chest-high on a person and knee-high on
     * a giraffe, and at tree scale they turned the plain into a field of traffic cones.
     */
    function mound(rng) {
        const b = new R3D.GeoBuilder();
        const h = rng.range(0.30, 0.52);
        const r = h * rng.range(0.30, 0.42);
        b.color(PAL.mound);
        b.cone(r, h, { low: true });
        b.color(PAL.moundLight);
        b.push().translate(rng.spread(r * 0.4), h * 0.42, rng.spread(r * 0.4))
            .cone(r * 0.52, h * 0.55)
            .pop();
        return b.build();
    }

    const BUILDERS = [acaciaTrunk, bush, rock, mound];
    const VARIANTS = 3;

    /* ------------------------------------------------------------------ *
     * Ground cover
     * ------------------------------------------------------------------ */

    /**
     * One tuft: a few tapered blades, cheap enough to place tens of thousands of.
     *
     * Sized against the animals, not against the tile grid. The first pass put them at
     * two-thirds of a metre, which is knee-high on a zebra and turned the plain into a
     * field of aloes; savanna grass at this scale is a few centimetres of geometry.
     */
    function tuftGeometry() {
        const b = new R3D.GeoBuilder();
        const blades = 3;
        for (let i = 0; i < blades; i++) {
            const a = (i / blades) * MathUtils.TAU;
            const lean = 0.032 + (i % 2) * 0.018;
            b.color(i === 1 ? PAL.bladeLush : PAL.blade);
            b.limb(0, 0, 0,
                Math.cos(a) * lean, 0.055 + (i % 2) * 0.018, Math.sin(a) * lean,
                0.007, 0.001, { radial: 3, noCaps: true });
        }
        return b.build();
    }

    /* ------------------------------------------------------------------ *
     * Flora
     * ------------------------------------------------------------------ */

    class Flora3D {
        /**
         * @param {Safari.TileWorld} world
         * @param {THREE.Scene} scene
         * @param {number} seed
         * @param {THREE.Texture} overlay Terrain's graze/burn texture.
         * @param {Safari.Vegetation} vegetation The world's standing vegetation. The
         *   scatter lives there now, because the acacias are food rather than scenery.
         */
        constructor(world, scene, seed, overlay, vegetation) {
            this.world = world;
            this.scene = scene;
            this.overlay = overlay;
            this.vegetation = vegetation;
            this.meshes = [];

            this.props = vegetation.props;
            /** Crown instances, so browsing can thin them: tree → {mesh, index}. */
            this.crowns = new Map();
            this._crownTimer = 0;

            this._buildProps(seed);
            this._buildGroundCover(seed);
        }

        _buildProps(seed) {
            const world = this.world;

            // One instanced mesh per kind and variant: four kinds, three variants, so
            // the whole reserve's vegetation is a dozen draw calls.
            const buckets = new Map();
            for (const p of this.props) {
                const key = p.type * VARIANTS + p.variant;
                let list = buckets.get(key);
                if (!list) buckets.set(key, (list = []));
                list.push(p);
            }

            for (const [key, list] of buckets) {
                const type = (key / VARIANTS) | 0;
                const geo = BUILDERS[type](new Rng(key * 977 + seed));
                const mesh = new THREE.InstancedMesh(geo, R3D.solidMaterial(), list.length);
                mesh.castShadow = true;
                mesh.receiveShadow = type !== PROP.ACACIA;

                for (let i = 0; i < list.length; i++) {
                    const p = list[i];
                    _pos.set(p.x, R3D.surfaceY(world, p.x, p.y) - 0.04, p.y);
                    _euler.set(0, p.yaw, 0);
                    _quat.setFromEuler(_euler);
                    _scale.setScalar(p.scale);
                    _m.compose(_pos, _quat, _scale);
                    mesh.setMatrixAt(i, _m);
                }
                mesh.instanceMatrix.needsUpdate = true;
                mesh.frustumCulled = false;
                this.scene.add(mesh);
                this.meshes.push(mesh);

                if (type === PROP.ACACIA) this._buildCrowns(key, list, seed);
            }
        }

        /**
         * The crowns, on their own instanced mesh so browsing can thin them.
         *
         * Each tree's crown carries a scale that follows the foliage the simulation says
         * it has left, which is what makes a browsed stand visibly bare and a recovered
         * one visibly full — the same idea as the grass shrinking over grazed ground,
         * one level up.
         */
        _buildCrowns(key, list, seed) {
            const world = this.world;
            const geo = acaciaCrown(new Rng(key * 977 + seed));
            const mesh = new THREE.InstancedMesh(geo, R3D.solidMaterial(), list.length);
            mesh.castShadow = true;
            mesh.frustumCulled = false;

            for (let i = 0; i < list.length; i++) {
                const p = list[i];
                p._crownBase = R3D.surfaceY(world, p.x, p.y) - 0.04;
                this.crowns.set(p, { mesh, index: i, foliage: -1 });
                this._placeCrown(p, mesh, i, 1);
            }
            mesh.instanceMatrix.needsUpdate = true;
            this.scene.add(mesh);
            this.meshes.push(mesh);
        }

        /** @param {number} foliage 0..1 of the crown remaining. */
        _placeCrown(p, mesh, index, foliage) {
            const geo = mesh.geometry;
            const crownY = geo.userData.crownY * p.scale;
            // A stripped crown thins rather than vanishing: browsers take the leaves,
            // not the branches, and a tree that disappeared would read as felled.
            const thin = 0.34 + 0.66 * foliage;
            _pos.set(p.x, p._crownBase + crownY, p.y);
            _euler.set(0, p.yaw, 0);
            _quat.setFromEuler(_euler);
            _scale.set(p.scale * (0.8 + 0.2 * foliage), p.scale * thin,
                p.scale * (0.8 + 0.2 * foliage));
            _m.compose(_pos, _quat, _scale);
            mesh.setMatrixAt(index, _m);
        }

        /**
         * Scatter ground cover over anything fertile enough to carry it.
         *
         * Placement is by tile fertility, so the plain is thick where the moisture field
         * says it should be and bare over rock and sand — the same field the grazers
         * eat from, which is why the grass you can see is the grass they are competing
         * for.
         */
        _buildGroundCover(seed) {
            const world = this.world;
            const rng = new Rng((seed || 1) ^ 0x7EF7);
            const n = world.size;
            const placements = [];

            /*
             * Tufts per tile at full fertility.
             *
             * Eight is generous — around forty thousand across a reserve this size —
             * but they are one instanced draw call of four triangles each, and the
             * difference between three and eight is the difference between a plain with
             * a few sprigs on it and a plain with grass on it.
             */
            const perTile = 8;
            for (let ty = 0; ty < n; ty++) {
                for (let tx = 0; tx < n; tx++) {
                    const fert = world.fertility[world.index(tx, ty)];
                    if (fert < 0.10) continue;
                    if (world.waterAt(tx + 0.5, ty + 0.5) > 0.02) continue;
                    const count = Math.round(perTile * fert);
                    for (let i = 0; i < count; i++) {
                        placements.push(tx + rng.next(), ty + rng.next(),
                            rng.range(0.7, 1.5), rng.range(0, MathUtils.TAU));
                    }
                }
            }

            const total = placements.length / 4;
            if (!total) return;

            const mesh = new THREE.InstancedMesh(tuftGeometry(), this._grassMaterial(), total);
            for (let i = 0; i < total; i++) {
                const x = placements[i * 4];
                const z = placements[i * 4 + 1];
                _pos.set(x, R3D.surfaceY(world, x, z) - 0.01, z);
                _euler.set(0, placements[i * 4 + 3], 0);
                _quat.setFromEuler(_euler);
                _scale.set(1, placements[i * 4 + 2], 1);
                _m.compose(_pos, _quat, _scale);
                mesh.setMatrixAt(i, _m);
            }
            mesh.instanceMatrix.needsUpdate = true;
            mesh.frustumCulled = false;
            // Grass neither casts nor receives: a hundred thousand blades in the shadow
            // pass costs more than it could possibly be worth.
            this.scene.add(mesh);
            this.meshes.push(mesh);
            this.grass = mesh;
        }

        /**
         * Grass that answers to the wind and to the herds.
         *
         * The sway is the usual vertex displacement. The interesting part is the second
         * line: the same overlay texture the terrain samples for grazed ground is read
         * here in the vertex shader, and a stripped tile's tufts shrink into it. Nothing
         * is rebuilt when a zebra eats — the simulation writes a number and the grass
         * follows.
         */
        _grassMaterial() {
            const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
            const uniforms = {
                uTime: { value: 0 },
                uWind: { value: 1 },
                uOverlay: { value: this.overlay },
                uOverlayScale: { value: 1 / this.world.size }
            };
            mat.userData.uniforms = uniforms;

            mat.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, uniforms);
                shader.vertexShader = [
                    'uniform float uTime;',
                    'uniform float uWind;',
                    'uniform sampler2D uOverlay;',
                    'uniform float uOverlayScale;'
                ].join('\n') + '\n' + shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    [
                        '#include <begin_vertex>',
                        'vec3 tuftOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1],',
                        '                       instanceMatrix[3][2]);',
                        'vec4 tuftOv = texture2D(uOverlay, tuftOrigin.xz * uOverlayScale);',
                        // Grazed pasture is cropped short; burnt ground has none at all.
                        'float crop = (1.0 - tuftOv.r * 0.8) * (1.0 - tuftOv.g);',
                        'transformed.y *= crop;',
                        'float sway = sin(uTime * 1.7 + tuftOrigin.x * 1.3 + tuftOrigin.z * 0.9);',
                        'transformed.xz += sway * uWind * 0.055 * transformed.y;'
                    ].join('\n'));
            };
            mat.customProgramCacheKey = () => 'safari-grass';
            return mat;
        }

        /**
         * @param {number} now Simulated seconds, for foliage regrowth.
         */
        update(dt, wind, now) {
            if (this.grass) {
                const u = this.grass.material.userData.uniforms;
                u.uTime.value += dt;
                u.uWind.value = wind;
            }

            // Crowns change over minutes, not frames, so they are checked on a cadence
            // and only rewritten when the foliage has actually moved.
            this._crownTimer -= dt;
            if (this._crownTimer > 0 || !this.vegetation) return;
            this._crownTimer = 0.4;

            const dirty = new Set();
            for (const [tree, slot] of this.crowns) {
                const foliage = this.vegetation.foliageAt(tree, now);
                if (Math.abs(foliage - slot.foliage) < 0.02) continue;
                slot.foliage = foliage;
                this._placeCrown(tree, slot.mesh, slot.index, foliage);
                dirty.add(slot.mesh);
            }
            for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
        }

        dispose() {
            for (const m of this.meshes) {
                this.scene.remove(m);
                m.geometry.dispose();
            }
            this.meshes.length = 0;
        }
    }

    Flora3D.PROP = PROP;
    Safari.Flora3D = Flora3D;

})(window.Safari, window.THREE);
