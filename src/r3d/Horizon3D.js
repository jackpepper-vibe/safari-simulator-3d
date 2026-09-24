/**
 * Safari Simulator 3D — The land beyond the fence.
 *
 * The reserve is 86 tiles square, and for a long time that was the whole world: past
 * its edge was a cliff into nothing, hidden by fog pulled in so tight that the far side
 * of the reserve itself was grey. It read as a board game on a table.
 *
 * This is the rest of the country. A plain that carries on from the reserve's own edge
 * — the same ground colour where they meet, so there is no seam — rolling out into low
 * hills, with a line of blue ranges on the horizon and one great volcanic peak standing
 * off to one side, the landmark every savanna picture has. It is scattered with distant
 * acacias so the woodland does not stop at the boundary.
 *
 * None of it is simulated. It is one vertex-coloured mesh and one instanced tree mesh,
 * on a grid whose cells grow with distance from the reserve, so the whole horizon costs
 * a couple of draw calls.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Noise, Rng, R3D, Terrain3D, Relief3D } = Safari;

    /** How far the land runs out from the reserve's edge, in world units. */
    const REACH = 560;
    /** Cell size at the reserve edge, and how fast cells grow with distance. */
    const NEAR_CELL = 1;
    const GROWTH = 1.075;
    /**
     * How far the horizon's own boundary vertices sit under the reserve's edge. The two
     * meshes share heights exactly at shared points; this hairline only hides the
     * difference between their samplings of the edge in between.
     */
    const TUCK = 0.015;

    const PAL = {
        plain: R3D.col('#a09568'),
        plainDry: R3D.col('#ae9f78'),
        plainGreen: R3D.col('#7c8750'),
        hill: R3D.col('#8f8559'),
        range: R3D.col('#6f7775'),
        rangeDark: R3D.col('#56605f'),
        snow: R3D.col('#eef1f2'),
        trunk: R3D.col('#4f3c2a'),
        crown: R3D.col('#56632f'),
        crownLight: R3D.col('#6d7a3c')
    };

    const _c = new THREE.Color();

    /** Axis coordinates: dense at the reserve's edge, stretching outward both ways. */
    function axis(size) {
        const out = [];
        let step = NEAR_CELL;
        let t = 0;
        const beyond = [];
        while (t < REACH) {
            t += step;
            beyond.push(t);
            step *= GROWTH;
        }
        for (let i = beyond.length - 1; i >= 0; i--) out.push(-beyond[i]);
        for (let x = 0; x <= size; x += 2) out.push(x);
        if (out[out.length - 1] !== size) out.push(size);
        for (const b of beyond) out.push(size + b);
        return out;
    }

    class Horizon3D {
        /**
         * @param {Safari.TileWorld} world
         * @param {THREE.Scene} scene
         * @param {number} seed
         */
        constructor(world, scene, seed) {
            this.world = world;
            this.scene = scene;
            this.size = world.size;
            this.relief = Relief3D.of(world);
            this.rng = new Rng((seed || 1) ^ 0x4E5A);
            this.salt = (seed % 997) * 0.13;

            /*
             * The landmark peak: one direction, well out, chosen per reserve so every
             * seed has its own horizon. It is a volcano, so it is a broad cone with a
             * snow cap, not a spike.
             */
            const a = this.rng.range(0, MathUtils.TAU);
            const c = this.size / 2;
            this.peak = {
                x: c + Math.cos(a) * 430,
                z: c + Math.sin(a) * 430,
                radius: 190,
                height: 78
            };

            this._build();
            this._buildTrees();
        }

        /** Distance from a point to the reserve's square, 0 inside it. */
        _outside(x, z) {
            const n = this.size;
            const dx = Math.max(0 - x, 0, x - n);
            const dz = Math.max(0 - z, 0, z - n);
            return Math.hypot(dx, dz);
        }

        /**
         * Height of the land at a point outside the reserve.
         *
         * At the fence it matches the reserve's own edge exactly; a few tiles out it
         * begins to roll; by a couple of hundred units it is hill country; and at the
         * rim the ranges and the peak take over.
         */
        heightAt(x, z) {
            const n = this.size;
            const d = this._outside(x, z);
            const ex = MathUtils.clamp(x, 0, n), ez = MathUtils.clamp(z, 0, n);
            const edge = this.relief.heightAt(ex, ez);
            const s = this.salt;

            const blend = MathUtils.smoothstep(0, 14, d);
            const roll = (Noise.fbm2(x * 0.025 + s, z * 0.025 - s, 4, 2.1, 0.5) - 0.45) *
                3.2 * MathUtils.smoothstep(4, 60, d);
            const hills = Math.pow(Noise.fbm2(x * 0.008 - s, z * 0.008 + s, 4, 2.0, 0.5), 2.2) *
                28 * MathUtils.smoothstep(90, 320, d);
            const ridge = 1 - Math.abs(Noise.fbm2(x * 0.004 + s * 3, z * 0.004, 3, 2.0, 0.5) * 2 - 1);
            const ranges = Math.pow(ridge, 3) * 58 * MathUtils.smoothstep(260, 470, d);

            const p = this.peak;
            const pd = Math.hypot(x - p.x, z - p.z) / p.radius;
            const cone = pd < 1 ? p.height * Math.pow(1 - pd, 1.6) *
                (0.92 + 0.08 * Noise.value2(x * 0.05, z * 0.05)) : 0;

            const land = Math.max(roll + hills + ranges, cone + roll);
            return MathUtils.lerp(edge, edge * 0.2 + land, blend) - (d < 0.01 ? TUCK : 0);
        }

        /** Albedo of the land at a point: matched to the reserve at the fence. */
        colorAt(x, z, h) {
            const n = this.size;
            const d = this._outside(x, z);
            const s = this.salt;

            const m = Noise.fbm2(x * 0.03 + s, z * 0.03, 3, 2, 0.5);
            _c.copy(PAL.plain).lerp(m > 0.5 ? PAL.plainGreen : PAL.plainDry,
                Math.abs(m - 0.5) * 1.6);

            if (d < 12) {
                // Continue the reserve's own ground across the boundary.
                const ex = MathUtils.clamp(Math.round(MathUtils.clamp(x, 0, n) * Relief3D.RES), 0,
                    this.relief.verts - 1);
                const ez = MathUtils.clamp(Math.round(MathUtils.clamp(z, 0, n) * Relief3D.RES), 0,
                    this.relief.verts - 1);
                const edge = Terrain3D.groundColor(this.world, this.relief, ex, ez);
                const k = MathUtils.smoothstep(0, 12, d);
                const r = edge.r, g = edge.g, b = edge.b;
                _c.setRGB(r + (_c.r - r) * k, g + (_c.g - g) * k, b + (_c.b - b) * k);
            }

            // Hills weather to scrubby brown, ranges to blue-grey rock, the peak to snow.
            _c.lerp(PAL.hill, MathUtils.smoothstep(6, 24, h) * 0.7);
            _c.lerp(Noise.value2(x * 0.02, z * 0.02) > 0.5 ? PAL.range : PAL.rangeDark,
                MathUtils.smoothstep(22, 46, h));
            _c.lerp(PAL.snow, MathUtils.smoothstep(58, 66, h + Noise.value2(x * 0.08, z * 0.08) * 6));
            return _c;
        }

        _build() {
            const xs = axis(this.size);
            const zs = xs;
            const nx = xs.length, nz = zs.length;
            const n = this.size;

            const positions = new Float32Array(nx * nz * 3);
            const colors = new Float32Array(nx * nz * 3);
            const heights = new Float32Array(nx * nz);

            for (let j = 0; j < nz; j++) {
                for (let i = 0; i < nx; i++) {
                    const x = xs[i], z = zs[j];
                    const k = j * nx + i;
                    const h = this.heightAt(x, z);
                    heights[k] = h;
                    positions[k * 3] = x;
                    positions[k * 3 + 1] = h;
                    positions[k * 3 + 2] = z;
                    const c = this.colorAt(x, z, h);
                    colors[k * 3] = c.r;
                    colors[k * 3 + 1] = c.g;
                    colors[k * 3 + 2] = c.b;
                }
            }

            // Skip every cell that lies wholly inside the reserve: the terrain is there.
            const indices = [];
            for (let j = 0; j < nz - 1; j++) {
                for (let i = 0; i < nx - 1; i++) {
                    const inside = xs[i] >= 0 && xs[i + 1] <= n && zs[j] >= 0 && zs[j + 1] <= n;
                    if (inside) continue;
                    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
                    indices.push(a, c, b, b, c, d);
                }
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            geo.setIndex(indices);
            geo.computeVertexNormals();
            geo.computeBoundingSphere();

            this.mesh = new THREE.Mesh(geo, this._material());
            this.mesh.receiveShadow = true;
            this.mesh.name = 'horizon';
            this.scene.add(this.mesh);
        }

        /**
         * The land's material: the ground's own shading, with the same world-space grain
         * so the join to the reserve is invisible at any distance.
         */
        _material() {
            const mat = new THREE.MeshPhongMaterial({
                vertexColors: true, specular: new THREE.Color(0, 0, 0), shininess: 1
            });
            Safari.Shading3D.patch(mat, 'horizon', {
                vertexHead: 'varying vec2 vHorizonXZ;',
                vertex: [[
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nvHorizonXZ = (modelMatrix * vec4(transformed, 1.0)).xz;'
                ]],
                fragmentHead: 'varying vec2 vHorizonXZ;',
                fragment: [[
                    '#include <color_fragment>',
                    '#include <color_fragment>\n' +
                    'diffuseColor.rgb *= 0.86 + 0.26 * detailAt(vHorizonXZ * 0.035).r;\n' +
                    'diffuseColor.rgb *= 0.93 + 0.12 * detailAt(vHorizonXZ * 0.11).g;'
                ]]
            });
            return mat;
        }

        /**
         * Acacias and scrub scattered out across the plain.
         *
         * Thinning with distance, and absent from the hills, so the woodland reads as
         * carrying on past the fence and fading into the haze rather than stopping.
         */
        _buildTrees() {
            const b = new R3D.GeoBuilder();
            b.color(PAL.trunk);
            b.limb(0, 0, 0, 0, 1.3, 0, 0.09, 0.06, { radial: 5 });
            b.limb(0, 1.1, 0, 0.5, 1.75, 0.1, 0.06, 0.03, { radial: 4 });
            b.limb(0, 1.1, 0, -0.45, 1.7, -0.15, 0.06, 0.03, { radial: 4 });
            b.color(PAL.crown);
            b.push().translate(0, 1.85, 0).sphere(1.25, 0.28, 1.1, { low: true }).pop();
            b.color(PAL.crownLight);
            b.push().translate(0.1, 2.0, 0).sphere(0.95, 0.16, 0.85, { low: true }).pop();
            const geo = b.build();

            const n = this.size;
            const rng = this.rng;
            const spots = [];
            for (let attempt = 0; attempt < 9000 && spots.length < 900; attempt++) {
                const x = rng.range(-220, n + 220);
                const z = rng.range(-220, n + 220);
                const d = this._outside(x, z);
                if (d < 3) continue;
                // Sparse and clumped: groves where a low-frequency field is high.
                const grove = Noise.fbm2(x * 0.04 + this.salt, z * 0.04, 3, 2, 0.5);
                if (rng.next() > MathUtils.smoothstep(0.45, 0.7, grove) * (1 - d / 240)) continue;
                const h = this.heightAt(x, z);
                if (h > 14) continue;
                spots.push(x, h, z, rng.range(0.8, 1.9), rng.range(0, MathUtils.TAU));
            }

            const count = spots.length / 5;
            if (!count) return;
            const mesh = new THREE.InstancedMesh(geo, R3D.solidMaterial(), count);
            const m = new THREE.Matrix4();
            const q = new THREE.Quaternion();
            const e = new THREE.Euler();
            const p = new THREE.Vector3();
            const s = new THREE.Vector3();
            for (let i = 0; i < count; i++) {
                const k = i * 5;
                p.set(spots[k], spots[k + 1] - 0.05, spots[k + 2]);
                e.set(0, spots[k + 4], 0);
                q.setFromEuler(e);
                s.set(spots[k + 3], spots[k + 3] * MathUtils.lerp(0.85, 1.1, (i % 7) / 7), spots[k + 3]);
                m.compose(p, q, s);
                mesh.setMatrixAt(i, m);
            }
            mesh.instanceMatrix.needsUpdate = true;
            // Beyond the shadow camera's reach almost everywhere; casting would only
            // put nine hundred trees through the shadow pass to be clipped away.
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            this.trees = mesh;
            this.scene.add(mesh);
        }

        dispose() {
            for (const m of [this.mesh, this.trees]) {
                if (!m) continue;
                this.scene.remove(m);
                m.geometry.dispose();
            }
        }
    }

    Horizon3D.REACH = REACH;
    Safari.Horizon3D = Horizon3D;

})(window.Safari, window.THREE);
