/**
 * Safari Simulator 3D — Standing vegetation.
 *
 * The acacias, scrub, boulders and termite mounds scattered across the reserve, and the
 * foliage the tall browsers feed on.
 *
 * In the 2D build this scatter lived in the renderer, because trees were scenery: they
 * were something to walk behind, and nothing in the simulation knew they existed. They
 * are a food supply now — a giraffe browses the crown of an acacia and an elephant
 * strips its lower branches — so the scatter belongs to the world rather than to the
 * thing that draws it, and the renderer reads this list rather than owning one.
 *
 * The placement rule is carried over unchanged: rejection sampling against the same
 * fertility field from the same seeded generator, so a given seed still grows its trees
 * in the same places as the 2D reserve.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Rng, Config, TileWorld } = Safari;
    const SUB = TileWorld.SUB;

    /** Prop kinds. */
    const PROP = { ACACIA: 0, BUSH: 1, ROCK: 2, MOUND: 3 };

    /**
     * Foliage regrowth, in canopy-fractions per simulated second.
     *
     * A stripped acacia takes about two in-game days to come back — an order slower
     * than grass, because a tree that regrew at pasture speed would make browsing a
     * free lunch and the herds would never leave the woodland.
     */
    const BROWSE_REGROW = 1 / 420;

    /**
     * How far a browser can reach into a canopy, in tiles, on top of its own radius.
     * Generous: an animal standing at the edge of a crown is browsing it.
     */
    const BROWSE_REACH = 1.6;

    class Vegetation {
        /**
         * @param {Safari.TileWorld} world
         * @param {number} seed
         */
        constructor(world, seed) {
            this.world = world;
            this.props = [];
            /** Acacias only, which is the list every browse query walks. */
            this.trees = [];
            this._scatter(seed);
        }

        _scatter(seed) {
            const world = this.world;
            const rng = new Rng((seed || 1) ^ 0x9E37);
            const n = world.size;
            const attempts = Math.floor(n * n * Config.terrain.propDensity);

            for (let i = 0; i < attempts; i++) {
                const tx = rng.range(1, n - 1);
                const ty = rng.range(1, n - 1);
                if (world.waterAt(tx, ty) > 0) continue;

                const fert = world.fertilityAt(tx, ty);
                const slope = world.slopeAt(tx, ty);
                const sub = world.substrateAt(tx, ty);
                const roll = rng.next();

                let type = -1;
                if (sub === SUB.ROCK || slope > 0.5) {
                    if (roll < 0.55) type = PROP.ROCK;
                    else if (roll < 0.72) type = PROP.BUSH;
                } else if (fert > 0.55) {
                    if (roll < 0.11) type = PROP.ACACIA;
                    else if (roll < 0.62) type = PROP.BUSH;
                    else if (roll < 0.70) type = PROP.ROCK;
                } else if (fert > 0.28) {
                    if (roll < 0.04) type = PROP.ACACIA;
                    else if (roll < 0.34) type = PROP.BUSH;
                    else if (roll < 0.44) type = PROP.ROCK;
                    else if (roll < 0.50) type = PROP.MOUND;
                } else {
                    if (roll < 0.10) type = PROP.ROCK;
                    else if (roll < 0.17) type = PROP.MOUND;
                    else if (roll < 0.22) type = PROP.BUSH;
                }
                if (type < 0) continue;

                const prop = {
                    type,
                    x: tx,
                    y: ty,
                    variant: rng.int(0, 2),
                    yaw: rng.range(0, MathUtils.TAU),
                    scale: rng.range(0.8, 1.25)
                };

                if (type === PROP.ACACIA) {
                    /**
                     * Foliage, as a fraction of the crown.
                     *
                     * Held the way standing grass is: a value and the moment it was
                     * last touched, with regrowth computed lazily from the timestamp.
                     * Only trees an animal actually browses are ever written to, so a
                     * reserve full of untouched woodland costs nothing to keep.
                     */
                    prop.browse = 1;
                    prop.browseStamp = 0;
                    /** Crown height in tiles, for the reach test and for the pose. */
                    prop.crown = 1.55 * prop.scale;
                    this.trees.push(prop);
                }

                this.props.push(prop);
            }
        }

        /* -------------------------------------------------------------- *
         * Browsing
         * -------------------------------------------------------------- */

        /**
         * Foliage remaining on a tree, 0..1.
         * @param {number} now Simulated seconds.
         */
        foliageAt(tree, now) {
            if (tree.browseStamp === 0) return tree.browse;
            const scale = this.world.regrowthScale === undefined ? 1 : this.world.regrowthScale;
            return MathUtils.clamp01(
                tree.browse + (now - tree.browseStamp) * BROWSE_REGROW * scale);
        }

        /**
         * Take foliage from a tree.
         * @returns {number} How much was actually there and eaten.
         */
        consumeBrowse(tree, amount, now) {
            const have = this.foliageAt(tree, now);
            const taken = Math.min(have, amount);
            tree.browse = have - taken;
            tree.browseStamp = now;
            return taken;
        }

        /**
         * The nearest acacia still carrying foliage.
         *
         * A linear scan over the trees. There are a few dozen of them in a reserve —
         * they are landmarks, not a canopy — so a grid would cost more to maintain than
         * it saves.
         *
         * @param {number} minFoliage Ignore trees stripped below this.
         * @returns {object|null}
         */
        nearestTree(tx, ty, radius, now, minFoliage) {
            const need = minFoliage === undefined ? 0.12 : minFoliage;
            let best = null;
            let bestDist = radius;
            for (let i = 0; i < this.trees.length; i++) {
                const t = this.trees[i];
                const d = Math.hypot(t.x - tx, t.y - ty);
                if (d >= bestDist) continue;
                if (this.foliageAt(t, now) < need) continue;
                bestDist = d;
                best = t;
            }
            return best;
        }

        /** Is this animal close enough to feed from this tree? */
        inReach(tree, x, y, radius) {
            return Math.hypot(tree.x - x, tree.y - y) <=
                BROWSE_REACH + radius + tree.scale * 0.8;
        }

        /**
         * Burn a tree out.
         *
         * A fire takes the standing grass with it; the crowns in its path should go the
         * same way, or a burnt scar stays full of untouched browse.
         */
        scorch(tx, ty, radius, now) {
            for (let i = 0; i < this.trees.length; i++) {
                const t = this.trees[i];
                if (Math.hypot(t.x - tx, t.y - ty) > radius) continue;
                t.browse = 0;
                t.browseStamp = now;
            }
        }
    }

    Vegetation.PROP = PROP;
    Vegetation.BROWSE_REACH = BROWSE_REACH;
    Vegetation.BROWSE_REGROW = BROWSE_REGROW;
    Safari.Vegetation = Vegetation;

})(window.Safari);
