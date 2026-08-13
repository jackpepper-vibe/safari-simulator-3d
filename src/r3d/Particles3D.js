/**
 * Safari Simulator 3D — Particles.
 *
 * The 2D build's particle system lived in projected screen space with `z` as height
 * above the plane, which was the right shape for a projection with no perspective.
 * There is a real camera now, so particles are simply points in the world.
 *
 * Two pools, because the two things particles do here composite differently: dust,
 * splashes and smoke are soft and occlude, while sparkles, embers and fireflies are
 * light and add. Each pool is one buffer and one draw call however many are alive.
 *
 * The emitter names are carried over from the 2D system — `dust`, `splash`, `sparkle`,
 * `puff`, `impact`, `heart`, `sleepMark`, `dartTrail` — so the scene's binding of
 * simulation events to effects reads the same in both builds.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Rng, Config } = Safari;

    const VERT = [
        'attribute float size;',
        'attribute float alpha;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main() {',
        '  vColor = color;',
        '  vAlpha = alpha;',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = size * (260.0 / max(0.1, -mv.z));',
        '  gl_Position = projectionMatrix * mv;',
        '}'
    ].join('\n');

    const FRAG = [
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main() {',
        '  vec2 d = gl_PointCoord - vec2(0.5);',
        '  float r = dot(d, d);',
        '  if (r > 0.25) discard;',
        '  float falloff = 1.0 - smoothstep(0.04, 0.25, r);',
        '  gl_FragColor = vec4(vColor, vAlpha * falloff);',
        // A hand-written shader has to do its own colour management; Three only injects
        // these into its own materials.
        '#include <tonemapping_fragment>',
        '#include <encodings_fragment>',
        '}'
    ].join('\n');

    /**
     * A fixed-size pool of points.
     *
     * Dead particles are swapped down from the end of the live range rather than being
     * skipped, so the draw range is always exactly the live count and the buffer never
     * needs compacting.
     */
    class Pool {
        constructor(scene, max, additive) {
            this.max = max;
            this.count = 0;

            this.pos = new Float32Array(max * 3);
            this.col = new Float32Array(max * 3);
            this.size = new Float32Array(max);
            this.alpha = new Float32Array(max);

            this.vel = new Float32Array(max * 3);
            this.life = new Float32Array(max);
            this.maxLife = new Float32Array(max);
            this.drag = new Float32Array(max);
            this.grav = new Float32Array(max);
            this.grow = new Float32Array(max);
            this.baseAlpha = new Float32Array(max);

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
            geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
            geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
            geo.setDrawRange(0, 0);
            geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

            const mat = new THREE.ShaderMaterial({
                vertexShader: VERT,
                fragmentShader: FRAG,
                transparent: true,
                depthWrite: false,
                vertexColors: true,
                blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
            });

            this.geometry = geo;
            this.points = new THREE.Points(geo, mat);
            this.points.frustumCulled = false;
            this.points.renderOrder = 4;
            scene.add(this.points);
        }

        /**
         * @param {object} p Emission parameters, all in world units.
         */
        emit(p) {
            const i = this.count < this.max ? this.count++ : (Math.random() * this.max) | 0;
            const i3 = i * 3;

            this.pos[i3] = p.x;
            this.pos[i3 + 1] = p.y;
            this.pos[i3 + 2] = p.z;
            this.vel[i3] = p.vx || 0;
            this.vel[i3 + 1] = p.vy || 0;
            this.vel[i3 + 2] = p.vz || 0;

            const c = p.color;
            this.col[i3] = c.r;
            this.col[i3 + 1] = c.g;
            this.col[i3 + 2] = c.b;

            this.size[i] = p.size;
            this.grow[i] = p.grow || 0;
            this.life[i] = p.life;
            this.maxLife[i] = p.life;
            this.drag[i] = p.drag === undefined ? 1.6 : p.drag;
            this.grav[i] = p.gravity === undefined ? -0.4 : p.gravity;
            this.baseAlpha[i] = p.alpha === undefined ? 0.8 : p.alpha;
            this.alpha[i] = this.baseAlpha[i];
        }

        update(dt, wind) {
            let n = this.count;
            for (let i = 0; i < n; i++) {
                this.life[i] -= dt;
                if (this.life[i] <= 0) {
                    n--;
                    this._swap(i, n);
                    i--;
                    continue;
                }

                const i3 = i * 3;
                const damp = Math.exp(-this.drag[i] * dt);
                this.vel[i3] = this.vel[i3] * damp + wind * 0.25 * dt;
                this.vel[i3 + 1] = this.vel[i3 + 1] * damp + this.grav[i] * dt;
                this.vel[i3 + 2] *= damp;

                this.pos[i3] += this.vel[i3] * dt;
                this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
                this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

                const t = this.life[i] / this.maxLife[i];
                this.size[i] += this.grow[i] * dt;
                this.alpha[i] = this.baseAlpha[i] * MathUtils.clamp01(t * 1.6);
            }
            this.count = n;

            this.geometry.setDrawRange(0, n);
            if (n > 0) {
                this.geometry.attributes.position.needsUpdate = true;
                this.geometry.attributes.color.needsUpdate = true;
                this.geometry.attributes.size.needsUpdate = true;
                this.geometry.attributes.alpha.needsUpdate = true;
            }
        }

        _swap(a, b) {
            if (a === b) return;
            const a3 = a * 3, b3 = b * 3;
            for (let k = 0; k < 3; k++) {
                this.pos[a3 + k] = this.pos[b3 + k];
                this.col[a3 + k] = this.col[b3 + k];
                this.vel[a3 + k] = this.vel[b3 + k];
            }
            this.size[a] = this.size[b];
            this.alpha[a] = this.alpha[b];
            this.life[a] = this.life[b];
            this.maxLife[a] = this.maxLife[b];
            this.drag[a] = this.drag[b];
            this.grav[a] = this.grav[b];
            this.grow[a] = this.grow[b];
            this.baseAlpha[a] = this.baseAlpha[b];
        }

        clear() {
            this.count = 0;
            this.geometry.setDrawRange(0, 0);
        }
    }

    /* ------------------------------------------------------------------ *
     * The system
     * ------------------------------------------------------------------ */

    const _c = new THREE.Color();
    const rgb = (t) => _c.setRGB(t.r / 255, t.g / 255, t.b / 255).convertSRGBToLinear();

    class Particles3D {
        constructor(scene, seed) {
            const max = Config.render.maxParticles;
            this.rng = new Rng((seed || 1) ^ 0xBEE5);
            this.soft = new Pool(scene, max, false);
            this.glow = new Pool(scene, Math.floor(max * 0.6), true);

            /**
             * One flickering light for the fire.
             *
             * A wildfire is the brightest thing that can happen on the reserve and the
             * only light source other than the sky, so it gets an actual light rather
             * than additive sprites alone — a front at night throws its glow onto the
             * ground and onto whatever is fleeing it.
             */
            this.fireLight = new THREE.PointLight(0xff8a30, 0, 26, 2);
            this.fireLight.visible = false;
            scene.add(this.fireLight);

            this._moteTimer = 0;
        }

        get count() {
            return this.soft.count + this.glow.count;
        }

        /* --- Emitters, named as in the 2D build ------------------------- */

        /** Hoof dust. `strength` 0..1-ish, `tint` an `{r,g,b}` 0..255 triple. */
        dust(x, y, z, strength, tint) {
            const n = 1 + (this.rng.next() < strength ? 1 : 0);
            for (let i = 0; i < n; i++) {
                this.soft.emit({
                    x: x + this.rng.spread(0.12), y: y + 0.04, z: z + this.rng.spread(0.12),
                    vx: this.rng.spread(0.35), vy: 0.25 + this.rng.next() * 0.4,
                    vz: this.rng.spread(0.35),
                    color: rgb(tint || { r: 196, g: 184, b: 128 }),
                    size: 0.9 + strength * 1.4, grow: 1.6,
                    life: 0.7 + this.rng.next() * 0.6,
                    alpha: 0.20 + strength * 0.22, gravity: -0.15, drag: 2.2
                });
            }
        }

        /** Water thrown up by something wading. */
        splash(x, y, z, strength, tint) {
            for (let i = 0; i < 3; i++) {
                this.soft.emit({
                    x, y: y + 0.05, z,
                    vx: this.rng.spread(1.1), vy: 0.8 + this.rng.next() * 1.2,
                    vz: this.rng.spread(1.1),
                    color: rgb(tint || { r: 150, g: 205, b: 220 }),
                    size: 0.5 + strength * 0.6, grow: 0.2,
                    life: 0.45 + this.rng.next() * 0.3,
                    alpha: 0.55, gravity: -3.4, drag: 0.5
                });
            }
        }

        /** A warm flourish: a placement, or a scatter of forage landing. */
        sparkle(x, y, z, tint) {
            for (let i = 0; i < 9; i++) {
                const a = this.rng.range(0, MathUtils.TAU);
                const s = this.rng.range(0.4, 1.5);
                this.glow.emit({
                    x, y: y + 0.15, z,
                    vx: Math.cos(a) * s, vy: this.rng.range(0.6, 1.8), vz: Math.sin(a) * s,
                    color: rgb(tint || { r: 255, g: 226, b: 150 }),
                    size: 0.5, grow: -0.2,
                    life: 0.7 + this.rng.next() * 0.5,
                    alpha: 0.9, gravity: -1.1, drag: 1.4
                });
            }
        }

        /** A birth. Soft, warm, and unmistakably a good thing. */
        heart(x, y, z) {
            for (let i = 0; i < 12; i++) {
                const a = this.rng.range(0, MathUtils.TAU);
                this.glow.emit({
                    x, y: y + 0.3, z,
                    vx: Math.cos(a) * 0.35, vy: this.rng.range(0.7, 1.3),
                    vz: Math.sin(a) * 0.35,
                    color: rgb({ r: 255, g: 168, b: 190 }),
                    size: 0.55, grow: -0.1,
                    life: 1.2 + this.rng.next() * 0.5,
                    alpha: 0.8, gravity: 0.15, drag: 1.1
                });
            }
        }

        /** A puff of fur or smoke. */
        puff(x, y, z, tint, scale) {
            const s = scale || 1;
            for (let i = 0; i < 7; i++) {
                this.soft.emit({
                    x, y: y + 0.2, z,
                    vx: this.rng.spread(0.9 * s), vy: this.rng.range(0.2, 1.0) * s,
                    vz: this.rng.spread(0.9 * s),
                    color: rgb(tint),
                    size: 0.8 * s, grow: 0.9,
                    life: 0.9 + this.rng.next() * 0.6,
                    alpha: 0.5, gravity: -0.2, drag: 1.8
                });
            }
        }

        /** A dart landing home. */
        impact(x, y, z, tint) {
            for (let i = 0; i < 8; i++) {
                const a = this.rng.range(0, MathUtils.TAU);
                this.glow.emit({
                    x, y, z,
                    vx: Math.cos(a) * 1.4, vy: this.rng.range(0.3, 1.2), vz: Math.sin(a) * 1.4,
                    color: rgb(tint || { r: 150, g: 240, b: 255 }),
                    size: 0.45, grow: -0.1,
                    life: 0.4 + this.rng.next() * 0.25,
                    alpha: 0.95, gravity: -1.5, drag: 2.6
                });
            }
        }

        /** Sleep: a slow drift upward from a resting animal. */
        sleepMark(x, y, z) {
            this.soft.emit({
                x, y, z,
                vx: 0.05, vy: 0.35, vz: 0,
                color: rgb({ r: 210, g: 225, b: 240 }),
                size: 0.5, grow: 0.35,
                life: 1.8, alpha: 0.32, gravity: 0.12, drag: 0.4
            });
        }

        /** A tracer behind a dart in flight. */
        dartTrail(x, y, z) {
            this.glow.emit({
                x, y, z,
                vx: 0, vy: 0, vz: 0,
                color: rgb({ r: 140, g: 224, b: 255 }),
                size: 0.32, grow: -0.3,
                life: 0.22, alpha: 0.7, gravity: 0, drag: 0
            });
        }

        /** Flame and ember from a burning tile. */
        fire(x, y, z, heat) {
            this.glow.emit({
                x: x + this.rng.spread(0.4), y: y + 0.1, z: z + this.rng.spread(0.4),
                vx: this.rng.spread(0.3), vy: this.rng.range(1.0, 2.4), vz: this.rng.spread(0.3),
                color: rgb({ r: 255, g: 150 + this.rng.next() * 80, b: 60 }),
                size: 1.1 + heat, grow: -0.5,
                life: 0.45 + this.rng.next() * 0.35,
                alpha: 0.7 * heat, gravity: 1.6, drag: 1.2
            });
            if (this.rng.next() < 0.35) {
                this.soft.emit({
                    x, y: y + 0.6, z,
                    vx: this.rng.spread(0.4), vy: this.rng.range(0.8, 1.6), vz: this.rng.spread(0.4),
                    color: rgb({ r: 60, g: 54, b: 48 }),
                    size: 1.6, grow: 2.2,
                    life: 1.6 + this.rng.next(), alpha: 0.28, gravity: 0.5, drag: 0.9
                });
            }
        }

        /**
         * Ambient motes around the camera: pollen by day, fireflies by night.
         *
         * Spawned near the focus rather than across the reserve, because a mote is only
         * worth simulating where it can be seen.
         */
        motes(dt, rig, light) {
            this._moteTimer -= dt;
            if (this._moteTimer > 0) return;
            this._moteTimer = 0.12;

            const night = 1 - light.daylight;
            const r = 6 + rig.dist * 0.35;
            const x = rig.focusX + this.rng.spread(r);
            const z = rig.focusY + this.rng.spread(r);
            const y = rig.focusH + this.rng.range(0.3, 2.4);

            if (night > 0.5) {
                this.glow.emit({
                    x, y, z,
                    vx: this.rng.spread(0.2), vy: this.rng.spread(0.15), vz: this.rng.spread(0.2),
                    color: rgb({ r: 190, g: 255, b: 140 }),
                    size: 0.35, grow: 0,
                    life: 2.4 + this.rng.next() * 2, alpha: 0.85, gravity: 0.02, drag: 0.2
                });
            } else {
                this.soft.emit({
                    x, y, z,
                    vx: this.rng.spread(0.25), vy: this.rng.spread(0.1), vz: this.rng.spread(0.25),
                    color: rgb({ r: 250, g: 240, b: 205 }),
                    size: 0.28, grow: 0,
                    life: 3 + this.rng.next() * 2.5, alpha: 0.30, gravity: -0.02, drag: 0.3
                });
            }
        }

        /* --- Frame ------------------------------------------------------- */

        /**
         * @param {number} dt
         * @param {number} wind
         * @param {{x:number,y:number,z:number,heat:number}|null} fireCentre
         */
        update(dt, wind, fireCentre) {
            this.soft.update(dt, wind);
            this.glow.update(dt, wind);

            if (fireCentre) {
                this.fireLight.visible = true;
                this.fireLight.position.set(fireCentre.x, fireCentre.y + 1.2, fireCentre.z);
                // Flicker, so a front reads as burning rather than as a lamp.
                this.fireLight.intensity = (2.2 + Math.sin(performance.now() * 0.011) * 0.6) *
                    MathUtils.clamp01(fireCentre.heat);
                this.fireLight.distance = 14 + fireCentre.heat * 22;
            } else {
                this.fireLight.visible = false;
            }
        }

        clear() {
            this.soft.clear();
            this.glow.clear();
        }
    }

    Safari.Particles3D = Particles3D;

})(window.Safari, window.THREE);
