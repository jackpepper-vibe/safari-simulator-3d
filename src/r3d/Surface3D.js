/**
 * Safari Simulator 3D — Implicit surfaces.
 *
 * A body assembled from primitives reads as an assembly of primitives. Ellipsoids
 * intersecting ellipsoids leave a crease at every seam, and at close range a hippo
 * stopped being an animal and became four visible lumps with a head balanced on them.
 *
 * So the parts of a creature that are *one continuous mass* — barrel, shoulder, haunch,
 * neck, skull, muzzle — are not drawn as separate meshes here. They are added to a
 * signed distance field, smooth-blended into each other, and the resulting surface is
 * polygonised once at build time. What comes out is a single skin with fillets where
 * the parts meet, which is what an animal actually looks like.
 *
 * The polygoniser is **naive surface nets** rather than marching cubes: one vertex per
 * cell placed at the average of its edge crossings, quads between neighbouring cells.
 * It is a fraction of the code, has no 256-entry tables, and — because it places
 * vertices in the interior of a cell rather than on its edges — produces exactly the
 * smooth, slightly rounded output that suits an organic body.
 *
 * Normals come from the gradient of the field, not from the triangles, so the surface
 * shades smoothly however coarse the grid is.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils } = Safari;

    /* ------------------------------------------------------------------ *
     * Distance functions
     * ------------------------------------------------------------------ */

    /**
     * Smooth minimum. `k` is the width of the blend, in world units — the size of the
     * fillet where two parts meet, and the single control that decides whether an
     * animal looks moulded or welded.
     */
    function smin(a, b, k) {
        if (k <= 0) return Math.min(a, b);
        const h = MathUtils.clamp01(0.5 + 0.5 * (b - a) / k);
        return b * (1 - h) + a * h - k * h * (1 - h);
    }

    /**
     * Distance to an axis-aligned ellipsoid.
     *
     * The usual cheap approximation — exact on a sphere and close enough elsewhere that
     * the error disappears into the blend.
     */
    function sdEllipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
        const x = (px - cx) / rx;
        const y = (py - cy) / ry;
        const z = (pz - cz) / rz;
        const k0 = Math.sqrt(x * x + y * y + z * z);
        if (k0 < 1e-6) return -Math.min(rx, ry, rz);
        const k1 = Math.sqrt(
            (x / rx) * (x / rx) + (y / ry) * (y / ry) + (z / rz) * (z / rz));
        return k0 * (k0 - 1) / k1;
    }

    /** Distance to a capsule: a segment with a radius, tapering from `ra` to `rb`. */
    function sdCapsule(px, py, pz, ax, ay, az, bx, by, bz, ra, rb) {
        const dx = bx - ax, dy = by - ay, dz = bz - az;
        const wx = px - ax, wy = py - ay, wz = pz - az;
        const len2 = dx * dx + dy * dy + dz * dz;
        const t = len2 > 1e-9
            ? MathUtils.clamp01((wx * dx + wy * dy + wz * dz) / len2)
            : 0;
        const cx = wx - dx * t, cy = wy - dy * t, cz = wz - dz * t;
        return Math.sqrt(cx * cx + cy * cy + cz * cz) - (ra + (rb - ra) * t);
    }

    /* ------------------------------------------------------------------ *
     * The field
     * ------------------------------------------------------------------ */

    /**
     * A collection of blended parts, with the bounds to polygonise them over.
     *
     * Each part also names the bone that drives it, which is what lets the polygonised
     * skin be weighted: a vertex near the join of neck and body ends up influenced by
     * both, so the neck bends instead of tearing.
     */
    class Field {
        /** @param {number} blend Fillet width, in world units. */
        constructor(blend) {
            this.parts = [];
            this.blend = blend === undefined ? 0.05 : blend;
            this.min = [Infinity, Infinity, Infinity];
            this.max = [-Infinity, -Infinity, -Infinity];
        }

        _grow(cx, cy, cz, rx, ry, rz) {
            const pad = this.blend * 1.5;
            this.min[0] = Math.min(this.min[0], cx - rx - pad);
            this.min[1] = Math.min(this.min[1], cy - ry - pad);
            this.min[2] = Math.min(this.min[2], cz - rz - pad);
            this.max[0] = Math.max(this.max[0], cx + rx + pad);
            this.max[1] = Math.max(this.max[1], cy + ry + pad);
            this.max[2] = Math.max(this.max[2], cz + rz + pad);
            return this;
        }

        /**
         * @param {number} bone Bone index this part belongs to.
         * @param {number} [blend] Override the fillet width for this part — a muzzle
         *   wants a tighter join than a haunch.
         */
        ellipsoid(bone, cx, cy, cz, rx, ry, rz, blend) {
            this.parts.push({
                kind: 0, bone, blend,
                c: [cx, cy, cz], r: [rx, ry, rz],
                a: [cx, cy, cz], b: [cx, cy, cz]
            });
            return this._grow(cx, cy, cz, rx, ry, rz);
        }

        capsule(bone, ax, ay, az, bx, by, bz, ra, rb, blend) {
            this.parts.push({
                kind: 1, bone, blend,
                a: [ax, ay, az], b: [bx, by, bz], ra, rb,
                c: [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2],
                r: [Math.max(ra, rb), Math.max(ra, rb), Math.max(ra, rb)]
            });
            const r = Math.max(ra, rb);
            this._grow(ax, ay, az, r, r, r);
            return this._grow(bx, by, bz, r, r, r);
        }

        /** Signed distance at a point: negative inside. */
        sample(x, y, z) {
            const parts = this.parts;
            let d = Infinity;
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                const pd = p.kind === 0
                    ? sdEllipsoid(x, y, z, p.c[0], p.c[1], p.c[2], p.r[0], p.r[1], p.r[2])
                    : sdCapsule(x, y, z, p.a[0], p.a[1], p.a[2],
                        p.b[0], p.b[1], p.b[2], p.ra, p.rb);
                d = i === 0 ? pd
                    : smin(d, pd, p.blend === undefined ? this.blend : p.blend);
            }
            return d;
        }

        /**
         * Walk outward from a point until the surface is crossed.
         *
         * Features that sit *on* an animal — an eye, an ear — are authored as offsets
         * from a bone, which works while the head is a known ellipsoid and fails the
         * moment it is a blended mass: on a big-headed species the eyes ended up buried
         * inside the skin. This finds where the skin actually is along a direction and
         * lets the feature be placed against it.
         *
         * @param {Array<number>} out Three slots for the surface point.
         * @param {number} [limit] How far to search, in world units.
         */
        project(px, py, pz, dx, dy, dz, out, limit) {
            const len = Math.hypot(dx, dy, dz) || 1;
            const ux = dx / len, uy = dy / len, uz = dz / len;
            const reach = limit === undefined ? 2 : limit;
            const step = Math.max(1e-3, reach / 48);

            let t = 0;
            let prev = this.sample(px, py, pz);
            for (let i = 0; i < 48; i++) {
                const nt = t + step;
                const d = this.sample(px + ux * nt, py + uy * nt, pz + uz * nt);
                if (prev < 0 && d >= 0) {
                    // Bisect the crossing for a clean contact point.
                    let lo = t, hi = nt;
                    for (let k = 0; k < 12; k++) {
                        const mid = (lo + hi) * 0.5;
                        if (this.sample(px + ux * mid, py + uy * mid, pz + uz * mid) < 0) lo = mid;
                        else hi = mid;
                    }
                    t = (lo + hi) * 0.5;
                    break;
                }
                prev = d;
                t = nt;
            }

            out[0] = px + ux * t;
            out[1] = py + uy * t;
            out[2] = pz + uz * t;
            return out;
        }

        /**
         * Skin weights at a point.
         *
         * Every part contributes in inverse proportion to its distance, so a vertex
         * deep in the barrel is entirely the body's and one on the throat is shared
         * between body and neck. That gradient is the whole reason the blended skin can
         * still be posed: a rigid binding would tear the fillet open the moment the
         * neck went down to graze.
         *
         * @param {Array<number>} out Eight slots: four bone indices then four weights.
         */
        weightsAt(x, y, z, out) {
            const parts = this.parts;
            const acc = this._acc || (this._acc = new Map());
            acc.clear();

            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                const d = p.kind === 0
                    ? sdEllipsoid(x, y, z, p.c[0], p.c[1], p.c[2], p.r[0], p.r[1], p.r[2])
                    : sdCapsule(x, y, z, p.a[0], p.a[1], p.a[2],
                        p.b[0], p.b[1], p.b[2], p.ra, p.rb);
                // Distance is signed; shift so that deep inside a part scores highest.
                const reach = Math.max(1e-4, this.blend * 2.2);
                const w = 1 / Math.pow(Math.max(1e-3, d + reach), 3);
                acc.set(p.bone, (acc.get(p.bone) || 0) + w);
            }

            // Keep the four strongest bones and normalise.
            const entries = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
            let total = 0;
            for (const e of entries) total += e[1];
            for (let i = 0; i < 4; i++) {
                const e = entries[i];
                out[i] = e ? e[0] : 0;
                out[4 + i] = e ? e[1] / total : 0;
            }
            return out;
        }
    }

    /* ------------------------------------------------------------------ *
     * Polygoniser
     * ------------------------------------------------------------------ */

    const EDGES = [
        [0, 1], [1, 3], [2, 3], [0, 2],
        [4, 5], [5, 7], [6, 7], [4, 6],
        [0, 4], [1, 5], [2, 6], [3, 7]
    ];
    /** Corner offsets, indexed so that bit 0 is +x, bit 1 is +z and bit 2 is +y. */
    const CORNER = [
        [0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1],
        [0, 1, 0], [1, 1, 0], [0, 1, 1], [1, 1, 1]
    ];

    /**
     * Polygonise a field into a `GeoBuilder`.
     *
     * Writes in field space and ignores the builder's transform stack: a field is
     * authored in mesh coordinates because that is where the rig's rest pose already
     * is, and there is nothing sensible to transform a scalar field by afterwards.
     *
     * @param {Safari.R3D.GeoBuilder} builder
     * @param {Field} field
     * @param {object} opts
     * @param {number} opts.cell Target cell size, in world units.
     * @param {function(number,number,number):THREE.Color} [opts.colorFn] Vertex colour,
     *   given the position in field space.
     * @param {boolean} [opts.skinned] Emit blended skin weights from the field.
     */
    function polygonise(builder, field, opts) {
        const cell = opts.cell;
        const lo = field.min;
        const hi = field.max;

        const nx = Math.max(2, Math.ceil((hi[0] - lo[0]) / cell));
        const ny = Math.max(2, Math.ceil((hi[1] - lo[1]) / cell));
        const nz = Math.max(2, Math.ceil((hi[2] - lo[2]) / cell));
        const sx = (hi[0] - lo[0]) / nx;
        const sy = (hi[1] - lo[1]) / ny;
        const sz = (hi[2] - lo[2]) / nz;

        /* --- Sample the field on the grid corners ------------------------ */
        const gw = nx + 1, gh = ny + 1, gd = nz + 1;
        const grid = new Float32Array(gw * gh * gd);
        const at = (i, j, k) => grid[(j * gd + k) * gw + i];

        for (let j = 0; j < gh; j++) {
            for (let k = 0; k < gd; k++) {
                for (let i = 0; i < gw; i++) {
                    grid[(j * gd + k) * gw + i] = field.sample(
                        lo[0] + i * sx, lo[1] + j * sy, lo[2] + k * sz);
                }
            }
        }

        /* --- One vertex per cell that the surface passes through --------- */
        const cellVert = new Int32Array(nx * ny * nz).fill(-1);
        const corner = new Array(8);
        const skin = opts.skinned ? new Array(8) : null;
        const grad = new THREE.Vector3();
        const eps = Math.min(sx, sy, sz) * 0.35;

        for (let j = 0; j < ny; j++) {
            for (let k = 0; k < nz; k++) {
                for (let i = 0; i < nx; i++) {
                    let neg = 0;
                    for (let c = 0; c < 8; c++) {
                        const o = CORNER[c];
                        const v = at(i + o[0], j + o[1], k + o[2]);
                        corner[c] = v;
                        if (v < 0) neg++;
                    }
                    if (neg === 0 || neg === 8) continue;

                    // Average the zero crossings on the cell's twelve edges.
                    let ax = 0, ay = 0, az = 0, n = 0;
                    for (let e = 0; e < 12; e++) {
                        const c0 = EDGES[e][0], c1 = EDGES[e][1];
                        const v0 = corner[c0], v1 = corner[c1];
                        if ((v0 < 0) === (v1 < 0)) continue;
                        const t = v0 / (v0 - v1);
                        const o0 = CORNER[c0], o1 = CORNER[c1];
                        ax += o0[0] + (o1[0] - o0[0]) * t;
                        ay += o0[1] + (o1[1] - o0[1]) * t;
                        az += o0[2] + (o1[2] - o0[2]) * t;
                        n++;
                    }
                    if (!n) continue;

                    const wx = lo[0] + (i + ax / n) * sx;
                    const wy = lo[1] + (j + ay / n) * sy;
                    const wz = lo[2] + (k + az / n) * sz;

                    // Normal from the gradient of the field: smooth whatever the grid.
                    grad.set(
                        field.sample(wx + eps, wy, wz) - field.sample(wx - eps, wy, wz),
                        field.sample(wx, wy + eps, wz) - field.sample(wx, wy - eps, wz),
                        field.sample(wx, wy, wz + eps) - field.sample(wx, wy, wz - eps));
                    if (grad.lengthSq() < 1e-12) grad.set(0, 1, 0);
                    grad.normalize();

                    // Indices are relative to the whole builder, not to this call: a
                    // creature adds its legs and ears through the ordinary primitive
                    // path either side of polygonising its trunk.
                    cellVert[(j * nz + k) * nx + i] = builder.pos.length / 3;

                    const c = opts.colorFn ? opts.colorFn(wx, wy, wz) : builder._color;
                    builder.pos.push(wx, wy, wz);
                    builder.nrm.push(grad.x, grad.y, grad.z);
                    builder.rgb.push(c.r, c.g, c.b);

                    if (builder.skinned) {
                        if (skin) {
                            field.weightsAt(wx, wy, wz, skin);
                            builder.si.push(skin[0], skin[1], skin[2], skin[3]);
                            builder.sw.push(skin[4], skin[5], skin[6], skin[7]);
                        } else {
                            builder.si.push(builder._bone, 0, 0, 0);
                            builder.sw.push(1, 0, 0, 0);
                        }
                    }
                }
            }
        }

        /* --- Quads between neighbouring cells ---------------------------- */
        const vAt = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz)
            ? -1 : cellVert[(j * nz + k) * nx + i];

        /**
         * Emit a quad, winding it to agree with the surface.
         *
         * Working the winding out from which end of the edge was inside is easy to get
         * subtly wrong per axis, and the failure mode is silent: half the faces are
         * culled and the animal comes out full of holes. The vertex normals are already
         * correct — they come from the gradient of the field, not from the triangles —
         * so the quad is simply turned to face the same way they do.
         */
        const pos = builder.pos;
        const nrm = builder.nrm;
        const quad = (a, b, c, d) => {
            if (a < 0 || b < 0 || c < 0 || d < 0) return;

            const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
            const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
            const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
            const facing =
                (uy * vz - uz * vy) * nrm[a * 3] +
                (uz * vx - ux * vz) * nrm[a * 3 + 1] +
                (ux * vy - uy * vx) * nrm[a * 3 + 2];

            if (facing >= 0) builder.idx.push(a, b, c, a, c, d);
            else builder.idx.push(a, c, b, a, d, c);
        };

        for (let j = 0; j < gh; j++) {
            for (let k = 0; k < gd; k++) {
                for (let i = 0; i < gw; i++) {
                    const v = at(i, j, k);
                    // Each grid edge with a sign change is shared by four cells, and
                    // those four cells' vertices form one quad of the surface.
                    if (i + 1 < gw && j > 0 && k > 0) {
                        const v2 = at(i + 1, j, k);
                        if ((v < 0) !== (v2 < 0)) {
                            quad(vAt(i, j - 1, k - 1), vAt(i, j - 1, k),
                                vAt(i, j, k), vAt(i, j, k - 1));
                        }
                    }
                    if (j + 1 < gh && i > 0 && k > 0) {
                        const v2 = at(i, j + 1, k);
                        if ((v < 0) !== (v2 < 0)) {
                            quad(vAt(i - 1, j, k - 1), vAt(i, j, k - 1),
                                vAt(i, j, k), vAt(i - 1, j, k));
                        }
                    }
                    if (k + 1 < gd && i > 0 && j > 0) {
                        const v2 = at(i, j, k + 1);
                        if ((v < 0) !== (v2 < 0)) {
                            quad(vAt(i - 1, j - 1, k), vAt(i, j - 1, k),
                                vAt(i, j, k), vAt(i - 1, j, k));
                        }
                    }
                }
            }
        }

        return builder;
    }

    Safari.Surface3D = { Field, polygonise, smin, sdEllipsoid, sdCapsule };

})(window.Safari, window.THREE);
