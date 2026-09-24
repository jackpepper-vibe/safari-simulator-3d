/**
 * Safari Simulator 3D — Built things.
 *
 * The ranger station, the boundary gate, the four vehicles and the items lying on the
 * ground. Each is assembled from the shared primitive kit and merged into as few
 * geometries as its moving parts allow, with colour per vertex, so a whole building is
 * one draw call and a vehicle is a handful.
 *
 * VEHICLES
 * --------
 * The simulation drives a point with a heading and a speed. Everything that makes a
 * vehicle look *driven* is worked out here from how that point moves: each wheel finds
 * the ground under itself, the body settles onto them and pitches and rolls with the
 * terrain, squats when it pulls away and dives when it brakes, leans out of a turn, and
 * the front wheels steer into it. None of it is written back; it is all read from the
 * frame-to-frame change in the vehicle's own state.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Noise, R3D } = Safari;

    const PAL = {
        // The jeep: sun-bleached reserve green with a canvas roof.
        jeep: R3D.col('#66704c'),
        jeepDark: R3D.col('#434b31'),
        jeepTrim: R3D.col('#2b2e26'),
        canvasTop: R3D.col('#c7b68c'),
        seat: R3D.col('#5a4633'),
        tyre: R3D.col('#1f1e1c'),
        tread: R3D.col('#2d2b28'),
        rim: R3D.col('#a19b8e'),
        hub: R3D.col('#5f5a52'),
        glass: R3D.col('#5f7d88'),
        lamp: R3D.col('#fff1c9'),
        tail: R3D.col('#b53a2c'),
        chrome: R3D.col('#c9c6bd'),

        // Working vehicles are yellow plant, and the poachers' truck is not.
        plant: R3D.col('#cf9d2c'),
        plantDark: R3D.col('#8a681b'),
        steel: R3D.col('#8e8b84'),
        steelDark: R3D.col('#56534c'),
        poacher: R3D.col('#6a4c38'),
        poacherDark: R3D.col('#3f2c21'),
        rust: R3D.col('#8a4f2a'),
        tarp: R3D.col('#56603f'),

        // People.
        khaki: R3D.col('#a8986a'),
        khakiDark: R3D.col('#7a6c48'),
        skin: R3D.col('#7a5238'),
        hat: R3D.col('#8c7a52'),
        drab: R3D.col('#3b3a33'),

        // The station: lime-washed plaster, timber, stone and thatch.
        wall: R3D.col('#e2d6bb'),
        wallShade: R3D.col('#bcae90'),
        timber: R3D.col('#6e5438'),
        timberDark: R3D.col('#4a3824'),
        plank: R3D.col('#8a6c49'),
        thatch: R3D.col('#9c7f4c'),
        thatchDark: R3D.col('#6a5232'),
        thatchPale: R3D.col('#b89c66'),
        stone: R3D.col('#a39786'),
        stoneDark: R3D.col('#7b7062'),
        earth: R3D.col('#a88a63'),
        earthDark: R3D.col('#8a7050'),
        tank: R3D.col('#8b988f'),
        solar: R3D.col('#253446'),
        solarFrame: R3D.col('#9aa0a3'),
        shade: R3D.col('#3f4a36'),
        drum: R3D.col('#7c3a2a'),
        drumBlue: R3D.col('#2f4d6b'),
        sign: R3D.col('#3f5a36'),
        signText: R3D.col('#e9e1c8'),
        ember: R3D.col('#e07a2a'),
        ash: R3D.col('#3a3530'),

        // Items.
        leaf: R3D.col('#7e8c48'),
        leafDark: R3D.col('#55632f'),
        melon: R3D.col('#5f8f3f'),
        melonStripe: R3D.col('#3d6428'),
        flesh: R3D.col('#b04a44'),
        bone: R3D.col('#e6dcc4'),
        dart: R3D.col('#e8e2d0'),
        dartFlight: R3D.col('#6fd0e8')
    };

    const _c = new THREE.Color();

    /* ------------------------------------------------------------------ *
     * Shared shapes
     * ------------------------------------------------------------------ */

    const _roofs = new Map();

    /**
     * A roof cone with flat faces and enough subdivision to carry painted streaks.
     *
     * Three's own cylinder with four radial segments is a four-faced pyramid with four
     * vertices round its base — which means a vertex colour can only change at the
     * corners, and thatch streaked by vertex colour came out as four flat tones. This
     * subdivides each face into a grid while keeping it planar.
     *
     * Unit base radius, unit height centred on the origin, top radius `top`.
     */
    function roofGeometry(sides, top) {
        const key = sides + ':' + top.toFixed(3);
        let geo = _roofs.get(key);
        if (geo) return geo;

        const segU = sides <= 4 ? 10 : 3;
        const segV = 6;
        const pos = [];
        const idx = [];
        for (let s = 0; s < sides; s++) {
            const a0 = (s / sides) * MathUtils.TAU + Math.PI / sides;
            const a1 = ((s + 1) / sides) * MathUtils.TAU + Math.PI / sides;
            const base = pos.length / 3;
            for (let j = 0; j <= segV; j++) {
                const v = j / segV;
                const r = 1 - v * (1 - top);
                for (let i = 0; i <= segU; i++) {
                    const u = i / segU;
                    const x = MathUtils.lerp(Math.cos(a0), Math.cos(a1), u) * r;
                    const z = MathUtils.lerp(Math.sin(a0), Math.sin(a1), u) * r;
                    pos.push(x, v - 0.5, z);
                }
            }
            for (let j = 0; j < segV; j++) {
                for (let i = 0; i < segU; i++) {
                    const a = base + j * (segU + 1) + i;
                    const b = a + 1, c = a + segU + 1, d = c + 1;
                    idx.push(a, c, b, b, c, d);
                }
            }
        }
        geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        _roofs.set(key, geo);
        return geo;
    }

    /**
     * A thatched roof.
     *
     * Laid in three courses with a slight step between them, the way thatch is laid;
     * streaked along the fall of the reed by a noise field so it reads as straw rather
     * than as a painted cone; darker and weathered at the eaves; and finished with a
     * ragged fringe hanging from the eaves and a bound ridge at the top. The old roofs
     * alternated light and dark courses, which read from across the reserve as a
     * striped traffic cone.
     *
     * @param {number} radius Eaves radius.
     * @param {number} height Apex height above the eaves.
     * @param {number} sides Plan shape: 4 for a hipped square, 8+ for a rondavel.
     */
    function thatchRoof(b, radius, height, sides, seed) {
        const salt = seed || 0;
        const courses = 3;
        for (let i = 0; i < courses; i++) {
            const t = i / courses;
            const t1 = (i + 1) / courses;
            const r0 = radius * (1 - t * 0.9) * (i === 0 ? 1 : 1.04);
            const r1 = radius * (1 - t1 * 0.9);
            const h = height / courses;
            b.push()
                .translate(0, height * t + h / 2 - (i === 0 ? 0 : h * 0.06), 0)
                .scale(r0, h * 1.08, r0);
            b.add(roofGeometry(sides, r1 / r0), {
                colorFn: (lx, ly, lz) => {
                    const a = Math.atan2(lz, lx);
                    const streak = Noise.value2(a * 46 + salt, (ly + i) * 3.2);
                    const age = MathUtils.clamp01(0.5 - ly) * (i === 0 ? 0.55 : 0.2);
                    return _c.copy(PAL.thatchDark).lerp(PAL.thatch, 0.35 + streak * 0.55)
                        .lerp(PAL.thatchPale, Math.max(0, streak - 0.75) * 1.4)
                        .multiplyScalar(1 - age * 0.35);
                }
            });
            b.pop();
        }

        // The fringe: reed ends hanging below the eaves, uneven in length.
        const perimeter = sides * 2 * radius * Math.sin(Math.PI / sides);
        const strands = Math.round(perimeter / 0.07);
        b.color(PAL.thatchDark);
        for (let k = 0; k < strands; k++) {
            const t = k / strands;
            const side = Math.floor(t * sides);
            const u = t * sides - side;
            const a0 = (side / sides) * MathUtils.TAU + Math.PI / sides;
            const a1 = ((side + 1) / sides) * MathUtils.TAU + Math.PI / sides;
            const x = MathUtils.lerp(Math.cos(a0), Math.cos(a1), u) * radius * 1.01;
            const z = MathUtils.lerp(Math.sin(a0), Math.sin(a1), u) * radius * 1.01;
            const len = 0.05 + Noise.value2(k * 0.7 + salt, 3.1) * 0.07;
            b.limb(x, 0.02, z, x * 1.02, -len, z * 1.02, 0.022, 0.006, { radial: 3, noCaps: true });
        }

        // A bound ridge cap.
        b.color(PAL.thatchDark);
        b.push().translate(0, height * 0.99, 0)
            .sphere(radius * 0.13, height * 0.1, radius * 0.13, { low: true })
            .pop();
    }

    /** A run of posts with rails along them. */
    function railing(b, x0, z0, x1, z1, height, y0) {
        const base = y0 || 0;
        const span = Math.hypot(x1 - x0, z1 - z0);
        const steps = Math.max(2, Math.round(span / 0.55));
        b.color(PAL.timber);
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            b.limb(x0 + (x1 - x0) * t, base, z0 + (z1 - z0) * t,
                x0 + (x1 - x0) * t, base + height, z0 + (z1 - z0) * t,
                0.034, 0.03, { radial: 5 });
        }
        b.color(PAL.timberDark);
        for (const h of [height, height * 0.55]) {
            b.push().translate((x0 + x1) / 2, base + h, (z0 + z1) / 2)
                .rotate(0, -Math.atan2(z1 - z0, x1 - x0), 0)
                .box(span, 0.04, 0.045)
                .pop();
        }
    }

    /** A plank deck: boards along X, with dark seams between them. */
    function deck(b, cx, y, cz, sx, sz) {
        const boards = Math.max(3, Math.round(sz / 0.16));
        const w = sz / boards;
        for (let i = 0; i < boards; i++) {
            b.color(i % 2 ? PAL.plank : _c.copy(PAL.plank).multiplyScalar(0.9));
            b.push().translate(cx, y, cz - sz / 2 + w * (i + 0.5)).box(sx, 0.06, w * 0.92).pop();
        }
    }

    /** A window: dark glass set in a timber frame, with a sill. */
    function window3(b, x, y, z, w, h, facing) {
        b.push().translate(x, y, z).rotate(0, facing, 0);
        b.color(PAL.timberDark);
        b.box(0.035, h + 0.07, w + 0.07);
        b.color(PAL.glass);
        b.push().translate(0.012, 0, 0).box(0.02, h, w).pop();
        b.color(PAL.timber);
        b.push().translate(0.015, 0, 0).box(0.02, h, 0.03).pop();
        b.push().translate(0.015, 0, 0).box(0.02, 0.03, w).pop();
        b.push().translate(0.04, -h / 2 - 0.03, 0).box(0.07, 0.03, w + 0.1).pop();
        b.pop();
    }

    /* ------------------------------------------------------------------ *
     * People
     * ------------------------------------------------------------------ */

    /**
     * A figure standing in a vehicle, facing +X: torso, arms, head and a bush hat.
     * Built with the rifle held at the ready so aiming only has to turn the figure.
     */
    function figure(b, cloth, clothDark, hat, withRifle) {
        b.color(clothDark);
        b.push().translate(0, 0.12, 0).box(0.14, 0.24, 0.2).pop();
        b.color(cloth);
        b.push().translate(0, 0.35, 0).sphere(0.085, 0.14, 0.11, { low: true }).pop();
        b.color(PAL.skin);
        b.push().translate(0.01, 0.55, 0).sphere(0.065, 0.075, 0.065, { low: true }).pop();
        b.color(hat);
        b.push().translate(0.01, 0.6, 0).scale(0.12, 0.012, 0.12).add(R3D.UNIT.cylinderLow).pop();
        b.push().translate(0.01, 0.63, 0).scale(0.065, 0.05, 0.065).add(R3D.UNIT.cylinderLow).pop();
        b.color(cloth);
        for (const side of [-1, 1]) {
            b.limb(0, 0.43, side * 0.1, 0.13, 0.36, side * 0.05, 0.03, 0.026, { radial: 5 });
        }
        if (withRifle) {
            b.color(PAL.timberDark);
            b.limb(0.04, 0.4, 0.04, 0.34, 0.44, 0.02, 0.018, 0.012, { radial: 4 });
            b.color(PAL.steelDark);
            b.limb(0.3, 0.44, 0.02, 0.5, 0.46, 0.02, 0.01, 0.009, { radial: 4 });
        }
    }

    /* ------------------------------------------------------------------ *
     * Vehicles
     * ------------------------------------------------------------------ */

    const _wheelGeos = new Map();

    /**
     * One wheel: a tyre with rounded shoulders and a ring of tread blocks, a steel rim
     * and a hub. Cached by size — every vehicle of a kind shares it.
     */
    function wheelGeometry(r, width) {
        const key = r.toFixed(3) + ':' + width.toFixed(3);
        let geo = _wheelGeos.get(key);
        if (geo) return geo;
        const b = new R3D.GeoBuilder();
        b.push().rotate(Math.PI / 2, 0, 0);
        b.color(PAL.tyre);
        b.push().scale(r * 0.94, width, r * 0.94).add(new THREE.CylinderGeometry(1, 1, 1, 20, 1)).pop();
        // Rounded shoulders, so the tyre is not a hockey puck.
        for (const s of [-1, 1]) {
            b.push().translate(0, s * width * 0.42, 0).scale(r * 0.97, width * 0.2, r * 0.97)
                .add(new THREE.CylinderGeometry(0.93, 1, 1, 20, 1)).pop();
        }
        b.color(PAL.tread);
        const blocks = 14;
        for (let i = 0; i < blocks; i++) {
            const a = (i / blocks) * MathUtils.TAU;
            b.push().translate(Math.cos(a) * r * 0.96, 0, Math.sin(a) * r * 0.96)
                .rotate(0, -a, 0)
                .box(r * 0.1, width * 0.9, r * 0.2).pop();
        }
        b.color(PAL.rim);
        b.push().scale(r * 0.56, width * 1.04, r * 0.56).add(new THREE.CylinderGeometry(1, 1, 1, 14, 1)).pop();
        b.color(PAL.hub);
        b.push().scale(r * 0.2, width * 1.12, r * 0.2).add(R3D.UNIT.cylinderLow).pop();
        for (let i = 0; i < 5; i++) {
            const a = (i / 5) * MathUtils.TAU;
            b.push().translate(Math.cos(a) * r * 0.33, width * 0.54, Math.sin(a) * r * 0.33)
                .box(r * 0.07, 0.01, r * 0.07).pop();
        }
        b.pop();
        geo = b.build();
        geo.userData.shared = true;
        _wheelGeos.set(key, geo);
        return geo;
    }

    /**
     * A vehicle on the ground.
     *
     * Hierarchy: `root` stands at the entity's position and heading; each wheel hangs
     * from it on its own steering pivot and finds the ground under itself; `body`
     * rides the wheels on a spring, carrying the chassis and anything that moves with
     * it — the ranger, the loader's cradle, the lorry's cargo.
     */
    class Vehicle3D {
        /**
         * @param {object} opts
         * @param {function(R3D.GeoBuilder, object):void} opts.body
         * @param {number} opts.wheel      Wheel radius.
         * @param {number} [opts.wheelWidth]
         * @param {Array<Array<number>>} opts.axles [[x, z], ...] wheel centres.
         * @param {number} [opts.steerAxle] X of the steered axle.
         */
        constructor(opts) {
            this.opts = opts;
            this.root = new THREE.Group();
            this.body = new THREE.Group();
            this.root.add(this.body);

            const b = new R3D.GeoBuilder();
            opts.body(b, PAL);
            this.chassis = new THREE.Mesh(b.build(), R3D.solidMaterial());
            this.chassis.castShadow = true;
            this.chassis.receiveShadow = true;
            this.body.add(this.chassis);

            const r = opts.wheel;
            const width = opts.wheelWidth || r * 0.5;
            const wheelGeo = wheelGeometry(r, width);
            const steerX = opts.steerAxle === undefined
                ? Math.max(...opts.axles.map((a) => a[0])) : opts.steerAxle;

            this.wheels = [];
            let front = 0, rear = 0;
            for (const axle of opts.axles) {
                const pivot = new THREE.Group();
                pivot.position.set(axle[0], r, axle[1]);
                const mesh = new THREE.Mesh(wheelGeo, R3D.solidMaterial());
                mesh.castShadow = true;
                pivot.add(mesh);
                this.root.add(pivot);
                const isFront = Math.abs(axle[0] - steerX) < 1e-3;
                this.wheels.push({ pivot, mesh, x: axle[0], z: axle[1], front: isFront, y: 0 });
                if (axle[0] > front) front = axle[0];
                if (axle[0] < rear) rear = axle[0];
            }
            this.wheelbase = Math.max(0.2, front - rear);
            this.track = Math.max(0.2, ...opts.axles.map((a) => Math.abs(a[1]) * 2));

            /* Presentation state: springs and the previous frame's motion. */
            this.pitch = 0;
            this.roll = 0;
            this.pitchVel = 0;
            this.rollVel = 0;
            this.heave = 0;
            this.steer = 0;
            this._prevFacing = null;
            this._prevSpeed = 0;
            this._accel = 0;
            this._yawRate = 0;
        }

        /**
         * Sit the vehicle on the ground and animate it.
         * @param {object} entity Simulation vehicle: x, y, facing, speed, renderState.
         * @param {Safari.TileWorld} world
         * @param {number} dt Real seconds since the last frame.
         */
        update(entity, world, dt) {
            const rs = entity.renderState;
            const facing = rs.facing === undefined ? entity.facing : rs.facing;
            const step = dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
            const root = this.root;

            /* --- Motion, differentiated ------------------------------------ */
            const speed = entity.speed || 0;
            if (this._prevFacing === null) this._prevFacing = facing;
            const yawRate = MathUtils.angleDelta(this._prevFacing, facing) / step;
            this._yawRate = MathUtils.damp(this._yawRate, yawRate, 10, step);
            this._accel = MathUtils.damp(this._accel, (speed - this._prevSpeed) / step, 8, step);
            this._prevFacing = facing;
            this._prevSpeed = speed;

            /* --- Wheels on the ground ---------------------------------------- */
            const cf = Math.cos(facing), sf = Math.sin(facing);
            let sum = 0;
            let frontH = 0, rearH = 0, leftH = 0, rightH = 0;
            let nf = 0, nr = 0, nl = 0, nrt = 0;
            const rough = MathUtils.clamp01(speed / 3);
            for (const w of this.wheels) {
                const tx = entity.x + w.x * cf - w.z * sf;
                const ty = entity.y + w.x * sf + w.z * cf;
                // Corrugations: a little extra jolt per wheel, only when moving.
                const jolt = (Noise.value2(tx * 2.7, ty * 2.7) - 0.5) * 0.05 * rough;
                w.y = R3D.surfaceY(world, tx, ty) + jolt;
                sum += w.y;
                if (w.x > 0) { frontH += w.y; nf++; } else { rearH += w.y; nr++; }
                if (w.z < 0) { leftH += w.y; nl++; } else { rightH += w.y; nrt++; }
            }
            const mean = sum / this.wheels.length;
            root.position.set(entity.x, mean, entity.y);
            root.rotation.set(0, R3D.yawFor(facing), 0);

            /* --- Body on its springs ------------------------------------------ */
            // Rest attitude from the wheels' ground heights...
            const groundPitch = Math.atan2((nf ? frontH / nf : mean) - (nr ? rearH / nr : mean),
                this.wheelbase);
            const groundRoll = Math.atan2((nl ? leftH / nl : mean) - (nrt ? rightH / nrt : mean),
                this.track);
            // ...plus the weight transfer: squat under acceleration, lean out of turns.
            const squat = MathUtils.clamp(-this._accel * 0.02, -0.07, 0.07);
            const lean = MathUtils.clamp(-this._yawRate * speed * 0.035, -0.09, 0.09);
            const wantPitch = groundPitch + squat;
            const wantRoll = groundRoll + lean;

            const k = 90, c = 13;
            this.pitchVel += ((wantPitch - this.pitch) * k - this.pitchVel * c) * step;
            this.rollVel += ((wantRoll - this.roll) * k - this.rollVel * c) * step;
            this.pitch += this.pitchVel * step;
            this.roll += this.rollVel * step;

            // Chassis-local: +X is the nose, so pitch is about Z, roll about X.
            this.body.rotation.set(this.roll, 0, this.pitch, 'YXZ');
            this.body.position.y = 0;

            /* --- Wheels: travel, steer, spin ----------------------------------- */
            const steerWant = speed > 0.05
                ? MathUtils.clamp(Math.atan(this._yawRate * this.wheelbase / Math.max(speed, 0.4)), -0.55, 0.55)
                : this.steer * 0.98;
            this.steer = MathUtils.damp(this.steer, steerWant, 9, step);
            const spin = rs.wheelPhase || 0;
            for (const w of this.wheels) {
                w.pivot.position.y = this.opts.wheel + MathUtils.clamp(w.y - mean, -0.12, 0.12);
                w.pivot.rotation.y = w.front ? -this.steer : 0;
                w.mesh.rotation.z = -spin;
            }
        }

        get object() {
            return this.root;
        }
    }

    /* --- Body builders ------------------------------------------------- */

    /**
     * The warden's 4x4: an open game-viewing vehicle — bonnet and wings over the front
     * wheels, a folded screen, tiered bench seats under a canvas roof on a roll cage,
     * a bull bar and winch, a snorkel, and the spare on the tailgate.
     */
    function jeepBody(b, pal) {
        // Chassis rails and the tub.
        b.color(pal.jeepTrim);
        b.push().translate(0, 0.2, 0).box(1.34, 0.08, 0.5).pop();
        b.color(pal.jeep);
        b.push().translate(-0.14, 0.36, 0).box(0.98, 0.24, 0.72).pop();
        // Bonnet, sloping slightly toward the grille.
        b.push().translate(0.46, 0.4, 0).rotate(0, 0, -0.05).box(0.44, 0.2, 0.62).pop();
        // Wings over the front wheels, and arches over the rear.
        b.color(pal.jeepDark);
        for (const s of [-1, 1]) {
            b.push().translate(0.44, 0.44, s * 0.35).box(0.46, 0.05, 0.12).pop();
            b.push().translate(-0.42, 0.46, s * 0.37).box(0.44, 0.04, 0.08).pop();
        }
        // Grille, bull bar, winch, headlamps.
        b.color(pal.jeepTrim);
        b.push().translate(0.69, 0.38, 0).box(0.03, 0.16, 0.44).pop();
        b.color(pal.chrome);
        for (let i = -2; i <= 2; i++) {
            b.push().translate(0.705, 0.38, i * 0.07).box(0.012, 0.13, 0.02).pop();
        }
        b.color(pal.steelDark);
        b.limb(0.78, 0.22, -0.3, 0.78, 0.22, 0.3, 0.028, 0.028, { radial: 6 });
        for (const s of [-1, 1]) {
            b.limb(0.7, 0.22, s * 0.26, 0.78, 0.22, s * 0.26, 0.024, 0.024, { radial: 5 });
            b.limb(0.78, 0.22, s * 0.3, 0.76, 0.46, s * 0.26, 0.024, 0.022, { radial: 5 });
        }
        b.limb(0.76, 0.46, -0.26, 0.76, 0.46, 0.26, 0.022, 0.022, { radial: 5 });
        b.push().translate(0.76, 0.25, 0).box(0.08, 0.08, 0.2).pop();
        b.color(pal.lamp);
        for (const s of [-1, 1]) {
            b.push().translate(0.7, 0.42, s * 0.23).rotate(0, 0, Math.PI / 2)
                .scale(0.052, 0.02, 0.052).add(R3D.UNIT.cylinder).pop();
        }
        // Screen, folded up, in a frame.
        b.color(pal.jeepTrim);
        b.push().translate(0.22, 0.62, 0).rotate(0, 0, -0.28).box(0.04, 0.34, 0.64).pop();
        b.color(pal.glass);
        b.push().translate(0.235, 0.63, 0).rotate(0, 0, -0.28).box(0.02, 0.28, 0.56).pop();
        // Snorkel up the right-hand pillar.
        b.color(pal.jeepTrim);
        b.limb(0.4, 0.44, 0.34, 0.24, 0.82, 0.34, 0.022, 0.02, { radial: 5 });
        // Tiered bench seats.
        b.color(pal.seat);
        b.push().translate(0.02, 0.52, 0).box(0.2, 0.08, 0.6).pop();
        b.push().translate(0.04, 0.62, 0).box(0.05, 0.18, 0.6).pop();
        b.push().translate(-0.34, 0.6, 0).box(0.2, 0.08, 0.64).pop();
        b.push().translate(-0.32, 0.7, 0).box(0.05, 0.18, 0.64).pop();
        // Roll cage and the canvas roof.
        b.color(pal.steelDark);
        for (const x of [0.2, -0.58]) {
            for (const s of [-1, 1]) {
                b.limb(x, 0.46, s * 0.34, x, 1.06, s * 0.32, 0.018, 0.018, { radial: 5 });
            }
        }
        for (const s of [-1, 1]) b.limb(0.2, 1.06, s * 0.32, -0.58, 1.06, s * 0.32, 0.016, 0.016, { radial: 5 });
        b.color(pal.canvasTop);
        b.push().translate(-0.19, 1.09, 0).box(0.86, 0.035, 0.7).pop();
        // Tailgate spare wheel and jerry cans.
        b.color(pal.tyre);
        b.push().translate(-0.64, 0.46, 0).rotate(0, 0, Math.PI / 2)
            .scale(0.19, 0.08, 0.19).add(new THREE.CylinderGeometry(1, 1, 1, 16, 1)).pop();
        b.color(pal.rim);
        b.push().translate(-0.655, 0.46, 0).rotate(0, 0, Math.PI / 2)
            .scale(0.1, 0.08, 0.1).add(R3D.UNIT.cylinderLow).pop();
        b.color(pal.tail);
        for (const s of [-1, 1]) b.push().translate(-0.635, 0.38, s * 0.3).box(0.02, 0.05, 0.05).pop();
        b.color(pal.jeepDark);
        for (const s of [-1, 1]) b.push().translate(-0.5, 0.56, s * 0.29).box(0.12, 0.14, 0.05).pop();
    }

    /** The loader: a small yellow tractor with a cab frame. The cradle is its own part. */
    function loaderBody(b, pal) {
        b.color(pal.steelDark);
        b.push().translate(-0.05, 0.22, 0).box(1.0, 0.1, 0.46).pop();
        b.color(pal.plant);
        b.push().translate(-0.28, 0.4, 0).box(0.56, 0.26, 0.62).pop();
        b.push().translate(0.2, 0.38, 0).rotate(0, 0, -0.08).box(0.42, 0.22, 0.44).pop();
        b.color(pal.plantDark);
        b.push().translate(0.42, 0.38, 0).box(0.03, 0.16, 0.36).pop();
        for (const s of [-1, 1]) b.push().translate(-0.36, 0.56, s * 0.34).box(0.46, 0.04, 0.12).pop();
        // Seat, steering column, cab frame and roof.
        b.color(pal.seat);
        b.push().translate(-0.36, 0.6, 0).box(0.18, 0.08, 0.24).pop();
        b.color(pal.steelDark);
        b.limb(-0.16, 0.55, 0, -0.1, 0.72, 0, 0.012, 0.012, { radial: 4 });
        for (const x of [-0.08, -0.56]) {
            for (const s of [-1, 1]) b.limb(x, 0.52, s * 0.28, x, 1.02, s * 0.28, 0.018, 0.018, { radial: 5 });
        }
        b.color(pal.plant);
        b.push().translate(-0.32, 1.04, 0).box(0.56, 0.04, 0.64).pop();
        // Exhaust stack and beacon.
        b.color(pal.jeepTrim);
        b.limb(0.28, 0.48, 0.16, 0.28, 0.82, 0.16, 0.02, 0.018, { radial: 5 });
        b.color(pal.ember);
        b.push().translate(-0.32, 1.09, 0).sphere(0.04, 0.035, 0.04, { low: true }).pop();
    }

    /** The loader's cradle: two arms and a sling, pivoting at the front of the body. */
    function cradleBody(b, pal) {
        b.color(pal.plantDark);
        for (const s of [-1, 1]) b.limb(0, 0, s * 0.26, 0.52, -0.08, s * 0.26, 0.035, 0.03, { radial: 6 });
        b.color(pal.steel);
        b.push().translate(0.62, -0.1, 0).box(0.34, 0.03, 0.56).pop();
        for (const s of [-1, 1]) b.push().translate(0.62, -0.02, s * 0.28).box(0.34, 0.14, 0.02).pop();
        b.push().translate(0.8, -0.02, 0).box(0.02, 0.14, 0.56).pop();
    }

    /** The lorry: a cab-over truck with a slatted livestock crate. */
    function lorryBody(b, pal) {
        b.color(pal.steelDark);
        b.push().translate(-0.1, 0.26, 0).box(2.14, 0.12, 0.54).pop();
        // Cab: tall and flat-fronted, with a big screen and a sun visor.
        b.color(pal.plant);
        b.push().translate(0.8, 0.66, 0).box(0.56, 0.62, 0.9).pop();
        b.color(pal.glass);
        b.push().translate(1.085, 0.78, 0).box(0.02, 0.26, 0.78).pop();
        for (const s of [-1, 1]) b.push().translate(0.86, 0.8, s * 0.455).box(0.3, 0.22, 0.02).pop();
        b.color(pal.plantDark);
        b.push().translate(1.1, 0.95, 0).box(0.1, 0.03, 0.9).pop();
        b.color(pal.jeepTrim);
        b.push().translate(1.09, 0.48, 0).box(0.04, 0.2, 0.62).pop();
        b.color(pal.chrome);
        b.push().translate(1.12, 0.3, 0).box(0.06, 0.1, 0.92).pop();
        b.color(pal.lamp);
        for (const s of [-1, 1]) b.push().translate(1.13, 0.42, s * 0.36).box(0.02, 0.07, 0.1).pop();
        // Fuel tank and mirrors.
        b.color(pal.steel);
        b.push().translate(0.28, 0.32, 0.36).rotate(Math.PI / 2, 0, 0)
            .scale(0.1, 0.34, 0.1).add(R3D.UNIT.cylinder).pop();
        b.color(pal.jeepTrim);
        for (const s of [-1, 1]) b.push().translate(1.02, 0.86, s * 0.54).box(0.03, 0.14, 0.06).pop();

        // The crate: a floor, corner posts, slatted sides and roof bars.
        b.color(pal.plank);
        b.push().translate(-0.34, 0.36, 0).box(1.36, 0.06, 0.9).pop();
        const posts = [[-1.0, -0.44], [-1.0, 0.44], [0.32, -0.44], [0.32, 0.44], [-0.34, -0.44], [-0.34, 0.44]];
        b.color(pal.plantDark);
        for (const [x, z] of posts) b.push().translate(x, 0.72, z).box(0.05, 0.7, 0.05).pop();
        b.color(pal.plant);
        for (const s of [-1, 1]) {
            for (let i = 0; i < 4; i++) {
                b.push().translate(-0.34, 0.48 + i * 0.15, s * 0.45).box(1.34, 0.07, 0.03).pop();
            }
        }
        for (let i = 0; i < 4; i++) b.push().translate(-1.01, 0.48 + i * 0.15, 0).box(0.03, 0.07, 0.9).pop();
        b.color(pal.plantDark);
        for (let i = 0; i < 4; i++) b.push().translate(-0.96 + i * 0.42, 1.07, 0).box(0.04, 0.04, 0.9).pop();
        // Mud flaps.
        b.color(pal.jeepTrim);
        for (const s of [-1, 1]) b.push().translate(-0.98, 0.22, s * 0.44).box(0.02, 0.16, 0.14).pop();
    }

    /** The poachers': a battered, rust-streaked pickup with a tarp over the bed. */
    function poacherBody(b, pal) {
        b.color(pal.jeepTrim);
        b.push().translate(0, 0.2, 0).box(1.36, 0.08, 0.5).pop();
        b.color(pal.poacher);
        b.push().translate(0.46, 0.38, 0).rotate(0, 0, -0.04).box(0.46, 0.2, 0.68).pop();
        b.push().translate(0.08, 0.5, 0).box(0.36, 0.44, 0.7).pop();
        b.color(pal.rust);
        b.push().translate(0.3, 0.33, 0.35).box(0.3, 0.1, 0.01).pop();
        b.push().translate(-0.4, 0.44, -0.36).box(0.2, 0.12, 0.01).pop();
        b.color(pal.glass);
        b.push().translate(0.27, 0.62, 0).rotate(0, 0, -0.3).box(0.02, 0.2, 0.6).pop();
        for (const s of [-1, 1]) b.push().translate(0.08, 0.62, s * 0.355).box(0.26, 0.16, 0.01).pop();
        // The bed, and a tarp roped over whatever is in it.
        b.color(pal.poacherDark);
        b.push().translate(-0.42, 0.36, 0).box(0.66, 0.12, 0.7).pop();
        for (const s of [-1, 1]) b.push().translate(-0.42, 0.46, s * 0.34).box(0.66, 0.14, 0.03).pop();
        b.color(pal.tarp);
        b.push().translate(-0.42, 0.53, 0).sphere(0.33, 0.1, 0.33, { low: true }).pop();
        b.color(pal.jeepTrim);
        b.push().translate(0.7, 0.3, 0).box(0.04, 0.1, 0.62).pop();
        b.color(pal.lamp);
        for (const s of [-1, 1]) b.push().translate(0.69, 0.4, s * 0.25).box(0.02, 0.05, 0.08).pop();
        b.color(pal.tail);
        for (const s of [-1, 1]) b.push().translate(-0.76, 0.4, s * 0.3).box(0.02, 0.06, 0.05).pop();
    }

    /* ------------------------------------------------------------------ *
     * Vehicle kinds
     * ------------------------------------------------------------------ */

    /**
     * The warden's jeep, with the ranger standing in the back. The figure turns to
     * the quarry and raises the dart rifle as `aiming` rises.
     */
    class Jeep3D extends Vehicle3D {
        constructor() {
            super({
                body: jeepBody, wheel: 0.2, wheelWidth: 0.12,
                axles: [[0.44, -0.33], [0.44, 0.33], [-0.42, -0.33], [-0.42, 0.33]]
            });
            const b = new R3D.GeoBuilder();
            figure(b, PAL.khaki, PAL.khakiDark, PAL.hat, true);
            this.ranger = new THREE.Mesh(b.build(), R3D.solidMaterial());
            this.ranger.castShadow = true;
            this.ranger.position.set(-0.34, 0.62, 0);
            this.body.add(this.ranger);
            this._aimYaw = 0;
        }

        update(entity, world, dt) {
            super.update(entity, world, dt);
            const rs = entity.renderState;
            const aim = MathUtils.clamp01(rs.aiming || 0);
            // Turn to the quarry, relative to the vehicle's own heading.
            let want = 0;
            if (rs.aimAngle !== null && rs.aimAngle !== undefined) {
                want = -MathUtils.angleDelta(rs.facing || 0, rs.aimAngle) * Math.min(1, aim * 3);
            }
            this._aimYaw = MathUtils.angleDamp(this._aimYaw, want, 8, dt > 0 ? dt : 1 / 60);
            this.ranger.rotation.set(0, this._aimYaw, -aim * 0.08);
            // Standing up to shoot: the figure rises a little as it aims.
            this.ranger.position.y = 0.6 + aim * 0.06;
        }
    }

    /** The loader, with its cradle arm and whatever it is carrying. */
    class Loader3D extends Vehicle3D {
        constructor() {
            super({
                body: loaderBody, wheel: 0.22, wheelWidth: 0.14,
                axles: [[0.3, -0.3], [0.3, 0.3], [-0.4, -0.34], [-0.4, 0.34]]
            });
            const b = new R3D.GeoBuilder();
            cradleBody(b, PAL);
            this.cradle = new THREE.Mesh(b.build(), R3D.solidMaterial());
            this.cradle.castShadow = true;
            this.cradle.position.set(0.36, 0.5, 0);
            this.body.add(this.cradle);
            this.cargoMesh = null;
            this.cargoId = null;
        }

        /**
         * Raise or lower the cradle, and show the animal in it.
         * @param {number} lift 0 down at the ground, 1 carried high.
         * @param {string|null} cargo Species id aboard.
         */
        setLoad(lift, cargo) {
            this.cradle.rotation.z = MathUtils.lerp(-0.62, 0.22, MathUtils.clamp01(lift));
            if (cargo !== this.cargoId) {
                if (this.cargoMesh) this.cradle.remove(this.cargoMesh);
                this.cargoMesh = cargo ? cargoMesh(cargo, true, 0.62) : null;
                if (this.cargoMesh) {
                    this.cargoMesh.position.set(0.62, -0.08, 0);
                    this.cradle.add(this.cargoMesh);
                }
                this.cargoId = cargo;
            }
        }
    }

    /** The lorry, with the animals it is carrying standing in the crate. */
    class Lorry3D extends Vehicle3D {
        constructor() {
            super({
                body: lorryBody, wheel: 0.24, wheelWidth: 0.16,
                axles: [[0.74, -0.43], [0.74, 0.43], [-0.5, -0.43], [-0.5, 0.43],
                    [-0.82, -0.43], [-0.82, 0.43]],
                steerAxle: 0.74
            });
            this.cargoMeshes = [];
            this.cargoKey = '';
        }

        /** @param {string[]} cargo Species ids aboard. */
        setCargo(cargo) {
            const key = (cargo || []).join(',');
            if (key === this.cargoKey) return;
            for (const m of this.cargoMeshes) this.body.remove(m);
            this.cargoMeshes = [];
            (cargo || []).slice(0, 4).forEach((id, i) => {
                const m = cargoMesh(id, false, 0.55);
                if (!m) return;
                m.position.set(-0.78 + i * 0.3, 0.39, (i % 2 ? 0.16 : -0.16));
                this.body.add(m);
                this.cargoMeshes.push(m);
            });
            this.cargoKey = key;
        }
    }

    /** The poachers' truck, with a figure in the back. */
    class Poacher3D extends Vehicle3D {
        constructor() {
            super({
                body: poacherBody, wheel: 0.21, wheelWidth: 0.12,
                axles: [[0.44, -0.34], [0.44, 0.34], [-0.46, -0.34], [-0.46, 0.34]]
            });
            const b = new R3D.GeoBuilder();
            figure(b, PAL.drab, PAL.poacherDark, PAL.drab, true);
            const man = new THREE.Mesh(b.build(), R3D.solidMaterial());
            man.castShadow = true;
            man.position.set(-0.22, 0.44, 0);
            man.rotation.y = 0.5;
            this.body.add(man);
        }
    }

    /**
     * A small posed copy of an animal, for a vehicle's cargo.
     * @param {string} id Species.
     * @param {boolean} down Lying sedated rather than standing.
     * @param {number} scale Relative to the reserve's animals.
     */
    function cargoMesh(id, down, scale) {
        const spec = Safari.IsoSpecies[id];
        const Creature3D = Safari.Creature3D;
        if (!spec || !Creature3D) return null;
        const mesh = Creature3D.create(spec);
        Creature3D.pose(mesh, {
            facing: 0, phase: 0, speed01: 0, time: 0, seed: 1,
            headDown: down ? 0.4 : 0, down: down ? 1 : 0, blink: down ? 1 : 0, earFlick: 0
        });
        // Pose sets the mesh's own scale for newborns; the cargo shrink goes on top.
        mesh.scale.multiplyScalar(scale);
        mesh.frustumCulled = false;
        return mesh;
    }

    /* ------------------------------------------------------------------ *
     * Structures
     * ------------------------------------------------------------------ */

    /**
     * The ranger station.
     *
     * The reserve's one built place, and the one the camera starts on, so it has to
     * look lived-in and worked from: a two-storey lodge of lime-washed plaster on a
     * stone plinth, under a big streaked thatch that is the landmark you navigate by,
     * with a wrapped veranda and a railed lookout facing the plain; a timber watchtower
     * behind it; a radio mast and solar panels, because a warden's post runs on both;
     * a rondavel for staff, a raised water tank, fuel drums, a fire pit with log
     * benches, and a signboard at the gate of the compound. It all stands on packed
     * earth, not on a concrete disc.
     *
     * One geometry, one draw call.
     */
    function buildStation() {
        const b = new R3D.GeoBuilder();

        /* --- Packed earth, with a ragged edge where it meets the grass ------ */
        {
            const ring = 28;
            const pos = [0, 0.015, 0];
            const cols = [PAL.earth];
            for (let i = 0; i < ring; i++) {
                const a = (i / ring) * MathUtils.TAU;
                const r = 3.7 * (0.9 + Noise.value2(i * 0.9, 2.2) * 0.2);
                pos.push(Math.cos(a) * r, 0.015, Math.sin(a) * r);
                cols.push(PAL.earthDark);
            }
            const idx = [];
            for (let i = 0; i < ring; i++) idx.push(0, 1 + ((i + 1) % ring), 1 + i);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geo.setIndex(idx);
            geo.computeVertexNormals();
            b.add(geo, { colorFn: (x, y, z) => _c.copy(PAL.earth).lerp(PAL.earthDark,
                MathUtils.clamp01(Math.hypot(x, z) / 3.7 - 0.2)) });
        }
        // A worn stone path from the steps to the compound's gate.
        b.color(PAL.stone);
        for (let i = 0; i < 7; i++) {
            b.push().translate(2.05 + i * 0.26, 0.03, Math.sin(i * 1.7) * 0.08)
                .sphere(0.12, 0.02, 0.1, { low: true }).pop();
        }

        /* --- The lodge: plinth, walls, corner posts -------------------------- */
        b.color(PAL.stoneDark);
        b.push().translate(0, 0.14, 0).box(2.3, 0.26, 1.8).pop();
        b.color(PAL.stone);
        b.push().translate(0, 0.28, 0).box(2.34, 0.04, 1.84).pop();
        b.color(PAL.wall);
        b.push().translate(0, 0.72, 0).box(2.1, 0.86, 1.6).pop();
        b.color(PAL.timberDark);
        for (const [x, z] of [[1.05, 0.8], [1.05, -0.8], [-1.05, 0.8], [-1.05, -0.8]]) {
            b.push().translate(x, 0.72, z).box(0.08, 0.88, 0.08).pop();
        }
        for (const side of [-1, 1]) {
            for (const wx of [-0.6, 0.05, 0.62]) window3(b, wx, 0.8, side * 0.81, 0.34, 0.3, side * Math.PI / 2);
        }
        window3(b, -1.06, 0.8, 0.35, 0.3, 0.3, Math.PI);
        // The front door, framed, with a lintel.
        b.color(PAL.timberDark);
        b.push().translate(1.06, 0.66, 0).box(0.04, 0.66, 0.46).pop();
        b.color(PAL.timber);
        b.push().translate(1.075, 0.64, 0).box(0.02, 0.58, 0.38).pop();
        b.push().translate(1.08, 1.0, 0).box(0.05, 0.05, 0.56).pop();

        /* --- Veranda --------------------------------------------------------- */
        deck(b, 0.2, 0.3, 0, 3.06, 2.5);
        b.color(PAL.stone);
        for (let i = 0; i < 3; i++) {
            b.push().translate(1.8 + i * 0.15, 0.22 - i * 0.07, 0).box(0.17, 0.07, 0.72).pop();
        }
        railing(b, 1.7, -1.24, 1.7, -0.4, 0.5, 0.33);
        railing(b, 1.7, 0.4, 1.7, 1.24, 0.5, 0.33);
        railing(b, -1.3, 1.24, 1.7, 1.24, 0.5, 0.33);
        railing(b, -1.3, -1.24, 1.7, -1.24, 0.5, 0.33);
        b.color(PAL.timber);
        for (const post of [[1.7, -1.24], [1.7, 1.24], [-1.3, 1.24], [-1.3, -1.24], [0.2, 1.24], [0.2, -1.24]]) {
            b.limb(post[0], 0.33, post[1], post[0], 1.34, post[1], 0.055, 0.048, { radial: 7 });
        }
        b.push().translate(0.2, 1.35, 0);
        thatchRoof(b, 2.25, 0.55, 4, 3);
        b.pop();

        /* --- Upper storey and the lookout -------------------------------------- */
        b.color(PAL.wall);
        b.push().translate(-0.12, 2.08, 0).box(1.58, 0.86, 1.26).pop();
        b.color(PAL.timberDark);
        for (const [x, z] of [[0.67, 0.63], [0.67, -0.63], [-0.91, 0.63], [-0.91, -0.63]]) {
            b.push().translate(x, 2.08, z).box(0.07, 0.88, 0.07).pop();
        }
        for (const side of [-1, 1]) window3(b, -0.12, 2.14, side * 0.64, 0.6, 0.34, side * Math.PI / 2);
        window3(b, 0.68, 2.14, 0, 0.5, 0.36, 0);
        deck(b, 1.08, 1.7, 0, 0.9, 1.46);
        railing(b, 1.5, -0.72, 1.5, 0.72, 0.44, 1.73);
        railing(b, 0.68, 0.72, 1.5, 0.72, 0.44, 1.73);
        railing(b, 0.68, -0.72, 1.5, -0.72, 0.44, 1.73);
        // The stair up the side.
        b.color(PAL.timber);
        for (let i = 0; i < 8; i++) {
            b.push().translate(-1.3, 0.44 + i * 0.165, -0.62 + i * 0.155).box(0.5, 0.05, 0.24).pop();
        }
        b.limb(-1.55, 0.3, -0.7, -1.55, 1.8, 0.55, 0.03, 0.03, { radial: 5 });
        // The roof that makes it a landmark.
        b.push().translate(-0.12, 2.5, 0);
        thatchRoof(b, 1.8, 1.7, 4, 11);
        b.pop();
        // Solar panels on the lower roof's rear slope.
        b.color(PAL.solarFrame);
        b.push().translate(-0.95, 1.62, 0.9).rotate(-0.45, 0, 0).box(0.9, 0.03, 0.46).pop();
        b.color(PAL.solar);
        for (let i = 0; i < 3; i++) {
            b.push().translate(-1.24 + i * 0.29, 1.635, 0.9).rotate(-0.45, 0, 0).box(0.26, 0.02, 0.42).pop();
        }

        /* --- Watchtower ---------------------------------------------------------- */
        {
            const tx = -2.55, tz = 1.7, h = 3.1;
            b.color(PAL.timberDark);
            for (const [dx, dz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) {
                b.limb(tx + dx * 1.2, 0, tz + dz * 1.2, tx + dx, h, tz + dz, 0.05, 0.04, { radial: 6 });
            }
            b.color(PAL.timber);
            // Cross-bracing on two faces.
            for (const s of [-1, 1]) {
                b.limb(tx - 0.46, 0.3, tz + s * 0.46, tx + 0.42, h * 0.55, tz + s * 0.42, 0.022, 0.022, { radial: 4 });
                b.limb(tx + 0.46, 0.3, tz + s * 0.46, tx - 0.42, h * 0.55, tz + s * 0.42, 0.022, 0.022, { radial: 4 });
            }
            deck(b, tx, h, tz, 1.0, 1.0);
            railing(b, tx - 0.48, tz - 0.48, tx + 0.48, tz - 0.48, 0.42, h);
            railing(b, tx - 0.48, tz + 0.48, tx + 0.48, tz + 0.48, 0.42, h);
            railing(b, tx - 0.48, tz - 0.48, tx - 0.48, tz + 0.48, 0.42, h);
            b.color(PAL.timberDark);
            for (const [dx, dz] of [[-0.44, -0.44], [0.44, -0.44], [-0.44, 0.44], [0.44, 0.44]]) {
                b.limb(tx + dx, h, tz + dz, tx + dx, h + 0.75, tz + dz, 0.025, 0.025, { radial: 5 });
            }
            b.push().translate(tx, h + 0.76, tz);
            thatchRoof(b, 0.8, 0.5, 4, 23);
            b.pop();
            // The ladder.
            b.color(PAL.timber);
            for (const s of [-1, 1]) b.limb(tx + 0.72, 0, tz + s * 0.16, tx + 0.5, h, tz + s * 0.16, 0.02, 0.02, { radial: 4 });
            for (let i = 1; i < 12; i++) {
                const t = i / 12;
                b.push().translate(tx + 0.72 - 0.22 * t, h * t, tz).box(0.03, 0.03, 0.32).pop();
            }
        }

        /* --- Staff rondavel -------------------------------------------------------- */
        {
            const gx = -2.8, gz = -1.6, gr = 0.58;
            b.color(PAL.stoneDark);
            b.push().translate(gx, 0.06, gz).scale(gr * 1.04, 0.12, gr * 1.04)
                .add(new THREE.CylinderGeometry(1, 1, 1, 18, 1)).pop();
            b.color(PAL.wall);
            b.push().translate(gx, 0.42, gz).scale(gr * 0.86, 0.72, gr * 0.86)
                .add(new THREE.CylinderGeometry(1, 1, 1, 18, 1)).pop();
            b.color(PAL.timberDark);
            b.push().translate(gx + gr * 0.86, 0.4, gz).box(0.03, 0.5, 0.3).pop();
            b.push().translate(gx, 0.78, gz);
            thatchRoof(b, gr * 1.34, gr * 1.5, 16, 31);
            b.pop();
        }

        /* --- Water tank on its stand ------------------------------------------------ */
        b.color(PAL.timberDark);
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                b.limb(-1.98 + sx * 0.28, 0, 0.02 + sz * 0.28,
                    -1.98 + sx * 0.21, 1.08, 0.02 + sz * 0.21, 0.042, 0.036, { radial: 5 });
            }
        }
        b.color(PAL.tank);
        b.push().translate(-1.98, 1.4, 0.02).scale(0.46, 0.64, 0.46)
            .add(new THREE.CylinderGeometry(1, 1, 1, 18, 1)).pop();
        b.color(PAL.steelDark);
        for (let i = 0; i < 4; i++) {
            b.push().translate(-1.98, 1.14 + i * 0.17, 0.02).scale(0.47, 0.012, 0.47)
                .add(new THREE.CylinderGeometry(1, 1, 1, 18, 1)).pop();
        }
        b.color(PAL.rust);
        b.push().translate(-1.98, 1.73, 0.02).scale(0.48, 0.06, 0.48)
            .add(new THREE.CylinderGeometry(0.2, 1, 1, 18, 1)).pop();

        /* --- Radio mast, with guys -------------------------------------------------- */
        {
            const mx = 1.2, mz = -2.3, mh = 3.6;
            b.color(PAL.steel);
            for (let i = 0; i < 3; i++) {
                const a = (i / 3) * MathUtils.TAU;
                b.limb(mx + Math.cos(a) * 0.1, 0, mz + Math.sin(a) * 0.1,
                    mx + Math.cos(a) * 0.05, mh, mz + Math.sin(a) * 0.05, 0.012, 0.01, { radial: 4 });
            }
            for (let i = 1; i < 10; i++) {
                b.push().translate(mx, (i / 10) * mh, mz).scale(0.1 - i * 0.005, 0.012, 0.1 - i * 0.005)
                    .add(R3D.UNIT.cylinderLow).pop();
            }
            b.color(PAL.steelDark);
            b.limb(mx, mh, mz, mx, mh + 0.6, mz, 0.008, 0.006, { radial: 3 });
            b.push().translate(mx + 0.08, mh - 0.3, mz).box(0.03, 0.26, 0.12).pop();
            b.color(PAL.chrome);
            for (let i = 0; i < 3; i++) {
                const a = (i / 3) * MathUtils.TAU + 0.4;
                b.limb(mx, mh * 0.8, mz, mx + Math.cos(a) * 1.3, 0.02, mz + Math.sin(a) * 1.3,
                    0.004, 0.004, { radial: 3, noCaps: true });
            }
        }

        /* --- Flag ------------------------------------------------------------------ */
        b.color(PAL.steel);
        b.limb(2.6, 0, -1.5, 2.6, 2.3, -1.5, 0.03, 0.018, { radial: 5 });
        b.color(PAL.sign);
        b.push().translate(2.78, 2.1, -1.5).box(0.36, 0.22, 0.015).pop();
        b.color(PAL.thatchPale);
        b.push().translate(2.78, 2.1, -1.49).box(0.36, 0.05, 0.016).pop();

        /* --- Fire pit and log benches --------------------------------------------- */
        {
            const fx = 2.35, fz = 1.85;
            b.color(PAL.stone);
            for (let i = 0; i < 10; i++) {
                const a = (i / 10) * MathUtils.TAU;
                b.push().translate(fx + Math.cos(a) * 0.36, 0.06, fz + Math.sin(a) * 0.36)
                    .sphere(0.09, 0.07, 0.09, { low: true }).pop();
            }
            b.color(PAL.ash);
            b.push().translate(fx, 0.04, fz).sphere(0.28, 0.03, 0.28, { low: true }).pop();
            b.color(PAL.timberDark);
            for (let i = 0; i < 3; i++) {
                const a = (i / 3) * MathUtils.TAU;
                b.limb(fx + Math.cos(a) * 0.2, 0.07, fz + Math.sin(a) * 0.2,
                    fx - Math.cos(a) * 0.05, 0.14, fz - Math.sin(a) * 0.05, 0.035, 0.03, { radial: 5 });
            }
            b.color(PAL.ember);
            b.push().translate(fx, 0.08, fz).sphere(0.08, 0.04, 0.08, { low: true }).pop();
            b.color(PAL.timber);
            for (const a of [0.9, 2.6, 4.4]) {
                const cx = fx + Math.cos(a) * 0.85, cz = fz + Math.sin(a) * 0.85;
                const t = a + Math.PI / 2;
                b.limb(cx - Math.cos(t) * 0.4, 0.1, cz - Math.sin(t) * 0.4,
                    cx + Math.cos(t) * 0.4, 0.1, cz + Math.sin(t) * 0.4, 0.09, 0.08, { radial: 7 });
            }
        }

        /* --- Fuel drums and crates -------------------------------------------------- */
        const drums = [[-1.55, -2.45, PAL.drum], [-1.3, -2.6, PAL.drumBlue], [-1.62, -2.75, PAL.drum]];
        for (const [x, z, col] of drums) {
            b.color(col);
            b.push().translate(x, 0.2, z).scale(0.13, 0.4, 0.13).add(new THREE.CylinderGeometry(1, 1, 1, 12, 1)).pop();
            b.color(PAL.steelDark);
            for (const y of [0.12, 0.28]) {
                b.push().translate(x, y, z).scale(0.135, 0.015, 0.135).add(R3D.UNIT.cylinderLow).pop();
            }
        }
        b.color(PAL.plank);
        b.push().translate(-0.9, 0.14, -2.55).rotate(0, 0.3, 0).box(0.34, 0.28, 0.3).pop();
        b.push().translate(-0.88, 0.4, -2.55).rotate(0, 0.1, 0).box(0.26, 0.22, 0.24).pop();

        /* --- The sign at the compound gate ------------------------------------------- */
        // Beside the path rather than across it: the jeep's carport is at the end of it.
        b.color(PAL.timberDark);
        for (const s of [-1, 1]) b.limb(3.1, 0, 1.55 + s * 0.42, 3.1, 1.05, 1.55 + s * 0.42, 0.035, 0.03, { radial: 5 });
        b.color(PAL.sign);
        b.push().translate(3.11, 0.82, 1.55).box(0.04, 0.34, 0.98).pop();
        b.color(PAL.signText);
        for (let i = 0; i < 2; i++) {
            b.push().translate(3.135, 0.88 - i * 0.12, 1.55).box(0.01, 0.045, 0.72 - i * 0.2).pop();
        }

        /* --- A short boma of stakes behind the lodge --------------------------------- */
        b.color(PAL.timberDark);
        for (let i = 0; i < 26; i++) {
            const a = Math.PI * 0.8 + (i / 25) * Math.PI * 0.42;
            const r = 3.55;
            const h = 0.55 + Noise.value2(i * 1.3, 0.5) * 0.25;
            b.limb(Math.cos(a) * r, 0, Math.sin(a) * r,
                Math.cos(a) * r * 1.01, h, Math.sin(a) * r * 1.01, 0.03, 0.022, { radial: 4 });
        }

        const mesh = new THREE.Mesh(b.build(), R3D.solidMaterial());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        return mesh;
    }

    /**
     * A carport where the jeep lives: four poles and a sagging shade net.
     * Built facing +X, to be placed over the jeep's parking spot.
     */
    function buildCarport() {
        const b = new R3D.GeoBuilder();
        b.color(PAL.timberDark);
        for (const [x, z] of [[0.75, 0.6], [0.75, -0.6], [-0.75, 0.6], [-0.75, -0.6]]) {
            b.limb(x, 0, z, x, 1.35, z, 0.04, 0.035, { radial: 6 });
        }
        b.color(PAL.timber);
        for (const s of [-1, 1]) b.push().translate(0, 1.35, s * 0.6).box(1.6, 0.05, 0.05).pop();
        b.color(PAL.shade);
        b.push().translate(0, 1.36, 0).box(1.7, 0.02, 1.34).pop();
        const mesh = new THREE.Mesh(b.build(), R3D.solidMaterial());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        return mesh;
    }

    /**
     * The boundary gate: fence panels either side and a barrier that lifts.
     *
     * The barrier is its own node because the simulation animates `gate.open` — the
     * lorry's arrival raises it, and that is the only moving part on the reserve's
     * boundary.
     */
    function buildGate() {
        const group = new THREE.Group();

        const b = new R3D.GeoBuilder();
        b.color(PAL.timberDark);
        for (const side of [-1, 1]) {
            b.limb(0, 0, side * 1.15, 0, 1.6, side * 1.15, 0.1, 0.085, { radial: 7 });
        }
        b.color(PAL.timber);
        b.push().translate(0, 1.65, 0).box(0.12, 0.12, 2.6).pop();
        b.color(PAL.sign);
        b.push().translate(0.07, 1.4, 0).box(0.03, 0.26, 1.2).pop();
        b.color(PAL.signText);
        b.push().translate(0.09, 1.42, 0).box(0.01, 0.06, 0.9).pop();
        // Fence running off both ways.
        for (const side of [-1, 1]) {
            for (let i = 1; i <= 5; i++) {
                const z = side * (1.15 + i * 1.35);
                b.color(PAL.timberDark);
                b.limb(0, 0, z, 0, 1.15, z, 0.055, 0.045, { radial: 5 });
                b.color(PAL.steelDark);
                for (const y of [0.95, 0.65, 0.35]) {
                    b.push().translate(0, y, z - side * 0.67).box(0.02, 0.02, 1.35).pop();
                }
            }
        }
        const posts = new THREE.Mesh(b.build(), R3D.solidMaterial());
        posts.castShadow = true;
        posts.receiveShadow = true;
        group.add(posts);

        // The barrier, pivoting about the left-hand post.
        const bb = new R3D.GeoBuilder();
        bb.color(R3D.col('#e3ddcf'));
        bb.push().translate(0, 0, 1.1).box(0.09, 0.14, 2.2).pop();
        bb.color(R3D.col('#b8402f'));
        for (let i = 0; i < 3; i++) {
            bb.push().translate(0, 0, 0.35 + i * 0.72).box(0.1, 0.15, 0.34).pop();
        }
        const barrier = new THREE.Mesh(bb.build(), R3D.solidMaterial());
        barrier.castShadow = true;
        barrier.position.set(0, 1.18, -1.15);
        group.add(barrier);

        group.userData.barrier = barrier;
        return group;
    }

    /* ------------------------------------------------------------------ *
     * Items
     * ------------------------------------------------------------------ */

    /**
     * One geometry per item kind, shared by every instance of it — and, because the
     * cache outlives a reserve, by every reserve. They are flagged so that tearing a
     * scene down does not dispose the buffers the next one is about to draw from.
     */
    const _items = new Map();

    function itemGeometry(kind) {
        let geo = _items.get(kind);
        if (geo) return geo;
        const b = new R3D.GeoBuilder();

        if (kind === 'melon') {
            b.color(PAL.melon);
            b.sphere(0.13, 0.11, 0.13, { low: true });
            b.color(PAL.melonStripe);
            for (let i = 0; i < 4; i++) {
                const a = (i / 4) * Math.PI;
                b.push().rotate(0, a, 0).box(0.02, 0.2, 0.26).pop();
            }
        } else if (kind === 'meat') {
            b.color(PAL.flesh);
            b.sphere(0.15, 0.07, 0.11, { low: true });
        } else if (kind === 'carcass') {
            b.color(PAL.flesh);
            b.sphere(0.34, 0.13, 0.2, { low: true });
            b.color(PAL.bone);
            for (let i = 0; i < 4; i++) {
                b.limb(-0.16 + i * 0.1, 0.05, -0.14, -0.2 + i * 0.11, 0.03, -0.3,
                    0.022, 0.014, { radial: 4 });
            }
            b.push().translate(0.34, 0.07, 0).sphere(0.1, 0.08, 0.08, { low: true }).pop();
        } else if (kind === 'shrub') {
            b.color(PAL.leafDark);
            for (let i = 0; i < 4; i++) {
                const a = (i / 4) * MathUtils.TAU;
                b.push().translate(Math.cos(a) * 0.07, 0.08, Math.sin(a) * 0.07)
                    .sphere(0.1, 0.09, 0.1, { low: true }).pop();
            }
        } else {
            // Forage: a cut bundle of grass, which is what the player is scattering.
            b.color(PAL.leaf);
            for (let i = 0; i < 5; i++) {
                const a = (i / 5) * MathUtils.TAU;
                b.limb(0, 0.01, 0, Math.cos(a) * 0.09, 0.17, Math.sin(a) * 0.09,
                    0.022, 0.006, { radial: 4, noCaps: true });
            }
            b.color(PAL.leafDark);
            b.push().translate(0, 0.02, 0).sphere(0.07, 0.03, 0.07, { low: true }).pop();
        }

        geo = b.build();
        geo.userData.shared = true;
        _items.set(kind, geo);
        return geo;
    }

    /** A tranquiliser dart in flight: a bright bolt with a visible flight. */
    function dartGeometry() {
        let geo = _items.get('__dart');
        if (geo) return geo;
        const b = new R3D.GeoBuilder();
        b.color(PAL.dart);
        b.limb(-0.1, 0, 0, 0.1, 0, 0, 0.022, 0.008, { radial: 5 });
        b.color(PAL.dartFlight);
        b.push().translate(-0.11, 0, 0).sphere(0.035, 0.045, 0.045, { low: true }).pop();
        geo = b.build();
        geo.userData.shared = true;
        _items.set('__dart', geo);
        return geo;
    }

    Safari.Models3D = {
        PAL,
        Vehicle3D,
        buildStation,
        buildCarport,
        buildGate,
        itemGeometry,
        dartGeometry,

        /** The warden's jeep. */
        jeep() {
            return new Jeep3D();
        },

        loader() {
            return new Loader3D();
        },

        lorry() {
            return new Lorry3D();
        },

        poacherTruck() {
            return new Poacher3D();
        }
    };

})(window.Safari, window.THREE);
