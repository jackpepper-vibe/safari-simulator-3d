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
     * A pyramidal thatched roof.
     *
     * Four courses of decreasing radius rather than one cone: real thatch is laid in
     * overlapping layers, and the steps catch the light, which is most of what makes a
     * roof read as thatch rather than as a brown pyramid. The eaves overhang, because a
     * roof that stops at the wall reads as a lid.
     *
     * @param {number} radius Eaves radius.
     * @param {number} height Apex height above the eaves.
     * @param {number} sides Plan shape: 4 for a hipped square, 8 for a round banda.
     */
    function thatchRoof(b, radius, height, sides, pal) {
        const courses = 4;
        for (let i = 0; i < courses; i++) {
            const t = i / courses;
            const t1 = (i + 1) / courses;
            const r0 = radius * (1 - t * 0.82);
            const r1 = radius * (1 - t1 * 0.82);
            b.color(i % 2 ? pal.thatch : pal.thatchDark);
            b.push()
                .translate(0, height * t + height / courses / 2, 0)
                .rotate(0, Math.PI / sides, 0)
                .scale(r0, height / courses * 1.04, r0);
            b.add(new THREE.CylinderGeometry(r1 / r0, 1, 1, sides, 1));
            b.pop();
        }
        // A capped ridge, so the apex is finished rather than sliced off.
        b.color(pal.thatchDark);
        b.push().translate(0, height * 1.02, 0)
            .sphere(radius * 0.12, height * 0.14, radius * 0.12, { low: true })
            .pop();
    }

    /** A run of veranda posts with rails along them. */
    function railing(b, x0, z0, x1, z1, height, pal) {
        const span = Math.hypot(x1 - x0, z1 - z0);
        const steps = Math.max(2, Math.round(span / 0.62));
        b.color(pal.post);
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            b.limb(x0 + (x1 - x0) * t, 0, z0 + (z1 - z0) * t,
                x0 + (x1 - x0) * t, height, z0 + (z1 - z0) * t,
                0.038, 0.032, { radial: 5 });
        }
        // Two rails, as a rough-sawn timber balustrade.
        for (const h of [height, height * 0.55]) {
            b.push().translate((x0 + x1) / 2, h, (z0 + z1) / 2)
                .rotate(0, -Math.atan2(z1 - z0, x1 - x0), 0)
                .box(span, 0.045, 0.045)
                .pop();
        }
    }

    /**
     * The safari camp.
     *
     * The reserve's one built thing, and for a while a shed with a hat on it. It is a
     * warden's headquarters, so it should look like somewhere a person lives and works:
     * a two-storey lodge on a stone plinth with a wrapped veranda, a railed lookout on
     * the upper floor facing the plain — the view the site is scored for when it is
     * chosen — and a thatched roof big enough to be the landmark you navigate by. Two
     * guest bandas, a water tank, a fire pit and a flag make it a camp rather than a
     * building.
     *
     * All of it merges into one geometry and draws in one call, so the detail costs
     * nothing at the distance the camp is usually seen from.
     */
    function buildStation() {
        const b = new R3D.GeoBuilder();

        /* --- The worn apron the camp stands on ---------------------------- */
        b.color(PAL.stone);
        b.push().translate(0, 0.02, 0).scale(4.2, 0.05, 4.2).add(R3D.UNIT.cylinder).pop();

        /* --- Ground floor -------------------------------------------------- */
        // A stone plinth under a whitewashed storey. The two materials are what give
        // the building a base rather than a hem.
        b.color(PAL.stone);
        b.push().translate(0, 0.16, 0).box(2.24, 0.24, 1.74).pop();
        b.color(PAL.wall);
        b.push().translate(0, 0.70, 0).box(2.10, 0.86, 1.60).pop();

        // Windows and a door, painted as recesses. Modelling them means holes in the
        // walls, which is a great deal of geometry for a dark rectangle.
        b.color(PAL.wallShade);
        for (const side of [-1, 1]) {
            for (const wx of [-0.62, 0, 0.62]) {
                b.push().translate(wx, 0.78, side * 0.805).box(0.34, 0.34, 0.03).pop();
            }
        }
        b.color(PAL.post);
        b.push().translate(1.06, 0.62, 0).box(0.03, 0.62, 0.44).pop();

        /* --- Veranda -------------------------------------------------------- */
        b.color(PAL.wallShade);
        b.push().translate(0.11, 0.27, 0).box(3.06, 0.07, 2.52).pop();
        b.color(PAL.stone);
        for (let i = 0; i < 3; i++) {
            b.push().translate(1.68 + i * 0.15, 0.20 - i * 0.06, 0)
                .box(0.17, 0.07, 0.72).pop();
        }

        railing(b, 1.58, -1.24, 1.58, 1.24, 0.52, PAL);
        railing(b, -1.36, 1.24, 1.58, 1.24, 0.52, PAL);
        railing(b, -1.36, -1.24, 1.58, -1.24, 0.52, PAL);

        // Posts carrying the veranda roof, standing above the rail.
        b.color(PAL.post);
        for (const post of [[1.58, -1.24], [1.58, 1.24], [-1.36, 1.24], [-1.36, -1.24],
            [0.15, 1.24], [0.15, -1.24]]) {
            b.limb(post[0], 0.27, post[1], post[0], 1.32, post[1], 0.062, 0.052,
                { radial: 6 });
        }

        /*
         * The veranda's own thatch apron, below the main roof.
         *
         * Pitched, not flat. A shallow one reads as a carport awning; thatch is steep
         * because it has to shed rain, and the pitch is a good part of why a camp looks
         * like a camp from across the reserve.
         */
        b.color(PAL.thatchDark);
        b.push().translate(0.11, 1.30, 0).rotate(0, Math.PI / 4, 0).scale(2.26, 0.07, 2.26);
        b.add(new THREE.CylinderGeometry(1, 1, 1, 4, 1));
        b.pop();
        b.push().translate(0.11, 1.33, 0);
        // Kept low and tight to the posts. Any deeper and it swallows the upper storey,
        // and a two-storey camp that reads as one storey is not worth building.
        thatchRoof(b, 2.20, 0.56, 4, PAL);
        b.pop();

        /* --- Upper storey and the lookout ------------------------------------ */
        b.color(PAL.wall);
        b.push().translate(-0.12, 2.06, 0).box(1.58, 0.86, 1.26).pop();
        b.color(PAL.wallShade);
        for (const side of [-1, 1]) {
            b.push().translate(-0.12, 2.14, side * 0.645).box(0.72, 0.38, 0.03).pop();
        }
        b.push().translate(-0.92, 2.14, 0).box(0.03, 0.38, 0.64).pop();

        // The balcony that faces the plain.
        b.color(PAL.wallShade);
        b.push().translate(1.06, 1.66, 0).box(0.92, 0.07, 1.46).pop();
        railing(b, 1.48, -0.72, 1.48, 0.72, 0.46, PAL);
        railing(b, 0.66, 0.72, 1.48, 0.72, 0.46, PAL);
        railing(b, 0.66, -0.72, 1.48, -0.72, 0.46, PAL);

        // The stair up the side of the building.
        b.color(PAL.post);
        for (let i = 0; i < 8; i++) {
            b.push().translate(-1.28, 0.42 + i * 0.165, -0.62 + i * 0.155)
                .box(0.52, 0.05, 0.26).pop();
        }

        /* --- The roof that makes it a landmark -------------------------------- */
        b.color(PAL.thatchDark);
        b.push().translate(-0.12, 2.46, 0).rotate(0, Math.PI / 4, 0).scale(1.78, 0.07, 1.78);
        b.add(new THREE.CylinderGeometry(1, 1, 1, 4, 1));
        b.pop();
        b.push().translate(-0.12, 2.49, 0);
        thatchRoof(b, 1.74, 1.76, 4, PAL);
        b.pop();

        /* --- Guest bandas ------------------------------------------------------ */
        const bandas = [[-2.60, 1.80, 0.62], [-2.80, -1.60, 0.55]];
        for (const banda of bandas) {
            const gx = banda[0], gz = banda[1], gr = banda[2];
            b.color(PAL.stone);
            b.push().translate(gx, 0.06, gz).scale(gr * 1.02, 0.12, gr * 1.02)
                .add(R3D.UNIT.cylinder).pop();
            b.color(PAL.wall);
            b.push().translate(gx, 0.40, gz).scale(gr * 0.84, 0.74, gr * 0.84)
                .add(R3D.UNIT.cylinder).pop();
            b.push().translate(gx, 0.77, gz);
            thatchRoof(b, gr * 1.30, gr * 1.45, 8, PAL);
            b.pop();
        }

        /* --- Water tank on its stand -------------------------------------------- */
        b.color(PAL.post);
        for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
                b.limb(-1.98 + sx * 0.28, 0, 0.02 + sz * 0.28,
                    -1.98 + sx * 0.21, 1.08, 0.02 + sz * 0.21, 0.046, 0.038, { radial: 5 });
            }
        }
        b.color(PAL.tank);
        b.push().translate(-1.98, 1.40, 0.02).scale(0.46, 0.64, 0.46)
            .add(R3D.UNIT.cylinder).pop();
        b.color(PAL.rust);
        b.push().translate(-1.98, 1.73, 0.02).scale(0.48, 0.07, 0.48)
            .add(R3D.UNIT.cylinder).pop();

        /* --- Fire pit and flagpole ----------------------------------------------- */
        b.color(PAL.stone);
        for (let i = 0; i < 9; i++) {
            const a = (i / 9) * MathUtils.TAU;
            b.push().translate(2.45 + Math.cos(a) * 0.44, 0.07, 1.80 + Math.sin(a) * 0.44)
                .sphere(0.11, 0.09, 0.11, { low: true }).pop();
        }
        b.color(PAL.poacherDark);
        b.push().translate(2.45, 0.09, 1.80).sphere(0.30, 0.05, 0.30, { low: true }).pop();

        b.color(PAL.steel);
        b.limb(2.15, 0, -1.90, 2.15, 2.20, -1.90, 0.036, 0.022, { radial: 5 });
        b.color(PAL.canvasTop);
        b.push().translate(2.31, 2.00, -1.90).box(0.34, 0.21, 0.02).pop();

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
