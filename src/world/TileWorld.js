/**
 * Safari Simulator — Tile world.
 *
 * The reserve as data: a square grid of tiles, each carrying an elevation and a blend
 * of ground substrates, generated from layered value noise. Nothing here draws — this
 * is the model the terrain renderer rasterises and the AI walks around on.
 *
 * The generation follows the approach proven in Iron Dominion: continuous fbm fields
 * sampled at sub-tile resolution, so substrate boundaries are organic curves rather
 * than visible tile edges, and an elevation field smoothed and terraced into benches
 * and scarps rather than a lumpy heightmap.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Noise, Rng, Config } = Safari;

    /**
     * Ground substrates. Each tile holds weights across these, which the renderer
     * blends per pixel; that is what makes the ground read as one continuous
     * landscape rather than a mosaic.
     * @enum {number}
     */
    const SUB = {
        GRASS: 0,
        DRY_GRASS: 1,
        DIRT: 2,
        SAND: 3,
        ROCK: 4,
        WATER: 5
    };

    /** Noise field resolution: samples per tile. Higher is smoother but slower. */
    const FIELD_RES = 4;

    /**
     * Grass regrowth, in units of tile fertility per simulated second.
     *
     * A grazed tile takes about an in-game day to come back, so the reserve has a real
     * carrying capacity: a herd exhausts its range and has to keep moving, and land it
     * stripped yesterday is worth returning to today. Faster than this and pasture stops
     * constraining anything — the herds simply grow until they hit the population
     * ceiling and sit there, which is not a game.
     */
    const GRAZE_REGROW = 1 / 210;

    /**
     * Stretch fbm output to fill 0..1.
     *
     * Averaged value noise clusters tightly around the middle of its range and almost
     * never reaches the extremes, so feeding it straight into a threshold wastes most
     * of the curve — the first version of this terrain peaked at a quarter of the
     * height it was configured for.
     */
    function _norm(v) {
        return MathUtils.clamp01((v - 0.26) / 0.48);
    }

    class TileWorld {
        /**
         * @param {number} size Width and height of the grid, in tiles.
         * @param {number} seed
         */
        constructor(size, seed) {
            this.size = size;
            this.seed = seed >>> 0;
            this.rng = new Rng(this.seed);

            const n = size * size;
            /** Elevation in levels; 0 is the base plain. */
            this.height = new Float32Array(n);
            /** Dominant substrate per tile, for gameplay queries. */
            this.substrate = new Uint8Array(n);
            /** Moisture 0..1, drives vegetation density and substrate. */
            this.moisture = new Float32Array(n);
            /** Water depth; 0 means dry land. */
            this.water = new Float32Array(n);
            /** Vegetation density 0..1, used when scattering props and grass. */
            this.fertility = new Float32Array(n);

            /**
             * Standing grass, 0..1 of what the tile's fertility can support.
             *
             * A reserve this size cannot be fed by scattered pickups: fourteen thousand
             * tiles against a hard cap of ninety forage items is one item per hundred
             * and fifty tiles, and a grazer that can see five tiles will starve beside a
             * full larder it never finds. So the ground itself is edible, which is also
             * what grazing actually is — the scattered forage is a treat the player
             * throws down, not the food supply.
             *
             * Regrowth is computed lazily from the timestamp rather than swept every
             * frame: only tiles an animal actually stands on are ever touched.
             */
            this.graze = new Float32Array(n);
            this.grazeStamp = new Float32Array(n);

            /**
             * Sub-tile noise fields, sampled bilinearly by the renderer so substrate
             * boundaries and shading are smooth across tile seams.
             */
            this.fieldW = size * FIELD_RES + 1;
            this.elevField = new Float32Array(this.fieldW * this.fieldW);
            this.moistField = new Float32Array(this.fieldW * this.fieldW);
            this.grainField = new Float32Array(this.fieldW * this.fieldW);
            /**
             * Pools get their own field rather than being derived from moisture.
             * Deriving them from moisture alone floods every damp region on the flat
             * plain; a separate higher-frequency field gives scattered waterholes of a
             * believable size.
             */
            this.poolField = new Float32Array(this.fieldW * this.fieldW);

            this.maxHeight = 0;

            /**
             * Set by the events system during a drought: a multiplier on grass regrowth
             * and a depth subtracted from every pool. Kept here rather than in the
             * event so that everything already asking the world about grass or water
             * sees the drought without being told about it.
             */
            this.regrowthScale = 1;
            this.drawdown = 0;
        }

        index(tx, ty) {
            return ty * this.size + tx;
        }

        inBounds(tx, ty) {
            return tx >= 0 && ty >= 0 && tx < this.size && ty < this.size;
        }

        /* -------------------------------------------------------------- *
         * Generation
         * -------------------------------------------------------------- */

        generate(seed) {
            if (seed !== undefined) {
                this.seed = seed >>> 0;
                this.rng = new Rng(this.seed);
            }
            const s = this.size;
            const o = this.seed % 1000;

            /* --- Continuous fields ------------------------------------- */
            // Two independent low-frequency fields: relief and moisture. Keeping them
            // uncorrelated is what produces dry uplands next to lush hollows rather
            // than everything varying together.
            const F = this.fieldW;
            for (let fy = 0; fy < F; fy++) {
                for (let fx = 0; fx < F; fx++) {
                    const wx = fx / FIELD_RES;
                    const wy = fy / FIELD_RES;
                    const i = fy * F + fx;

                    /*
                      * Frequencies are chosen so features span a legible number of
                      * tiles: roughly 18 tiles for a ridge, 26 for a moisture belt,
                      * 2 for surface mottling. Too low and the whole reserve is one
                      * smooth gradient; too high and it turns to noise.
                      */
                    this.elevField[i] = _norm(Noise.fbm2(wx * 0.055 + o, wy * 0.055 + o, 5, 2.1, 0.52));
                    this.moistField[i] = _norm(Noise.fbm2(wx * 0.038 + o + 71, wy * 0.038 + o + 33, 4, 2.0, 0.5));
                    this.grainField[i] = Noise.fbm2(wx * 2.4 + o + 11, wy * 2.4 + o + 91, 3, 2.3, 0.55);
                    this.poolField[i] = _norm(Noise.fbm2(wx * 0.085 + o + 211, wy * 0.085 + o + 157, 4, 2.2, 0.5));
                }
            }

            /* --- Shape the relief -------------------------------------- */
            // Push the field through a curve so most of the reserve is walkable plain
            // with occasional rises, rather than uniform rolling hills.
            const RELIEF = Config.terrain.relief;
            for (let i = 0; i < this.elevField.length; i++) {
                let e = this.elevField[i];
                // Below the plain threshold everything flattens to zero.
                e = MathUtils.smoothstep(RELIEF.plainLevel, 1.0, e);
                // Terrace into benches so slopes read as escarpments, not ramps.
                e = this._terrace(e, RELIEF.benches);
                this.elevField[i] = e * RELIEF.maxHeight;
            }

            // Soften the field so tile-to-tile steps are gradual.
            this._blurField(this.elevField, F, 1);

            /* --- Per-tile properties ----------------------------------- */
            this.maxHeight = 0;
            for (let ty = 0; ty < s; ty++) {
                for (let tx = 0; tx < s; tx++) {
                    const k = this.index(tx, ty);
                    const h = this._sampleField(this.elevField, tx + 0.5, ty + 0.5);
                    const m = this._sampleField(this.moistField, tx + 0.5, ty + 0.5);

                    // Taper the world edge down to the plain so the map has a natural
                    // boundary instead of cliffs sliced off mid-face.
                    const edge = this._edgeFalloff(tx, ty);
                    const height = h * edge;

                    this.height[k] = height;
                    this.moisture[k] = m;
                    if (height > this.maxHeight) this.maxHeight = height;

                    /*
                     * Pools form where the pool field peaks, and only on low ground.
                     * The mask is what keeps water off the benches — a pond perched on
                     * a plateau reads as a bug even when the maths allows it.
                     */
                    this.water[k] = this.waterAt(tx + 0.5, ty + 0.5);

                    this.substrate[k] = this._classify(height, m, this.water[k]);

                    // Vegetation follows moisture, thinning on rock and high ground.
                    this.fertility[k] = MathUtils.clamp01(
                        m * 1.35 - height * 0.30 - (this.water[k] > 0 ? 1 : 0)
                    );
                }
            }

            return this;
        }

        /** Which substrate dominates, given relief, moisture and standing water. */
        _classify(height, moisture, water) {
            if (water > 0) return SUB.WATER;
            if (height > Config.terrain.relief.rockLevel * Config.terrain.relief.maxHeight) {
                return SUB.ROCK;
            }
            if (moisture < 0.34) return SUB.SAND;
            if (moisture < 0.46) return SUB.DIRT;
            if (moisture < 0.60) return SUB.DRY_GRASS;
            return SUB.GRASS;
        }

        /**
         * Terrace a 0..1 value into `n` benches joined by steep risers, which is what
         * turns a smooth heightfield into readable stepped ground.
         */
        _terrace(v, benches) {
            if (v <= 0) return 0;
            const u = v * benches;
            const step = Math.floor(u);
            const f = u - step;
            // Most of a bench is flat; the last third climbs sharply to the next.
            const shaped = f < 0.68 ? f * 0.18 : 0.12 + (f - 0.68) / 0.32 * 0.88;
            return (step + shaped) / benches;
        }

        /** Fade elevation to zero near the map edge. */
        _edgeFalloff(tx, ty) {
            const s = this.size;
            const margin = s * 0.10;
            const d = Math.min(tx, ty, s - 1 - tx, s - 1 - ty);
            return MathUtils.smoothstep(0, margin, d);
        }

        /** Separable box blur over a square field, `passes` times. */
        _blurField(field, width, passes) {
            const tmp = new Float32Array(field.length);
            const R = 1;
            const span = 2 * R + 1;
            for (let p = 0; p < passes; p++) {
                for (let y = 0; y < width; y++) {
                    for (let x = 0; x < width; x++) {
                        let acc = 0;
                        for (let k = -R; k <= R; k++) {
                            acc += field[y * width + MathUtils.clamp(x + k, 0, width - 1)];
                        }
                        tmp[y * width + x] = acc / span;
                    }
                }
                for (let x = 0; x < width; x++) {
                    for (let y = 0; y < width; y++) {
                        let acc = 0;
                        for (let k = -R; k <= R; k++) {
                            acc += tmp[MathUtils.clamp(y + k, 0, width - 1) * width + x];
                        }
                        field[y * width + x] = acc / span;
                    }
                }
            }
        }

        /**
         * Bilinear sample of a sub-tile field at continuous tile coordinates.
         * @param {Float32Array} field
         */
        _sampleField(field, tx, ty) {
            const F = this.fieldW;
            const x = MathUtils.clamp(tx * FIELD_RES, 0, F - 1.001);
            const y = MathUtils.clamp(ty * FIELD_RES, 0, F - 1.001);
            const xi = x | 0, yi = y | 0;
            const xf = x - xi, yf = y - yi;
            const i = yi * F + xi;
            const a = field[i], b = field[i + 1];
            const c = field[i + F], d = field[i + F + 1];
            return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
        }

        /* -------------------------------------------------------------- *
         * Queries
         * -------------------------------------------------------------- */

        /** Smooth elevation at continuous tile coordinates. */
        heightAt(tx, ty) {
            if (!this.inBounds(tx | 0, ty | 0)) return 0;
            return this._sampleField(this.elevField, tx, ty) *
                this._edgeFalloff(tx | 0, ty | 0);
        }

        /** Moisture at continuous tile coordinates. */
        moistureAt(tx, ty) {
            return this._sampleField(this.moistField, tx, ty);
        }

        /** Fine grain noise, for speckle and texture. */
        grainAt(tx, ty) {
            return this._sampleField(this.grainField, tx, ty);
        }

        /** Is this point standing water? */
        isWater(tx, ty) {
            const x = tx | 0, y = ty | 0;
            if (!this.inBounds(x, y)) return false;
            return this.water[this.index(x, y)] > 0;
        }

        /**
         * Water depth 0..1 at a point, sampled continuously.
         *
         * The per-tile `water` array is for gameplay queries; drawing from it produced
         * hard diamond shorelines, because the renderer works per pixel and every pixel
         * in a tile got that tile's single value. This resamples the underlying fields
         * instead, so the water's edge is a smooth curve.
         */
        /**
         * Water depth at a point.
         *
         * `drawdown` is set by a drought and subtracted here rather than being written
         * into the water field, so the pools shrink and refill without the terrain
         * having to be regenerated — and every query that already asks about water,
         * from a thirsty zebra to the fire's fuel test, sees the drought for free.
         */
        waterAt(tx, ty) {
            if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return 0;
            const WATER = Config.terrain.water;
            const pool = this._sampleField(this.poolField, tx, ty);
            const height = this.heightAt(tx, ty);
            const lowGround = 1 - MathUtils.smoothstep(0.15, 0.9, height);
            let depth = MathUtils.smoothstep(
                WATER.level, WATER.level + WATER.depthScale, pool) * lowGround;
            if (this.drawdown) depth -= this.drawdown;
            return depth > 0.02 ? depth : 0;
        }

        /** Per-tile water depth, for gameplay queries. */
        waterTile(tx, ty) {
            const x = tx | 0, y = ty | 0;
            if (!this.inBounds(x, y)) return 0;
            return this.water[this.index(x, y)];
        }

        /** Dominant substrate at a point. */
        substrateAt(tx, ty) {
            const x = tx | 0, y = ty | 0;
            if (!this.inBounds(x, y)) return SUB.GRASS;
            return this.substrate[this.index(x, y)];
        }

        /** Vegetation density at a point. */
        fertilityAt(tx, ty) {
            const x = tx | 0, y = ty | 0;
            if (!this.inBounds(x, y)) return 0;
            return this.fertility[this.index(x, y)];
        }

        /* -------------------------------------------------------------- *
         * Obstructions
         * -------------------------------------------------------------- */

        /**
         * Mark a circle of ground as built on and therefore impassable.
         *
         * The reserve's only structure is the ranger station, and until now nothing had
         * told the world it was there — herds walked straight through the hut. Blocked
         * ground lives with the terrain rather than with the building, so every mover
         * already consults it through `isWalkable`, and anything built later gets the
         * same treatment for free.
         */
        block(tx, ty, radius) {
            if (!this.blocked) this.blocked = new Uint8Array(this.size * this.size);
            const r = Math.ceil(radius);
            for (let y = (ty | 0) - r; y <= (ty | 0) + r; y++) {
                for (let x = (tx | 0) - r; x <= (tx | 0) + r; x++) {
                    if (!this.inBounds(x, y)) continue;
                    if (Math.hypot(x + 0.5 - tx, y + 0.5 - ty) > radius) continue;
                    this.blocked[this.index(x, y)] = 1;
                }
            }
        }

        /** Is this tile built on? */
        isBlocked(tx, ty) {
            if (!this.blocked) return false;
            const x = tx | 0, y = ty | 0;
            if (!this.inBounds(x, y)) return false;
            return this.blocked[this.index(x, y)] === 1;
        }

        /**
         * Nearest dry ground.
         *
         * The escape hatch for a water-dweller that has run out of options: a hippo in
         * the middle of a lake with no pasture within sight has nothing to steer toward,
         * and water is walkable to it, so wandering at random keeps it in the lake. This
         * at least gets it ashore, where ordinary foraging can take over.
         */
        findLandNear(tx, ty, radius) {
            let best = null;
            let bestDist = radius;
            const r = Math.ceil(radius);
            const x0 = MathUtils.clamp((tx | 0) - r, 1, this.size - 2);
            const x1 = MathUtils.clamp((tx | 0) + r, 1, this.size - 2);
            const y0 = MathUtils.clamp((ty | 0) - r, 1, this.size - 2);
            const y1 = MathUtils.clamp((ty | 0) + r, 1, this.size - 2);

            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    if (this.water[this.index(x, y)] > 0.02) continue;
                    if (!this.isWalkable(x, y)) continue;
                    const d = Math.hypot(x + 0.5 - tx, y + 0.5 - ty);
                    if (d < bestDist) {
                        bestDist = d;
                        best = { x: x + 0.5, y: y + 0.5 };
                    }
                }
            }
            return best;
        }

        /**
         * Nearest open water at least `minDepth` deep.
         *
         * The companion to `findWaterNear`, which deliberately returns the bank because
         * that is where a land animal stands to drink. A hippo or a crocodile wants the
         * opposite: the water itself, and deep enough to lie in.
         */
        findWaterDeep(tx, ty, radius, minDepth, minDist) {
            let best = null;
            let bestDist = radius;
            const need = minDepth === undefined ? 0.3 : minDepth;
            // A floor on the distance lets a caller ask for *a different* pool from the
            // one it is standing in, which is what dispersal needs.
            const floor = minDist || 0;
            const r = Math.ceil(radius);
            const x0 = MathUtils.clamp((tx | 0) - r, 0, this.size - 1);
            const x1 = MathUtils.clamp((tx | 0) + r, 0, this.size - 1);
            const y0 = MathUtils.clamp((ty | 0) - r, 0, this.size - 1);
            const y1 = MathUtils.clamp((ty | 0) + r, 0, this.size - 1);

            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    if (this.water[this.index(x, y)] < need) continue;
                    const d = Math.hypot(x + 0.5 - tx, y + 0.5 - ty);
                    if (d < floor) continue;
                    if (d < bestDist) {
                        bestDist = d;
                        best = { x: x + 0.5, y: y + 0.5 };
                    }
                }
            }
            return best;
        }

        /* -------------------------------------------------------------- *
         * Grazing
         * -------------------------------------------------------------- */

        /**
         * How much grass a tile is carrying right now, 0..1 of its fertility.
         *
         * @param {number} now Simulated seconds since the reserve was generated.
         */
        grazeAt(tx, ty, now) {
            const x = tx | 0, y = ty | 0;
            if (!this.inBounds(x, y)) return 0;
            const k = this.index(x, y);
            const fert = this.fertility[k];
            if (fert <= 0.02) return 0;

            // Untouched tiles start full; a stamp of zero means never grazed.
            const stamp = this.grazeStamp[k];
            if (stamp === 0) return fert;

            const grown = this.graze[k] +
                (now - stamp) * GRAZE_REGROW * (this.regrowthScale === undefined
                    ? 1 : this.regrowthScale);
            return Math.min(fert, Math.max(0, grown));
        }

        /**
         * Take grass from a tile.
         * @returns {number} How much was actually available and eaten.
         */
        consumeGraze(tx, ty, amount, now) {
            const x = tx | 0, y = ty | 0;
            if (!this.inBounds(x, y)) return 0;
            const k = this.index(x, y);

            const have = this.grazeAt(x, y, now);
            const taken = Math.min(have, amount);
            this.graze[k] = have - taken;
            this.grazeStamp[k] = now;
            return taken;
        }

        /**
         * Steepness at a point, 0 (flat) upward. Animals avoid climbing scarps, so the
         * AI uses this to steer rather than walking up a cliff face.
         */
        slopeAt(tx, ty) {
            const d = 0.6;
            const ex = this.heightAt(tx + d, ty) - this.heightAt(tx - d, ty);
            const ey = this.heightAt(tx, ty + d) - this.heightAt(tx, ty - d);
            return Math.hypot(ex, ey);
        }

        /** Can a land animal stand here? */
        isWalkable(tx, ty) {
            const x = tx | 0, y = ty | 0;
            if (!this.inBounds(x, y)) return false;
            if (this.blocked && this.blocked[this.index(x, y)]) return false;
            if (this.water[this.index(x, y)] > Config.terrain.water.wadeDepth) return false;
            return this.slopeAt(tx, ty) < Config.terrain.maxWalkableSlope;
        }

        /**
         * Find a walkable tile near a preferred point, spiralling outward.
         * @returns {{x:number,y:number}|null}
         */
        findWalkableNear(tx, ty, maxRadius) {
            if (this.isWalkable(tx, ty)) return { x: tx, y: ty };
            const limit = maxRadius || 12;
            for (let r = 1; r <= limit; r++) {
                for (let i = 0; i < r * 8; i++) {
                    const a = (i / (r * 8)) * MathUtils.TAU;
                    const nx = tx + Math.cos(a) * r;
                    const ny = ty + Math.sin(a) * r;
                    if (this.isWalkable(nx, ny)) return { x: nx, y: ny };
                }
            }
            return null;
        }

        /** Nearest standing water within a radius, for drinking. */
        findWaterNear(tx, ty, radius) {
            let best = null;
            let bestDist = radius;
            const r = Math.ceil(radius);
            const x0 = MathUtils.clamp((tx | 0) - r, 0, this.size - 1);
            const x1 = MathUtils.clamp((tx | 0) + r, 0, this.size - 1);
            const y0 = MathUtils.clamp((ty | 0) - r, 0, this.size - 1);
            const y1 = MathUtils.clamp((ty | 0) + r, 0, this.size - 1);

            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    if (this.water[this.index(x, y)] <= 0) continue;

                    /*
                     * Return the bank, not the water.
                     *
                     * Returning the water tile itself sent thirsty animals walking at
                     * the middle of a lake, where they could not stand: they stalled a
                     * couple of tiles short, never got close enough to count as
                     * drinking, and looped on the shoreline until they starved. What an
                     * animal actually wants is somewhere to stand with water in front
                     * of it, so that is what this returns.
                     */
                    for (let i = 0; i < 4; i++) {
                        const nx = x + (i === 0 ? 1 : i === 1 ? -1 : 0);
                        const ny = y + (i === 2 ? 1 : i === 3 ? -1 : 0);
                        if (!this.isWalkable(nx, ny)) continue;
                        const d = Math.hypot(nx + 0.5 - tx, ny + 0.5 - ty);
                        if (d < bestDist) {
                            bestDist = d;
                            best = { x: nx + 0.5, y: ny + 0.5 };
                        }
                    }
                }
            }
            return best;
        }
    }

    TileWorld.SUB = SUB;
    TileWorld.FIELD_RES = FIELD_RES;
    Safari.TileWorld = TileWorld;

})(window.Safari);
