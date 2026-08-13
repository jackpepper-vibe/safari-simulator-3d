/**
 * Safari Simulator — The warden's brief.
 *
 * What the player is actually being asked to do, in one place: hold the reserve for a
 * fixed tenure and leave it in a particular state. Everything else — the ecology, the
 * ranger, the droughts — is the means.
 *
 * The same evaluation drives the objectives panel during play and the report at the
 * end, so what the player is watching tick over is exactly what they will be judged
 * on. Keeping those apart would be the easiest way to make the ending feel unfair.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, IsoSpecies } = Safari;

    /**
     * The objectives, in the order they are shown.
     *
     * Each knows how to read the reserve, so adding one is a single entry rather than
     * an edit in three files.
     *
     * `weight` is its share of the final grade. Survival is worth the most because
     * everything else is moot without it, and the two the player has direct agency over
     * — relocation and poaching — are weighted above the ones the ecology largely does
     * on its own.
     */
    const OBJECTIVES = [
        {
            id: 'tenure',
            weight: 0.28,
            label: (g) => 'Hold the reserve for ' + g.tenureDays + ' days',
            read: (s, g) => ({ have: Math.min(s.days, g.tenureDays), need: g.tenureDays }),
            detail: (v, g) => 'Day ' + v.have + ' of ' + g.tenureDays
        },
        {
            id: 'starvation',
            weight: 0.16,
            label: (g) => 'Lose no more than ' + g.maxStarved + ' to hunger',
            /*
             * The term that replaced "leave more animals than you brought in".
             *
             * Growth was the right measure when the allowance was small enough that a
             * herd might fail to replace itself. At the size this landscape actually
             * wants, breeding outruns death without help and the target became free —
             * passive play scored as well as attentive. Starvation does not have that
             * problem: it cannot be bought, because stocking more animals puts more
             * mouths on the same grass and makes it worse. It is the difference between
             * a reserve that was managed and one that was merely filled, measured
             * directly, and it is the number the warden's own tools move — forage where
             * the herds are, and animals moved on before the pasture is stripped.
             */
            read: (s, g) => ({
                have: Math.max(0, g.maxStarved - s.starved),
                need: g.maxStarved,
                inverted: true,
                lost: s.starved
            }),
            detail: (v, g) => v.lost === 0
                ? 'None lost'
                : v.lost + ' lost of ' + g.maxStarved + ' allowed'
        },
        {
            id: 'predators',
            weight: 0.14,
            label: (g) => 'Keep ' + g.predators + ' predators alive',
            read: (s, g) => ({ have: s.predators, need: g.predators })
        },
        {
            id: 'species',
            weight: 0.12,
            label: (g) => 'Hold ' + g.species + ' different species',
            read: (s, g) => ({ have: s.species, need: g.species })
        },
        {
            id: 'relocate',
            weight: 0.18,
            label: (g) => 'Move ' + g.relocate + ' animals to other reserves',
            read: (s, g) => ({ have: s.relocated, need: g.relocate })
        },
        {
            id: 'poaching',
            weight: 0.12,
            label: (g) => 'Lose no more than ' + g.maxPoached + ' to poachers',
            // Counts down rather than up, so "have" is what is left of the allowance.
            read: (s, g) => ({
                have: Math.max(0, g.maxPoached - s.poached),
                need: g.maxPoached,
                inverted: true,
                lost: s.poached
            }),
            detail: (v, g) => v.lost === 0
                ? 'None lost'
                : v.lost + ' lost of ' + g.maxPoached + ' allowed'
        }
    ];

    /**
     * Read the reserve into the handful of numbers the objectives care about.
     * @returns {object}
     */
    function survey(scene) {
        const eco = scene.ecology;
        let predators = 0, grazers = 0;
        const species = Object.create(null);

        for (const a of eco.animals) {
            if (!a.alive) continue;
            species[a.species] = (species[a.species] || 0) + 1;
            if (a.diet === 'carnivore') predators++; else grazers++;
        }

        const eStats = eco.stats;
        return {
            days: scene.time.day,
            introduced: eStats.placedCarnivores + eStats.placedHerbivores,
            predatorsLeft: eco.stockLeft('carnivore'),
            grazersLeft: eco.stockLeft('herbivore'),
            predators,
            grazers,
            population: predators + grazers,
            species: Object.keys(species).length,
            speciesCounts: species,
            starved: eco.stats.starved,
            relocated: scene.relocation ? scene.relocation.relocated : 0,
            poached: scene.events ? scene.events.stats.poached : 0,
            droughts: scene.events ? scene.events.stats.droughts : 0,
            fires: scene.events ? scene.events.stats.fires : 0,
            burnt: scene.events ? scene.events.burntTiles : 0
        };
    }

    /**
     * Evaluate every objective against the reserve as it stands.
     *
     * @param {object} scene
     * @returns {{items: object[], met: number, score: number, survey: object}}
     */
    function evaluate(scene) {
        const g = Config.goal;
        const s = survey(scene);
        const items = [];
        let score = 0;
        let met = 0;

        for (const o of OBJECTIVES) {
            const v = o.read(s, g);

            /*
             * The two loss terms — poaching and hunger — are allowances, not floors.
             * "Lose no more than two to poachers" is satisfied by losing one, but the
             * shared `have >= need` test marked it failed the moment a single animal
             * went, because `have` counts down from the allowance. That silently made
             * both of them all-or-nothing: a run that lost one of two permitted was
             * graded exactly as harshly as one that lost ten.
             *
             * Within the allowance they are met and score full marks. Past it the credit
             * decays as the ratio of what was permitted to what was actually lost, so
             * overshooting by one still grades well above losing everything.
             */
            const done = v.inverted ? v.lost <= v.need : v.have >= v.need;
            let ratio;
            if (v.inverted) {
                ratio = done ? 1 : MathUtils.clamp01(v.need / Math.max(1, v.lost));
            } else {
                ratio = v.need > 0 ? MathUtils.clamp01(v.have / v.need) : 1;
            }

            if (done) met++;
            score += o.weight * ratio;

            items.push({
                id: o.id,
                label: o.label(g),
                detail: o.detail ? o.detail(v, g) : v.have + ' of ' + v.need,
                have: v.have,
                need: v.need,
                ratio,
                done
            });
        }

        return { items, met, total: OBJECTIVES.length, score: MathUtils.clamp01(score), survey: s };
    }

    /** Has the tenure run its course? */
    function tenureComplete(scene) {
        return scene.time.day > Config.goal.tenureDays;
    }

    Safari.IsoGoals = { OBJECTIVES, survey, evaluate, tenureComplete };

})(window.Safari);
