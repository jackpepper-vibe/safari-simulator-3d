/**
 * Safari Simulator — Three-quarter species rigs.
 *
 * Anatomy expressed in three dimensions, in world screen pixels at zoom 1.
 * `fx` runs forward toward the nose, `fy` to the animal's left, `fz` up.
 *
 * These replace the side-on rigs as the view moves to isometric. The zebra is authored
 * first and deliberately: stripes and a strong silhouette make any error in the
 * projection or the gait immediately obvious, so it is the right species to settle the
 * style on before the rest follow.
 */
(function (Safari) {
    'use strict';

    /** Shared quadruped skeleton; species override what differs. */
    const QUADRUPED = {
        /** Ellipsoid semi-axes: length along the spine, width across, height. */
        body: { x: 0, z: 26, length: 21, width: 11, height: 12 },

        neck: {
            x: 15, z: 32,
            length: 17,
            angle: 0.72,          // radians above horizontal
            grazeAngle: -0.85,    // when the head is down to feed
            thickBase: 11,
            thickTip: 7
        },

        head: {
            offset: 7,
            angle: -0.55,         // relative to the neck
            length: 8, width: 5, height: 6,
            muzzle: { offset: 6, length: 5, width: 3.4, height: 3.4 }
        },

        ear: { offset: 1, rise: 4, spread: 2.6, length: 5.5, thick: 2.6 },
        eye: { offset: 3.4, rise: 1.6, spread: 3.2, radius: 1.1 },

        legs: {
            front: { x: 12, z: 24, spread: 6.5, upper: 12, lower: 13 },
            rear: { x: -12, z: 25, spread: 7, upper: 13, lower: 13 },
            thickTop: 6, thickMid: 4, thickBot: 3,
            hoof: 2.4
        },

        tail: {
            rise: 4, angle: -0.35, length: 15,
            thick: 2, tip: 1.4, droop: 1.0, tuft: 3
        },

        gait: {
            stride: 13,
            lift: 5,
            bodyBob: 1.4,
            stanceFraction: 0.6,
            /** Foot phases: front-left, front-right, rear-left, rear-right. */
            phases: [0, 0.5, 0.5, 0]
        },

        mane: null,
        markings: null,
        ruff: null,
        horns: null,
        tusks: null,
        trunk: null,
        wings: null,
        flight: null,
        diet: 'herbivore'
    };

    function extend(base, over) {
        const out = Object.assign({}, base);
        for (const k in over) {
            const v = over[k];
            out[k] = (v && typeof v === 'object' && !Array.isArray(v) &&
                base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
                ? extend(base[k], v) : v;
        }
        return out;
    }

    const IsoSpecies = {
        zebra: extend(QUADRUPED, {
            id: 'zebra',
            label: 'Zebra',
            palette: {
                base: '#efe9dc',
                limb: '#e4ded1',
                hoof: '#332e29',
                muzzle: '#2c2824',
                mane: '#26221f',
                eye: '#171310'
            },
            /*
             * Proportions taken from the real animal rather than eyeballed: a zebra is
             * about 2.3m long and 1.4m at the shoulder, so the leg is roughly a third
             * of the body length, not over half. The first pass had legs at 0.57 of
             * body length and read unmistakably as a llama.
             */
            body: { x: 0, z: 22, length: 26, width: 7.5, height: 11 },
            neck: { x: 19, z: 27, length: 11, angle: 0.60, thickBase: 12, thickTip: 8 },
            head: {
                offset: 6, angle: -0.50,
                length: 9, width: 4.5, height: 6,
                muzzle: { offset: 6.5, length: 5, width: 3, height: 3.2 }
            },
            ear: { offset: 0.5, rise: 3.8, spread: 2.6, length: 4.5, thick: 3.2 },
            legs: {
                front: { x: 15, z: 20, spread: 5.5, upper: 11, lower: 11 },
                rear: { x: -15, z: 20.5, spread: 6, upper: 11.5, lower: 11.5 },
                thickTop: 5.5, thickMid: 3.4, thickBot: 2.6,
                hoof: 2.2
            },
            tail: { rise: 3, angle: -0.5, length: 13, thick: 1.5, tip: 1.1, droop: 1.2, tuft: 2.6 },
            mane: { height: 3.2, thick: 3.6 },
            markings: { type: 'stripes', color: '#242019', count: 12, width: 1.5 },
            gait: { stride: 13, lift: 5, bodyBob: 1.4 }
        }),

        /* ============================================================== *
         * PREDATORS
         * ============================================================== */

        lion: extend(QUADRUPED, {
            id: 'lion', label: 'Lion', diet: 'carnivore',
            palette: {
                base: '#c99257', limb: '#bf884e', hoof: '#7d5730',
                muzzle: '#e4cda2', mane: '#6b3a15', eye: '#241408'
            },
            body: { x: 0, z: 20, length: 25, width: 9, height: 11 },
            neck: { x: 17, z: 24, length: 8, angle: 0.34, thickBase: 13, thickTip: 11 },
            head: {
                offset: 6, angle: -0.24,
                length: 8.5, width: 6.5, height: 6.5,
                muzzle: { offset: 5.5, length: 4.4, width: 3.8, height: 3.4 }
            },
            /**
             * The ruff is what makes a lion read as a lion at any distance.
             *
             * `strands` is what makes it read as a *mane* rather than as a larger head.
             * Blended into the skull it only ever produced a bigger ball; the ragged
             * outline is the whole signal, so it is drawn as a collar of tapered
             * strands around a ruff that keeps its own edge.
             */
            ruff: {
                radius: 10,
                /** Overlapping lumps around the collar, which give it a shaggy edge. */
                lumps: 13, lump: 4.2, inset: 0.80,
                /** Short tufts over the lumps, to break the outline without spiking it. */
                strands: 18, length: 2.8, thick: 2.8, rake: 0.35
            },
            ear: { offset: -1, rise: 3.4, spread: 3, length: 3, thick: 3 },
            eye: { offset: 3.4, rise: 1.4, spread: 3, radius: 1.1 },
            legs: {
                front: { x: 13, z: 19, spread: 5.5, upper: 10, lower: 10.5 },
                rear: { x: -13, z: 19.5, spread: 6, upper: 10.5, lower: 10.5 },
                thickTop: 6.5, thickMid: 4.4, thickBot: 3.4, hoof: 2.8
            },
            tail: { rise: 3, angle: -0.1, length: 17, thick: 1.6, tip: 1.2, droop: 0.8, tuft: 3 },
            gait: { stride: 12, lift: 4.5, bodyBob: 1.3 }
        }),

        tiger: extend(QUADRUPED, {
            id: 'tiger', label: 'Tiger', diet: 'carnivore',
            palette: {
                base: '#e08a35', limb: '#d9822c', hoof: '#6d4520',
                muzzle: '#f3e6d2', mane: '#2a1a0e', eye: '#1d1005'
            },
            body: { x: 0, z: 19, length: 26, width: 8.5, height: 10 },
            neck: { x: 18, z: 22, length: 8, angle: 0.28, thickBase: 11, thickTip: 9 },
            head: {
                offset: 6, angle: -0.2,
                length: 8, width: 6, height: 6,
                muzzle: { offset: 5.2, length: 4.2, width: 3.6, height: 3.2 }
            },
            ear: { offset: -1, rise: 3.2, spread: 2.8, length: 2.8, thick: 2.8 },
            eye: { offset: 3.2, rise: 1.3, spread: 2.8, radius: 1.1 },
            legs: {
                front: { x: 13, z: 18, spread: 5.2, upper: 9.5, lower: 10 },
                rear: { x: -13, z: 18.5, spread: 5.8, upper: 10, lower: 10 },
                thickTop: 6, thickMid: 4.2, thickBot: 3.2, hoof: 2.6
            },
            tail: { rise: 3, angle: -0.05, length: 19, thick: 1.6, tip: 1.2, droop: 0.7, tuft: 0 },
            markings: { type: 'stripes', color: '#2a1a0e', count: 11, width: 1.4 },
            gait: { stride: 12.5, lift: 4.5, bodyBob: 1.3 }
        }),

        wolf: extend(QUADRUPED, {
            id: 'wolf', label: 'Wolf', diet: 'carnivore',
            palette: {
                base: '#918d88', limb: '#85817c', hoof: '#3a3733',
                muzzle: '#d8d2c9', mane: '#54504c', eye: '#c9a13c'
            },
            body: { x: 0, z: 17, length: 20, width: 6.5, height: 8.5 },
            neck: { x: 14, z: 20, length: 8, angle: 0.34, thickBase: 9, thickTip: 7 },
            head: {
                offset: 5.5, angle: -0.3,
                length: 7.5, width: 4.4, height: 5,
                muzzle: { offset: 5.4, length: 4.6, width: 2.6, height: 2.6 }
            },
            ear: { type: 'point', offset: -1, rise: 3, spread: 2.4, length: 4, thick: 2.4 },
            eye: { offset: 3, rise: 1.2, spread: 2.4, radius: 1 },
            legs: {
                front: { x: 10.5, z: 16, spread: 4.4, upper: 8.5, lower: 9 },
                rear: { x: -10.5, z: 16.5, spread: 4.8, upper: 9, lower: 9 },
                thickTop: 5, thickMid: 3.4, thickBot: 2.6, hoof: 2.2
            },
            tail: { rise: 2.5, angle: -0.5, length: 13, thick: 4, tip: 2.4, droop: 1.1, tuft: 0 },
            gait: { stride: 11, lift: 4.5, bodyBob: 1.2 }
        }),

        crocodile: extend(QUADRUPED, {
            id: 'crocodile', label: 'Crocodile', diet: 'carnivore',
            palette: {
                base: '#5c6b42', limb: '#526038', hoof: '#39422a',
                muzzle: '#6d7a4e', mane: '#43512f', eye: '#c9b23c'
            },
            /* Long, low and wide, with the legs splayed out to the sides. */
            body: { x: 0, z: 7, length: 30, width: 9, height: 5.5 },
            neck: { x: 24, z: 7.5, length: 5, angle: 0.02, thickBase: 9, thickTip: 8 },
            head: {
                offset: 7, angle: 0,
                length: 11, width: 4.5, height: 3.2,
                muzzle: { offset: 8, length: 6, width: 3.2, height: 2.4 }
            },
            ear: null,
            eye: { offset: 2, rise: 2.2, spread: 2.4, radius: 1 },
            legs: {
                front: { x: 11, z: 6, spread: 6, upper: 4.5, lower: 4.5 },
                rear: { x: -11, z: 6, spread: 6.5, upper: 4.5, lower: 4.5 },
                thickTop: 4, thickMid: 3, thickBot: 2.4, hoof: 2,
                sprawl: 4.5
            },
            tail: { rise: 1, angle: 0.02, length: 26, thick: 7, tip: 0.8, droop: 0.25, tuft: 0 },
            /**
             * Osteoderms.
             *
             * A crocodile's back is armour, and without it the animal is a smooth green
             * torpedo — which is exactly what a blended surface makes of it. Three rows
             * of keeled scutes down the body and a single ridge along the tail put the
             * texture back into the silhouette, which is where it matters: a croc is
             * usually seen as a shape lying half in the water.
             */
            scutes: {
                color: '#3f4a2a',
                rows: 3, spacing: 3.2, size: 2.8, spread: 3.2,
                tail: { rows: 1, spacing: 2.4, size: 2.6 }
            },
            gait: { type: 'sprawl', stride: 7, lift: 2, bodyBob: 0.6,
                phases: [0, 0.5, 0.5, 0] }
        }),

        eagle: extend(QUADRUPED, {
            id: 'eagle', label: 'Eagle', diet: 'carnivore',
            palette: {
                base: '#6b4a30', limb: '#d8b64a', hoof: '#c69a2e',
                muzzle: '#e8c04a', mane: '#3a2718', eye: '#f2d98a'
            },
            /** Hovers above the ground; legs stay tucked and the wings do the work. */
            flight: { height: 30 },
            body: { x: 0, z: 6, length: 11, width: 5, height: 6 },
            neck: { x: 7, z: 9, length: 4, angle: 0.5, thickBase: 7, thickTip: 6 },
            head: {
                offset: 3.5, angle: -0.3,
                length: 5, width: 4, height: 4.5,
                muzzle: { offset: 3.6, length: 3, width: 1.8, height: 2 }
            },
            ear: null,
            eye: { offset: 2, rise: 1, spread: 2.4, radius: 1 },
            legs: {
                front: { x: 2, z: 3, spread: 2, upper: 3, lower: 3 },
                rear: { x: -2, z: 3, spread: 2.2, upper: 3, lower: 3 },
                thickTop: 2, thickMid: 1.6, thickBot: 1.4, hoof: 1.6
            },
            wings: { root: 1, rise: 3, span: 22, chord: 11 },
            tail: { rise: 1, angle: -0.1, length: 9, thick: 5, tip: 6, droop: 0.2, tuft: 0 },
            gait: { type: 'fly', stride: 0, lift: 0, bodyBob: 1.6 }
        }),

        /* ============================================================== *
         * GRAZERS
         * ============================================================== */

        elephant: extend(QUADRUPED, {
            id: 'elephant', label: 'Elephant', diet: 'herbivore',
            palette: {
                base: '#8e8b87', limb: '#847f7b', hoof: '#c9c2b6',
                muzzle: '#8e8b87', mane: '#6d6a67', eye: '#2a2320',
                tusk: '#eee6d2'
            },
            body: { x: 0, z: 34, length: 32, width: 15, height: 19 },
            neck: { x: 24, z: 40, length: 5, angle: 0.14, thickBase: 24, thickTip: 21 },
            head: {
                offset: 8, angle: -0.1,
                length: 11, width: 10, height: 11,
                muzzle: { offset: 7, length: 5, width: 5, height: 5 }
            },
            ear: { type: 'fan', offset: -3, rise: 3, spread: 6, length: 15, width: 13, thick: 3 },
            eye: { offset: 5, rise: 2, spread: 6, radius: 1.2 },
            trunk: { length: 34, segments: 8, thick: 6.5, tip: 2.2, curl: 0.62 },
            tusks: { length: 13, thick: 3, curve: 0.9, spread: 3.4 },
            legs: {
                front: { x: 15, z: 31, spread: 8, upper: 17, lower: 17 },
                rear: { x: -15, z: 31, spread: 8.5, upper: 17, lower: 17 },
                thickTop: 11, thickMid: 10, thickBot: 10, hoof: 5.5
            },
            tail: { rise: 4, angle: -0.9, length: 14, thick: 1.6, tip: 1.2, droop: 1.4, tuft: 2 },
            gait: { stride: 12, lift: 3.5, bodyBob: 1.1 }
        }),

        giraffe: extend(QUADRUPED, {
            id: 'giraffe', label: 'Giraffe', diet: 'herbivore',
            palette: {
                base: '#e5c684', limb: '#e8cd90', hoof: '#4d3a22',
                muzzle: '#d8bb85', mane: '#96601f', eye: '#241a0c',
                horn: '#7d5a2e'
            },
            body: { x: 0, z: 40, length: 22, width: 9, height: 12 },
            /** The neck is the whole silhouette: very long, steeply raised. */
            neck: { x: 15, z: 47, length: 40, angle: 1.02, grazeAngle: -0.7,
                thickBase: 11, thickTip: 6 },
            head: {
                offset: 5, angle: -0.85,
                length: 7, width: 4, height: 4.5,
                muzzle: { offset: 4.6, length: 3.6, width: 2.4, height: 2.4 }
            },
            ear: { offset: -1, rise: 2, spread: 3, length: 4, thick: 2.4 },
            eye: { offset: 2.6, rise: 1.2, spread: 2.6, radius: 1 },
            horns: { type: 'ossicone', offset: -0.5, rise: 2.4, spread: 1.6,
                length: 5, thick: 1.8 },
            legs: {
                front: { x: 11, z: 38, spread: 5, upper: 20, lower: 20 },
                rear: { x: -11, z: 37, spread: 5.5, upper: 19.5, lower: 19.5 },
                thickTop: 6, thickMid: 4, thickBot: 3, hoof: 2.6
            },
            tail: { rise: 3, angle: -1.0, length: 17, thick: 1.2, tip: 1, droop: 1.3, tuft: 2.6 },
            markings: { type: 'patches', color: '#a3661f', count: 16, size: 3.2, alpha: 0.92 },
            /** Giraffes pace: both legs on a side swing together. */
            gait: { stride: 15, lift: 5, bodyBob: 1.6, phases: [0, 0.52, 0.06, 0.58] }
        }),

        /*
         * The hippo is authored against the 3D build rather than the isometric one.
         *
         * Its rig used to give it a neck thicker than its head, which the flat
         * projection hid and a blended surface does not: barrel, neck, head and muzzle
         * all narrowed in turn, so the animal came out as one smooth cone — a mole the
         * size of a car. A hippo's head is the widest thing about its front end, and
         * its muzzle is wider still, so that is how it is built now: the profile
         * *widens* toward the nose. Eyes, ears and nostrils sit on the top plane, where
         * a hippo's are, which is the other half of the read.
         */
        hippo: extend(QUADRUPED, {
            id: 'hippo', label: 'Hippo', diet: 'herbivore',
            palette: {
                base: '#8f7580', limb: '#856b76', hoof: '#4f4046',
                muzzle: '#a88e99', mane: '#6f5a63', eye: '#20161a'
            },
            body: { x: 0, z: 16, length: 27, width: 14, height: 13 },
            neck: { x: 18, z: 17, length: 4, angle: 0.03, thickBase: 11, thickTip: 10 },
            head: {
                offset: 6, angle: -0.02,
                length: 13, width: 12, height: 10,
                muzzle: { offset: 7, length: 10, width: 14, height: 8 }
            },
            ear: { offset: -5, rise: 4.6, spread: 3.2, length: 2.6, thick: 2.6 },
            eye: { offset: 0.5, rise: 4.4, spread: 4.6, radius: 1.2 },
            legs: {
                front: { x: 11, z: 14, spread: 6.5, upper: 7, lower: 7 },
                rear: { x: -11, z: 14, spread: 7, upper: 7, lower: 7 },
                thickTop: 8, thickMid: 7.5, thickBot: 7, hoof: 4
            },
            tail: { rise: 2, angle: -0.6, length: 6, thick: 2.4, tip: 1.6, droop: 0.8, tuft: 0 },
            gait: { stride: 8, lift: 2.6, bodyBob: 1.0 }
        }),

        deer: extend(QUADRUPED, {
            id: 'deer', label: 'Deer', diet: 'herbivore',
            palette: {
                base: '#b07a45', limb: '#a87446', hoof: '#3f2e1e',
                muzzle: '#e8d8bc', mane: '#8f5f33', eye: '#1c1108',
                horn: '#8d7350'
            },
            body: { x: 0, z: 19, length: 19, width: 6.5, height: 9 },
            neck: { x: 14, z: 23, length: 12, angle: 0.78, thickBase: 8, thickTip: 5.5 },
            head: {
                offset: 5, angle: -0.72,
                length: 6.5, width: 3.6, height: 4,
                muzzle: { offset: 4.4, length: 3.4, width: 2.2, height: 2.2 }
            },
            ear: { offset: -1, rise: 2.4, spread: 2.6, length: 4.4, thick: 2.6 },
            eye: { offset: 2.4, rise: 1.1, spread: 2.4, radius: 1 },
            horns: { type: 'antler', offset: -0.5, rise: 2, spread: 1.8,
                length: 8, thick: 1.4, tines: 2 },
            legs: {
                front: { x: 9.5, z: 18, spread: 4, upper: 9.5, lower: 9.5 },
                rear: { x: -9.5, z: 18.5, spread: 4.4, upper: 10, lower: 10 },
                thickTop: 4, thickMid: 2.6, thickBot: 2, hoof: 1.8
            },
            tail: { rise: 2.4, angle: -0.2, length: 5, thick: 2.6, tip: 2.8, droop: 0.6, tuft: 0 },
            markings: { type: 'spots', color: '#f0e2c6', count: 12, size: 1.2, alpha: 0.55 },
            gait: { stride: 11, lift: 5, bodyBob: 1.4 }
        }),

        rabbit: extend(QUADRUPED, {
            id: 'rabbit', label: 'Rabbit', diet: 'herbivore',
            palette: {
                base: '#a89684', limb: '#9c8a78', hoof: '#7a6b5c',
                muzzle: '#efe6da', mane: '#efe6da', eye: '#241a14'
            },
            body: { x: 0, z: 6, length: 7, width: 4, height: 5 },
            neck: { x: 4, z: 8, length: 2, angle: 0.6, thickBase: 5, thickTip: 4.5 },
            head: {
                offset: 2.6, angle: -0.3,
                length: 3.4, width: 2.6, height: 3,
                muzzle: { offset: 2.2, length: 1.8, width: 1.4, height: 1.4 }
            },
            /** Ears are the silhouette; long and upright. */
            ear: { type: 'long', offset: -0.5, rise: 2, spread: 1.1, length: 7, thick: 2 },
            eye: { offset: 1.4, rise: 0.7, spread: 1.5, radius: 0.8 },
            legs: {
                front: { x: 3, z: 5, spread: 2, upper: 2.6, lower: 2.6 },
                rear: { x: -3, z: 5.5, spread: 2.4, upper: 3, lower: 3 },
                thickTop: 2.4, thickMid: 1.8, thickBot: 1.5, hoof: 1.2
            },
            tail: { rise: 1.5, angle: 0.2, length: 2, thick: 2.6, tip: 2.6, droop: 0, tuft: 0 },
            gait: { type: 'hop', stride: 6, lift: 4, bodyBob: 1.2 }
        })
    };

    /** Ordered id lists, matching the side-on build's grouping. */
    const CARNIVORES = Object.keys(IsoSpecies).filter((k) => IsoSpecies[k].diet === 'carnivore');
    const HERBIVORES = Object.keys(IsoSpecies).filter((k) => IsoSpecies[k].diet !== 'carnivore');

    Safari.IsoSpeciesLists = { CARNIVORES, HERBIVORES, ALL: CARNIVORES.concat(HERBIVORES) };
    Safari.IsoSpecies = IsoSpecies;
    Safari.ISO_QUADRUPED = QUADRUPED;

})(window.Safari);
