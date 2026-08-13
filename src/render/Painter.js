/**
 * Safari Simulator — Low-level canvas drawing primitives.
 *
 * Everything drawn in the game is built from this handful of shapes. The two that
 * matter most are `smoothPath` (a Catmull–Rom spline through arbitrary points) and
 * `tapered` (a variable-width ribbon along a spine), which together produce the
 * organic limbs, necks, tails, trunks and branches the rest of the art depends on.
 *
 * Functions here are stateless and take an explicit context; they never read game state.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Noise } = Safari;
    const TAU = MathUtils.TAU;

    /**
     * Scratch buffers for `tapered`, which is the hottest function in the renderer.
     *
     * The point objects themselves are pooled, not just the arrays: a scene of thirty
     * animals calls `tapered` several hundred times a frame, and allocating a fresh
     * `{x, y}` per offset point generated thousands of short-lived objects per frame.
     * Here the buffers grow once and their contents are overwritten in place.
     */
    const _left = [];
    const _right = [];
    const _outline = [];
    /** Reusable point objects indexed in parallel with the buffers above. */
    const _leftPool = [];
    const _rightPool = [];
    const _capPool = [{ x: 0, y: 0 }, { x: 0, y: 0 }];

    function poolPoint(pool, i) {
        let p = pool[i];
        if (!p) { p = { x: 0, y: 0 }; pool[i] = p; }
        return p;
    }

    const Painter = {

        /* ============================================================== *
         * Paths
         * ============================================================== */

        /**
         * Trace a smooth Catmull–Rom spline through `pts` onto the current path.
         *
         * @param {CanvasRenderingContext2D} ctx
         * @param {Array<{x:number,y:number}>} pts
         * @param {boolean} [closed] Wrap the spline into a loop.
         * @param {number} [tension] 0 = polyline, 0.5 = natural, 1 = loose.
         * @param {boolean} [continuePath] Append to the current path instead of starting one.
         */
        smoothPath(ctx, pts, closed, tension, continuePath) {
            const n = pts.length;
            if (n === 0) return;
            if (!continuePath) ctx.beginPath();

            if (n === 1) { ctx.moveTo(pts[0].x, pts[0].y); return; }
            if (n === 2) {
                ctx.moveTo(pts[0].x, pts[0].y);
                ctx.lineTo(pts[1].x, pts[1].y);
                if (closed) ctx.closePath();
                return;
            }

            const t = (tension === undefined ? 0.5 : tension) / 3;
            const get = closed
                ? (i) => pts[((i % n) + n) % n]
                : (i) => pts[i < 0 ? 0 : (i > n - 1 ? n - 1 : i)];

            ctx.moveTo(pts[0].x, pts[0].y);
            const last = closed ? n : n - 1;
            for (let i = 0; i < last; i++) {
                const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
                ctx.bezierCurveTo(
                    p1.x + (p2.x - p0.x) * t, p1.y + (p2.y - p0.y) * t,
                    p2.x - (p3.x - p1.x) * t, p2.y - (p3.y - p1.y) * t,
                    p2.x, p2.y
                );
            }
            if (closed) ctx.closePath();
        },

        /**
         * Build a closed outline around a spine, with per-point width.
         *
         * This is the workhorse behind every limb, neck, tail and branch in the game:
         * given a centre line and a width profile, it produces a smooth, organically
         * tapering silhouette rather than a stack of stroked line segments.
         *
         * @param {CanvasRenderingContext2D} ctx
         * @param {Array<{x:number,y:number}>} spine At least two points.
         * @param {number[]|number} widths Per-point width, or a constant.
         * @param {object} [opts]
         * @param {boolean} [opts.roundStart] Extend a cap beyond the first point.
         * @param {boolean} [opts.roundEnd] Extend a cap beyond the last point.
         * @param {number} [opts.tension]
         */
        tapered(ctx, spine, widths, opts) {
            const n = spine.length;
            if (n < 2) return;
            const o = opts || {};
            const widthAt = typeof widths === 'number'
                ? () => widths
                : (i) => widths[i < 0 ? 0 : (i >= widths.length ? widths.length - 1 : i)];

            _left.length = 0;
            _right.length = 0;

            for (let i = 0; i < n; i++) {
                const p = spine[i];
                const a = spine[i > 0 ? i - 1 : 0];
                const b = spine[i < n - 1 ? i + 1 : n - 1];
                let tx = b.x - a.x, ty = b.y - a.y;
                const len = Math.hypot(tx, ty) || 1;
                tx /= len; ty /= len;
                const w = widthAt(i) * 0.5;

                const lp = poolPoint(_leftPool, i);
                lp.x = p.x - ty * w; lp.y = p.y + tx * w;
                _left.push(lp);

                const rp = poolPoint(_rightPool, i);
                rp.x = p.x + ty * w; rp.y = p.y - tx * w;
                _right.push(rp);
            }

            _outline.length = 0;

            // Leading cap: nudge a point past the tip so the spline rounds it off.
            if (o.roundStart) {
                const p = spine[0], q = spine[1];
                let tx = p.x - q.x, ty = p.y - q.y;
                const l = Math.hypot(tx, ty) || 1;
                const w = widthAt(0) * 0.5;
                const cap = _capPool[0];
                cap.x = p.x + (tx / l) * w * 0.92;
                cap.y = p.y + (ty / l) * w * 0.92;
                _outline.push(cap);
            }

            for (let i = 0; i < n; i++) _outline.push(_left[i]);

            if (o.roundEnd) {
                const p = spine[n - 1], q = spine[n - 2];
                let tx = p.x - q.x, ty = p.y - q.y;
                const l = Math.hypot(tx, ty) || 1;
                const w = widthAt(n - 1) * 0.5;
                const cap = _capPool[1];
                cap.x = p.x + (tx / l) * w * 0.92;
                cap.y = p.y + (ty / l) * w * 0.92;
                _outline.push(cap);
            }

            for (let i = n - 1; i >= 0; i--) _outline.push(_right[i]);

            Painter.smoothPath(ctx, _outline, true, o.tension === undefined ? 0.5 : o.tension);
        },

        /** Fill a tapered ribbon in one call. */
        fillTapered(ctx, spine, widths, style, opts) {
            Painter.tapered(ctx, spine, widths, opts);
            ctx.fillStyle = style;
            ctx.fill();
        },

        /**
         * An organic, slightly irregular ellipse — used for canopies, rocks, clouds,
         * bushes and animal torsos, wherever a perfect ellipse would read as synthetic.
         *
         * @param {number} lobes How many bumps around the perimeter.
         * @param {number} wobble Bump depth as a fraction of the radius.
         * @param {number} seed Deterministic shape selector.
         */
        blobPath(ctx, cx, cy, rx, ry, rotation, lobes, wobble, seed, steps) {
            const count = steps || 22;
            const pts = [];
            const rot = rotation || 0;
            const cos = Math.cos(rot), sin = Math.sin(rot);
            const lb = lobes || 3;
            const wb = wobble === undefined ? 0.1 : wobble;
            const sd = seed || 0;

            for (let i = 0; i < count; i++) {
                const a = (i / count) * TAU;
                // Two harmonics keep the silhouette from looking like a regular polygon.
                const n1 = Noise.value1(Math.cos(a) * lb + sd * 7.3) - 0.5;
                const n2 = Noise.value1(Math.sin(a) * lb * 1.7 + sd * 13.1 + 40) - 0.5;
                const k = 1 + (n1 * 1.3 + n2 * 0.7) * wb;
                const ex = Math.cos(a) * rx * k;
                const ey = Math.sin(a) * ry * k;
                pts.push({ x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos });
            }
            Painter.smoothPath(ctx, pts, true, 0.5);
        },

        /** Fill an organic blob in one call. */
        blob(ctx, cx, cy, rx, ry, rotation, lobes, wobble, seed, style) {
            Painter.blobPath(ctx, cx, cy, rx, ry, rotation, lobes, wobble, seed);
            ctx.fillStyle = style;
            ctx.fill();
        },

        /**
         * Superellipse (squircle) path. `n` = 2 is an ellipse; higher values square it
         * off, which is how barrel-chested torsos and boxy muzzles are shaped.
         */
        superellipse(ctx, cx, cy, rx, ry, n, rotation, steps) {
            const count = steps || 40;
            const exp = 2 / (n || 3);
            const rot = rotation || 0;
            const cos = Math.cos(rot), sin = Math.sin(rot);
            ctx.beginPath();
            for (let i = 0; i <= count; i++) {
                const a = (i / count) * TAU;
                const ca = Math.cos(a), sa = Math.sin(a);
                const ex = Math.sign(ca) * Math.pow(Math.abs(ca), exp) * rx;
                const ey = Math.sign(sa) * Math.pow(Math.abs(sa), exp) * ry;
                const x = cx + ex * cos - ey * sin;
                const y = cy + ex * sin + ey * cos;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
        },

        /** Axis-aligned (or rotated) ellipse as a path. */
        ellipsePath(ctx, cx, cy, rx, ry, rotation) {
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), rotation || 0, 0, TAU);
        },

        /** Filled ellipse. */
        ellipse(ctx, cx, cy, rx, ry, style, rotation) {
            Painter.ellipsePath(ctx, cx, cy, rx, ry, rotation);
            ctx.fillStyle = style;
            ctx.fill();
        },

        /** Capsule (stadium) between two points. */
        capsule(ctx, x0, y0, x1, y1, r) {
            const dx = x1 - x0, dy = y1 - y0;
            const a = Math.atan2(dy, dx);
            ctx.beginPath();
            ctx.arc(x0, y0, r, a + Math.PI / 2, a - Math.PI / 2);
            ctx.arc(x1, y1, r, a - Math.PI / 2, a + Math.PI / 2);
            ctx.closePath();
        },

        /** Rounded rectangle path, with a uniform or per-corner radius. */
        roundRect(ctx, x, y, w, h, r) {
            const rr = typeof r === 'number'
                ? { tl: r, tr: r, br: r, bl: r }
                : Object.assign({ tl: 0, tr: 0, br: 0, bl: 0 }, r);
            const max = Math.min(Math.abs(w), Math.abs(h)) / 2;
            const tl = Math.min(rr.tl, max), tr = Math.min(rr.tr, max);
            const br = Math.min(rr.br, max), bl = Math.min(rr.bl, max);

            ctx.beginPath();
            ctx.moveTo(x + tl, y);
            ctx.lineTo(x + w - tr, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
            ctx.lineTo(x + w, y + h - br);
            ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
            ctx.lineTo(x + bl, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
            ctx.lineTo(x, y + tl);
            ctx.quadraticCurveTo(x, y, x + tl, y);
            ctx.closePath();
        },

        /* ============================================================== *
         * Shading
         * ============================================================== */

        /**
         * Soft elliptical contact shadow with a falloff gradient.
         * Drawn in world space directly beneath an entity.
         */
        softShadow(ctx, cx, cy, rx, ry, alpha, color) {
            if (rx <= 0 || ry <= 0 || alpha <= 0) return;
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
            const c = color || '0,0,0';
            grad.addColorStop(0, 'rgba(' + c + ',' + alpha + ')');
            grad.addColorStop(0.55, 'rgba(' + c + ',' + alpha * 0.62 + ')');
            grad.addColorStop(1, 'rgba(' + c + ',0)');

            ctx.save();
            ctx.translate(cx, cy);
            ctx.scale(1, ry / Math.max(rx, ry));
            ctx.translate(-cx, -cy);
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(rx, ry), 0, TAU);
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.restore();
        },

        /** Radial glow, additive-friendly. */
        glow(ctx, cx, cy, radius, color, alpha, innerStop) {
            if (radius <= 0 || alpha <= 0) return;
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            grad.addColorStop(0, 'rgba(' + color + ',' + alpha + ')');
            grad.addColorStop(innerStop === undefined ? 0.4 : innerStop,
                'rgba(' + color + ',' + alpha * 0.34 + ')');
            grad.addColorStop(1, 'rgba(' + color + ',0)');
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, TAU);
            ctx.fillStyle = grad;
            ctx.fill();
        },

        /** Build a vertical gradient from an array of `{p, c}` stops. */
        verticalGradient(ctx, y0, y1, stops) {
            const g = ctx.createLinearGradient(0, y0, 0, y1);
            for (let i = 0; i < stops.length; i++) {
                g.addColorStop(MathUtils.clamp01(stops[i].p), stops[i].c);
            }
            return g;
        },

        /** Build a linear gradient between two arbitrary points. */
        linearGradient(ctx, x0, y0, x1, y1, stops) {
            const g = ctx.createLinearGradient(x0, y0, x1, y1);
            for (let i = 0; i < stops.length; i++) {
                g.addColorStop(MathUtils.clamp01(stops[i].p), stops[i].c);
            }
            return g;
        },

        /**
         * Apply a directional light/shade pass over the shape currently on the path.
         * Call after filling the base colour, with the path still intact.
         */
        shadeCurrentPath(ctx, bounds, lightAngle, lightColor, shadeColor, strength) {
            const cx = bounds.x + bounds.w / 2;
            const cy = bounds.y + bounds.h / 2;
            const r = Math.max(bounds.w, bounds.h) * 0.72;
            const lx = Math.cos(lightAngle) * r, ly = Math.sin(lightAngle) * r;
            const g = ctx.createLinearGradient(cx + lx, cy + ly, cx - lx, cy - ly);
            g.addColorStop(0, 'rgba(' + lightColor + ',' + strength + ')');
            g.addColorStop(0.5, 'rgba(' + lightColor + ',0)');
            g.addColorStop(0.52, 'rgba(' + shadeColor + ',0)');
            g.addColorStop(1, 'rgba(' + shadeColor + ',' + strength + ')');
            ctx.fillStyle = g;
            ctx.fill();
        },

        /* ============================================================== *
         * Composition helpers
         * ============================================================== */

        /** Run `fn` with the current path used as a clip region. */
        clipped(ctx, fn) {
            ctx.save();
            ctx.clip();
            fn(ctx);
            ctx.restore();
        },

        /** Run `fn` inside a saved/restored transform. */
        transformed(ctx, x, y, rotation, scaleX, scaleY, fn) {
            ctx.save();
            ctx.translate(x, y);
            if (rotation) ctx.rotate(rotation);
            if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
            fn(ctx);
            ctx.restore();
        },

        /* ============================================================== *
         * Textures
         * ============================================================== */

        /**
         * Generate a tileable noise tile for the film-grain pass.
         *
         * The grain is *signed*: pixels are either black or white, with alpha
         * proportional to how far the sample sits from mid-grey. Averaged over the tile
         * it is therefore neutral, which lets it be composited with an ordinary
         * `source-over` draw instead of the much more expensive `overlay` blend, without
         * washing the image toward grey.
         *
         * @returns {HTMLCanvasElement}
         */
        makeGrainTile(size, intensity) {
            const s = size || 128;
            const strength = intensity === undefined ? 1 : intensity;
            const canvas = Safari.Utils.createCanvas(s, s);
            const ctx = canvas.getContext('2d');
            const img = ctx.createImageData(s, s);
            const data = img.data;

            for (let i = 0; i < data.length; i += 4) {
                const v = Math.random();
                const light = v > 0.5;
                const level = light ? 255 : 0;
                data[i] = level; data[i + 1] = level; data[i + 2] = level;
                data[i + 3] = (Math.abs(v - 0.5) * 2 * strength * 255) | 0;
            }

            ctx.putImageData(img, 0, 0);
            return canvas;
        },

        /**
         * Speckle a region with small semi-transparent dots — used for ground
         * mottling, sand grain and rock texture on pre-rendered surfaces.
         */
        speckle(ctx, rng, x, y, w, h, count, colors, minR, maxR, alpha) {
            for (let i = 0; i < count; i++) {
                const px = x + rng.next() * w;
                const py = y + rng.next() * h;
                const r = MathUtils.lerp(minR, maxR, rng.next());
                ctx.globalAlpha = alpha * (0.4 + rng.next() * 0.6);
                ctx.fillStyle = colors[(rng.next() * colors.length) | 0];
                ctx.beginPath();
                ctx.ellipse(px, py, r, r * (0.5 + rng.next() * 0.5), rng.next() * TAU, 0, TAU);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        },

        /* ============================================================== *
         * Text
         * ============================================================== */

        /** Draw text with a soft drop shadow, for in-world labels. */
        shadowText(ctx, text, x, y, font, color, align, shadowAlpha) {
            ctx.font = font;
            ctx.textAlign = align || 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(0,0,0,' + (shadowAlpha === undefined ? 0.45 : shadowAlpha) + ')';
            ctx.fillText(text, x, y + 1.5);
            ctx.fillStyle = color;
            ctx.fillText(text, x, y);
        }
    };

    Safari.Painter = Painter;

})(window.Safari);
