/**
 * Safari Simulator — Solid geometry for isometric objects.
 *
 * Built objects — the ranger's jeep, the ranger's station — are described as sets of
 * quadrilaterals in the same local space the creature rigs use (fx forward, fy left,
 * fz up), then rotated by a heading, projected, sorted back to front and shaded from
 * each face's own normal.
 *
 * One description therefore renders correctly through a full circle with no
 * per-direction art and no special cases at the diagonals, which is the whole reason
 * the creatures are built this way too.
 *
 * The face list is a module-level scratch buffer: nothing here allocates per frame,
 * and callers are expected to `begin()`, add geometry, then `flush()` in one go.
 */
(function (Safari) {
    'use strict';

    const { MathUtils } = Safari;
    const SQUASH = Safari.IsoCreatureArt.SQUASH;

    /** Matches the terrain hillshade and the creature renderer. */
    const LIGHT_DIR = { x: -0.7, y: -0.7, z: 0.62 };

    const _faces = [];
    let _count = 0;

    /** Start a new solid. */
    function begin() {
        _count = 0;
    }

    /**
     * Add one quadrilateral.
     *
     * @param {number[]} verts Twelve numbers: four (fx, fy, fz) corners, in order.
     * @param {number} nx Outward normal.
     * @param {number} ny
     * @param {number} nz
     * @param {string} color
     * @param {number} [alpha]
     */
    function quad(verts, nx, ny, nz, color, alpha) {
        let f = _faces[_count];
        if (!f) {
            f = _faces[_count] = {
                v: null, n: [0, 0, 0], color: '', alpha: 1,
                depth: 0, shade: 1, pts: [{ x: 0, y: 0 }, { x: 0, y: 0 },
                    { x: 0, y: 0 }, { x: 0, y: 0 }]
            };
        }
        f.v = verts;
        f.n[0] = nx; f.n[1] = ny; f.n[2] = nz;
        f.color = color;
        f.alpha = alpha === undefined ? 1 : alpha;
        _count++;
        return f;
    }

    /**
     * Add an axis-aligned box.
     *
     * The underside is skipped: it is never visible from above, and leaving it out
     * halves neither the sort nor the fill by much on its own, but across a compound
     * of a dozen boxes it is worth having.
     *
     * @param {object} c Centre `{x, y, z}` in local space.
     * @param {object} s Size `{x, y, z}`.
     * @param {object} tone `{side, top, end}` colours; `end` defaults to `side`.
     */
    function box(c, s, tone) {
        const x0 = c.x - s.x / 2, x1 = c.x + s.x / 2;
        const y0 = c.y - s.y / 2, y1 = c.y + s.y / 2;
        const z0 = c.z - s.z / 2, z1 = c.z + s.z / 2;
        const end = tone.end || tone.side;

        quad([x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], 0, 0, 1, tone.top);
        quad([x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0], 1, 0, 0, end);
        quad([x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0], -1, 0, 0, end);
        quad([x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0], 0, 1, 0, tone.side);
        quad([x0, y0, z0, x0, y0, z1, x1, y0, z1, x1, y0, z0], 0, -1, 0, tone.side);
    }

    /**
     * Shading factor for a face, from its world-space normal.
     *
     * Horizontal faces catch the sky, vertical ones catch the sun or fall into shade.
     * The range is kept narrow so an object does not strobe as it turns.
     */
    function shade(nx, ny, nz, sunStrength) {
        const d = nx * LIGHT_DIR.x + ny * LIGHT_DIR.y + nz * LIGHT_DIR.z;
        return 0.80 + MathUtils.clamp(d, -1, 1) * (0.10 + sunStrength * 0.13);
    }

    const _order = [];

    /**
     * Project, depth-sort and fill everything added since `begin()`.
     *
     * @param {CanvasRenderingContext2D} ctx Already translated to the object's origin.
     * @param {number} cos Cosine of the object's heading.
     * @param {number} sin
     * @param {number} sunStrength
     */
    function flush(ctx, cos, sin, sunStrength) {
        for (let i = 0; i < _count; i++) {
            const f = _faces[i];
            const v = f.v;
            let depth = 0;

            for (let k = 0; k < 4; k++) {
                const fx = v[k * 3], fy = v[k * 3 + 1], fz = v[k * 3 + 2];
                const gx = fx * cos - fy * sin;
                const gy = fx * sin + fy * cos;
                const pt = f.pts[k];
                pt.x = gx;
                pt.y = gy * SQUASH - fz;
                depth += gy;
            }
            f.depth = depth / 4;

            // Rotate the normal with the object so shading turns with it.
            const n = f.n;
            f.shade = shade(n[0] * cos - n[1] * sin, n[0] * sin + n[1] * cos, n[2],
                sunStrength);
        }

        _order.length = _count;
        for (let i = 0; i < _count; i++) _order[i] = _faces[i];
        _order.sort((a, b) => a.depth - b.depth);

        for (let i = 0; i < _order.length; i++) {
            const f = _order[i];
            const pts = f.pts;

            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let k = 1; k < 4; k++) ctx.lineTo(pts[k].x, pts[k].y);
            ctx.closePath();

            ctx.globalAlpha = f.alpha;
            ctx.fillStyle = f.color;
            ctx.fill();

            // A wash rather than a recolour, so every panel keeps the same hue.
            ctx.fillStyle = f.shade > 1
                ? 'rgba(255,246,214,' + ((f.shade - 1) * 1.6).toFixed(3) + ')'
                : 'rgba(18,14,8,' + ((1 - f.shade) * 1.1).toFixed(3) + ')';
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    Safari.IsoSolid = { begin, quad, box, flush, shade, SQUASH, LIGHT_DIR };

})(window.Safari);
