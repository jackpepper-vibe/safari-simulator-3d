/**
 * Safari Simulator 3D — Built things.
 *
 * The ranger station, the boundary gate, the four vehicles and the items lying on the
 * ground. Each is assembled from the shared primitive kit and merged into one geometry
 * with its colour per vertex, so every object in this file is a single draw call and
 * every one of them is lit by the same key light as the animals.
 *
 * The vehicles read the render state the simulation already produced — `facing`,
 * `speed01`, `wheelPhase`, `bounce`, `aiming`, `cargo`, `lift`. Nothing new was asked
 * of the simulation to make them three-dimensional; the wheel phase that spun a drawn
 * ellipse now spins a wheel.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, R3D } = Safari;

    const PAL = {
        // The jeep: sun-bleached reserve green with a canvas roof.
        jeep: R3D.col('#5d6b45'),
        jeepDark: R3D.col('#3f4a2f'),
        canvasTop: R3D.col('#c9bb95'),
        tyre: R3D.col('#22201d'),
        rim: R3D.col('#9a958a'),
        glass: R3D.col('#7d99a4'),
        lamp: R3D.col('#ffeec2'),

        // Working vehicles are yellow plant, and the poachers' truck is not.
        plant: R3D.col('#c99a2e'),
        plantDark: R3D.col('#8a6a1c'),
        steel: R3D.col('#8e8b84'),
        steelDark: R3D.col('#5b584f'),
        poacher: R3D.col('#6b4a34'),
        poacherDark: R3D.col('#422d20'),

        // The station: whitewashed block, thatch, and a rusting water tank.
        wall: R3D.col('#d8cdb4'),
        wallShade: R3D.col('#b3a68c'),
        thatch: R3D.col('#9a7a44'),
        thatchDark: R3D.col('#6d5530'),
        post: R3D.col('#7a6242'),
        tank: R3D.col('#8d9a92'),
        rust: R3D.col('#9c6438'),
        stone: R3D.col('#a09484'),

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

    /* ------------------------------------------------------------------ *
     * Vehicles
     * ------------------------------------------------------------------ */

    /**
     * Vehicles are built as a body plus four wheels on their own pivots, so the wheels
     * can spin and the body can pitch on its suspension. That is two nodes and five
     * meshes rather than one merged block — the one place in this file where a hierarchy
     * earns its keep.
     */
    class Vehicle3D {
        /**
         * @param {object} opts
         * @param {number} opts.length  Along +X, in world units.
         * @param {number} opts.width
         * @param {function(Safari.R3D.GeoBuilder, object):void} opts.body
         * @param {number} opts.wheel   Wheel radius.
         * @param {Array<Array<number>>} opts.axles [[x, z], ...] wheel centres.
         */
        constructor(opts) {
            this.opts = opts;
            this.root = new THREE.Group();

            const b = new R3D.GeoBuilder();
            opts.body(b, PAL);
            this.chassis = new THREE.Mesh(b.build(), R3D.solidMaterial());
            this.chassis.castShadow = true;
            this.chassis.receiveShadow = true;
            this.root.add(this.chassis);

            // One wheel geometry, reused; the tread is a ring of blocks so the spin is
            // actually visible rather than a smooth cylinder that looks static.
            const wb = new R3D.GeoBuilder();
            const r = opts.wheel;
            wb.color(PAL.tyre);
            wb.push().rotate(Math.PI / 2, 0, 0).scale(r, opts.wheelWidth || r * 0.5, r);
            wb.add(R3D.UNIT.cylinder);
            wb.pop();
            wb.color(PAL.rim);
            wb.push().rotate(Math.PI / 2, 0, 0).scale(r * 0.42, (opts.wheelWidth || r * 0.5) * 1.1, r * 0.42);
            wb.add(R3D.UNIT.cylinder);
            wb.pop();
            wb.color(PAL.steelDark);
            for (let i = 0; i < 4; i++) {
                const a = (i / 4) * MathUtils.TAU;
                wb.push().translate(Math.cos(a) * r * 0.7, 0, Math.sin(a) * r * 0.7)
                    .box(r * 0.28, r * 0.5, (opts.wheelWidth || r * 0.5) * 0.9)
                    .pop();
            }
            const wheelGeo = wb.build();

            this.wheels = [];
            for (const axle of opts.axles) {
                const mesh = new THREE.Mesh(wheelGeo, R3D.solidMaterial());
                mesh.castShadow = true;
                mesh.position.set(axle[0], r, axle[1]);
                this.root.add(mesh);
                this.wheels.push(mesh);
            }
        }

        /**
         * Sit the vehicle on the ground and animate it.
         *
         * The body pitches and rolls to the slope it is standing on, which is the single
         * cheapest thing that makes a vehicle look like it is on the terrain rather than
         * sliding over a picture of it.
         */
        update(entity, world, dt) {
            const rs = entity.renderState;
            const root = this.root;
            root.position.set(entity.x, R3D.surfaceY(world, entity.x, entity.y), entity.y);
            root.rotation.y = R3D.yawFor(rs.facing === undefined ? entity.facing : rs.facing);

            // Pitch and roll from the terrain gradient, in the vehicle's own frame.
            const d = 0.5;
            const f = root.rotation.y;
            const fx = Math.cos(-f), fz = Math.sin(-f);
            const ahead = R3D.groundY(world, entity.x + fx * d, entity.y + fz * d);
            const behind = R3D.groundY(world, entity.x - fx * d, entity.y - fz * d);
            const left = R3D.groundY(world, entity.x - fz * d, entity.y + fx * d);
            const right = R3D.groundY(world, entity.x + fz * d, entity.y - fx * d);

            this.chassis.rotation.z = MathUtils.clamp(
                -(ahead - behind) / (2 * d), -0.5, 0.5) + (rs.bounce || 0) * 0.02;
            this.chassis.rotation.x = MathUtils.clamp((left - right) / (2 * d), -0.5, 0.5);
            this.chassis.position.y = Math.abs(rs.bounce || 0) * 0.01;

            const spin = (rs.wheelPhase || 0);
            for (let i = 0; i < this.wheels.length; i++) {
                this.wheels[i].rotation.z = -spin;
            }
            void dt;
        }

        get object() {
            return this.root;
        }
    }

    /* --- Body builders ------------------------------------------------- */

    /** The warden's 4x4: open-topped, roll bar, spare on the back. */
    function jeepBody(b, pal) {
        b.color(pal.jeep);
        b.push().translate(0, 0.30, 0).box(1.30, 0.26, 0.72).pop();
        b.push().translate(-0.18, 0.48, 0).box(0.72, 0.24, 0.66).pop();
        b.color(pal.jeepDark);
        b.push().translate(0.42, 0.46, 0).box(0.44, 0.22, 0.62).pop();

        // Screen and roll bar.
        b.color(pal.glass);
        b.push().translate(0.16, 0.62, 0).rotate(0, 0, -0.22).box(0.05, 0.30, 0.58).pop();
        b.color(pal.steel);
        for (const side of [-1, 1]) {
            b.limb(-0.30, 0.52, side * 0.28, -0.30, 0.84, side * 0.28, 0.026, 0.026, { radial: 5 });
        }
        b.limb(-0.30, 0.84, -0.28, -0.30, 0.84, 0.28, 0.026, 0.026, { radial: 5 });
        b.color(pal.canvasTop);
        b.push().translate(-0.30, 0.86, 0).box(0.52, 0.04, 0.60).pop();

        // Headlamps and the spare wheel.
        b.color(pal.lamp);
        for (const side of [-1, 1]) {
            b.push().translate(0.63, 0.38, side * 0.22).sphere(0.05, 0.07, 0.07, { low: true }).pop();
        }
        b.color(pal.tyre);
        b.push().translate(-0.68, 0.44, 0).rotate(0, 0, Math.PI / 2)
            .scale(0.19, 0.08, 0.19).add(R3D.UNIT.cylinderLow).pop();
    }

    /** The loader: a small tractor with a cradle arm on the front. */
    function loaderBody(b, pal) {
        b.color(pal.plant);
        b.push().translate(-0.10, 0.34, 0).box(1.00, 0.30, 0.70).pop();
        b.push().translate(-0.34, 0.62, 0).box(0.44, 0.32, 0.56).pop();
        b.color(pal.steelDark);
        b.push().translate(-0.34, 0.80, 0).box(0.40, 0.04, 0.52).pop();
        b.color(pal.plantDark);
        b.push().translate(0.34, 0.30, 0).box(0.34, 0.20, 0.60).pop();
    }

    /** The lorry: a flatbed with slatted sides and a crew cab. */
    function lorryBody(b, pal) {
        b.color(pal.steel);
        b.push().translate(0, 0.34, 0).box(2.10, 0.20, 0.92).pop();
        b.color(pal.plant);
        b.push().translate(0.72, 0.66, 0).box(0.64, 0.50, 0.86).pop();
        b.color(pal.glass);
        b.push().translate(0.99, 0.74, 0).box(0.10, 0.26, 0.74).pop();

        // Slatted stock sides, which is what says "livestock lorry" at a glance.
        b.color(pal.plantDark);
        for (const side of [-1, 1]) {
            for (let i = 0; i < 5; i++) {
                b.push().translate(-0.75 + i * 0.30, 0.60, side * 0.44)
                    .box(0.06, 0.44, 0.05).pop();
            }
            b.push().translate(-0.30, 0.80, side * 0.44).box(1.30, 0.06, 0.06).pop();
            b.push().translate(-0.30, 0.52, side * 0.44).box(1.30, 0.05, 0.05).pop();
        }
        b.push().translate(-0.96, 0.62, 0).box(0.06, 0.46, 0.86).pop();
    }

    /** The poachers': a battered pickup, deliberately drab. */
    function poacherBody(b, pal) {
        b.color(pal.poacher);
        b.push().translate(0, 0.32, 0).box(1.40, 0.26, 0.74).pop();
        b.push().translate(0.16, 0.56, 0).box(0.56, 0.28, 0.68).pop();
        b.color(pal.poacherDark);
        b.push().translate(-0.42, 0.46, 0).box(0.62, 0.16, 0.70).pop();
        b.color(pal.glass);
        b.push().translate(0.42, 0.60, 0).box(0.06, 0.20, 0.60).pop();
        b.color(pal.steelDark);
        // A rifle rack across the bed: the read is meant to be uncomfortable.
        b.push().translate(-0.42, 0.60, 0).rotate(0, 0.3, 0).box(0.72, 0.03, 0.03).pop();
    }

    /* ------------------------------------------------------------------ *
     * Structures
     * ------------------------------------------------------------------ */

    /**
     * The ranger station: a thatched block, a water tank on a stand, and a shaded
     * veranda. The one fixed point on a landscape that is otherwise grass and weather.
     */
    function buildStation() {
        const b = new R3D.GeoBuilder();

        // Worn apron.
        b.color(PAL.stone);
        b.push().translate(0, 0.02, 0).scale(3.0, 0.04, 3.0).add(R3D.UNIT.cylinderLow).pop();

        // The hut.
        b.color(PAL.wall);
        b.push().translate(0, 0.62, 0).box(2.00, 1.20, 1.50).pop();
        b.color(PAL.wallShade);
        b.push().translate(0, 0.16, 0).box(2.08, 0.24, 1.58).pop();

        // Thatch, as a shallow pyramid with an overhang.
        b.color(PAL.thatch);
        b.push().translate(0, 1.22, 0).scale(1.55, 0.55, 1.25).add(R3D.UNIT.cone).pop();
        b.color(PAL.thatchDark);
        b.push().translate(0, 1.20, 0).scale(1.62, 0.06, 1.32).add(R3D.UNIT.cylinderLow).pop();

        // Veranda posts and roof.
        b.color(PAL.post);
        for (const side of [-1, 1]) {
            b.limb(1.30, 0, side * 0.62, 1.30, 1.00, side * 0.62, 0.055, 0.05, { radial: 5 });
        }
        b.color(PAL.thatch);
        b.push().translate(1.10, 1.06, 0).rotate(0, 0, -0.12).box(0.80, 0.07, 1.44).pop();

        // Water tank on a stand — the thing that makes a compound read as inhabited.
        b.color(PAL.post);
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                b.limb(-1.55 + sx * 0.22, 0, 0.95 + sz * 0.22,
                    -1.55 + sx * 0.22, 0.80, 0.95 + sz * 0.22, 0.04, 0.035, { radial: 4 });
            }
        }
        b.color(PAL.tank);
        b.push().translate(-1.55, 1.10, 0.95).scale(0.42, 0.60, 0.42)
            .add(R3D.UNIT.cylinder).pop();
        b.color(PAL.rust);
        b.push().translate(-1.55, 1.42, 0.95).scale(0.44, 0.06, 0.44)
            .add(R3D.UNIT.cylinderLow).pop();

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
        b.color(PAL.post);
        // Gateposts.
        for (const side of [-1, 1]) {
            b.limb(0, 0, side * 1.15, 0, 1.60, side * 1.15, 0.10, 0.085, { radial: 6 });
        }
        // Fence running off both ways, thinning into the distance.
        for (const side of [-1, 1]) {
            for (let i = 1; i <= 5; i++) {
                const z = side * (1.15 + i * 1.35);
                b.limb(0, 0, z, 0, 1.15, z, 0.055, 0.045, { radial: 4 });
                b.color(PAL.steelDark);
                b.push().translate(0, 0.95, z - side * 0.67).box(0.035, 0.035, 1.35).pop();
                b.push().translate(0, 0.55, z - side * 0.67).box(0.030, 0.030, 1.35).pop();
                b.color(PAL.post);
            }
        }
        const posts = new THREE.Mesh(b.build(), R3D.solidMaterial());
        posts.castShadow = true;
        posts.receiveShadow = true;
        group.add(posts);

        // The barrier, pivoting about the left-hand post.
        const bb = new R3D.GeoBuilder();
        bb.color(R3D.col('#d8d2c4'));
        bb.push().translate(0, 0, 1.10).box(0.09, 0.16, 2.20).pop();
        bb.color(R3D.col('#c04a3a'));
        for (let i = 0; i < 3; i++) {
            bb.push().translate(0, 0, 0.35 + i * 0.72).box(0.10, 0.17, 0.34).pop();
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
                b.push().rotate(0, a, 0).box(0.02, 0.20, 0.26).pop();
            }
        } else if (kind === 'meat') {
            b.color(PAL.flesh);
            b.sphere(0.15, 0.07, 0.11, { low: true });
        } else if (kind === 'carcass') {
            b.color(PAL.flesh);
            b.sphere(0.34, 0.13, 0.20, { low: true });
            b.color(PAL.bone);
            for (let i = 0; i < 4; i++) {
                b.limb(-0.16 + i * 0.10, 0.05, -0.14, -0.20 + i * 0.11, 0.03, -0.30,
                    0.022, 0.014, { radial: 4 });
            }
            b.push().translate(0.34, 0.07, 0).sphere(0.10, 0.08, 0.08, { low: true }).pop();
        } else if (kind === 'shrub') {
            b.color(PAL.leafDark);
            for (let i = 0; i < 4; i++) {
                const a = (i / 4) * MathUtils.TAU;
                b.push().translate(Math.cos(a) * 0.07, 0.08, Math.sin(a) * 0.07)
                    .sphere(0.10, 0.09, 0.10, { low: true }).pop();
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
        b.limb(-0.10, 0, 0, 0.10, 0, 0, 0.022, 0.008, { radial: 5 });
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
        buildGate,
        itemGeometry,
        dartGeometry,

        /** The warden's jeep. */
        jeep() {
            return new Vehicle3D({
                body: jeepBody, wheel: 0.20, wheelWidth: 0.11,
                axles: [[0.42, -0.34], [0.42, 0.34], [-0.42, -0.34], [-0.42, 0.34]]
            });
        },

        loader() {
            return new Vehicle3D({
                body: loaderBody, wheel: 0.22, wheelWidth: 0.13,
                axles: [[0.34, -0.32], [0.34, 0.32], [-0.40, -0.36], [-0.40, 0.36]]
            });
        },

        lorry() {
            return new Vehicle3D({
                body: lorryBody, wheel: 0.24, wheelWidth: 0.14,
                axles: [[0.74, -0.44], [0.74, 0.44], [-0.52, -0.46], [-0.52, 0.46],
                    [-0.84, -0.46], [-0.84, 0.46]]
            });
        },

        poacherTruck() {
            return new Vehicle3D({
                body: poacherBody, wheel: 0.21, wheelWidth: 0.12,
                axles: [[0.44, -0.36], [0.44, 0.36], [-0.46, -0.36], [-0.46, 0.36]]
            });
        }
    };

})(window.Safari, window.THREE);
