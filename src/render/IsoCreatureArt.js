/**
 * Safari Simulator — Three-quarter creature renderer.
 *
 * The side-on rig drew a fixed profile. This one defines the skeleton in **three
 * dimensions** and projects it, so an animal foreshortens correctly as it turns and
 * every facing comes out of the same data. There are no per-direction sprites.
 *
 * LOCAL SPACE
 * -----------
 *   fx  forward, toward the nose
 *   fy  left, across the body
 *   fz  up
 *
 * A point is rotated about the vertical axis by the animal's facing, then flattened:
 *
 *   sx = gx
 *   sy = gy * SQUASH - gz
 *
 * `SQUASH` is the isometric ground foreshortening, so the animal sits in exactly the
 * same projected plane as the terrain beneath it. Depth within the body comes from
 * `gy`: larger means nearer the viewer, and therefore drawn later.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Color, Painter, Palettes, Noise } = Safari;
    const TAU = MathUtils.TAU;

    /** Ground foreshortening. Matches the 2:1 tile ratio the terrain is drawn at. */
    const SQUASH = 0.5;

    /**
     * Newborns.
     *
     * A calf drawn as a uniformly shrunken adult just reads as an adult standing
     * further away. What actually says "young" is the proportions: a big head on a
     * small body, and legs that have not caught up. So the whole rig shrinks and the
     * skull is then scaled back up against it.
     */
    const BABY_SCALE = 0.52;
    const BABY_HEAD = 1.34;

    /** Light direction in the ground plane, matching the terrain's hillshading. */
    const LIGHT_DIR = { x: -0.7, y: -0.7 };

    /* ------------------------------------------------------------------ *
     * Projection
     * ------------------------------------------------------------------ */

    const _p = { x: 0, y: 0, depth: 0 };

    /**
     * Rotate a local point by `facing` and project it.
     * @returns {{x:number, y:number, depth:number}} A shared scratch object.
     */
    function project(fx, fy, fz, cos, sin, out) {
        const p = out || _p;
        const gx = fx * cos - fy * sin;
        const gy = fx * sin + fy * cos;
        p.x = gx;
        p.y = gy * SQUASH - fz;
        p.depth = gy;
        return p;
    }

    /**
     * Silhouette of an ellipsoid under the projection.
     *
     * An ellipsoid with semi-axes (a, b, c) always projects to an ellipse. Rather than
     * approximating with a fixed shape per facing, this solves for it exactly: the
     * projected conic is M·diag(a²,b²,c²)·Mᵀ where M is the combined rotate-and-flatten
     * matrix, and its eigenvectors give the ellipse's radii and tilt. That is what makes
     * a body turning through 360° look solid rather than like a card being rotated.
     *
     * @returns {{rx:number, ry:number, rot:number}}
     */
    const _ell = { rx: 0, ry: 0, rot: 0 };
    function projectEllipsoid(a, b, c, cos, sin) {
        const a2 = a * a, b2 = b * b, c2 = c * c;

        // M = [[cos, -sin, 0], [S·sin, S·cos, -1]]
        const c11 = a2 * cos * cos + b2 * sin * sin;
        const c12 = SQUASH * sin * cos * (a2 - b2);
        const c22 = SQUASH * SQUASH * (a2 * sin * sin + b2 * cos * cos) + c2;

        const mid = (c11 + c22) * 0.5;
        const diff = (c11 - c22) * 0.5;
        const root = Math.sqrt(diff * diff + c12 * c12);

        _ell.rx = Math.sqrt(Math.max(1e-6, mid + root));
        _ell.ry = Math.sqrt(Math.max(1e-6, mid - root));
        _ell.rot = 0.5 * Math.atan2(2 * c12, c11 - c22);
        return _ell;
    }

    /**
     * Two-bone IK solved in the vertical plane that contains the limb.
     *
     * Working in that plane rather than in screen space keeps knees bending the right
     * way no matter which direction the animal faces.
     *
     * @returns {{x:number, y:number, z:number}} Joint position in local space.
     */
    const _joint = { x: 0, y: 0, z: 0 };
    function solveLimb(hx, hy, hz, tx, ty, tz, upper, lower, bend) {
        const dx = tx - hx, dy = ty - hy, dz = tz - hz;
        // Horizontal run and vertical drop define the plane.
        const run = Math.hypot(dx, dy);
        let dist = Math.hypot(run, dz);

        const maxReach = (upper + lower) * 0.999;
        const minReach = Math.abs(upper - lower) * 1.001 + 0.001;
        dist = MathUtils.clamp(dist, minReach, maxReach);

        // Angle of the upper bone away from the hip-to-foot line.
        const cosA = MathUtils.clamp(
            (upper * upper + dist * dist - lower * lower) / (2 * upper * dist), -1, 1);
        const a = Math.acos(cosA);
        const base = Math.atan2(dz, run);
        const ang = base + a * Math.sign(bend || 1);

        // Direction of the limb plane in the ground plane.
        const ux = run > 1e-5 ? dx / run : 1;
        const uy = run > 1e-5 ? dy / run : 0;

        const horiz = Math.cos(ang) * upper;
        _joint.x = hx + ux * horiz;
        _joint.y = hy + uy * horiz;
        _joint.z = hz + Math.sin(ang) * upper;
        return _joint;
    }

    /* ------------------------------------------------------------------ *
     * Drawing helpers
     * ------------------------------------------------------------------ */

    /** Filled ellipsoid with a directional highlight. */
    function limbSegment(ctx, ax, ay, bx, by, wA, wB, fill) {
        Painter.fillTapered(ctx,
            [{ x: ax, y: ay }, { x: (ax + bx) / 2, y: (ay + by) / 2 }, { x: bx, y: by }],
            [wA, (wA + wB) / 2, wB], fill, { roundStart: true, roundEnd: true });
    }

    /**
     * A solid body mass: the projected ellipsoid, shaded from the light direction so
     * the form reads as round rather than as a flat blob.
     */
    function mass(ctx, sx, sy, ell, base, light, litSide, shadeSide) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(ell.rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, ell.rx, ell.ry, 0, 0, TAU);
        ctx.fillStyle = base;
        ctx.fill();

        // Shade across the form, from the upper-left highlight to the lower-right core.
        ctx.clip();
        const g = ctx.createLinearGradient(-ell.rx * 0.5, -ell.ry, ell.rx * 0.6, ell.ry);
        g.addColorStop(0, litSide);
        g.addColorStop(0.55, 'rgba(0,0,0,0)');
        g.addColorStop(1, shadeSide);
        ctx.fillStyle = g;
        ctx.fillRect(-ell.rx, -ell.ry, ell.rx * 2, ell.ry * 2);
        ctx.restore();
    }

    /* ------------------------------------------------------------------ *
     * Painter
     * ------------------------------------------------------------------ */

    /**
     * Draw one animal.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} spec Species rig from IsoSpecies.
     * @param {object} st Render state: facing, phase, speed01, time, seed.
     * @param {number} screenX Ground contact point.
     * @param {number} screenY
     * @param {number} scale
     * @param {object} light
     */
    function paint(ctx, spec, st, screenX, screenY, scale, light) {
        const facing = st.facing || 0;
        const cos = Math.cos(facing);
        const sin = Math.sin(facing);
        const move = MathUtils.clamp01(st.speed01 || 0);
        const pal = litPalette(spec, light);

        // Newborns shrink the whole rig; the head is scaled back up below.
        const baby = MathUtils.clamp01(st.baby || 0);
        const bodyScale = scale * MathUtils.lerp(1, BABY_SCALE, baby);
        const headScale = MathUtils.lerp(1, BABY_HEAD, baby);

        ctx.save();
        ctx.translate(screenX, screenY);
        ctx.scale(bodyScale, bodyScale);

        const body = spec.body;

        /*
         * Water line.
         *
         * The terrain draws its water beneath everything, so an animal standing in a
         * river was drawn whole and on top of it — hippos appeared to be walking on the
         * surface. The first fix washed the submerged part over with a water tone, which
         * worked for one animal and fell apart for a pod: a dozen translucent discs
         * layered into an opaque smear.
         *
         * Clipping is the right tool. The submerged part is simply not drawn, so the
         * terrain's own water shows through it, nothing is overlaid, and any number of
         * animals can share a pool without compounding. Depth comes from the ground
         * underfoot, so a zebra crossing a shallow is wet to the knees and a hippo out
         * in the channel shows only its back, from the same few lines.
         */
        const sub = MathUtils.clamp01(st.submerged || 0);
        const waterLine = sub > 0.02
            ? (body.z + body.height) * MathUtils.lerp(0.15, 0.60, sub)
            : 0;
        if (waterLine > 0) {
            ctx.save();
            const far = 4000;
            ctx.beginPath();
            ctx.rect(-far, -far, far * 2, far - waterLine);
            ctx.clip();
        }
        const gait = spec.gait;
        // Fliers ride above the ground and tuck their legs.
        const flight = spec.flight ? spec.flight.height : 0;

        /*
         * Contact shadow. Drawn first, in the ground plane, and squashed to the same
         * 2:1 ratio as the terrain so it lies flat rather than standing up behind the
         * animal. Without it a creature reads as floating above the tiles.
         */
        const airborne = flight > 0 ? MathUtils.clamp01(flight / 40) : 0;
        // No shadow on the lake bed: it is under the water, not on it.
        const shadowFade = 1 - MathUtils.clamp01(sub * 1.4);
        const shadowLen = body.length * 1.05 * MathUtils.lerp(1, 0.62, airborne);
        const shadowWid = body.width * 1.5 * MathUtils.lerp(1, 0.62, airborne);
        const se = projectEllipsoid(shadowLen, shadowWid, 0.001, cos, sin);
        ctx.save();
        ctx.rotate(se.rot);
        ctx.fillStyle = 'rgba(28,24,14,' +
            (light.shadowAlpha * 0.8 * MathUtils.lerp(1, 0.5, airborne) *
                shadowFade).toFixed(3) + ')';
        ctx.beginPath();
        ctx.ellipse(0, 0, se.rx, Math.max(2, se.ry), 0, 0, TAU);
        ctx.fill();
        ctx.restore();

        /* --- Body placement ------------------------------------------- */
        // A hopping animal lifts its whole body once per cycle instead of bobbing twice.
        const hop = gait.type === 'hop';
        const bobFreq = hop ? 1 : 2;
        const bob = hop
            ? Math.max(0, Math.sin(st.phase * TAU)) * gait.lift * 1.15 * move
            : Math.sin(st.phase * TAU * bobFreq) * gait.bodyBob * move;
        const breath = Math.sin(st.time * 1.6 + st.seed) * 0.4 * (1 - move * 0.6);

        /*
         * Going down.
         *
         * A sedated animal used only to stop moving and shut its eyes, which at this
         * scale is indistinguishable from one standing still. `down` collapses the whole
         * rig: the belly sinks to the ground, the legs fold under it because the hips
         * descend toward feet that stay planted, and the head goes down with the neck.
         * The pose does all the work — no icon needed.
         */
        const down = MathUtils.clamp01(st.down || 0);
        const bodyZ = MathUtils.lerp(body.z + bob + breath + flight,
            body.height * 0.82, down);

        /* --- Legs ------------------------------------------------------- */
        // Four limbs at the corners of the torso. Lateral offset is what the
        // three-quarter view buys us: all four legs are visible and separated.
        const legs = spec.legs;
        const phases = gait.phases;
        const stride = gait.stride * MathUtils.lerp(0.5, 1.2, move);
        const lift = gait.lift * MathUtils.lerp(0.4, 1.1, move);

        const limbs = [];
        for (let i = 0; i < 4; i++) {
            const front = i < 2;
            const left = (i % 2) === 0;
            const anchor = front ? legs.front : legs.rear;

            const hx = anchor.x;
            const hy = (left ? 1 : -1) * anchor.spread;
            const hz = anchor.z + (bodyZ - body.z) * 0.85;

            // Sprawled limbs plant their feet wide of the hip, as a crocodile's do.
            const sprawl = legs.sprawl || 0;
            const footY = hy + (left ? 1 : -1) * sprawl;

            let footX, footZ;
            if (spec.flight) {
                // Tucked up in flight.
                footX = hx - 1;
                footZ = hz - (anchor.upper + anchor.lower) * 0.45;
            } else if (hop) {
                // All four move together; the forelimbs reach first on landing.
                const p = MathUtils.wrap(st.phase + (front ? 0.12 : 0), 1);
                const air = Math.max(0, Math.sin(p * TAU));
                footX = hx + (front ? 1 : -1) * stride * 0.25 * Math.cos(p * TAU) * move;
                footZ = air * lift * 0.9 * move;
            } else {
                // Foot cycle: a backward sweep in contact, a forward arc in the air.
                const p = MathUtils.wrap(st.phase + phases[i], 1);
                const stance = gait.stanceFraction;
                if (p < stance) {
                    const t = p / stance;
                    footX = hx + stride * 0.5 - stride * t;
                    footZ = 0;
                } else {
                    const t = (p - stance) / (1 - stance);
                    footX = hx - stride * 0.5 + stride * MathUtils.easeInOutQuad(t);
                    footZ = lift * Math.sin(Math.PI * t);
                }
                footX = hx + (footX - hx) * move;
                footZ *= move;
            }

            // Tuck the feet in under the hip as the body settles, so the limbs fold
            // rather than splaying out flat like a shot deer.
            if (down > 0) {
                footX = MathUtils.lerp(footX, hx - (front ? 2.5 : -2.5), down);
                footZ = MathUtils.lerp(footZ, 0, down);
            }

            const j = solveLimb(hx, hy, hz, footX, footY, footZ,
                anchor.upper, anchor.lower, front ? -1 : 1);

            limbs.push({
                hip: { x: hx, y: hy, z: hz },
                knee: { x: j.x, y: j.y, z: j.z },
                foot: { x: footX, y: footY, z: footZ },
                depth: project(hx, hy, hz, cos, sin).depth
            });
        }

        // Far limbs first. Sorting by projected depth is what keeps the near legs in
        // front of the body and the far ones behind it, at every facing.
        limbs.sort((a, b) => a.depth - b.depth);

        const drawLimb = (limb, far) => {
            const col = far ? pal.limbFar : pal.limb;
            const h = project(limb.hip.x, limb.hip.y, limb.hip.z, cos, sin, {});
            const k = project(limb.knee.x, limb.knee.y, limb.knee.z, cos, sin, {});
            const f = project(limb.foot.x, limb.foot.y, limb.foot.z, cos, sin, {});
            limbSegment(ctx, h.x, h.y, k.x, k.y, legs.thickTop, legs.thickMid, col);
            limbSegment(ctx, k.x, k.y, f.x, f.y, legs.thickMid, legs.thickBot, col);
            // Hoof.
            ctx.fillStyle = far ? pal.hoofFar : pal.hoof;
            ctx.beginPath();
            ctx.ellipse(f.x, f.y, legs.hoof, legs.hoof * 0.6, 0, 0, TAU);
            ctx.fill();
        };

        for (let i = 0; i < 2; i++) drawLimb(limbs[i], true);

        // Far wing, behind the body.
        if (spec.wings) {
            paintWing(ctx, spec.wings, body, bodyZ, cos, sin, pal, st, move, true);
        }

        /* --- Torso ------------------------------------------------------ */
        const torsoP = project(body.x, 0, bodyZ, cos, sin, {});
        const torsoE = projectEllipsoid(body.length, body.width, body.height, cos, sin);
        mass(ctx, torsoP.x, torsoP.y, torsoE, pal.base, light,
            pal.litWash, pal.shadeWash);

        // Markings ride the torso, clipped to it.
        if (spec.markings) {
            ctx.save();
            ctx.translate(torsoP.x, torsoP.y);
            ctx.rotate(torsoE.rot);
            ctx.beginPath();
            ctx.ellipse(0, 0, torsoE.rx, torsoE.ry, 0, 0, TAU);
            ctx.clip();
            ctx.rotate(-torsoE.rot);
            paintMarkings(ctx, spec.markings, torsoE, facing, st.seed, pal);
            ctx.restore();
        }

        /* --- Neck and head ---------------------------------------------- */
        const neck = spec.neck;
        const head = spec.head;

        const headDown = st.headDown || 0;
        // A downed animal's neck goes below the grazing angle: it is resting the head
        // on the ground, not reaching for it.
        const neckAngle = MathUtils.lerp(
            MathUtils.lerp(neck.angle, neck.grazeAngle, headDown),
            (neck.grazeAngle === undefined ? -0.85 : neck.grazeAngle) - 0.35, down);
        const neckLen = neck.length;

        const nBase = { x: neck.x, y: 0, z: neck.z + (bodyZ - body.z) };
        const nTip = {
            x: nBase.x + Math.cos(neckAngle) * neckLen,
            y: 0,
            z: nBase.z + Math.sin(neckAngle) * neckLen
        };

        // Neck as a tapered tube between the projected endpoints.
        const nb = project(nBase.x, nBase.y, nBase.z, cos, sin, {});
        const nt = project(nTip.x, nTip.y, nTip.z, cos, sin, {});
        limbSegment(ctx, nb.x, nb.y, nt.x, nt.y, neck.thickBase, neck.thickTip, pal.base);

        if (spec.mane) paintMane(ctx, spec.mane, nb, nt, pal);
        // A lion's ruff sits behind the skull, so it is drawn before the head.
        if (spec.ruff) {
            const rp = project(nTip.x, nTip.y, nTip.z, cos, sin, {});
            const re = projectEllipsoid(spec.ruff.radius, spec.ruff.radius,
                spec.ruff.radius * 0.9, cos, sin);
            ctx.fillStyle = pal.mane;
            Painter.blobPath(ctx, rp.x, rp.y, re.rx * 1.15, re.ry * 1.15,
                re.rot, 5, 0.2, st.seed, 18);
            ctx.fill();
        }

        // Head.
        const headAngle = neckAngle + head.angle;
        const hCentre = {
            x: nTip.x + Math.cos(headAngle) * head.offset,
            y: 0,
            z: nTip.z + Math.sin(headAngle) * head.offset
        };
        const hp = project(hCentre.x, hCentre.y, hCentre.z, cos, sin, {});
        const he = projectEllipsoid(head.length * headScale, head.width * headScale,
            head.height * headScale, cos, sin);
        mass(ctx, hp.x, hp.y, he, pal.base, light, pal.litWash, pal.shadeWash);

        // Muzzle, pushed out along the head's axis.
        const mz = {
            x: hCentre.x + Math.cos(headAngle) * head.muzzle.offset,
            y: 0,
            z: hCentre.z + Math.sin(headAngle) * head.muzzle.offset
        };
        const mp = project(mz.x, mz.y, mz.z, cos, sin, {});
        const me = projectEllipsoid(head.muzzle.length * headScale,
            head.muzzle.width * headScale, head.muzzle.height * headScale, cos, sin);
        mass(ctx, mp.x, mp.y, me, pal.muzzle, light, pal.litWash, pal.shadeWash);

        paintEars(ctx, spec.ear, hCentre, headAngle, cos, sin, pal, st, headScale);
        if (spec.horns) paintHorns(ctx, spec.horns, hCentre, headAngle, cos, sin, pal);
        if (spec.tusks) paintTusks(ctx, spec.tusks, mz, headAngle, cos, sin, pal);
        if (spec.trunk) {
            paintTrunk(ctx, spec.trunk, mz, headAngle, cos, sin, pal, st, headDown);
        }
        paintEyes(ctx, spec.eye, hCentre, headAngle, head, cos, sin, pal, st);

        /* --- Near limbs --------------------------------------------------- */
        for (let i = 2; i < 4; i++) drawLimb(limbs[i], false);

        // Near wing, over the body.
        if (spec.wings) {
            paintWing(ctx, spec.wings, body, bodyZ, cos, sin, pal, st, move, false);
        }

        /* --- Tail --------------------------------------------------------- */
        paintTail(ctx, spec.tail, body, bodyZ, cos, sin, pal, st, move);

        if (waterLine > 0) {
            ctx.restore();

            // A thin ring where the body breaks the surface — tight to the animal, so
            // a pod of them reads as several animals in the water rather than one slick.
            const be = projectEllipsoid(body.length * 0.95, body.width * 1.15, 0.001,
                cos, sin);
            ctx.save();
            ctx.translate(0, -waterLine);
            ctx.rotate(be.rot);
            ctx.strokeStyle = 'rgba(228,246,250,' + (0.10 + sub * 0.16).toFixed(3) + ')';
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.ellipse(0, 0, be.rx, Math.max(1.6, be.ry), 0, 0, TAU);
            ctx.stroke();
            ctx.restore();
        }

        ctx.restore();
    }

    /* ------------------------------------------------------------------ *
     * Features
     * ------------------------------------------------------------------ */

    function paintMane(ctx, mane, nb, nt, pal) {
        // A crest along the top of the neck, offset perpendicular to it on screen.
        const dx = nt.x - nb.x, dy = nt.y - nb.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const off = mane.height;

        Painter.fillTapered(ctx, [
            { x: nb.x + nx * off * 0.5, y: nb.y + ny * off * 0.5 },
            { x: (nb.x + nt.x) / 2 + nx * off, y: (nb.y + nt.y) / 2 + ny * off },
            { x: nt.x + nx * off * 0.7, y: nt.y + ny * off * 0.7 }
        ], [mane.thick * 0.7, mane.thick, mane.thick * 0.5], pal.mane,
            { roundStart: true, roundEnd: true });
    }

    /**
     * Elephant trunk: a segmented taper that curls when idle and reaches down to feed.
     */
    function paintTrunk(ctx, trunk, muzzle, headAngle, cos, sin, pal, st, headDown) {
        const segs = trunk.segments;
        const pts = [];
        const widths = [];
        const sway = Math.sin(st.time * 1.3 + st.seed) * 0.14;
        const curl = trunk.curl * (1 - headDown * 0.8);

        let x = muzzle.x, y = 0, z = muzzle.z;
        let ang = headAngle - 1.15;

        for (let i = 0; i <= segs; i++) {
            const p = project(x, y, z, cos, sin, {});
            pts.push({ x: p.x, y: p.y });
            widths.push(MathUtils.lerp(trunk.thick, trunk.tip, MathUtils.easeInQuad(i / segs)));
            ang -= curl * 0.22;
            const seg = trunk.length / segs;
            x += Math.cos(ang) * seg;
            y += sway * seg * 0.3;
            z += Math.sin(ang) * seg;
        }
        /*
         * Drawn a shade darker than the coat. In the same tone as the body it simply
         * disappeared into the head — an elephant without a visible trunk is not an
         * elephant.
         */
        Painter.fillTapered(ctx, pts, widths, pal.trunk, { roundEnd: true });

        // Ring texture, which also separates it from the skull behind.
        ctx.strokeStyle = pal.trunkRing;
        ctx.lineWidth = 0.9;
        for (let i = 2; i < segs; i++) {
            const a = pts[i], b = pts[i + 1] || pts[i];
            let tx2 = b.x - a.x, ty2 = b.y - a.y;
            const l = Math.hypot(tx2, ty2) || 1;
            tx2 /= l; ty2 /= l;
            const w = widths[i] * 0.42;
            ctx.beginPath();
            ctx.moveTo(a.x - ty2 * w, a.y + tx2 * w);
            ctx.lineTo(a.x + ty2 * w, a.y - tx2 * w);
            ctx.stroke();
        }
    }

    /** Tusks: a pair of tapered curves sweeping forward and up. */
    function paintTusks(ctx, tusks, muzzle, headAngle, cos, sin, pal) {
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? 1 : -1;
            const pts = [];
            const widths = [];
            let x = muzzle.x, y = side * tusks.spread, z = muzzle.z;
            let ang = headAngle - 0.35;

            for (let k = 0; k <= 4; k++) {
                const p = project(x, y, z, cos, sin, {});
                pts.push({ x: p.x, y: p.y });
                widths.push(tusks.thick * (1 - k / 5));
                ang += tusks.curve * 0.20;
                const seg = tusks.length / 4;
                x += Math.cos(ang) * seg;
                z += Math.sin(ang) * seg;
            }
            Painter.fillTapered(ctx, pts, widths, pal.tusk, { roundEnd: true });
        }
    }

    /** Antlers and ossicones. */
    function paintHorns(ctx, horns, head, headAngle, cos, sin, pal) {
        ctx.strokeStyle = pal.horn;
        ctx.lineCap = 'round';

        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? 1 : -1;
            const bx = head.x + Math.cos(headAngle) * horns.offset;
            const bz = head.z + Math.sin(headAngle) * horns.offset + horns.rise;
            const by = side * horns.spread;
            const base = project(bx, by, bz, cos, sin, {});

            if (horns.type === 'ossicone') {
                const tip = project(bx, by, bz + horns.length, cos, sin, {});
                ctx.lineWidth = horns.thick;
                ctx.beginPath();
                ctx.moveTo(base.x, base.y);
                ctx.lineTo(tip.x, tip.y);
                ctx.stroke();
                ctx.fillStyle = pal.horn;
                ctx.beginPath();
                ctx.arc(tip.x, tip.y, horns.thick * 0.8, 0, TAU);
                ctx.fill();
            } else {
                // Antler: a main beam with tines branching forward.
                const tipX = bx - horns.length * 0.2;
                const tipZ = bz + horns.length;
                const tipY = by + side * horns.length * 0.3;
                const tip = project(tipX, tipY, tipZ, cos, sin, {});
                ctx.lineWidth = horns.thick;
                ctx.beginPath();
                ctx.moveTo(base.x, base.y);
                ctx.quadraticCurveTo(
                    (base.x + tip.x) / 2 + side * 2, (base.y + tip.y) / 2,
                    tip.x, tip.y);
                ctx.stroke();

                const tines = horns.tines || 2;
                for (let t = 1; t <= tines; t++) {
                    const u = t / (tines + 0.6);
                    const jx = bx + (tipX - bx) * u;
                    const jy = by + (tipY - by) * u;
                    const jz = bz + (tipZ - bz) * u;
                    const j = project(jx, jy, jz, cos, sin, {});
                    const e = project(jx + horns.length * 0.28, jy,
                        jz + horns.length * 0.22, cos, sin, {});
                    ctx.lineWidth = horns.thick * 0.7;
                    ctx.beginPath();
                    ctx.moveTo(j.x, j.y);
                    ctx.lineTo(e.x, e.y);
                    ctx.stroke();
                }
            }
        }
    }

    /**
     * Wing, drawn as a swept membrane with primaries along the trailing edge.
     * The two wings are painted either side of the body by the caller.
     */
    function paintWing(ctx, wings, body, bodyZ, cos, sin, pal, st, move, far) {
        const side = far ? -1 : 1;
        const flap = Math.sin(st.phase * TAU) * MathUtils.lerp(0.35, 1, move);

        const rootX = body.x + wings.root;
        const rootZ = bodyZ + wings.rise;
        const tipY = side * wings.span;
        const tipZ = rootZ + flap * wings.span * 0.55;

        /*
         * The membrane is built as a ring of points around the wing's own plane and
         * projected, rather than as a couple of screen-space curves. That keeps it
         * broad and wing-shaped at every facing; the earlier version collapsed into a
         * thin sliver whenever the bird turned.
         */
        const ring = [];
        const OUTLINE = [
            // [along span 0..1, chordwise offset, extra lift]
            [0.00, 0.35, 0.00],
            [0.35, 0.55, 0.10],
            [0.70, 0.45, 0.06],
            [1.00, 0.10, 0.00],
            [0.92, -0.45, -0.02],
            [0.55, -0.85, -0.04],
            [0.22, -0.95, -0.02],
            [0.00, -0.55, 0.00]
        ];
        for (let i = 0; i < OUTLINE.length; i++) {
            const [u, c, lift] = OUTLINE[i];
            const p = project(
                rootX + c * wings.chord * 0.5,
                side * (body.width * 0.4 + u * wings.span),
                rootZ + flap * wings.span * 0.5 * u + lift * wings.span,
                cos, sin, {});
            ring.push({ x: p.x, y: p.y });
        }
        Painter.smoothPath(ctx, ring, true, 0.45);
        ctx.fillStyle = far ? pal.wingFar : pal.wing;
        ctx.fill();

        // Primaries fanning along the trailing edge.
        ctx.strokeStyle = far ? pal.wingFar : pal.mane;
        ctx.lineWidth = 1.1;
        for (let i = 1; i <= 4; i++) {
            const u = 0.25 + (i / 5) * 0.7;
            const a = project(rootX + wings.chord * 0.1,
                side * (body.width * 0.4 + u * wings.span * 0.85),
                rootZ + flap * wings.span * 0.5 * u, cos, sin, {});
            const b = project(rootX - wings.chord * 0.55,
                side * (body.width * 0.4 + u * wings.span),
                rootZ + flap * wings.span * 0.5 * u - wings.span * 0.03, cos, sin, {});
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }
    }

    function paintEars(ctx, ear, head, headAngle, cos, sin, pal, st, scale) {
        if (!ear) return;
        const flick = (st.earFlick || 0);
        // Ears follow the skull, so a calf's are oversized along with it.
        if (scale !== undefined && scale !== 1) {
            ear = {
                type: ear.type, offset: ear.offset, rise: ear.rise * scale,
                spread: ear.spread * scale, length: ear.length * scale,
                thick: ear.thick * scale, width: (ear.width || 0) * scale
            };
        }
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? 1 : -1;
            const ex = head.x + Math.cos(headAngle) * ear.offset;
            const ez = head.z + Math.sin(headAngle) * ear.offset + ear.rise;
            const ey = side * ear.spread;

            const base = project(ex, ey, ez, cos, sin, {});
            const col = base.depth > 0 ? pal.base : pal.limbFar;

            if (ear.type === 'fan') {
                // A broad elephant ear, hinged at the front edge and flapping about it.
                const flapAngle = flick * 0.5;
                const outer = project(ex - ear.length * 0.9,
                    ey + side * (ear.width + flapAngle * 3),
                    ez - ear.length * 0.25, cos, sin, {});
                const lower = project(ex - ear.length * 0.7,
                    ey + side * ear.width * 0.7, ez - ear.length, cos, sin, {});
                ctx.beginPath();
                ctx.moveTo(base.x, base.y);
                ctx.quadraticCurveTo(outer.x, outer.y, lower.x, lower.y);
                ctx.quadraticCurveTo(base.x + (lower.x - base.x) * 0.2,
                    base.y + (lower.y - base.y) * 0.6, base.x, base.y);
                ctx.closePath();
                ctx.fillStyle = col;
                ctx.fill();
                continue;
            }

            const long = ear.type === 'long';
            const tip = project(
                ex - ear.length * (long ? 0.1 : 0.25),
                ey + side * ear.length * (long ? 0.18 : 0.35),
                ez + ear.length + flick * side * 2, cos, sin, {});

            Painter.fillTapered(ctx,
                [{ x: base.x, y: base.y }, { x: tip.x, y: tip.y }],
                [ear.thick, ear.thick * (long ? 0.7 : 0.35)],
                col, { roundEnd: true });
        }
    }

    function paintEyes(ctx, eye, head, headAngle, headSpec, cos, sin, pal, st) {
        if (!eye) return;
        const blink = st.blink || 0;
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? 1 : -1;
            const ex = head.x + Math.cos(headAngle) * eye.offset;
            const ez = head.z + Math.sin(headAngle) * eye.offset + eye.rise;
            const p = project(ex, side * eye.spread, ez, cos, sin, {});

            // Only draw the eye on the side facing the viewer.
            if (p.depth < 0) continue;
            const r = eye.radius * (1 - blink * 0.85);
            if (r <= 0.05) continue;
            ctx.fillStyle = pal.eye;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, eye.radius, r, 0, 0, TAU);
            ctx.fill();
        }
    }

    function paintTail(ctx, tail, body, bodyZ, cos, sin, pal, st, move) {
        if (!tail) return;
        const sway = Math.sin(st.time * 2.2 + st.seed) * 0.25 +
            Math.sin(st.phase * TAU) * 0.3 * move;

        const pts = [];
        const widths = [];
        let x = body.x - body.length;
        let y = 0;
        let z = bodyZ + tail.rise;
        let ang = tail.angle;

        for (let i = 0; i <= 4; i++) {
            const p = project(x, y, z, cos, sin, {});
            pts.push({ x: p.x, y: p.y });
            widths.push(MathUtils.lerp(tail.thick, tail.tip, i / 4));
            ang -= tail.droop * 0.28;
            const seg = tail.length / 4;
            x -= Math.cos(ang) * seg;
            y += sway * seg * 0.28;
            z += Math.sin(ang) * seg;
        }

        Painter.fillTapered(ctx, pts, widths, pal.limb, { roundStart: true });

        // Switch of hair at the tip.
        if (tail.tuft) {
            const t = pts[pts.length - 1];
            ctx.fillStyle = pal.mane;
            ctx.beginPath();
            ctx.ellipse(t.x, t.y, tail.tuft, tail.tuft * 1.3, 0, 0, TAU);
            ctx.fill();
        }
    }

    /**
     * Body markings, drawn in the torso's own frame and clipped to its silhouette.
     * Stripes are spaced along the projected long axis, which makes them compress
     * correctly as the animal turns away.
     */
    function paintMarkings(ctx, markings, ell, facing, seed, pal) {
        if (markings.type === 'spots' || markings.type === 'patches') {
            const n = markings.count;
            const patch = markings.type === 'patches';
            ctx.save();
            ctx.rotate(ell.rot);
            ctx.fillStyle = pal.markings || markings.color;
            ctx.globalAlpha = markings.alpha === undefined ? 1 : markings.alpha;
            for (let i = 0; i < n; i++) {
                // Jittered grid keeps the scatter even without looking regular.
                const gx = (Noise.hash(i * 37 + seed) - 0.5) * 2;
                const gy = (Noise.hash(i * 91 + seed + 7) - 0.5) * 2;
                const r = markings.size * (0.6 + Noise.hash(i * 13 + seed) * 0.8);
                const px = gx * ell.rx * 0.86;
                const py = gy * ell.ry * 0.78;
                if (patch) {
                    Painter.blobPath(ctx, px, py, r, r * 0.8, gx, 5, 0.32, i + seed, 12);
                    ctx.fill();
                } else {
                    ctx.beginPath();
                    ctx.ellipse(px, py, r, r * 0.8, 0, 0, TAU);
                    ctx.fill();
                }
            }
            ctx.restore();
            return;
        }
        if (markings.type !== 'stripes') return;

        ctx.save();
        ctx.rotate(ell.rot);
        ctx.strokeStyle = pal.markings || markings.color;
        ctx.lineCap = 'round';

        const n = markings.count;
        for (let i = 0; i < n; i++) {
            const u = (i + 0.5) / n;
            const x = (u - 0.5) * ell.rx * 2.1;
            // Stripes bow around the barrel of the body.
            const bow = Math.cos((u - 0.5) * Math.PI) * ell.ry * 0.30;
            ctx.lineWidth = markings.width * (0.75 + Math.sin(u * Math.PI) * 0.5);
            ctx.beginPath();
            ctx.moveTo(x - bow * 0.3, -ell.ry * 1.1);
            ctx.quadraticCurveTo(x + bow * 0.5, 0, x - bow * 0.3, ell.ry * 1.1);
            ctx.stroke();
        }
        ctx.restore();
    }

    /* ------------------------------------------------------------------ *
     * Palette
     * ------------------------------------------------------------------ */

    const _palCache = new Map();
    let _palHour = -999;

    function litPalette(spec, light) {
        if (Math.abs(light.hour - _palHour) > 0.05) {
            _palCache.clear();
            _palHour = light.hour;
        }
        let pal = _palCache.get(spec.id);
        if (pal) return pal;

        const P = spec.palette;
        const lit = (hex, warmth) =>
            Color.css(Palettes.litColor(Color.parse(hex), light, warmth === undefined ? 0.5 : warmth));

        const baseRgb = Palettes.litColor(Color.parse(P.base), light, 0.5);

        pal = {
            base: Color.css(baseRgb),
            limb: lit(P.limb || P.base),
            limbFar: Color.css(Color.darken(Palettes.litColor(
                Color.parse(P.limb || P.base), light, 0.5), 0.3)),
            hoof: lit(P.hoof || '#3a332c', 0.3),
            hoofFar: Color.css(Color.darken(Palettes.litColor(
                Color.parse(P.hoof || '#3a332c'), light, 0.3), 0.3)),
            muzzle: lit(P.muzzle || P.base),
            mane: lit(P.mane || P.base, 0.4),
            tusk: lit(P.tusk || '#e8dfc8', 0.4),
            wing: Color.css(Palettes.litColor(Color.parse(P.wing || P.base), light, 0.5)),
            wingFar: Color.css(Color.darken(Palettes.litColor(
                Color.parse(P.wing || P.base), light, 0.5), 0.26)),
            trunk: Color.css(Color.darken(Palettes.litColor(
                Color.parse(P.trunk || P.base), light, 0.5), 0.14)),
            trunkRing: Color.css(Color.darken(Palettes.litColor(
                Color.parse(P.trunk || P.base), light, 0.5), 0.34)),
            horn: lit(P.horn || '#8d7350', 0.4),
            /*
             * Markings are authored on the rig, not in the palette, but they still have
             * to obey the hour: a giraffe whose patches keep their daylight orange after
             * dark glows against a moonlit reserve.
             */
            markings: spec.markings ? lit(spec.markings.color, 0.4) : null,
            eye: lit(P.eye || '#1a1410', 0.2),
            litWash: 'rgba(255,246,214,' + (0.10 + light.sunStrength * 0.22).toFixed(3) + ')',
            shadeWash: 'rgba(22,16,10,' + (0.20 + (1 - light.daylight) * 0.12).toFixed(3) + ')'
        };
        _palCache.set(spec.id, pal);
        return pal;
    }

    /* ------------------------------------------------------------------ *
     * Portraits
     * ------------------------------------------------------------------ */

    /** Bounding box of the non-transparent pixels on a context. */
    function measureInk(ctx, width, height) {
        const data = ctx.getImageData(0, 0, width, height).data;
        let minX = width, minY = height, maxX = -1, maxY = -1;

        for (let y = 0; y < height; y++) {
            const row = y * width * 4;
            for (let x = 0; x < width; x++) {
                // Ignore near-transparent pixels so the ground shadow does not
                // inflate the box and shrink every animal inside its card.
                if (data[row + x * 4 + 3] > 12) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    /**
     * Draw a species into a dock tile, scaled and centred to fill it.
     *
     * The rigs span an order of magnitude — a rabbit beside a giraffe — so a fixed
     * scale leaves one card empty and overflows the next. Rather than estimating the
     * extents from the rig parameters, which goes wrong the moment a species adds a
     * trunk, antlers or a wingspan, the animal is drawn once oversized, the pixels it
     * actually covered are measured, and it is drawn again fitted to that box. Runs
     * once per species at startup.
     *
     * @param {string} speciesId
     * @param {number} width  CSS pixels.
     * @param {number} height CSS pixels.
     * @param {object} light
     * @param {number} [dpr]  Backing-store multiplier for a crisp portrait.
     */
    function makePortrait(speciesId, width, height, light, dpr) {
        const spec = Safari.IsoSpecies[speciesId];
        const canvas = Safari.Utils.createCanvas(width, height);
        if (!spec) return canvas;

        const state = {
            facing: 0.85, phase: 0.12, speed01: 0, time: 1.2,
            seed: 3, headDown: 0, blink: 0, earFlick: 0.08,
            wingFlap: 0.3, baby: 0
        };

        const PROBE = 360;
        const probe = Safari.Utils.createCanvas(PROBE, PROBE);
        const pctx = probe.getContext('2d');
        const ox = PROBE * 0.5;
        const oy = PROBE * 0.62;
        paint(pctx, spec, state, ox, oy, 1, light);

        const box = measureInk(pctx, PROBE, PROBE);
        if (!box) return canvas;

        const scale2 = dpr === undefined ? 2 : dpr;
        canvas.width = Math.round(width * scale2);
        canvas.height = Math.round(height * scale2);
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(scale2, scale2);

        const margin = 0.92;
        const scale = Math.min((width * margin) / box.w, (height * margin) / box.h);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;

        paint(ctx, spec, state,
            width / 2 - (cx - ox) * scale,
            height / 2 - (cy - oy) * scale,
            scale, light);

        return canvas;
    }

    Safari.IsoCreatureArt = {
        SQUASH,
        paint,
        project,
        projectEllipsoid,
        solveLimb,
        makePortrait,
        measureInk
    };

})(window.Safari);
