/**
 * Safari Simulator — Three-quarter ranger vehicle.
 *
 * The side-on jeep was a stack of shapes drawn in profile; it only ever faced two ways.
 * This one is a solid: the vehicle is defined as a set of quadrilaterals in the same
 * local space the creature rigs use (fx forward, fy left, fz up), rotated by its
 * heading, projected, sorted back to front and shaded from each face's own normal.
 *
 * The result is one description that renders correctly through a full circle of
 * headings, with no per-direction art and no special cases at the diagonals.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Color, Painter, Palettes, IsoSolid } = Safari;
    const { SQUASH, projectEllipsoid } = Safari.IsoCreatureArt;
    const TAU = MathUtils.TAU;

    /**
     * Vehicle dimensions, in world screen pixels at zoom 1.
     *
     * A long-wheelbase open-top safari cruiser: distinctly larger than a zebra so it
     * reads as a machine among animals, but not so large that it dominates a herd.
     */
    const DIM = {
        length: 46,
        width: 19,
        /** Chassis floor and its height. */
        floorZ: 9,
        bodyH: 9,
        wheelR: 6.4,
        wheelW: 3.2,
        wheelFront: 15,
        wheelRear: -14,
        /** Roll cage. */
        cageZ: 31,
        /** Where the ranger stands. */
        standZ: 18
    };

    const PALETTE = {
        body: '#6d7f52',
        bodyDark: '#55643f',
        trim: '#3d4632',
        bonnet: '#7b8d5c',
        canvas: '#d9cfae',
        tyre: '#241f1c',
        rim: '#98938a',
        glass: '#9fb9bd',
        lamp: '#f4e6b6',
        cage: '#4a5340',
        skin: '#c99a6e',
        shirt: '#c8b98d',
        hat: '#8a7a52',
        rifle: '#2f2a24'
    };

    /* ------------------------------------------------------------------ *
     * Lighting
     * ------------------------------------------------------------------ */

    let _lit = null;
    let _litHour = -999;

    function palette(light) {
        if (_lit && Math.abs(light.hour - _litHour) < 0.05) return _lit;
        _litHour = light.hour;

        const lit = (hex, warmth) => Color.css(
            Palettes.litColor(Color.parse(hex), light, warmth === undefined ? 0.5 : warmth));

        _lit = {
            body: lit(PALETTE.body),
            bodyDark: lit(PALETTE.bodyDark),
            trim: lit(PALETTE.trim, 0.3),
            bonnet: lit(PALETTE.bonnet),
            canvas: lit(PALETTE.canvas, 0.6),
            tyre: lit(PALETTE.tyre, 0.2),
            rim: lit(PALETTE.rim, 0.3),
            glass: lit(PALETTE.glass, 0.4),
            lamp: PALETTE.lamp,
            cage: lit(PALETTE.cage, 0.3),
            skin: lit(PALETTE.skin, 0.6),
            shirt: lit(PALETTE.shirt, 0.5),
            hat: lit(PALETTE.hat, 0.5),
            rifle: lit(PALETTE.rifle, 0.2)
        };
        return _lit;
    }

    /* ------------------------------------------------------------------ *
     * Painter
     * ------------------------------------------------------------------ */

    const _wheels = [
        { x: DIM.wheelFront, y: DIM.width / 2 + 1 },
        { x: DIM.wheelFront, y: -DIM.width / 2 - 1 },
        { x: DIM.wheelRear, y: DIM.width / 2 + 1 },
        { x: DIM.wheelRear, y: -DIM.width / 2 - 1 }
    ];

    /**
     * Draw the ranger vehicle.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} st Render state: facing, speed01, wheelPhase, bounce, aiming,
     *   selected, aimAngle, time.
     * @param {number} screenX Ground contact point.
     * @param {number} screenY
     * @param {number} scale
     * @param {object} light
     */
    function paint(ctx, st, screenX, screenY, scale, light) {
        const pal = palette(light);
        const facing = st.facing || 0;
        const cos = Math.cos(facing);
        const sin = Math.sin(facing);
        const sun = light.sunStrength || 0;

        ctx.save();
        ctx.translate(screenX, screenY);
        if (scale !== 1) ctx.scale(scale, scale);

        /* --- Ground shadow --------------------------------------------- */
        // Soft and tight to the wheelbase. A hard ellipse the size of the vehicle
        // reads as a hole in the ground rather than as shade under a chassis.
        ctx.save();
        const shGrad = ctx.createRadialGradient(0, 2, 1, 0, 2, DIM.length * 0.46);
        const shA = (0.30 + sun * 0.18).toFixed(3);
        shGrad.addColorStop(0, 'rgba(26,22,15,' + shA + ')');
        shGrad.addColorStop(0.65, 'rgba(26,22,15,' + (shA * 0.55).toFixed(3) + ')');
        shGrad.addColorStop(1, 'rgba(26,22,15,0)');
        ctx.fillStyle = shGrad;
        ctx.beginPath();
        ctx.ellipse(0, 2, DIM.length * 0.46, DIM.length * 0.46 * SQUASH, 0, 0, TAU);
        ctx.fill();
        ctx.restore();

        const lift = (st.bounce || 0);

        /* --- Assemble the solid ---------------------------------------- */
        IsoSolid.begin();
        buildChassis(pal, lift);

        /*
         * Wheels are drawn as discs rather than facetted into the body: the exact
         * ellipsoid silhouette is both cheaper and rounder. The pair on the far side
         * goes down before the body and the near pair after, so the chassis occludes
         * the wheels behind it and the wheels in front occlude the chassis.
         */
        const wheelEll = projectEllipsoid(DIM.wheelR, DIM.wheelW / 2, DIM.wheelR, cos, sin);
        const wr = { rx: wheelEll.rx, ry: wheelEll.ry, rot: wheelEll.rot };
        const phase = st.wheelPhase || 0;

        for (let i = 0; i < 4; i++) {
            const w = _wheels[i];
            const gy = w.x * sin + w.y * cos;
            if (gy >= 0) continue;
            drawWheel(ctx, w.x * cos - w.y * sin, gy * SQUASH - (DIM.wheelR + lift),
                wr, pal, phase);
        }

        /* --- Body ------------------------------------------------------- */
        IsoSolid.flush(ctx, cos, sin, sun);

        for (let i = 0; i < 4; i++) {
            const w = _wheels[i];
            const gy = w.x * sin + w.y * cos;
            if (gy < 0) continue;
            drawWheel(ctx, w.x * cos - w.y * sin, gy * SQUASH - (DIM.wheelR + lift),
                wr, pal, phase);
        }

        /* --- Roll bar, lamps and the ranger ----------------------------- */
        paintUpper(ctx, cos, sin, lift, pal, st, sun);

        ctx.restore();
    }

    /** The chassis, bonnet, bed and seats, as boxes. */
    function buildChassis(pal, lift) {
        const z = DIM.floorZ + lift;
        const box = (cx, cy, cz, sx, sy, sz, side, top, end) =>
            IsoSolid.box({ x: cx, y: cy, z: cz }, { x: sx, y: sy, z: sz },
                { side, top: top || side, end: end || side });

        // Main tub.
        box(0, 0, z + DIM.bodyH / 2, DIM.length * 0.78, DIM.width, DIM.bodyH,
            pal.body, pal.bodyDark, pal.bodyDark);

        // Bonnet, forward and a little lower than the tub, which is what makes the
        // silhouette read as a vehicle rather than a crate.
        box(DIM.length * 0.42, 0, z + DIM.bodyH * 0.62,
            DIM.length * 0.30, DIM.width * 0.92, DIM.bodyH * 0.78,
            pal.bonnet, pal.bonnet, pal.bodyDark);

        // Grille and bumper.
        box(DIM.length * 0.56, 0, z + DIM.bodyH * 0.34,
            2.6, DIM.width * 0.86, DIM.bodyH * 0.8, pal.trim, pal.trim, pal.trim);

        // Bench seat back.
        box(-DIM.length * 0.06, 0, z + DIM.bodyH + 4,
            2.6, DIM.width * 0.78, 8, pal.trim, pal.trim, pal.trim);

        // Rear equipment crate.
        box(-DIM.length * 0.30, 0, z + DIM.bodyH + 2.6,
            DIM.length * 0.20, DIM.width * 0.7, 5.2, pal.canvas, pal.canvas, pal.trim);

        // Side sills, which give the flank a line instead of a flat slab.
        box(0, DIM.width / 2 - 0.4, z + 1.2, DIM.length * 0.72, 1.4, 2.4,
            pal.trim, pal.trim, pal.trim);
        box(0, -DIM.width / 2 + 0.4, z + 1.2, DIM.length * 0.72, 1.4, 2.4,
            pal.trim, pal.trim, pal.trim);
    }

    /** One wheel: tyre, rim and spokes that turn with travel. */
    function drawWheel(ctx, sx, sy, ell, pal, phase) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(ell.rot);

        ctx.beginPath();
        ctx.ellipse(0, 0, ell.rx, ell.ry, 0, 0, TAU);
        ctx.fillStyle = pal.tyre;
        ctx.fill();

        ctx.beginPath();
        ctx.ellipse(0, 0, ell.rx * 0.52, ell.ry * 0.52, 0, 0, TAU);
        ctx.fillStyle = pal.rim;
        ctx.fill();

        // Spokes make rotation legible; without them a wheel just slides.
        ctx.strokeStyle = 'rgba(28,24,20,0.7)';
        ctx.lineWidth = 1.1;
        for (let s = 0; s < 3; s++) {
            const a = phase + s * (Math.PI / 3);
            ctx.beginPath();
            ctx.moveTo(-Math.cos(a) * ell.rx * 0.5, -Math.sin(a) * ell.ry * 0.5);
            ctx.lineTo(Math.cos(a) * ell.rx * 0.5, Math.sin(a) * ell.ry * 0.5);
            ctx.stroke();
        }
        ctx.restore();
    }

    /**
     * Windscreen, roll bar, lamps and the ranger.
     *
     * An open-top game viewer, not a hard-top: an enclosed cab at this scale is a pale
     * slab floating on four hairlines, and it buries the one figure the player actually
     * needs to see. A low hoop behind the seats reads as a safari vehicle and leaves the
     * ranger in clear silhouette.
     *
     * Drawn after the body in a single pass — everything here sits above the tub, so
     * nothing behind it can occlude it and the painter's sort has no work to do.
     */
    function paintUpper(ctx, cos, sin, lift, pal, st, sun) {
        const z0 = DIM.floorZ + DIM.bodyH + lift;
        const halfW = DIM.width / 2 - 1.8;

        const P = (fx, fy, fz) => {
            const gx = fx * cos - fy * sin;
            const gy = fx * sin + fy * cos;
            return { x: gx, y: gy * SQUASH - fz, d: gy };
        };

        /* --- Headlamps -------------------------------------------------- */
        const lampY = DIM.width * 0.30;
        for (const s of [1, -1]) {
            const l = P(DIM.length * 0.56, s * lampY, DIM.floorZ + DIM.bodyH * 0.95 + lift);
            ctx.beginPath();
            ctx.ellipse(l.x, l.y, 2.3, 1.9, 0, 0, TAU);
            ctx.fillStyle = pal.lamp;
            ctx.fill();
        }

        /* --- Windscreen ------------------------------------------------- */
        const wsZ = z0 + 10;
        const wa = P(DIM.length * 0.24, halfW, z0);
        const wb = P(DIM.length * 0.24, -halfW, z0);
        const wc = P(DIM.length * 0.20, -halfW, wsZ);
        const wd = P(DIM.length * 0.20, halfW, wsZ);

        ctx.beginPath();
        ctx.moveTo(wa.x, wa.y);
        ctx.lineTo(wb.x, wb.y);
        ctx.lineTo(wc.x, wc.y);
        ctx.lineTo(wd.x, wd.y);
        ctx.closePath();
        ctx.fillStyle = pal.glass;
        ctx.globalAlpha = 0.5;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = pal.cage;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = 'round';
        ctx.stroke();

        /* --- Roll hoop --------------------------------------------------- */
        const hoopX = -DIM.length * 0.26;
        const hz = DIM.cageZ + lift;
        const ha = P(hoopX, halfW, z0);
        const hb = P(hoopX, halfW, hz);
        const hc = P(hoopX, -halfW, hz);
        const hd = P(hoopX, -halfW, z0);

        ctx.strokeStyle = pal.cage;
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(ha.x, ha.y);
        ctx.lineTo(hb.x, hb.y);
        ctx.lineTo(hc.x, hc.y);
        ctx.lineTo(hd.x, hd.y);
        ctx.stroke();

        // Sun awning stretched forward from the hoop: a strip, not a box.
        const aa = P(hoopX, halfW, hz);
        const ab = P(hoopX, -halfW, hz);
        const ac = P(DIM.length * 0.06, -halfW, hz - 1.2);
        const ad = P(DIM.length * 0.06, halfW, hz - 1.2);
        ctx.beginPath();
        ctx.moveTo(aa.x, aa.y);
        ctx.lineTo(ab.x, ab.y);
        ctx.lineTo(ac.x, ac.y);
        ctx.lineTo(ad.x, ad.y);
        ctx.closePath();
        ctx.fillStyle = pal.canvas;
        ctx.globalAlpha = 0.92;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(255,246,214,' + (0.05 + sun * 0.10).toFixed(3) + ')';
        ctx.fill();

        /*
         * The ranger goes on last, standing through the awning line. Painting him over
         * it is the correct read — a man standing up through a roof hatch — and it keeps
         * the one figure the player is tracking from ever being swallowed by the vehicle.
         */
        paintRanger(ctx, P, pal, st, lift);
    }

    /**
     * The ranger, standing through the roof line with a dart rifle.
     *
     * Deliberately simple — at this scale the read is a silhouette and a hat — but the
     * rifle tracks the aim direction, because that is the one part of the figure the
     * player is actually reading.
     */
    function paintRanger(ctx, P, pal, st, lift) {
        const bodyZ = DIM.floorZ + DIM.bodyH + lift;
        const fx = -DIM.length * 0.10;

        const hip = P(fx, 0, bodyZ - 1);
        const chest = P(fx, 0, bodyZ + 9);
        const head = P(fx, 0, bodyZ + 14.5);

        // Torso.
        Painter.fillTapered(ctx,
            [{ x: hip.x, y: hip.y }, { x: chest.x, y: chest.y }],
            [5.2, 6.0], pal.shirt, { roundStart: true, roundEnd: true });

        // Head and bush hat.
        ctx.beginPath();
        ctx.ellipse(head.x, head.y, 2.9, 3.1, 0, 0, TAU);
        ctx.fillStyle = pal.skin;
        ctx.fill();

        ctx.beginPath();
        ctx.ellipse(head.x, head.y - 2.2, 5.4, 2.2, 0, 0, TAU);
        ctx.fillStyle = pal.hat;
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(head.x, head.y - 3.4, 2.9, 2.0, 0, 0, TAU);
        ctx.fillStyle = pal.hat;
        ctx.fill();

        /* --- Rifle ------------------------------------------------------ */
        // Aim is a world-space angle, so the barrel is built in world space directly
        // rather than in the vehicle's local frame — the ranger can shoot behind the
        // jeep without the vehicle turning.
        const aim = st.aimAngle;
        if (aim === undefined || aim === null) return;

        const reach = 15 + (st.aiming || 0) * 4;
        const ax = Math.cos(aim);
        const ay = Math.sin(aim);
        const gripX = chest.x + ax * 4;
        const gripY = chest.y + ay * 4 * SQUASH + 1;
        const tipX = chest.x + ax * reach;
        const tipY = chest.y + ay * reach * SQUASH + 1;

        Painter.fillTapered(ctx,
            [{ x: gripX, y: gripY }, { x: tipX, y: tipY }],
            [2.2, 1.3], pal.rifle, { roundStart: true, roundEnd: true });
    }

    /**
     * A dart in flight: a bright bead with a short motion streak behind it.
     * Drawn separately from the vehicle because darts outlive the frame they left in.
     */
    function paintDart(ctx, sx, sy, angle, light) {
        const len = 7;
        const ax = Math.cos(angle) * len;
        const ay = Math.sin(angle) * len * SQUASH;

        ctx.save();
        ctx.strokeStyle = 'rgba(255,236,180,0.45)';
        ctx.lineWidth = 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sx - ax * 1.6, sy - ay * 1.6);
        ctx.lineTo(sx, sy);
        ctx.stroke();

        ctx.fillStyle = '#ffe9a8';
        ctx.beginPath();
        ctx.ellipse(sx, sy, 2.0, 1.6, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
    }

    /**
     * Draw the jeep into a dock tile, measured and fitted like the species portraits.
     *
     * Same treatment for the same reason: the button must show exactly what it
     * commands, and guessing the extents of a vehicle with a mast, an awning and a
     * standing figure gets it wrong every time.
     */
    function makePortrait(width, height, light, dpr) {
        const state = {
            facing: 0.7, speed01: 0, wheelPhase: 0.6, bounce: 0,
            aiming: 0, aimAngle: null, time: 1
        };

        const PROBE = 360;
        const probe = Safari.Utils.createCanvas(PROBE, PROBE);
        const pctx = probe.getContext('2d');
        const ox = PROBE * 0.5;
        const oy = PROBE * 0.62;
        paint(pctx, state, ox, oy, 1, light);

        const box = Safari.IsoCreatureArt.measureInk(pctx, PROBE, PROBE);
        const scale2 = dpr === undefined ? 2 : dpr;
        const canvas = Safari.Utils.createCanvas(
            Math.round(width * scale2), Math.round(height * scale2));
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        if (!box) return canvas;

        const ctx = canvas.getContext('2d');
        ctx.scale(scale2, scale2);

        const margin = 0.92;
        const scale = Math.min((width * margin) / box.w, (height * margin) / box.h);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;

        paint(ctx, state,
            width / 2 - (cx - ox) * scale,
            height / 2 - (cy - oy) * scale,
            scale, light);

        return canvas;
    }

    Safari.IsoVehicleArt = { DIM, paint, paintDart, palette, makePortrait };

})(window.Safari);
