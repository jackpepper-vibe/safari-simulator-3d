/**
 * Safari Simulator 3D — Relief.
 *
 * The drawn shape of the ground, computed once per reserve and sampled by everything
 * that stands on it.
 *
 * The simulation's elevation field knows nothing about water beyond "this tile is wet,
 * this deep". Drawing that directly — carving each wet point down by its depth and
 * floating a sheet over the result — is what produced the reserve's worst artefacts:
 * a pool lying across a slope has no single level, so the sheet was either tilted,
 * or flat and hanging in mid-air over the low side of its own basin, and its edge ran
 * along tile boundaries in straight lines.
 *
 * Here every pool is found, given one water level, and the ground under and around it
 * is **shaped to hold that level**: cut down into a bed wherever the pool lies, and
 * lifted into a low bank wherever the ground falls away below the waterline. The water
 * surface then only has to be drawn where the shaped ground is below it, which gives an
 * exact, curved shoreline with no special cases.
 *
 * Nothing in the simulation reads this. Animals, vehicles and trees *stand* on it —
 * through `R3D.surfaceY` — which is what puts a hippo's belly under the waterline and a
 * zebra's hooves on the bank.
 */
(function (Safari) {
    'use strict';

    const { MathUtils } = Safari;

    /** Samples per tile. The terrain mesh uses the same grid, vertex for vertex. */
    const RES = 3;

    /** Height of the bank lip above the waterline, in world units. */
    const BANK_LIP = 0.05;
    /** The bed sits at least this far under the level, so no pool is a film. */
    const MIN_DEPTH = 0.05;

    const _cache = new WeakMap();

    class Relief3D {
        /**
         * The relief for a world, built on first use.
         * @param {Safari.TileWorld} world
         * @returns {Relief3D}
         */
        static of(world) {
            let r = _cache.get(world);
            if (!r) {
                r = new Relief3D(world);
                _cache.set(world, r);
            }
            return r;
        }

        /** @param {Safari.TileWorld} world */
        constructor(world) {
            const R3D = Safari.R3D;
            this.world = world;
            this.size = world.size;
            this.verts = world.size * RES + 1;

            const V = this.verts;
            const n = this.size;
            const step = 1 / RES;

            /*
             * Everything here is shaped against the pools at their full extent. A drought
             * lowers the *water*, not the ground, so the basin is carved once from the
             * undrawn field and the receding shoreline falls out of the level dropping.
             */
            const drawdown = world.drawdown;
            world.drawdown = 0;

            /** Ground before any shaping, and how strongly each point is pool. */
            const ground = new Float32Array(V * V);
            const carve = new Float32Array(V * V);
            for (let j = 0; j < V; j++) {
                for (let i = 0; i < V; i++) {
                    const k = j * V + i;
                    ground[k] = R3D.groundY(world, i * step, j * step);
                    carve[k] = R3D.waterCarve(world, i * step, j * step);
                }
            }

            this._findPools(carve);
            this.surface = this._shape(ground, carve);

            world.drawdown = drawdown;
            void n;
        }

        /* -------------------------------------------------------------- *
         * Pools
         * -------------------------------------------------------------- */

        /**
         * Flood-fill the wet tiles into pools and give each one level.
         *
         * The level is the **spill height**: a low percentile of the ground around the
         * pool's rim, the dry tiles just outside it. Water can stand no higher than the
         * lowest gap in its bank, and filling to that makes the rule hold everywhere by
         * construction — on a flat plain the pool is brim-full; on a slope the water
         * lies in the lower part of its basin, the upper part is a bare bed, and nothing
         * spills over the plain as a film. The carve-weighted mean of the ground under
         * the pool, tried first, sat above the rim on every sloping pool and flooded
         * the flat ground around it in thin tile-edged sheets.
         */
        _findPools(carve) {
            const R3D = Safari.R3D;
            const world = this.world;
            const n = this.size;
            const V = this.verts;

            this.tilePool = new Int32Array(n * n).fill(-1);
            this.levels = [];
            const stack = [];

            const wetTile = (tx, ty) => {
                const k = (ty * RES + (RES >> 1)) * V + tx * RES + (RES >> 1);
                return carve[k] > 0.01;
            };

            for (let ty = 0; ty < n; ty++) {
                for (let tx = 0; tx < n; tx++) {
                    const t = ty * n + tx;
                    if (this.tilePool[t] >= 0 || !wetTile(tx, ty)) continue;

                    const id = this.levels.length;
                    let sum = 0, weight = 0;
                    const rim = [];
                    const rimSeen = new Set();
                    stack.length = 0;
                    stack.push(t);
                    this.tilePool[t] = id;

                    while (stack.length) {
                        const c = stack.pop();
                        const cx = c % n, cy = (c / n) | 0;
                        const w = R3D.waterCarve(world, cx + 0.5, cy + 0.5);
                        sum += R3D.groundY(world, cx + 0.5, cy + 0.5) * w;
                        weight += w;

                        for (let d = 0; d < 4; d++) {
                            const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
                            const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
                            if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
                            const nk = ny * n + nx;
                            if (this.tilePool[nk] >= 0) continue;
                            if (!wetTile(nx, ny)) {
                                if (!rimSeen.has(nk)) {
                                    rimSeen.add(nk);
                                    rim.push(R3D.groundY(world, nx + 0.5, ny + 0.5));
                                }
                                continue;
                            }
                            this.tilePool[nk] = id;
                            stack.push(nk);
                        }
                    }

                    let level = weight > 0 ? sum / weight : 0;
                    if (rim.length) {
                        // A low percentile rather than the minimum, so one notch in the
                        // bank does not drain the whole pool.
                        rim.sort((a, b) => a - b);
                        level = rim[Math.floor((rim.length - 1) * 0.12)];
                    }
                    this.levels.push(level);
                }
            }

            /*
             * Which pool each grid point answers to: the pool its own tile belongs to,
             * or failing that the nearest one within three tiles — past the reach of
             * the bank's blur — so the bank around a pool is shaped to *that* pool's
             * level and fades out before the search gives up.
             */
            this.pointPool = new Int32Array(V * V).fill(-1);
            for (let j = 0; j < V; j++) {
                for (let i = 0; i < V; i++) {
                    const x = i / RES, z = j / RES;
                    const tx = Math.min(n - 1, Math.floor(x));
                    const tz = Math.min(n - 1, Math.floor(z));
                    let best = this.tilePool[tz * n + tx];
                    if (best < 0) {
                        let bestD = Infinity;
                        for (let dz = -3; dz <= 3; dz++) {
                            for (let dx = -3; dx <= 3; dx++) {
                                const qx = tx + dx, qz = tz + dz;
                                if (qx < 0 || qz < 0 || qx >= n || qz >= n) continue;
                                const p = this.tilePool[qz * n + qx];
                                if (p < 0) continue;
                                const d = Math.hypot(qx + 0.5 - x, qz + 0.5 - z);
                                if (d < bestD) { bestD = d; best = p; }
                            }
                        }
                    }
                    this.pointPool[j * V + i] = best;
                }
            }
        }

        /* -------------------------------------------------------------- *
         * Shaping
         * -------------------------------------------------------------- */

        /**
         * Cut each pool's bed and raise its bank.
         *
         * `bank` is a blurred mask of the pool's footprint, so the lift toward the lip
         * is widest right at the water and fades out over a couple of tiles: a pool on a
         * slope sits behind a low natural levee rather than a wall.
         */
        _shape(ground, carve) {
            const R3D = Safari.R3D;
            const V = this.verts;
            const out = new Float32Array(V * V);

            const mask = new Float32Array(V * V);
            for (let k = 0; k < mask.length; k++) mask[k] = carve[k] > 0.004 ? 1 : 0;
            const bank = blur(mask, V, 4, 2);

            for (let k = 0; k < out.length; k++) {
                let s = ground[k];
                const pool = this.pointPool[k];
                if (pool >= 0) {
                    const level = this.levels[pool];
                    const lift = MathUtils.smoothstep(0, 0.6, bank[k]);
                    s = MathUtils.lerp(s, Math.max(s, level + BANK_LIP), lift);

                    const w = MathUtils.smoothstep(0, 0.3, carve[k]);
                    const bed = level - MIN_DEPTH - carve[k] * R3D.WATER_DEPTH * 1.1;
                    s = MathUtils.lerp(s, Math.min(s, bed), w);
                }
                out[k] = s;
            }
            return out;
        }

        /* -------------------------------------------------------------- *
         * Queries
         * -------------------------------------------------------------- */

        /** Shaped ground height at continuous tile coordinates, in world units. */
        heightAt(tx, ty) {
            const V = this.verts;
            const x = MathUtils.clamp(tx * RES, 0, V - 1.0001);
            const y = MathUtils.clamp(ty * RES, 0, V - 1.0001);
            const xi = x | 0, yi = y | 0;
            const xf = x - xi, yf = y - yi;
            const i = yi * V + xi;
            const s = this.surface;
            const a = s[i], b = s[i + 1], c = s[i + V], d = s[i + V + 1];
            return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
        }

        /** Grid-point height, for the mesh builders. */
        at(i, j) {
            return this.surface[j * this.verts + i];
        }

        /** Pool index a grid point belongs to, or −1. */
        poolAt(i, j) {
            return this.pointPool[j * this.verts + i];
        }

        /**
         * A pool's current water level.
         *
         * A drought lowers every pool by the same share of its depth, so the shoreline
         * recedes down the shaped bank rather than the water vanishing.
         */
        levelOf(pool) {
            const R3D = Safari.R3D;
            return this.levels[pool] - (this.world.drawdown || 0) * R3D.WATER_DEPTH * 1.1;
        }

        /** Depth of standing water at a grid point, or 0 on dry ground. */
        depthAt(i, j) {
            const pool = this.poolAt(i, j);
            if (pool < 0) return 0;
            return Math.max(0, this.levelOf(pool) - this.at(i, j));
        }
    }

    /** Separable box blur, `passes` times, radius `r` samples. */
    function blur(src, width, r, passes) {
        let a = Float32Array.from(src);
        const b = new Float32Array(src.length);
        const span = 2 * r + 1;
        for (let p = 0; p < passes; p++) {
            for (let y = 0; y < width; y++) {
                for (let x = 0; x < width; x++) {
                    let acc = 0;
                    for (let k = -r; k <= r; k++) {
                        acc += a[y * width + MathUtils.clamp(x + k, 0, width - 1)];
                    }
                    b[y * width + x] = acc / span;
                }
            }
            for (let x = 0; x < width; x++) {
                for (let y = 0; y < width; y++) {
                    let acc = 0;
                    for (let k = -r; k <= r; k++) {
                        acc += b[MathUtils.clamp(y + k, 0, width - 1) * width + x];
                    }
                    a[y * width + x] = acc / span;
                }
            }
        }
        return a;
    }

    Relief3D.RES = RES;
    Safari.Relief3D = Relief3D;

})(window.Safari);
