/**
 * Safari Simulator 3D — World item kinds.
 *
 * Forage, browse, melons, meat and carcasses: what they are worth and who can eat them.
 *
 * In the 2D build this table lived at the top of `IsoItemArt`, alongside the canvas
 * painters that drew each kind. The painters are gone here — items are modelled in
 * `Models3D` — but the table is simulation data, not art: the ecology asks it what a
 * carcass is worth and which diet a melon belongs to. So it moves into config, and the
 * old name is kept as an alias so `IsoEcology` remains byte-identical to the 2D build's
 * copy and a balance change can be diffed straight across.
 *
 * The energy values are carried over unchanged. That balance was measured against the
 * metabolism and does not depend on how the item is drawn.
 */
(function (Safari) {
    'use strict';

    const KINDS = {
        forage: { id: 'forage', diet: 'plant', energy: 38, weight: 4, label: 'Forage' },
        shrub: { id: 'shrub', diet: 'plant', energy: 50, weight: 2, label: 'Browse' },
        melon: { id: 'melon', diet: 'plant', energy: 62, weight: 1, label: 'Tsamma melon' },
        meat: { id: 'meat', diet: 'meat', energy: 70, weight: 0, label: 'Meat' },
        carcass: { id: 'carcass', diet: 'meat', energy: 105, weight: 0, label: 'Carcass' }
    };

    /** The kinds that can be scattered as forage; meat only ever comes from a kill. */
    const PLANT_KINDS = Object.keys(KINDS).filter((k) => KINDS[k].weight > 0);

    const ItemKinds = {
        KINDS,
        PLANT_KINDS,

        /** Weighted pick of a plant kind. */
        randomPlant(rng) {
            let total = 0;
            for (const k of PLANT_KINDS) total += KINDS[k].weight;
            let r = rng.next() * total;
            for (const k of PLANT_KINDS) {
                r -= KINDS[k].weight;
                if (r <= 0) return k;
            }
            return 'forage';
        }
    };

    Safari.ItemKinds = ItemKinds;
    /** The name the carried-over ecology asks for. */
    Safari.IsoItemArt = ItemKinds;

})(window.Safari);
