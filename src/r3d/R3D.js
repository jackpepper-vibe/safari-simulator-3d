/**
 * Safari Simulator 3D — Presentation kit.
 *
 * The shared foundation every model in the reserve is built from: the scale that
 * converts the simulation's tile space into world space, the colour pipeline, and a
 * geometry builder that merges primitives into single buffers.
 *
 * WORLD SPACE
 * -----------
 *   tile x        → world  X
 *   tile y        → world  Z          (the camera looks north, so smaller y is far)
 *   elevation     → world  Y
 *
 * One tile is one world unit. Everything else is derived from that, including the
 * species rigs: those are authored in isometric screen pixels, and `PX` is the
 * conversion. A tile projects to a 64px diamond in the 2D build, which is 32·√2 ≈ 45.25
 * pixels of unforeshortened ground, so that is what one tile of rig measures.
 *
 * DRAW CALLS
 * ----------
 * Nothing here produces a mesh per part. Structures, vehicles and props merge their
 * whole primitive kit into one geometry with colour baked per vertex; creatures do the
 * same and bind the result to a skeleton. A zebra is one draw call, not twenty-six,
 * which is what makes a hundred of them affordable.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils } = Safari;

    /** World units per rig pixel. See the header. */
    const PX = 1 / 45.25;

    /**
     * World units per elevation level.
     *
     * The 2D build lifts a tile 18 screen pixels per level, which in these units would
     * be 0.4 — barely a ripple across an 86-tile reserve once you can see it in
     * perspective. Real relief is exaggerated about threefold so the benches read as
     * escarpments from a low camera, which is the whole reason for the fork.
     */
    const HEIGHT = 1.25;

    /** Basin depth, in world units, at full water depth. Pools are carved, not painted. */
    const WATER_DEPTH = 0.62;

    /* ------------------------------------------------------------------ *
     * Colour
     * ------------------------------------------------------------------ */

    const _c = new THREE.Color();

    /**
     * Authored sRGB → the linear values the renderer wants.
     *
     * The renderer writes sRGB, so Three treats every material and vertex colour as
     * already linear. Every hex in this project is picked by eye as sRGB, so all of
     * them come through here. Skipping it lifts the whole palette to pale putty.
     *
     * @param {string|number} hex
     * @returns {THREE.Color}
     */
    function col(hex) {
        return new THREE.Color(hex).convertSRGBToLinear();
    }

    /** The same, for the `{r,g,b}` 0..255 triples the palettes deal in. */
    function colOf(rgb) {
        return new THREE.Color(rgb.r / 255, rgb.g / 255, rgb.b / 255).convertSRGBToLinear();
    }

    /** Scratch colour, for hot paths that must not allocate. */
    function tmpCol(hex) {
        return _c.set(hex).convertSRGBToLinear();
    }

    /* ------------------------------------------------------------------ *
     * Unit primitives
     * ------------------------------------------------------------------ */

    /**
     * The kit. Every one is a unit shape at the origin, scaled and placed by the
     * builder — so the vertex data is authored once and reused by everything.
     */
    const UNIT = {
        /** Radius 1, centred. */
        sphere: new THREE.SphereGeometry(1, 16, 12),
        sphereLow: new THREE.SphereGeometry(1, 10, 7),
        /**
         * For torsos that carry markings.
         *
         * Stripes and patches are baked into vertex colours rather than a texture, so
         * the mesh has to be fine enough to resolve them: a zebra's twelve stripes over
         * sixteen segments came out as a uniform pale body, which is not a zebra.
         */
        sphereHi: new THREE.SphereGeometry(1, 44, 26),
        /** Radius 1, height 1, axis +Y, centred. */
        cylinder: new THREE.CylinderGeometry(1, 1, 1, 12, 1),
        cylinderLow: new THREE.CylinderGeometry(1, 1, 1, 7, 1),
        cone: new THREE.CylinderGeometry(0, 1, 1, 10, 1),
        box: new THREE.BoxGeometry(1, 1, 1),
        /** Unit square in the XZ plane, facing +Y. */
        quad: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
    };

    /** Tapered cylinders are wanted at arbitrary ratios; cache them by rounded ratio. */
    const _tapers = new Map();
    function taper(ratio, radial) {
        const key = (radial || 10) + ':' + ratio.toFixed(2);
        let g = _tapers.get(key);
        if (!g) {
            g = new THREE.CylinderGeometry(ratio, 1, 1, radial || 10, 1);
            _tapers.set(key, g);
        }
        return g;
    }

    /* ------------------------------------------------------------------ *
     * Geometry builder
     * ------------------------------------------------------------------ */

    const _m = new THREE.Matrix4();
    const _mn = new THREE.Matrix3();
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _e = new THREE.Euler();
    const _s = new THREE.Vector3();

    /**
     * Accumulates transformed primitives into one interleaved buffer.
     *
     * Colour is per vertex rather than per material, so a whole animal — hide, hooves,
     * muzzle, eyes, stripes — is one geometry with one material. `bone()` tags the
     * vertices that follow, which is what turns the same data into a skinned mesh.
     */
    class GeoBuilder {
        /** @param {boolean} [skinned] Emit skinIndex/skinWeight attributes. */
        constructor(skinned) {
            this.pos = [];
            this.nrm = [];
            this.rgb = [];
            /**
             * Texture coordinates. Almost everything is untextured and takes the current
             * `_uv` point; leaf cards map a rectangle of the foliage atlas.
             */
            this.uvs = [];
            this.idx = [];
            this.skinned = !!skinned;
            if (this.skinned) {
                this.si = [];
                this.sw = [];
            }
            /** Per-vertex extra channels, by attribute name: `{size, data, value}`. */
            this.channels = {};

            this._stack = [];
            this._mat = new THREE.Matrix4();
            this._color = new THREE.Color(1, 1, 1);
            this._bone = 0;
            this._uv = [0.5, 0.5];
        }

        /**
         * Declare an extra per-vertex attribute. Every vertex emitted from now on
         * carries the channel's current value, set with `set()`; vertices emitted
         * before the declaration are back-filled with `init`.
         *
         * @param {string} name Attribute name as the shader sees it.
         * @param {number} size Components.
         * @param {Array<number>} init Value for existing and following vertices.
         */
        channel(name, size, init) {
            const data = [];
            for (let i = 0; i < this.vertexCount; i++) data.push(...init);
            this.channels[name] = { size, data, value: init.slice() };
            return this;
        }

        /** Set a channel's value for everything emitted next. */
        set(name, value) {
            this.channels[name].value = value.slice();
            return this;
        }

        /** Record one vertex's worth of every channel. Called by each emitter. */
        _emitChannels() {
            for (const key in this.channels) {
                const ch = this.channels[key];
                for (let i = 0; i < ch.size; i++) ch.data.push(ch.value[i]);
            }
        }

        /** Texture coordinate for untextured primitives emitted next. */
        uv(u, v) {
            this._uv[0] = u;
            this._uv[1] = v;
            return this;
        }

        /* --- Transform stack ------------------------------------------- */

        push() {
            this._stack.push(this._mat.clone());
            return this;
        }

        pop() {
            this._mat = this._stack.pop() || new THREE.Matrix4();
            return this;
        }

        /** Concatenate a translation onto the current transform. */
        translate(x, y, z) {
            this._mat.multiply(_m.makeTranslation(x, y, z));
            return this;
        }

        /** Concatenate an Euler rotation (radians, XYZ order). */
        rotate(x, y, z) {
            _e.set(x || 0, y || 0, z || 0);
            this._mat.multiply(_m.makeRotationFromEuler(_e));
            return this;
        }

        scale(x, y, z) {
            this._mat.multiply(_m.makeScale(x, y === undefined ? x : y, z === undefined ? x : z));
            return this;
        }

        /** Replace the current transform outright. */
        setMatrix(m) {
            this._mat.copy(m);
            return this;
        }

        /* --- State ------------------------------------------------------ */

        /** @param {THREE.Color} c Colour for everything added next. */
        color(c) {
            this._color.copy(c);
            return this;
        }

        /** @param {number} i Bone index for everything added next. */
        bone(i) {
            this._bone = i;
            return this;
        }

        /* --- Emission ---------------------------------------------------- */

        /**
         * Append a unit geometry under the current transform.
         *
         * @param {THREE.BufferGeometry} geo
         * @param {object} [opts]
         * @param {function(number,number,number):THREE.Color} [opts.colorFn] Per-vertex
         *   colour, given the vertex position in the geometry's own local space. This is
         *   how markings are painted — a zebra's stripes are a function of the position
         *   along its body, not a texture.
         */
        add(geo, opts) {
            const src = geo.attributes.position;
            const srcN = geo.attributes.normal;
            const index = geo.index;
            const base = this.pos.length / 3;
            const colorFn = opts && opts.colorFn;

            _mn.getNormalMatrix(this._mat);

            for (let i = 0; i < src.count; i++) {
                const lx = src.getX(i), ly = src.getY(i), lz = src.getZ(i);
                _v.set(lx, ly, lz).applyMatrix4(this._mat);
                this.pos.push(_v.x, _v.y, _v.z);

                _v.set(srcN.getX(i), srcN.getY(i), srcN.getZ(i))
                    .applyMatrix3(_mn).normalize();
                this.nrm.push(_v.x, _v.y, _v.z);

                const c = colorFn ? colorFn(lx, ly, lz) : this._color;
                this.rgb.push(c.r, c.g, c.b);
                this.uvs.push(this._uv[0], this._uv[1]);

                if (this.skinned) {
                    this.si.push(this._bone, 0, 0, 0);
                    this.sw.push(1, 0, 0, 0);
                }
                if (opts && opts.channelFn) opts.channelFn(lx, ly, lz, this);
                this._emitChannels();
            }

            if (index) {
                for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
            } else {
                for (let i = 0; i < src.count; i++) this.idx.push(base + i);
            }
            return this;
        }

        /* --- Convenience shapes ------------------------------------------ */

        /** Ellipsoid with the given semi-axes at the current transform. */
        sphere(rx, ry, rz, opts) {
            this.push().scale(rx, ry === undefined ? rx : ry, rz === undefined ? rx : rz);
            const geo = (opts && opts.hi) ? UNIT.sphereHi
                : ((opts && opts.low) ? UNIT.sphereLow : UNIT.sphere);
            this.add(geo, opts);
            return this.pop();
        }

        /** Box with the given full extents. */
        box(sx, sy, sz, opts) {
            this.push().scale(sx, sy, sz);
            this.add(UNIT.box, opts);
            return this.pop();
        }

        /**
         * A limb: a tapered cylinder from one point to another, capped with spheres so
         * joints stay round however the bones fold.
         *
         * Both points are in the current transform's space.
         */
        limb(ax, ay, az, bx, by, bz, rA, rB, opts) {
            const dx = bx - ax, dy = by - ay, dz = bz - az;
            const len = Math.hypot(dx, dy, dz);
            if (len < 1e-5) return this;

            this.push();
            this.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);

            // Point the cylinder's +Y axis down the segment.
            _v.set(dx / len, dy / len, dz / len);
            _q.setFromUnitVectors(_s.set(0, 1, 0), _v);
            this._mat.multiply(_m.makeRotationFromQuaternion(_q));

            this.push().scale(rA, len, rA);
            // The cached taper has its ratio end at +Y, which the rotation above put at
            // point B — so the segment thins from rA to rB along its length.
            this.add(taper(Math.max(0.02, rB / rA), (opts && opts.radial) || 10), opts);
            this.pop();
            this.pop();

            if (!opts || !opts.noCaps) {
                this.push().translate(ax, ay, az).sphere(rA, rA, rA, { low: true }).pop();
                this.push().translate(bx, by, bz).sphere(rB, rB, rB, { low: true }).pop();
            }
            return this;
        }

        /** Cone with its base at the origin and its point at +Y. */
        cone(radius, height, opts) {
            this.push().translate(0, height / 2, 0).scale(radius, height, radius);
            this.add(UNIT.cone, opts);
            return this.pop();
        }

        /**
         * A textured card: a quad centred on a point, in the builder's current space.
         *
         * The card spans `right` and `up` (not necessarily orthogonal, not normalised —
         * their lengths are the half-extents). Its normal is supplied rather than
         * derived: leaf cards take the normal of the clump they belong to, so a crown
         * lights as one soft volume instead of as a heap of flat, randomly-facing
         * squares.
         *
         * @param {Array<number>} centre [x, y, z]
         * @param {Array<number>} right  Half-extent vector along the card's u.
         * @param {Array<number>} up     Half-extent vector along its v.
         * @param {Array<number>} normal Shading normal for all four corners.
         * @param {{u0:number,u1:number,v0:number,v1:number}} rect Atlas rectangle.
         */
        card(centre, right, up, normal, rect) {
            const base = this.pos.length / 3;
            const corners = [[-1, -1, rect.u0, rect.v0], [1, -1, rect.u1, rect.v0],
                [1, 1, rect.u1, rect.v1], [-1, 1, rect.u0, rect.v1]];
            _mn.getNormalMatrix(this._mat);
            _s.set(normal[0], normal[1], normal[2]).applyMatrix3(_mn).normalize();
            for (const [a, b, u, v] of corners) {
                _v.set(centre[0] + right[0] * a + up[0] * b,
                    centre[1] + right[1] * a + up[1] * b,
                    centre[2] + right[2] * a + up[2] * b).applyMatrix4(this._mat);
                this.pos.push(_v.x, _v.y, _v.z);
                this.nrm.push(_s.x, _s.y, _s.z);
                this.rgb.push(this._color.r, this._color.g, this._color.b);
                this.uvs.push(u, v);
                if (this.skinned) {
                    this.si.push(this._bone, 0, 0, 0);
                    this.sw.push(1, 0, 0, 0);
                }
                this._emitChannels();
            }
            this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
            return this;
        }

        /* --- Output -------------------------------------------------------- */

        /** @returns {THREE.BufferGeometry} */
        build() {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
            g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
            g.setAttribute('color', new THREE.Float32BufferAttribute(this.rgb, 3));
            g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
            for (const key in this.channels) {
                const ch = this.channels[key];
                g.setAttribute(key, new THREE.Float32BufferAttribute(ch.data, ch.size));
            }
            if (this.skinned) {
                g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
                g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
            }
            g.setIndex(this.idx);
            g.computeBoundingSphere();
            return g;
        }

        get vertexCount() {
            return this.pos.length / 3;
        }
    }

    /* ------------------------------------------------------------------ *
     * Materials
     * ------------------------------------------------------------------ */

    /**
     * Two materials for the entire reserve.
     *
     * Everything is vertex-coloured, so the only thing that varies between a boulder
     * and a lion is whether the vertices are driven by a skeleton. Keeping the count
     * this low is what lets the renderer batch and what keeps the shadow pass cheap.
     *
     * Phong rather than Lambert, with next to no specular. In this version of Three a
     * Lambert material is lit per *vertex*, so a coarse mesh shades in visible facets
     * and nothing finer than a triangle can ever catch the light. Phong with a black
     * specular is the same diffuse model evaluated per pixel — and the faint sheen left
     * in is what makes a hide or a painted bonnet read as a surface rather than as
     * clay.
     */
    let _solid = null;
    let _skinned = null;

    function solidMaterial() {
        if (!_solid) {
            _solid = new THREE.MeshPhongMaterial({
                vertexColors: true, specular: col('#141414'), shininess: 14
            });
        }
        return _solid;
    }

    function skinnedMaterial() {
        if (!_skinned) {
            _skinned = new THREE.MeshPhongMaterial({
                vertexColors: true, skinning: true, specular: col('#1c1c1c'), shininess: 20
            });
        }
        return _skinned;
    }

    /* ------------------------------------------------------------------ *
     * Quality tiers
     * ------------------------------------------------------------------ */

    /**
     * How much the device can be asked to draw.
     *
     * `high` is the game as designed. `low` is for software rendering — Chrome falls
     * back to SwiftShader when a machine's graphics driver is blocklisted, inside most
     * virtual machines and over some remote desktops — where a single frame of the full
     * scene takes long enough to trip the browser's GPU watchdog and lose the context.
     * Low drops the post pass, most of the grass and the shadow resolution, which is
     * the difference between a plainer game and no game.
     */
    const TIERS = {
        high: { tier: 'high', post: true, grass: 1, shadowMap: 2048, maxPixelRatio: 2 },
        low: { tier: 'low', post: false, grass: 0.2, shadowMap: 1024, maxPixelRatio: 1 }
    };
    const QUALITY = Object.assign({}, TIERS.high);

    /** @param {'high'|'low'} tier */
    function setQuality(tier) {
        Object.assign(QUALITY, TIERS[tier] || TIERS.high);
        return QUALITY;
    }

    /**
     * Pick a tier for a renderer: `?quality=low|high` in the URL wins; otherwise a
     * software rasteriser gets `low` and everything else `high`.
     * @param {THREE.WebGLRenderer} renderer
     */
    function detectQuality(renderer) {
        let forced = null;
        try {
            forced = new URLSearchParams(window.location.search).get('quality');
        } catch (e) {
            forced = null;
        }
        if (forced && TIERS[forced]) return setQuality(forced);

        const name = rendererName(renderer.getContext()) || probeRendererName();
        const software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
        QUALITY.renderer = name;
        return setQuality(software ? 'low' : 'high');
    }

    /** The GPU's name as the driver reports it, or '' if the context cannot say. */
    function rendererName(gl) {
        if (!gl || gl.isContextLost()) return '';
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER);
        return name ? String(name) : '';
    }

    /**
     * Ask a throwaway context, when the game's own cannot answer — it can be lost at
     * the moment it is created, which software rasterisers in particular do, and a
     * lost context reports no renderer at all. Released at once.
     */
    function probeRendererName() {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            const name = rendererName(gl);
            const lose = gl && gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
            return name;
        } catch (e) {
            return '';
        }
    }

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */

    /**
     * Ground height in world units at continuous tile coordinates.
     *
     * The single place elevation is converted, so nothing else has to know about
     * `HEIGHT` — and so carving pool basins in one place moves every animal, tree and
     * wheel that stands on them.
     */
    function groundY(world, tx, ty) {
        return world.heightAt(tx, ty) * HEIGHT;
    }

    /**
     * Basin depth at a point, smoothed.
     *
     * The water field goes from dry to full depth over about a tile, which is fine when
     * it only decides what colour to paint the ground but not when it carves geometry:
     * sampled three times per tile it produced a saw-toothed rim of triangles standing
     * out of every shoreline. Averaging over a wider kernel spreads the transition to
     * roughly two tiles, which is both smoother to look at and closer to what the bank
     * of a waterhole does.
     */
    function waterCarve(world, tx, ty) {
        const d = 0.7;
        return (world.waterAt(tx, ty) * 2 +
            world.waterAt(tx + d, ty) + world.waterAt(tx - d, ty) +
            world.waterAt(tx, ty + d) + world.waterAt(tx, ty - d)) / 6;
    }

    /**
     * The drawn ground: pool beds cut and banks raised to hold a level waterline —
     * what the terrain mesh actually is, and what everything stands on. See Relief3D.
     */
    function surfaceY(world, tx, ty) {
        return Safari.Relief3D.of(world).heightAt(tx, ty);
    }

    /**
     * Surface normal of the terrain, for standing vehicles and props on a slope.
     * @param {THREE.Vector3} out
     */
    function groundNormal(world, tx, ty, out, spread) {
        const d = spread || 0.6;
        const ex = groundY(world, tx + d, ty) - groundY(world, tx - d, ty);
        const ez = groundY(world, tx, ty + d) - groundY(world, tx, ty - d);
        return out.set(-ex, 2 * d, -ez).normalize();
    }

    Safari.R3D = {
        PX, HEIGHT, WATER_DEPTH,
        UNIT, taper,
        col, colOf, tmpCol,
        GeoBuilder,
        solidMaterial, skinnedMaterial,
        QUALITY, setQuality, detectQuality,
        groundY, surfaceY, waterCarve, groundNormal,
        /** Rig pixels → world units. */
        px(v) { return v * PX; },
        /** Model authored nose-along-+X → a simulation heading. */
        yawFor(facing) { return -facing; },
        clamp01: MathUtils.clamp01
    };

})(window.Safari, window.THREE);
