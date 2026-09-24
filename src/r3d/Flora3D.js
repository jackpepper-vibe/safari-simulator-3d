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
 *
 * FOLIAGE
 * -------
 * Bushes and crowns are a dark inner mass wrapped in a shell of leaf cards cut from the
 * shared foliage atlas and alpha-tested. The inner mass stops the eye seeing through
 * the canopy; the cards give it a broken, leafy outline, which is the whole difference
 * between a bush and a green pebble. Every card takes the normal of the clump it sits
 * on rather than its own, so a crown lights as one soft volume.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Rng, Noise, Vegetation, R3D, Shading3D, Surface3D } = Safari;
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
        bark: R3D.col('#5e4a36'),
        barkDark: R3D.col('#3e3024'),
        barkPale: R3D.col('#7d6a54'),
        canopy: R3D.col('#6f8040'),
        canopyLight: R3D.col('#93a256'),
        canopyDark: R3D.col('#3c4a22'),
        canopyCore: R3D.col('#46552a'),
        bush: R3D.col('#6d7a3e'),
        bushLight: R3D.col('#8f9a55'),
        bushDry: R3D.col('#8c8747'),
        bushCore: R3D.col('#4b5729'),
        rock: R3D.col('#968d80'),
        rockLight: R3D.col('#b3aa9b'),
        rockDark: R3D.col('#615a50'),
        lichen: R3D.col('#b5a86a'),
        lichenPale: R3D.col('#c9c6b5'),
        clay: R3D.col('#9a6b4c'),
        clayLight: R3D.col('#b38a68'),
        clayDark: R3D.col('#6f4a33'),
        grassDry: R3D.col('#c4ad6c'),
        grass: R3D.col('#a3ab5a'),
        grassLush: R3D.col('#7c9a48')
    };

    const _m = new THREE.Matrix4();
    const _pos = new THREE.Vector3();
    const _quat = new THREE.Quaternion();
    const _scale = new THREE.Vector3();
    const _euler = new THREE.Euler();
    const _c = new THREE.Color();
    const _a = new THREE.Vector3();
    const _b = new THREE.Vector3();
    const _n = new THREE.Vector3();

    /* ------------------------------------------------------------------ *
     * Materials
     * ------------------------------------------------------------------ */

    let _foliageMat = null;
    let _foliageDepth = null;
    let _rockMat = null;

    /**
     * The foliage material: alpha-tested leaf cards that stir in the wind.
     *
     * Alpha-to-coverage turns the hard alpha-test edge into a soft one under the
     * multisampled render target, so leaves are not ringed with stair-steps.
     */
    function foliageMaterial() {
        if (_foliageMat) return _foliageMat;
        const mat = new THREE.MeshPhongMaterial({
            vertexColors: true,
            map: Shading3D.foliageTexture(),
            alphaTest: 0.42,
            side: THREE.DoubleSide,
            specular: new THREE.Color(0, 0, 0),
            shininess: 1
        });
        mat.alphaToCoverage = true;
        Shading3D.patch(mat, 'foliage', {
            vertex: [[
                '#include <begin_vertex>',
                [
                    '#include <begin_vertex>',
                    // Sway grows with height above the prop's base, and each instance
                    // takes its phase from where it stands.
                    'vec3 swayOrigin = vec3(0.0);',
                    '#ifdef USE_INSTANCING',
                    'swayOrigin = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);',
                    '#endif',
                    'float swayH = max(transformed.y - 0.4, 0.0);',
                    'float swayT = uTime * 1.3 + swayOrigin.x * 0.7 + swayOrigin.z * 0.5;',
                    'transformed.x += sin(swayT + transformed.y * 2.0) * 0.018 * uWind * swayH;',
                    'transformed.z += cos(swayT * 0.8 + transformed.x * 3.0) * 0.014 * uWind * swayH;'
                ].join('\n')
            ]]
        });
        _foliageMat = mat;
        return mat;
    }

    /** Depth material for foliage shadows, so a crown casts a dappled shadow. */
    function foliageDepthMaterial() {
        if (_foliageDepth) return _foliageDepth;
        _foliageDepth = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            map: Shading3D.foliageTexture(),
            alphaTest: 0.42
        });
        return _foliageDepth;
    }

    /**
     * Stone is faceted: flat-shaded, so each weathered plane catches the light on its
     * own. A smooth normal is what made the old boulders read as river pebbles.
     */
    function rockMaterial() {
        if (_rockMat) return _rockMat;
        _rockMat = new THREE.MeshPhongMaterial({
            vertexColors: true, flatShading: true,
            specular: R3D.col('#101010'), shininess: 8
        });
        return _rockMat;
    }

    /* ------------------------------------------------------------------ *
     * Leaf shells
     * ------------------------------------------------------------------ */

    /**
     * Wrap a polygonised mass in leaf cards.
     *
     * Cards are seeded on the mass's own surface, pushed half out of it so they break
     * the silhouette, and turned to face outward with a random roll. They take the
     * clump's outward normal, lifted toward the sky, for shading.
     *
     * @param {R3D.GeoBuilder} b
     * @param {number} from First vertex of the mass in the builder.
     * @param {object} o
     */
    function leafShell(b, from, o) {
        const rng = o.rng;
        const to = b.vertexCount;
        if (to <= from) return;
        for (let i = 0; i < o.count; i++) {
            const v = from + ((rng.next() * (to - from)) | 0);
            const px = b.pos[v * 3], py = b.pos[v * 3 + 1], pz = b.pos[v * 3 + 2];
            _n.set(b.nrm[v * 3], b.nrm[v * 3 + 1], b.nrm[v * 3 + 2]);
            if (o.minUp !== undefined && _n.y < o.minUp) continue;

            const size = o.size * rng.range(0.75, 1.25);
            // Facing: the surface normal, bent toward the sky for a crown whose leaves
            // lie flat, then jittered so the cards do not align.
            _a.copy(_n).lerp(_b.set(0, 1, 0), o.lift || 0)
                .add(_b.set(rng.spread(0.5), rng.spread(0.35), rng.spread(0.5))).normalize();
            // Any vector not parallel to the facing gives the card's plane.
            _b.set(rng.spread(1), rng.spread(1), rng.spread(1));
            if (Math.abs(_b.dot(_a)) > 0.9 * _b.length()) _b.set(1, 0, 0);
            const right = _b.clone().cross(_a).normalize().multiplyScalar(size);
            const up = _a.clone().cross(right).normalize().multiplyScalar(size);

            const push = size * (o.push === undefined ? 0.45 : o.push);
            const cx = px + _n.x * push, cy = py + _n.y * push, cz = pz + _n.z * push;

            // Shade: light on top, dark underneath, jittered per card.
            const top = MathUtils.clamp01((cy - o.baseY) / Math.max(1e-3, o.height));
            _c.copy(o.dark).lerp(o.light, MathUtils.clamp01(top * 0.85 + rng.range(-0.15, 0.2)));
            if (o.dry && rng.next() < 0.18) _c.lerp(o.dry, 0.5);
            b.color(_c);

            // Lighting normal: the clump's, raised toward the sky.
            const nn = [_n.x * 0.7, _n.y * 0.7 + 0.5, _n.z * 0.7];
            b.card([cx, cy, cz], [right.x, right.y, right.z], [up.x, up.y, up.z], nn,
                Shading3D.leafRect((rng.next() * Shading3D.ATLAS.cols) | 0, o.fine));
        }
    }

    /** Point the builder at the atlas's solid swatch, for an opaque inner mass. */
    function solidUV(b) {
        const s = Shading3D.ATLAS.solid;
        b.uv((s.u0 + s.u1) / 2, (s.v0 + s.v1) / 2);
    }

    /* ------------------------------------------------------------------ *
     * Prop geometry
     * ------------------------------------------------------------------ */

    /**
     * An acacia's trunk and limbs.
     *
     * The trunk leans, forks low and throws its limbs up and out in two bends each,
     * which is the gnarled architecture that carries the flat crown. Bark darkens
     * toward the ground.
     */
    function acaciaTrunk(rng) {
        const b = new R3D.GeoBuilder();
        const h = 1.02 * PROP_SCALE;
        const spread = 0.72 * PROP_SCALE * rng.range(0.85, 1.15);
        const lean = [rng.spread(0.12), rng.spread(0.12)];
        const fork = h * rng.range(0.42, 0.55);

        b.color(PAL.barkDark);
        b.limb(0, -0.05, 0, lean[0] * 0.5, fork * 0.5, lean[1] * 0.5,
            0.095 * PROP_SCALE, 0.075 * PROP_SCALE, { radial: 8 });
        b.color(PAL.bark);
        b.limb(lean[0] * 0.5, fork * 0.5, lean[1] * 0.5, lean[0], fork, lean[1],
            0.075 * PROP_SCALE, 0.06 * PROP_SCALE, { radial: 8 });

        const limbs = 3 + (rng.next() < 0.6 ? 1 : 0);
        for (let i = 0; i < limbs; i++) {
            const a = (i / limbs) * MathUtils.TAU + rng.spread(0.5);
            const r = spread * rng.range(0.45, 0.7);
            const midR = r * rng.range(0.35, 0.5);
            const mx = lean[0] + Math.cos(a) * midR, mz = lean[1] + Math.sin(a) * midR;
            const my = fork + (h - fork) * rng.range(0.35, 0.55);
            b.color(i % 2 ? PAL.bark : PAL.barkPale);
            b.limb(lean[0], fork, lean[1], mx, my, mz,
                0.05 * PROP_SCALE, 0.036 * PROP_SCALE, { radial: 6 });
            b.limb(mx, my, mz, lean[0] + Math.cos(a) * r, h * rng.range(0.93, 1.02),
                lean[1] + Math.sin(a) * r, 0.036 * PROP_SCALE, 0.018 * PROP_SCALE, { radial: 5 });
        }
        return b.build();
    }

    /**
     * The crown: flat, layered and see-through at the edges.
     *
     * The umbrella silhouette is the one thing that has to survive — it is what says
     * savanna from a kilometre away — so the crown is a few thin, flat pads at slightly
     * different heights, with leaf cards lying mostly flat across their tops and hanging
     * from their rims. The dark core under the cards keeps the canopy from looking like
     * lace from below.
     *
     * Built separately from the trunk because the crown is a resource: browsers strip
     * it and it grows back, and the only way an instanced tree can show that is if the
     * part that changes has its own transform. Its geometry is centred on the crown
     * height, so scaling an instance thins the canopy in place.
     */
    function acaciaCrown(rng) {
        const b = new R3D.GeoBuilder();
        const h = 1.02 * PROP_SCALE;
        const spread = 0.72 * PROP_SCALE * rng.range(0.9, 1.15);

        const field = new Surface3D.Field(spread * 0.12);
        const pads = 4 + (rng.next() < 0.5 ? 1 : 0);
        for (let i = 0; i < pads; i++) {
            const a = (i / pads) * MathUtils.TAU + rng.spread(0.5);
            const r = i === 0 ? 0 : spread * rng.range(0.28, 0.5);
            const pr = spread * rng.range(0.42, 0.6);
            field.ellipsoid(0, Math.cos(a) * r, rng.range(-0.08, 0.08) * PROP_SCALE,
                Math.sin(a) * r, pr, 0.075 * PROP_SCALE, pr * rng.range(0.85, 1.05));
        }

        b.color(PAL.canopyCore);
        solidUV(b);
        const from = b.vertexCount;
        Surface3D.polygonise(b, field, { cell: spread * 0.12 });

        leafShell(b, from, {
            rng, count: 150, size: spread * 0.2, lift: 0.75, push: 0.3,
            baseY: -0.12 * PROP_SCALE, height: 0.3 * PROP_SCALE,
            dark: PAL.canopyDark, light: PAL.canopyLight, fine: true
        });
        // A second, looser layer on top, so the crown has a sunlit upper surface.
        leafShell(b, from, {
            rng, count: 60, size: spread * 0.24, lift: 0.9, push: 0.7, minUp: 0.3,
            baseY: -0.1 * PROP_SCALE, height: 0.25 * PROP_SCALE,
            dark: PAL.canopy, light: PAL.canopyLight, fine: true
        });

        const geo = b.build();
        geo.userData.crownY = h * 1.02;
        return geo;
    }

    /**
     * Scrub: a leafy clump.
     *
     * A few blended lumps make the inner mass, shrunk so the cards around it carry the
     * outline, and the cards are the broad-leaf sprites of the atlas.
     */
    function bush(rng) {
        const b = new R3D.GeoBuilder();
        const s = 0.30 * PROP_SCALE;
        const field = new Surface3D.Field(s * 0.3);
        const n = 3 + (rng.next() < 0.5 ? 1 : 0);
        let top = 0;
        for (let i = 0; i < n; i++) {
            const r = s * rng.range(0.5, 0.85);
            const y = r * rng.range(0.5, 0.75);
            top = Math.max(top, y + r);
            field.ellipsoid(0, rng.spread(s * 0.9), y, rng.spread(s * 0.9),
                r * 1.15, r * 0.9, r * 1.15);
        }

        b.color(PAL.bushCore);
        solidUV(b);
        const from = b.vertexCount;
        Surface3D.polygonise(b, field, { cell: s * 0.3 });

        leafShell(b, from, {
            rng, count: 110, size: s * 0.4, lift: 0.2, push: 0.35,
            baseY: 0, height: top,
            dark: PAL.bush.clone().multiplyScalar(0.72), light: PAL.bushLight,
            dry: PAL.bushDry, fine: false
        });
        return b.build();
    }

    /**
     * A boulder: weathered, faceted and lichen-spotted.
     *
     * Blended lumps give the overall mass; the surface is then pushed in and out by
     * noise and drawn flat-shaded, so it breaks into planes the way granite does. Colour
     * darkens toward the ground and is spotted with lichen on the faces that see the sky.
     */
    function rock(rng) {
        const b = new R3D.GeoBuilder();
        const s = 0.28 * PROP_SCALE;
        const field = new Surface3D.Field(s * 0.3);
        const n = 2 + (rng.next() < 0.6 ? 2 : 1);
        for (let i = 0; i < n; i++) {
            const r = s * rng.range(0.55, 1.0);
            field.ellipsoid(0, rng.spread(s * 0.8), r * 0.35, rng.spread(s * 0.8),
                r * rng.range(0.95, 1.3), r * rng.range(0.6, 0.85), r * rng.range(0.85, 1.1));
        }
        const salt = rng.range(0, 100);
        b.color(PAL.rock);
        const from = b.vertexCount;
        Surface3D.polygonise(b, field, { cell: s * 0.22 });

        // Weather it: displace along the normal, coarse facets plus a finer chip.
        for (let v = from; v < b.vertexCount; v++) {
            const x = b.pos[v * 3], y = b.pos[v * 3 + 1], z = b.pos[v * 3 + 2];
            const d = (Noise.fbm2(x * 3.1 + salt, (y + z) * 3.1, 3, 2.2, 0.5) - 0.5) * s * 0.55;
            b.pos[v * 3] += b.nrm[v * 3] * d;
            b.pos[v * 3 + 1] = Math.max(-0.08, y + b.nrm[v * 3 + 1] * d);
            b.pos[v * 3 + 2] += b.nrm[v * 3 + 2] * d;

            const ny = b.nrm[v * 3 + 1];
            const grain = Noise.value2(x * 9 + salt, z * 9 - y * 6);
            _c.copy(PAL.rockDark).lerp(PAL.rock, MathUtils.clamp01(0.3 + y / (s * 1.2)))
                .lerp(PAL.rockLight, MathUtils.clamp01(ny) * 0.35 * grain);
            const lichen = Noise.fbm2(x * 5 + salt, z * 5, 2, 2, 0.5);
            if (ny > 0.25 && lichen > 0.6) {
                _c.lerp(grain > 0.5 ? PAL.lichen : PAL.lichenPale, MathUtils.clamp01((lichen - 0.6) * 5) * 0.7);
            }
            b.rgb[v * 3] = _c.r;
            b.rgb[v * 3 + 1] = _c.g;
            b.rgb[v * 3 + 2] = _c.b;
        }
        return b.build();
    }

    /**
     * A termite mound: a clay spire with chimneys, distinctly redder than the dust.
     *
     * Not scaled up with the trees. A mound is chest-high on a person and knee-high on
     * a giraffe, and at tree scale they turned the plain into a field of traffic cones.
     */
    function mound(rng) {
        const b = new R3D.GeoBuilder();
        const h = rng.range(0.42, 0.72);
        const r = h * rng.range(0.28, 0.36);
        const field = new Surface3D.Field(r * 0.35);
        field.ellipsoid(0, 0, r * 0.25, 0, r * 1.25, r * 0.6, r * 1.15);
        field.capsule(0, 0, 0, 0, rng.spread(r * 0.2), h, rng.spread(r * 0.2), r * 0.8, r * 0.18);
        const chimneys = 1 + ((rng.next() * 2.5) | 0);
        for (let i = 0; i < chimneys; i++) {
            const a = rng.range(0, MathUtils.TAU);
            const ox = Math.cos(a) * r * 0.55, oz = Math.sin(a) * r * 0.55;
            field.capsule(0, ox, 0, oz, ox * 1.4, h * rng.range(0.45, 0.75), oz * 1.4,
                r * 0.42, r * 0.12);
        }
        const salt = rng.range(0, 50);
        b.color(PAL.clay);
        Surface3D.polygonise(b, field, {
            cell: r * 0.22,
            // Vertical runnels where rain has streaked the clay, and a paler crust.
            colorFn: (x, y, z) => {
                const streak = Noise.value2(Math.atan2(z, x) * 5 + salt, y * 1.5);
                return _c.copy(PAL.clayDark).lerp(PAL.clay, MathUtils.clamp01(0.35 + y / h))
                    .lerp(PAL.clayLight, streak * 0.45);
            }
        });
        return b.build();
    }

    const BUILDERS = [acaciaTrunk, bush, rock, mound];
    const VARIANTS = 3;

    /* ------------------------------------------------------------------ *
     * Ground cover
     * ------------------------------------------------------------------ */

    /**
     * One tuft: two crossed cards of the grass texture.
     *
     * Blades drawn as geometry cost a dozen triangles each and still read as sticks;
     * a card carries forty blades and seed heads for two. Normals point up, so a tuft
     * is lit like the ground it grows from rather than like a wall.
     */
    function tuftGeometry() {
        const b = new R3D.GeoBuilder();
        b.color(new THREE.Color(1, 1, 1));
        // Ankle-high on a zebra. Any taller and the herds disappear into it, which is
        // the one thing the reserve's grass must never do.
        const w = 0.15, hgt = 0.095;
        const full = { u0: 0, u1: 1, v0: 0, v1: 1 };
        for (let i = 0; i < 2; i++) {
            const a = i * Math.PI / 2 + 0.3;
            const rx = Math.cos(a) * w, rz = Math.sin(a) * w;
            b.card([0, hgt, 0], [rx, 0, rz], [0, hgt, 0], [0, 1, 0], full);
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
         * @param {object} [opts]
         * @param {Array<{x:number,y:number,r:number}>} [opts.clearings] Ground kept
         *   bare of grass: the station's compound, where the ground is worn to earth.
         * @param {Safari.Horizon3D} [opts.horizon] The land beyond the fence, so the
         *   sward can carry on across the boundary instead of stopping at it.
         */
        constructor(world, scene, seed, overlay, vegetation, opts) {
            this.world = world;
            this.scene = scene;
            this.overlay = overlay;
            this.vegetation = vegetation;
            this.clearings = (opts && opts.clearings) || [];
            this.horizon = (opts && opts.horizon) || null;
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
                const material = type === PROP.BUSH ? foliageMaterial()
                    : type === PROP.ROCK ? rockMaterial() : R3D.solidMaterial();
                const mesh = new THREE.InstancedMesh(geo, material, list.length);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                if (type === PROP.BUSH) mesh.customDepthMaterial = foliageDepthMaterial();

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
            const mesh = new THREE.InstancedMesh(geo, foliageMaterial(), list.length);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.customDepthMaterial = foliageDepthMaterial();
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
         * for. Each tuft is tinted from how fertile its ground is: lush green in the
         * wet hollows, gold on the dry plain.
         */
        _buildGroundCover(seed) {
            const world = this.world;
            const rng = new Rng((seed || 1) ^ 0x7EF7);
            const n = world.size;
            const relief = Safari.Relief3D.of(world);
            const placements = [];

            /*
             * Tufts per tile at full fertility.
             *
             * Each tuft is a pair of cards carrying dozens of blades, so this density
             * reads as a continuous sward near the camera; the vertex shader shrinks
             * tufts away with distance, so the far plain costs nothing it cannot show.
             */
            const perTile = 20;
            const fertility = (x, z) => {
                // Bilinear between tile centres, so the sward thins across a boundary
                // instead of stopping at a tile edge.
                const fx = MathUtils.clamp(x - 0.5, 0, n - 1.001);
                const fz = MathUtils.clamp(z - 0.5, 0, n - 1.001);
                const ix = fx | 0, iz = fz | 0;
                const ux = fx - ix, uz = fz - iz;
                const f = world.fertility;
                const a = f[world.index(ix, iz)], b = f[world.index(ix + 1, iz)];
                const c = f[world.index(ix, iz + 1)], d = f[world.index(ix + 1, iz + 1)];
                return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
            };
            for (let ty = 0; ty < n; ty++) {
                for (let tx = 0; tx < n; tx++) {
                    for (let i = 0; i < perTile; i++) {
                        const x = tx + rng.next(), z = ty + rng.next();
                        const fert = fertility(x, z);
                        if (rng.next() > MathUtils.smoothstep(0.04, 0.6, fert)) continue;
                        // Nothing grows in standing water, up a cliff face, or on the
                        // trodden earth of a clearing — thinning out toward its edge.
                        if (world.waterAt(x, z) > 0.02) continue;
                        if (world.slopeAt(x, z) > 0.6) continue;
                        if (this._cleared(x, z, rng)) continue;
                        placements.push(x, z, rng.range(0.7, 1.45), rng.range(0, MathUtils.TAU),
                            MathUtils.clamp01(world.moistureAt(x, z) * 1.4 - 0.25 + rng.spread(0.12)));
                    }
                }
            }

            /*
             * A band of sward beyond the fence.
             *
             * The reserve's grass stopping dead at its boundary drew the fence line
             * across the plain as a hard edge. Past it the tufts carry on, thinning with
             * distance and following the outer land's own moisture, until they are too
             * far out for the camera to show them anyway.
             */
            const inside = placements.length / 5;
            if (this.horizon) {
                const MARGIN = 26;
                for (let ty = -MARGIN; ty < n + MARGIN; ty++) {
                    for (let tx = -MARGIN; tx < n + MARGIN; tx++) {
                        if (tx >= 0 && ty >= 0 && tx < n && ty < n) continue;
                        const edge = Math.max(-tx, -ty, tx - n + 1, ty - n + 1);
                        const lush = Noise.fbm2(tx * 0.06 + 3, ty * 0.06, 3, 2, 0.5);
                        const keep = (1 - edge / MARGIN) * MathUtils.smoothstep(0.3, 0.6, lush);
                        for (let i = 0; i < perTile * 0.6; i++) {
                            if (rng.next() > keep) continue;
                            placements.push(tx + rng.next(), ty + rng.next(),
                                rng.range(0.7, 1.35), rng.range(0, MathUtils.TAU),
                                MathUtils.clamp01(lush * 0.9 - 0.1 + rng.spread(0.12)));
                        }
                    }
                }
            }

            const total = placements.length / 5;
            if (!total) return;

            const mesh = new THREE.InstancedMesh(tuftGeometry(), this._grassMaterial(), total);
            const colours = new Float32Array(total * 3);
            for (let i = 0; i < total; i++) {
                const k = i * 5;
                const x = placements[k], z = placements[k + 1];
                const ground = i < inside ? relief.heightAt(x, z) : this.horizon.heightAt(x, z);
                // Sunk a little, so no card's straight bottom edge shows on a rise.
                _pos.set(x, ground - 0.045, z);
                _euler.set(0, placements[k + 3], 0);
                _quat.setFromEuler(_euler);
                const s = placements[k + 2];
                _scale.set(s, s * (0.8 + placements[k + 4] * 0.6), s);
                _m.compose(_pos, _quat, _scale);
                mesh.setMatrixAt(i, _m);

                const lush = placements[k + 4];
                _c.copy(PAL.grassDry).lerp(PAL.grass, MathUtils.smoothstep(0.1, 0.5, lush))
                    .lerp(PAL.grassLush, MathUtils.smoothstep(0.5, 0.95, lush))
                    .multiplyScalar(0.9 + rng.next() * 0.2);
                colours[i * 3] = _c.r;
                colours[i * 3 + 1] = _c.g;
                colours[i * 3 + 2] = _c.b;
            }
            mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3);
            mesh.instanceMatrix.needsUpdate = true;
            mesh.frustumCulled = false;
            // Grass receives the shadows of everything standing in it, but casting its
            // own would put a hundred thousand cards through the shadow pass for a
            // speckle nobody could see.
            mesh.receiveShadow = true;
            this.scene.add(mesh);
            this.meshes.push(mesh);
            this.grass = mesh;
        }

        /** Is this point inside a clearing? Soft-edged, so the grass thins into it. */
        _cleared(x, z, rng) {
            for (const c of this.clearings) {
                const d = Math.hypot(x - c.x, z - c.y) / c.r;
                if (d < 1 && rng.next() > MathUtils.smoothstep(0.75, 1, d)) return true;
            }
            return false;
        }

        /**
         * Grass that answers to the wind, to the herds and to the camera.
         *
         * The sway is the usual vertex displacement, stronger at the tips. The second
         * part is the overlay: the texture the terrain samples for grazed ground is read
         * here in the vertex shader, and a stripped tile's tufts shrink into it. The
         * third is distance: tufts shrink away beyond the middle distance, where the
         * ground's own colour carries the pasture and a card would only shimmer.
         */
        _grassMaterial() {
            const mat = new THREE.MeshPhongMaterial({
                map: Shading3D.grassTexture(),
                alphaTest: 0.38,
                side: THREE.DoubleSide,
                specular: new THREE.Color(0, 0, 0),
                shininess: 1
            });
            mat.alphaToCoverage = true;
            Shading3D.patch(mat, 'grass', {
                uniforms: {
                    uOverlay: { value: this.overlay },
                    uOverlayScale: { value: 1 / this.world.size }
                },
                vertexHead: 'uniform sampler2D uOverlay;\nuniform float uOverlayScale;',
                vertex: [[
                    '#include <begin_vertex>',
                    [
                        '#include <begin_vertex>',
                        'vec3 tuftOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1],',
                        '                       instanceMatrix[3][2]);',
                        'vec4 tuftOv = texture2D(uOverlay, tuftOrigin.xz * uOverlayScale);',
                        // Grazed pasture is cropped short; burnt ground has none at all.
                        'float crop = (1.0 - tuftOv.r * 0.8) * (1.0 - tuftOv.g);',
                        'float far = distance(cameraPosition.xz, tuftOrigin.xz);',
                        'crop *= 1.0 - smoothstep(34.0, 58.0, far);',
                        'transformed.y *= crop;',
                        'float tip = uv.y;',
                        'float sway = sin(uTime * 1.9 + tuftOrigin.x * 1.3 + tuftOrigin.z * 0.9);',
                        'transformed.xz += sway * uWind * 0.05 * tip * tip;'
                    ].join('\n')
                ]]
            });
            return mat;
        }

        /**
         * @param {number} now Simulated seconds, for foliage regrowth.
         */
        update(dt, wind, now) {
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
    Flora3D.foliageMaterial = foliageMaterial;
    Safari.Flora3D = Flora3D;

})(window.Safari, window.THREE);
