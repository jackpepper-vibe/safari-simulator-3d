/**
 * Safari Simulator 3D — Creatures.
 *
 * The species rigs in `IsoSpecies` were already authored in three dimensions — `fx`
 * forward, `fy` left, `fz` up — because the isometric build projected them by hand.
 * That is the whole reason this fork was cheap: the anatomy is data the 2D game already
 * had, and all that changed is that a real camera looks at it instead of a projection
 * function.
 *
 * Each species is built once into a **skinned mesh**: every primitive is merged into a
 * single buffer with its colour baked per vertex and each vertex bound rigidly to one
 * bone. An animal is therefore one draw call and one skeleton, not thirty meshes, and
 * a hundred of them cost what a handful of naive rigs would.
 *
 * AXES
 *   rig fx  →  +X    (nose)
 *   rig fz  →  +Y    (up)
 *   rig fy  →  −Z    (the animal's left)
 *
 * A model authored nose-along-+X is oriented with `rotation.y = -facing`, because the
 * simulation's headings increase from +X toward +Z.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Noise, R3D, Surface3D } = Safari;
    const TAU = MathUtils.TAU;
    const PX = R3D.PX;

    /** Newborn proportions, matching the 2D rig: small body, outsized head. */
    const BABY_SCALE = 0.52;
    const BABY_HEAD = 1.34;

    /* Low-poly options. A reserve holds a hundred animals and every one of them casts
     * a shadow, so the primitive counts are kept deliberately lean. */
    const LOW = { low: true };
    const SEG = { radial: 7, noCaps: true };

    const _q = new THREE.Quaternion();
    const _q2 = new THREE.Quaternion();
    const _v = new THREE.Vector3();
    const _up = new THREE.Vector3(0, 1, 0);
    const _down = new THREE.Vector3(0, -1, 0);
    const _col = new THREE.Color();

    /* ------------------------------------------------------------------ *
     * Rig definition
     * ------------------------------------------------------------------ */

    /**
     * Lay out the skeleton for a species.
     *
     * Rest positions are absolute, in mesh space; the parent offsets Three actually
     * wants are derived from them. Authoring absolutes is what lets the geometry for a
     * bone simply be built around that bone's rest point.
     *
     * @returns {{list:Array, index:Object}}
     */
    function defineRig(spec) {
        const list = [];
        const index = {};

        const add = (name, parent, x, y, z) => {
            index[name] = list.length;
            list.push({ name, parent, x: x * PX, y: y * PX, z: z * PX });
        };

        const body = spec.body;
        const neck = spec.neck;
        const legs = spec.legs;

        add('root', -1, 0, 0, 0);
        add('body', 'root', body.x, body.z, 0);

        // The neck's tip is where the head sits, at the rig's authored rest angle.
        const neckTipX = neck.x + Math.cos(neck.angle) * neck.length;
        const neckTipZ = neck.z + Math.sin(neck.angle) * neck.length;
        add('neck', 'body', neck.x, neck.z, 0);
        add('head', 'neck', neckTipX, neckTipZ, 0);
        add('eyes', 'head', neckTipX + (spec.eye ? spec.eye.offset : 0),
            neckTipZ + (spec.eye ? spec.eye.rise : 0), 0);

        if (spec.ear) {
            const ear = spec.ear;
            add('earL', 'head', neckTipX + ear.offset, neckTipZ + ear.rise, -ear.spread);
            add('earR', 'head', neckTipX + ear.offset, neckTipZ + ear.rise, ear.spread);
        }
        if (spec.trunk) {
            add('trunkA', 'head', neckTipX + spec.head.offset, neckTipZ - spec.head.height * 0.2, 0);
            add('trunkB', 'trunkA',
                neckTipX + spec.head.offset + spec.trunk.length * 0.28,
                neckTipZ - spec.head.height * 0.2 - spec.trunk.length * 0.34, 0);
        }

        add('tail', 'body', -body.length * 0.5, body.z + spec.tail.rise, 0);

        // Four limbs, front pair first, left of each pair first — the order the gait
        // phase table in the species rig is written in.
        for (let i = 0; i < 4; i++) {
            const front = i < 2;
            const left = (i % 2) === 0;
            const a = front ? legs.front : legs.rear;
            const lateral = (left ? 1 : -1) * a.spread;
            add('hip' + i, 'body', a.x, a.z, -lateral);
            add('knee' + i, 'hip' + i, a.x, a.z - a.upper, -lateral);
        }

        if (spec.wings) {
            add('wingL', 'body', spec.wings.root, body.z + spec.wings.rise, -body.width * 0.6);
            add('wingR', 'body', spec.wings.root, body.z + spec.wings.rise, body.width * 0.6);
        }

        return { list, index };
    }

    /* ------------------------------------------------------------------ *
     * Markings
     * ------------------------------------------------------------------ */

    /**
     * Per-vertex colouring for a marked hide.
     *
     * The 2D build drew stripes and patches as paths over the body. Here they are a
     * function of position on the unit sphere the torso is scaled from, evaluated once
     * at build time and baked into the vertex colours — no texture, no UV unwrap, and
     * a zebra still reads as a zebra from any angle.
     *
     * @returns {function(number,number,number):THREE.Color|null}
     */
    function markingFn(spec, base, seed) {
        const m = spec.markings;
        if (!m) return null;
        const mark = R3D.col(m.color);
        const alpha = m.alpha === undefined ? 1 : m.alpha;

        if (m.type === 'stripes') {
            const n = m.count * 0.55;
            return (x, y, z) => {
                // Stripes run around the barrel, bending as they cross the flank.
                const bend = z * 0.35 + Math.abs(y) * 0.25;
                const s = Math.sin((x * n + bend) * Math.PI);
                // Broad bands with a hard edge. Narrower ones vanished under a strong
                // sun on a near-white hide, which is the opposite of what a zebra is for.
                const k = MathUtils.clamp01((Math.abs(s) - 0.42) * 4.5);
                return _col.copy(base).lerp(mark, (1 - k) * alpha);
            };
        }

        if (m.type === 'patches') {
            const f = 1.9;
            return (x, y, z) => {
                // Reticulated: a low-frequency cellular field thresholded hard, so the
                // patches have the flat edges a giraffe's do.
                const v = Noise.fbm2(x * f + seed, (y * 1.3 + z) * f + seed * 0.3, 2, 2.1, 0.55);
                const k = MathUtils.smoothstep(0.46, 0.54, v);
                return _col.copy(base).lerp(mark, k * alpha);
            };
        }

        // Spots: small, sparse, and only along the back.
        const f = 5.5;
        return (x, y, z) => {
            const v = Noise.value2(x * f + seed, (z * f + y * 2.2) + seed);
            const top = MathUtils.clamp01(y * 1.4 + 0.35);
            const k = v > 0.74 ? top : 0;
            return _col.copy(base).lerp(mark, k * alpha);
        };
    }

    /* ------------------------------------------------------------------ *
     * Geometry
     * ------------------------------------------------------------------ */

    /**
     * Build the merged, skinned geometry for a species.
     *
     * Every part is authored at its bone's rest position, so the bind pose is the rig
     * exactly as `IsoSpecies` describes it — standing square, head up.
     */
    function buildGeometry(spec, rig) {
        const b = new R3D.GeoBuilder(true);
        const pal = spec.palette;
        const base = R3D.col(pal.base);
        const limbCol = R3D.col(pal.limb);
        const hoofCol = R3D.col(pal.hoof);
        const muzzleCol = R3D.col(pal.muzzle);
        const maneCol = R3D.col(pal.mane);
        const eyeCol = R3D.col(pal.eye);

        const body = spec.body;
        const neck = spec.neck;
        const head = spec.head;
        const legs = spec.legs;
        const rest = rig.list;
        /** Rest position of a bone in mesh space. The rig stores these absolute. */
        const abs = (name) => rest[rig.index[name]];

        /* --- The trunk, as one continuous surface ---------------------------- *
         *
         * Barrel, shoulder, haunch, neck, skull and muzzle are one mass on a real
         * animal, so they are one surface here: added to a distance field, blended, and
         * polygonised into a single skin with fillets at the joins. Drawn as separate
         * ellipsoids — which is how this started — a hippo read as four lumps with a
         * head balanced on them, and no amount of tessellation fixes that, because the
         * creases are real geometry.
         *
         * The blend width is scaled to the animal: a fillet that flatters a rabbit
         * would swallow an elephant's neck.
         */
        const bodyPos = abs('body');
        const neckPos = abs('neck');
        const headPos = abs('head');
        const marks = markingFn(spec, base, (spec.id || '').length * 7 + 3);

        const iBody = rig.index.body;
        const iNeck = rig.index.neck;
        const iHead = rig.index.head;
        const bulk = Math.max(body.length, body.height) * PX;
        const field = new Surface3D.Field(bulk * 0.26);

        field.ellipsoid(iBody, bodyPos.x, bodyPos.y, bodyPos.z,
            body.length * 0.5 * PX, body.height * 0.5 * PX, body.width * 0.5 * PX);

        // Shoulder and haunch masses. Blended in, they stop reading as attached balls
        // and start doing what they are for: keeping the barrel from being a balloon.
        field.ellipsoid(iBody,
            bodyPos.x + body.length * 0.30 * PX, bodyPos.y + body.height * 0.10 * PX, 0,
            body.length * 0.24 * PX, body.height * 0.46 * PX, body.width * 0.54 * PX);
        field.ellipsoid(iBody,
            bodyPos.x - body.length * 0.32 * PX, bodyPos.y + body.height * 0.06 * PX, 0,
            body.length * 0.25 * PX, body.height * 0.48 * PX, body.width * 0.56 * PX);

        // Stubs where the legs leave the body, so a limb emerges from a haunch rather
        // than being posted into a hole.
        for (let i = 0; i < 4; i++) {
            const anchor = i < 2 ? legs.front : legs.rear;
            const lateral = (i % 2 === 0 ? 1 : -1) * anchor.spread;
            field.ellipsoid(iBody, anchor.x * PX, anchor.z * PX, -lateral * PX,
                legs.thickTop * 0.60 * PX, legs.thickTop * 0.72 * PX,
                legs.thickTop * 0.48 * PX);
        }

        field.capsule(iNeck, neckPos.x, neckPos.y, neckPos.z,
            headPos.x, headPos.y, headPos.z,
            neck.thickBase * 0.5 * PX, neck.thickTip * 0.5 * PX);

        if (spec.ruff) {
            field.ellipsoid(iHead,
                headPos.x - spec.ruff.radius * 0.28 * PX, headPos.y, 0,
                spec.ruff.radius * 0.85 * PX, spec.ruff.radius * PX, spec.ruff.radius * PX);
        }

        // Head and muzzle offsets, relative to the head bone — the appendages below
        // are still built in that bone's space.
        const hx = Math.cos(head.angle) * head.offset * PX;
        const hy = Math.sin(head.angle) * head.offset * PX;
        const mz = head.muzzle;
        const mx = Math.cos(head.angle) * (head.offset + mz.offset) * PX;
        const my = Math.sin(head.angle) * (head.offset + mz.offset) * PX;

        field.ellipsoid(iHead, headPos.x + hx, headPos.y + hy, 0,
            head.length * 0.5 * PX, head.height * 0.5 * PX, head.width * 0.5 * PX);
        // A tighter blend on the muzzle: a soft one melts the face into the skull.
        field.ellipsoid(iHead, headPos.x + mx, headPos.y + my, 0,
            mz.length * 0.5 * PX, mz.height * 0.5 * PX, mz.width * 0.5 * PX, bulk * 0.09);

        /*
         * A jaw under the muzzle.
         *
         * Without one the front of the head is a single tapering mass and every animal
         * on the reserve ends up with the same blunt snout — the hippo in particular
         * came out as a mole. The jaw is set slightly back and below, on a tight blend,
         * which gives a crease for the mouth line to be painted into and stops the
         * profile reading as a cone.
         */
        const jawY = headPos.y + my - mz.height * 0.30 * PX;
        const jawX = headPos.x + mx - mz.length * 0.14 * PX;
        field.ellipsoid(iHead, jawX, jawY, 0,
            mz.length * 0.52 * PX, mz.height * 0.34 * PX, mz.width * 0.44 * PX,
            bulk * 0.07);

        /*
         * Where the hide changes colour on the finished skin.
         *
         * The markings were a function of position on the unit sphere the torso was
         * scaled from. There is no such sphere any more, so they are evaluated in the
         * same normalised body space, computed back from the mesh position. Muzzle,
         * ruff and mane are regions of the one surface rather than separate meshes, so
         * they are painted here too.
         */
        const bodyRX = body.length * 0.5 * PX;
        const bodyRY = body.height * 0.5 * PX;
        const bodyRZ = body.width * 0.5 * PX;
        const maneReach = spec.mane ? spec.mane.thick * 0.75 * PX : 0;
        const neckRun = Math.max(1e-6,
            (headPos.x - neckPos.x) * (headPos.x - neckPos.x) +
            (headPos.y - neckPos.y) * (headPos.y - neckPos.y));

        const noseX = headPos.x + mx + mz.length * 0.42 * PX;
        const noseY = headPos.y + my + mz.height * 0.12 * PX;
        const noseSpread = mz.width * 0.26 * PX;
        const noseR = Math.max(mz.width, mz.height) * 0.11 * PX;
        const mouthR = mz.width * 0.55 * PX;

        const skinColour = (x, y, z) => {
            /*
             * Nostrils and a mouth line.
             *
             * Two dark spots and a crease, and a blank snout becomes a face. They are
             * painted rather than modelled because at the size an animal is usually
             * seen they only ever need to be marks — and because a hole in the skin
             * would have to be a hole in the field, which is a lot of geometry for two
             * dots.
             */
            if (Math.hypot(x - noseX, (y - noseY) * 1.2, Math.abs(z) - noseSpread) < noseR) {
                return _col.copy(eyeCol);
            }
            if (x > headPos.x + mx - mz.length * 0.5 * PX &&
                Math.abs(y - jawY - mz.height * 0.30 * PX) < mz.height * 0.07 * PX &&
                Math.abs(z) < mouthR) {
                return _col.copy(eyeCol).lerp(muzzleCol, 0.35);
            }

            /*
             * The muzzle, painted to its own shape.
             *
             * A round test around the muzzle's centre looks reasonable on an elephant
             * and swallows a zebra's whole face, because it takes no account of a
             * muzzle being long and narrow. Testing against the ellipsoid the muzzle
             * actually is scales correctly for every species on the reserve.
             */
            const ex = (x - (headPos.x + mx)) / (mz.length * 0.5 * PX);
            const ey = (y - (headPos.y + my)) / (mz.height * 0.5 * PX);
            const ez = z / (mz.width * 0.5 * PX);
            if (ex * ex + ey * ey + ez * ez < 1.2) return _col.copy(muzzleCol);

            if (spec.ruff) {
                const dr = Math.hypot(x - (headPos.x - spec.ruff.radius * 0.28 * PX),
                    y - headPos.y, z);
                if (dr < spec.ruff.radius * 0.95 * PX) return _col.copy(maneCol);
            }

            // A mane rides the crest of the neck: close to the neck line, and above it.
            if (maneReach) {
                const t = MathUtils.clamp01(
                    ((x - neckPos.x) * (headPos.x - neckPos.x) +
                        (y - neckPos.y) * (headPos.y - neckPos.y)) / neckRun);
                const cx = neckPos.x + (headPos.x - neckPos.x) * t;
                const cy = neckPos.y + (headPos.y - neckPos.y) * t;
                if (t > 0.02 && t < 0.98 && Math.abs(z) < maneReach && y > cy &&
                    Math.hypot(x - cx, y - cy) < neck.thickBase * 0.6 * PX + maneReach) {
                    return _col.copy(maneCol);
                }
            }

            if (marks) {
                return marks((x - bodyPos.x) / bodyRX, (y - bodyPos.y) / bodyRY, z / bodyRZ);
            }
            return _col.copy(base);
        };

        /*
         * Set the eyes and ears against the skin.
         *
         * Their rig offsets are measured from the base of the neck, which was fine when
         * a head was a known ellipsoid drawn at a known place. On a blended surface it
         * puts them wherever the skin happens to be — on a hippo, several centimetres
         * inside its own skull. So the nominal position is pushed outward until it
         * meets the surface, and the feature is placed proud of that.
         *
         * The bone rest positions are corrected to match, which is what keeps a blink
         * squashing the eye rather than sliding it across the face.
         */
        const hit = [0, 0, 0];
        const headCX = headPos.x + hx;
        const headCY = headPos.y + hy;
        const headReach = Math.max(head.length, head.width, head.height) * 2 * PX;

        if (spec.eye) {
            const eye = spec.eye;
            // Cast from the middle of the skull outward along where the eye belongs.
            // Starting anywhere else risks starting outside the skin, and a ray that
            // begins outside never finds a crossing — which is how the first attempt
            // left ears hanging in the air beside the head.
            field.project(headCX, headCY, 0,
                eye.offset * PX, eye.rise * PX, eye.spread * PX, hit, headReach);
            rest[rig.index.eyes].x = hit[0];
            rest[rig.index.eyes].y = hit[1];
            rest[rig.index.eyes].z = 0;
            spec._eyeZ = Math.abs(hit[2]) - eye.radius * 0.3 * PX;
        }

        if (spec.ear) {
            const ear = spec.ear;
            for (const side of [-1, 1]) {
                field.project(headCX, headCY, 0,
                    ear.offset * PX, ear.rise * PX, side * ear.spread * PX, hit, headReach);
                const bone = rest[rig.index[side < 0 ? 'earL' : 'earR']];
                bone.x = hit[0];
                bone.y = hit[1] - ear.thick * 0.12 * PX;
                bone.z = hit[2];
            }
        }

        b.bone(iBody).color(base);
        Surface3D.polygonise(b, field, {
            /*
             * Cell size against the animal's own bulk — so a rabbit and an elephant are
             * both resolved to about the same number of cells — but never coarser than
             * the head can stand. A grid sized only by the barrel puts two cells across
             * a zebra's muzzle, and a face made of two cells is a wedge.
             */
            cell: Math.min(bulk * 0.105,
                Math.max(head.length, head.width, head.height) * 0.20 * PX),
            colorFn: skinColour,
            skinned: true
        });

        /* --- Appendages, in the head bone's space ---------------------------- */
        b.bone(iHead).color(base);
        b.push().translate(headPos.x, headPos.y, headPos.z);

        /* --- Horns, tusks and the trunk -------------------------------------- */
        if (spec.horns) {
            const h = spec.horns;
            b.color(R3D.col(pal.horn || pal.hoof));
            for (const side of [-1, 1]) {
                const ox = hx + h.offset * PX;
                const oy = hy + h.rise * PX;
                const oz = side * h.spread * PX;
                if (h.type === 'antler') {
                    // A beam raked back, with tines off it.
                    const tipX = ox - h.length * 0.35 * PX;
                    const tipY = oy + h.length * PX;
                    b.limb(ox, oy, oz, tipX, tipY, oz + side * h.length * 0.28 * PX,
                        h.thick * 0.5 * PX, h.thick * 0.28 * PX, SEG);
                    for (let t = 1; t <= (h.tines || 2); t++) {
                        const f = t / ((h.tines || 2) + 1);
                        b.limb(
                            ox + (tipX - ox) * f, oy + (tipY - oy) * f, oz + side * h.length * 0.28 * PX * f,
                            ox + (tipX - ox) * f + h.length * 0.32 * PX,
                            oy + (tipY - oy) * f + h.length * 0.30 * PX,
                            oz + side * h.length * 0.42 * PX,
                            h.thick * 0.3 * PX, h.thick * 0.18 * PX, SEG);
                    }
                } else {
                    // Ossicones: short, upright, knobbed.
                    b.limb(ox, oy, oz, ox, oy + h.length * PX, oz,
                        h.thick * 0.5 * PX, h.thick * 0.42 * PX, SEG);
                    b.push().translate(ox, oy + h.length * PX, oz)
                        .sphere(h.thick * 0.62 * PX, h.thick * 0.62 * PX, h.thick * 0.62 * PX, LOW)
                        .pop();
                }
            }
        }

        if (spec.tusks) {
            const t = spec.tusks;
            b.color(R3D.col(pal.tusk || '#eee6d2'));
            for (const side of [-1, 1]) {
                let px = mx, py = my - mz.height * 0.2 * PX, pz = side * t.spread * PX;
                const segs = 4;
                for (let i = 1; i <= segs; i++) {
                    const f = i / segs;
                    const nx = mx + t.length * PX * f * 0.95;
                    const ny = my - mz.height * 0.2 * PX - t.length * PX * f * 0.25 +
                        Math.pow(f, 2) * t.length * PX * t.curve * 0.5;
                    const nz = pz;
                    b.limb(px, py, pz, nx, ny, nz,
                        t.thick * 0.5 * PX * (1 - f * 0.5),
                        t.thick * 0.5 * PX * (1 - (f + 0.2) * 0.5), SEG);
                    px = nx; py = ny; pz = nz;
                }
            }
        }
        b.pop();

        if (spec.trunk) {
            const tr = spec.trunk;
            const aPos = abs('trunkA');
            const bPos = abs('trunkB');
            b.color(base);
            b.bone(rig.index.trunkA).push().translate(aPos.x, aPos.y, aPos.z);
            b.limb(0, 0, 0, bPos.x - aPos.x, bPos.y - aPos.y, 0,
                tr.thick * 0.5 * PX, tr.thick * 0.34 * PX, { radial: 8 });
            b.pop();
            b.bone(rig.index.trunkB).push().translate(bPos.x, bPos.y, bPos.z);
            b.limb(0, 0, 0, tr.length * 0.34 * PX, -tr.length * 0.30 * PX, 0,
                tr.thick * 0.34 * PX, tr.tip * 0.5 * PX, { radial: 8 });
            b.pop();
        }

        /* --- Ears and eyes ---------------------------------------------------- */
        if (spec.ear) {
            const ear = spec.ear;
            for (const side of ['earL', 'earR']) {
                const p = abs(side);
                const dir = side === 'earL' ? -1 : 1;
                b.bone(rig.index[side]).color(base);
                b.push().translate(p.x, p.y, p.z);
                if (ear.type === 'fan') {
                    // An elephant's ear is a sheet, not a spike.
                    b.push().rotate(0, 0, -0.2)
                        .sphere(ear.length * 0.5 * PX, (ear.width || ear.length) * 0.5 * PX,
                            ear.thick * 0.25 * PX, LOW)
                        .pop();
                } else if (ear.type === 'long') {
                    b.limb(0, 0, 0, -ear.length * 0.18 * PX, ear.length * PX,
                        dir * ear.length * 0.1 * PX,
                        ear.thick * 0.4 * PX, ear.thick * 0.16 * PX, SEG);
                    b.sphere(ear.thick * 0.38 * PX, ear.thick * 0.38 * PX,
                        ear.thick * 0.28 * PX, LOW);
                } else {
                    // No cap at the tip: an ear should come to a point, and a rounded
                    // end turns every one of them into an egg balanced on the skull.
                    b.limb(0, 0, 0, -ear.length * 0.25 * PX, ear.length * 0.85 * PX,
                        dir * ear.length * 0.35 * PX,
                        ear.thick * 0.42 * PX, ear.thick * 0.10 * PX, SEG);
                    b.sphere(ear.thick * 0.40 * PX, ear.thick * 0.40 * PX,
                        ear.thick * 0.30 * PX, LOW);
                }
                b.pop();
            }
        }

        if (spec.eye) {
            const eye = spec.eye;
            const p = abs('eyes');
            const spread = spec._eyeZ === undefined ? eye.spread * PX : spec._eyeZ;
            b.bone(rig.index.eyes).color(eyeCol);
            for (const side of [-1, 1]) {
                // A lid of hide around the eye, so it reads as set into the head rather
                // than stuck onto it.
                b.color(base);
                b.push().translate(p.x, p.y, p.z + side * spread * 0.94)
                    .sphere(eye.radius * 1.7 * PX, eye.radius * 1.7 * PX,
                        eye.radius * 0.9 * PX, LOW)
                    .pop();
                b.color(eyeCol);
                b.push().translate(p.x, p.y, p.z + side * spread)
                    .sphere(eye.radius * 1.15 * PX, eye.radius * 1.15 * PX,
                        eye.radius * 0.8 * PX, LOW)
                    .pop();
            }
        }

        /* --- Tail -------------------------------------------------------------- */
        const tail = spec.tail;
        const tailPos = abs('tail');
        b.bone(rig.index.tail).color(base);
        b.push().translate(tailPos.x, tailPos.y, tailPos.z);
        const tEndX = -Math.cos(tail.angle) * tail.length * PX;
        const tEndY = Math.sin(tail.angle) * tail.length * PX - tail.droop * tail.length * 0.25 * PX;
        b.limb(0, 0, 0, tEndX, tEndY, 0, tail.thick * 0.5 * PX, tail.tip * 0.5 * PX, SEG);
        if (tail.tuft) {
            b.color(maneCol);
            b.push().translate(tEndX, tEndY, 0)
                .sphere(tail.tuft * 0.6 * PX, tail.tuft * 0.8 * PX, tail.tuft * 0.6 * PX, LOW)
                .pop();
        }
        b.pop();

        /* --- Legs ---------------------------------------------------------------- */
        for (let i = 0; i < 4; i++) {
            const front = i < 2;
            const a = front ? legs.front : legs.rear;
            const hipPos = abs('hip' + i);
            const kneePos = abs('knee' + i);

            b.bone(rig.index['hip' + i]).color(limbCol);
            b.push().translate(hipPos.x, hipPos.y, hipPos.z);
            b.limb(0, 0, 0, 0, -a.upper * PX, 0,
                legs.thickTop * 0.5 * PX, legs.thickMid * 0.5 * PX, SEG);
            // Joint caps are drawn a shade under the bone width. Matching it exactly
            // makes every leg read as a string of beads.
            b.sphere(legs.thickTop * 0.44 * PX, legs.thickTop * 0.44 * PX,
                legs.thickTop * 0.44 * PX, LOW);
            b.pop();

            b.bone(rig.index['knee' + i]);
            b.push().translate(kneePos.x, kneePos.y, kneePos.z);
            b.sphere(legs.thickMid * 0.46 * PX, legs.thickMid * 0.46 * PX,
                legs.thickMid * 0.46 * PX, LOW);
            b.limb(0, 0, 0, 0, -a.lower * PX, 0,
                legs.thickMid * 0.5 * PX, legs.thickBot * 0.5 * PX, SEG);
            b.color(hoofCol);
            b.push().translate(0, -a.lower * PX, 0)
                .sphere(legs.hoof * 0.5 * PX, legs.hoof * 0.45 * PX, legs.hoof * 0.5 * PX, LOW)
                .pop();
            b.pop();
        }

        /* --- Wings ---------------------------------------------------------------- */
        if (spec.wings) {
            const wg = spec.wings;
            for (const side of ['wingL', 'wingR']) {
                const p = abs(side);
                const dir = side === 'wingL' ? -1 : 1;
                b.bone(rig.index[side]).color(base);
                b.push().translate(p.x, p.y, p.z);
                // A flat, tapered plank: the silhouette is the whole of a bird at range.
                b.push().translate(0, 0, dir * wg.span * 0.25 * PX)
                    .sphere(wg.chord * 0.5 * PX, wg.chord * 0.06 * PX, wg.span * 0.25 * PX, LOW)
                    .pop();
                b.push().translate(-wg.chord * 0.18 * PX, 0, dir * wg.span * 0.42 * PX)
                    .sphere(wg.chord * 0.30 * PX, wg.chord * 0.05 * PX, wg.span * 0.18 * PX, LOW)
                    .pop();
                b.pop();
            }
        }

        return b.build();
    }

    /* ------------------------------------------------------------------ *
     * Species cache
     * ------------------------------------------------------------------ */

    const _cache = new Map();

    /**
     * Build (or fetch) the shared geometry and rig for a species.
     * @returns {{geometry:THREE.BufferGeometry, rig:object, spec:object}}
     */
    function species(spec) {
        let entry = _cache.get(spec.id);
        if (!entry) {
            const rig = defineRig(spec);
            const geometry = buildGeometry(spec, rig);
            /*
             * A pose moves bones well outside the bind pose — a galloping stride, a
             * collapsed animal, an eagle with its wings out — and Three culls skinned
             * meshes against the bind-pose bounds. Widening the sphere keeps the culling
             * (which matters at a hundred animals) without animals popping out of view
             * at the edge of the screen.
             */
            geometry.boundingSphere.radius *= 2.4;
            entry = { rig, geometry, spec };
            _cache.set(spec.id, entry);
        }
        return entry;
    }

    /**
     * A fresh animal, ready to add to the scene.
     *
     * The geometry is shared across every individual of the species; only the skeleton
     * is per-animal, because that is the only part a pose changes.
     *
     * @param {object} spec Species rig from IsoSpecies.
     * @param {THREE.Material} [material]
     * @returns {THREE.SkinnedMesh}
     */
    function create(spec, material) {
        const entry = species(spec);
        const bones = [];

        for (const def of entry.rig.list) {
            const bone = new THREE.Bone();
            bone.name = def.name;
            if (def.parent === -1) {
                bone.position.set(def.x, def.y, def.z);
            } else {
                const p = entry.rig.list[entry.rig.index[def.parent]];
                bone.position.set(def.x - p.x, def.y - p.y, def.z - p.z);
                bones[entry.rig.index[def.parent]].add(bone);
            }
            bone.userData.rest = bone.position.clone();
            bones.push(bone);
        }

        const mesh = new THREE.SkinnedMesh(entry.geometry, material || R3D.skinnedMaterial());
        mesh.add(bones[0]);
        mesh.bind(new THREE.Skeleton(bones));
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        mesh.userData.rig = entry.rig;
        mesh.userData.spec = spec;
        mesh.userData.bones = bones;
        return mesh;
    }

    /* ------------------------------------------------------------------ *
     * Posing
     * ------------------------------------------------------------------ */

    /**
     * Two-bone IK, solved in the vertical plane that contains the limb.
     *
     * Identical in spirit to the 2D rig's `solveLimb` — working in the limb's own plane
     * rather than in screen space is what keeps knees bending the right way whichever
     * direction the animal faces — but it emits bone rotations rather than a joint
     * position, because a skeleton is what drives the mesh here.
     *
     * @param {THREE.Bone} hip
     * @param {THREE.Bone} knee
     * @param {number} bend −1 for a forelimb (knee back), +1 for a hind limb.
     */
    function solveLeg(hip, knee, hipX, hipY, hipZ, footX, footY, footZ, upper, lower, bend) {
        const dx = footX - hipX;
        const dy = footY - hipY;
        const dz = footZ - hipZ;

        const run = Math.hypot(dx, dz);
        let dist = Math.hypot(run, dy);
        const maxReach = (upper + lower) * 0.999;
        const minReach = Math.abs(upper - lower) * 1.001 + 1e-4;
        dist = MathUtils.clamp(dist, minReach, maxReach);

        const cosA = MathUtils.clamp(
            (upper * upper + dist * dist - lower * lower) / (2 * upper * dist), -1, 1);
        const ang = Math.atan2(dy, run) + Math.acos(cosA) * (bend < 0 ? -1 : 1);

        const ux = run > 1e-5 ? dx / run : 1;
        const uz = run > 1e-5 ? dz / run : 0;
        const horiz = Math.cos(ang) * upper;

        // Knee position, then the two rotations that put the bones through it.
        const kx = ux * horiz;
        const ky = Math.sin(ang) * upper;
        const kz = uz * horiz;

        _v.set(kx, ky, kz).normalize();
        _q.setFromUnitVectors(_down, _v);
        hip.quaternion.copy(_q);

        _v.set(dx - kx, dy - ky, dz - kz);
        if (_v.lengthSq() < 1e-8) _v.set(0, -1, 0);
        _v.normalize();
        _q2.setFromUnitVectors(_down, _v);
        // The lower bone's rotation is expressed in the upper bone's space.
        knee.quaternion.copy(_q.invert()).multiply(_q2);
    }

    /**
     * Drive a mesh's skeleton from an animal's render state.
     *
     * Everything here reads; nothing writes back to the simulation. The state block is
     * the same one the 2D creature renderer consumed — `facing`, `phase`, `speed01`,
     * `headDown`, `down`, `baby`, `submerged`, `blink`, `earFlick` — so a pose bug is
     * a bug in one build and not the other.
     */
    function pose(mesh, st) {
        const spec = mesh.userData.spec;
        const rig = mesh.userData.rig;
        const bones = mesh.userData.bones;
        const bone = (name) => bones[rig.index[name]];

        const body = spec.body;
        const gait = spec.gait;
        const legs = spec.legs;
        const move = MathUtils.clamp01(st.speed01 || 0);
        const down = MathUtils.clamp01(st.down || 0);
        const time = st.time || 0;
        const seed = st.seed || 0;

        /* --- Newborns ---------------------------------------------------- */
        const baby = MathUtils.clamp01(st.baby || 0);
        const bodyScale = MathUtils.lerp(1, BABY_SCALE, baby);
        mesh.scale.setScalar(bodyScale);
        const headBone = bone('head');
        headBone.scale.setScalar(MathUtils.lerp(1, BABY_HEAD, baby));

        /* --- Torso ------------------------------------------------------- */
        const hop = gait.type === 'hop';
        const bob = hop
            ? Math.max(0, Math.sin((st.phase || 0) * TAU)) * gait.lift * 1.15 * move
            : Math.sin((st.phase || 0) * TAU * 2) * gait.bodyBob * move;
        const breath = Math.sin(time * 1.6 + seed) * 0.4 * (1 - move * 0.6);

        // Collapsing: the belly sinks toward the ground and the legs fold under it,
        // because the hips descend while the feet stay planted.
        const bodyZ = MathUtils.lerp(body.z + bob + breath, body.height * 0.82, down);
        const bodyBone = bone('body');
        bodyBone.position.set(body.x * PX, bodyZ * PX, 0);
        bodyBone.rotation.set(down * 0.42, 0, MathUtils.lerp(0, -0.10, down));

        /* --- Neck and head ------------------------------------------------ */
        const neck = spec.neck;
        const graze = neck.grazeAngle === undefined ? -0.85 : neck.grazeAngle;
        const headDown = MathUtils.clamp01(st.headDown || 0);
        // Sedated animals put their heads down with everything else.
        let wantAngle = MathUtils.lerp(neck.angle, graze, Math.max(headDown, down * 0.85));

        /*
         * Browsing is the opposite of grazing, and has to look it.
         *
         * A browser reaching into a crown lifts its neck past the rest angle rather
         * than lowering it, which is the whole silhouette of a giraffe at a tree. The
         * ceiling keeps the neck short of vertical — a giraffe stretching straight up
         * reads as alarmed, not as feeding.
         */
        const reach = MathUtils.clamp01(st.reach || 0);
        if (reach > 0) {
            wantAngle = MathUtils.lerp(wantAngle,
                Math.min(neck.angle + 0.62, 1.42), reach);
        }
        const neckDelta = wantAngle - neck.angle;
        const neckBone = bone('neck');
        neckBone.rotation.set(0, 0, neckDelta);
        // A little life in the neck when standing still.
        neckBone.rotation.y = Math.sin(time * 0.7 + seed) * 0.08 * (1 - move);

        // The head stays nearer level than the neck it hangs off, which is what a
        // grazing animal actually does and stops the muzzle pointing at its own knees.
        headBone.rotation.set(0, 0, -neckDelta * 0.45 + reach * 0.35);

        const eyes = bone('eyes');
        eyes.scale.set(1, MathUtils.lerp(1, 0.08, MathUtils.clamp01(st.blink || 0)), 1);

        if (rig.index.earL !== undefined) {
            const flick = (st.earFlick || 0) + Math.sin(time * 3.1 + seed) * 0.06;
            bone('earL').rotation.set(flick, 0, 0);
            bone('earR').rotation.set(-flick, 0, 0);
        }

        if (rig.index.trunkA !== undefined) {
            const sway = Math.sin(time * 1.3 + seed) * 0.22;
            bone('trunkA').rotation.set(0, sway * 0.5, -0.25 + headDown * 0.5);
            bone('trunkB').rotation.set(0, sway, 0.35 - headDown * 0.9);
        }

        /* --- Tail --------------------------------------------------------- */
        const tailBone = bone('tail');
        tailBone.rotation.set(
            0,
            Math.sin(time * 2.4 + seed) * (0.16 + move * 0.25),
            Math.sin(time * 1.7 + seed * 0.5) * 0.08 - down * 0.3);

        /* --- Legs --------------------------------------------------------- */
        const phases = gait.phases;
        const stride = gait.stride * MathUtils.lerp(0.5, 1.2, move);
        const lift = gait.lift * MathUtils.lerp(0.4, 1.1, move);
        const flight = spec.flight ? spec.flight.height : 0;

        for (let i = 0; i < 4; i++) {
            const front = i < 2;
            const left = (i % 2) === 0;
            const a = front ? legs.front : legs.rear;

            const hipX = a.x;
            const hipZ = -(left ? 1 : -1) * a.spread;
            // Hips ride with the body, which is what folds the legs as it sinks.
            const hipY = a.z + (bodyZ - body.z) * 0.85;

            const sprawl = legs.sprawl || 0;
            const footZ = hipZ - (left ? 1 : -1) * sprawl;

            let footX, footY;
            if (flight) {
                footX = hipX - 1;
                footY = hipY - (a.upper + a.lower) * 0.45;
            } else if (hop) {
                const p = MathUtils.wrap((st.phase || 0) + (front ? 0.12 : 0), 1);
                const air = Math.max(0, Math.sin(p * TAU));
                footX = hipX + (front ? 1 : -1) * stride * 0.25 * Math.cos(p * TAU) * move;
                footY = air * lift * 0.9 * move;
            } else {
                // A straight backward sweep in contact, a forward arc in the air. The
                // velocity discontinuity at the hand-off is what reads as a footfall.
                const p = MathUtils.wrap((st.phase || 0) + phases[i], 1);
                const stanceFrac = gait.stanceFraction || 0.6;
                if (p < stanceFrac) {
                    footX = hipX + stride * 0.5 - stride * (p / stanceFrac);
                    footY = 0;
                } else {
                    const t = (p - stanceFrac) / (1 - stanceFrac);
                    footX = hipX - stride * 0.5 + stride * MathUtils.easeInOutQuad(t);
                    footY = lift * Math.sin(Math.PI * t);
                }
                footX = hipX + (footX - hipX) * move;
                footY *= move;
            }

            if (down > 0) {
                footX = MathUtils.lerp(footX, hipX - (front ? 2.5 : -2.5), down);
                footY = MathUtils.lerp(footY, 0, down);
            }

            solveLeg(
                bone('hip' + i), bone('knee' + i),
                hipX * PX, hipY * PX, hipZ * PX,
                footX * PX, footY * PX, footZ * PX,
                a.upper * PX, a.lower * PX,
                front ? -1 : 1);
        }

        /* --- Wings --------------------------------------------------------- */
        if (rig.index.wingL !== undefined) {
            const flap = Math.sin((st.phase || 0) * TAU) * 0.85;
            bone('wingL').rotation.set(-flap, 0, 0);
            bone('wingR').rotation.set(flap, 0, 0);
        }
    }

    Safari.Creature3D = {
        create,
        pose,
        species,
        BABY_SCALE,
        /**
         * The rig's tallest authored point, in world units — where a condition bar goes.
         * Cached on the spec, because the rigs never change.
         */
        topOf(spec) {
            if (spec._top3d !== undefined) return spec._top3d;
            let top = spec.body.z + spec.body.height;
            if (spec.neck) {
                top = Math.max(top, spec.neck.z +
                    Math.sin(spec.neck.angle) * spec.neck.length +
                    (spec.head ? spec.head.height : 0) * 2);
            }
            if (spec.horns) top += spec.horns.length;
            if (spec.ear && spec.ear.type === 'long') top += spec.ear.length;
            spec._top3d = top * PX;
            return spec._top3d;
        }
    };

})(window.Safari, window.THREE);
