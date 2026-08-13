/**
 * Safari Simulator — Species definitions.
 *
 * Each entry carries two halves:
 *
 *   `stats` — the simulation profile (movement, metabolism, perception, breeding).
 *   `art`   — a complete anatomical rig consumed by CreatureArt to draw the animal
 *             procedurally. There are no sprites or image assets anywhere in the game.
 *
 * ART COORDINATE SYSTEM
 * ---------------------
 * The origin sits on the ground between the animal's feet. `x` increases forward
 * (the animal faces +x before mirroring) and `y` is **height above ground**, so larger
 * y means higher up. CreatureArt negates y when it rasterises. All lengths are in art
 * units, which equal screen pixels at `scale: 1` and a perspective factor of 1.
 */
(function (Safari) {
    'use strict';

    /**
     * Shared quadruped skeleton. Species override only what differs from this,
     * which keeps the definitions readable and the proportions coherent.
     */
    const QUADRUPED = {
        scale: 1,
        /** Height above ground the animal's body floats at when flying (0 = walks). */
        flightHeight: 0,

        body: {
            cx: 0, cy: 40,      // centre of the torso
            len: 62, h: 27,     // length along x, height along y
            taper: 0.88,        // rear-to-front thickness ratio (<1 = narrower rump)
            chest: 1.06,        // chest depth multiplier at the shoulder
            belly: 0.5,         // how far the belly shading rides up the torso
            arch: 0.06          // upward curvature of the spine
        },

        neck: {
            x: 25, y: 46,       // attachment point on the torso
            len: 15,
            angle: 24,          // degrees above horizontal
            thickBase: 16,
            thickTip: 11
        },

        head: {
            len: 23, h: 17,
            angle: -8,          // degrees relative to the neck direction
            shape: 'feline',    // feline | canine | equine | bovine | blunt | reptile | avian | rodent
            muzzle: { len: 9, h: 9, drop: 3 },
            jawLine: 0.5
        },

        eye: { x: 0.52, y: 0.62, r: 2.0, shine: true },

        ear: { type: 'round', len: 7, w: 7.5, x: -5, y: 8, angle: -20, inner: true },

        legs: {
            front: { x: 20, y: 40 },
            rear: { x: -22, y: 41 },
            upper: 17, lower: 18,
            thickTop: 8, thickMid: 5.5, thickBot: 4.2,
            foot: 'paw',        // paw | hoof | splitHoof | pad | talon
            footLen: 7,
            /** Sideways offset applied to the far pair, creating depth separation. */
            spread: 5,
            /** Positive values splay the limbs outward, as in a crocodile. */
            sprawl: 0,
            /** Which way the joint folds: 1 = knee forward, -1 = hock backward. */
            frontBend: -1,
            rearBend: 1
        },

        tail: {
            len: 32, thick: 3.2, tip: 4.5,
            type: 'tuft',       // tuft | bushy | thin | whip | stub | fan | none
            x: -30, y: 44,
            baseAngle: 20,      // degrees above horizontal at the root
            droop: 0.9,         // how much gravity bends it downward
            sway: 1
        },

        gait: {
            type: 'quadruped',  // quadruped | hop | sprawl | fly | biped
            stride: 21,         // horizontal travel of a foot through one cycle
            lift: 7,            // peak foot height during the swing phase
            bodyBob: 2.0,
            headBob: 1.3,
            /** Cycles per unit distance — larger means quicker leg turnover. */
            rate: 0.055,
            /** Foot phase offsets: front-near, rear-far, front-far, rear-near. */
            phases: [0, 0.25, 0.5, 0.75],
            stanceFraction: 0.62
        },

        mane: null,
        markings: null,
        trunk: null,
        tusk: null,
        horn: null,
        wings: null,
        dorsal: null,

        /** Multiplied into the whole rig for newborns, plus a head-size bonus for cuteness. */
        babyScale: 0.54,
        babyHeadBonus: 1.26
    };

    /** Deep-merge helper used only at module load; species tables are small. */
    function extend(base, override) {
        const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
        for (const key in override) {
            if (!Object.prototype.hasOwnProperty.call(override, key)) continue;
            const v = override[key];
            if (v && typeof v === 'object' && !Array.isArray(v) &&
                base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
                out[key] = extend(base[key], v);
            } else {
                out[key] = v;
            }
        }
        return out;
    }

    /**
     * @typedef {object} SpeciesStats
     * @property {'carnivore'|'herbivore'} diet
     * @property {number} walkSpeed   Pixels per simulated second when wandering.
     * @property {number} runSpeed    Pixels per second when hunting or fleeing.
     * @property {number} sense       Perception radius in pixels.
     * @property {number} radius      Collision/interaction radius in pixels.
     * @property {number} maxEnergy
     * @property {number} energyDrain Energy lost per simulated second while active.
     *   Carnivores burn roughly half what a grazer of the same size does. Grass is
     *   underfoot everywhere; prey is not, and on a reserve of fourteen thousand tiles
     *   a predator that has to kill every two minutes is dead before the second day.
     *   Large carnivores really do eat every few days, so the biology and the balance
     *   want the same number here.
     * @property {number} breedChance Probability per second, given ideal conditions.
     *
     * These rates are calibrated against the stocking allowance, not in isolation.
     * Doubling them was right when the warden had twenty animals to work with — a herd
     * that small often failed to replace itself at all, which made the brief a coin toss
     * — but the allowance that actually suits this landscape is more than twice that,
     * and at that scale the same rates ran the reserve to the population ceiling inside
     * a week and made every state target free. Raise the allowance and these come down;
     * they are two ends of one dial.
     * @property {boolean} huntable   Whether predators will target this species.
     * @property {number} threat      Relative danger, used for prey prioritisation.
     * @property {number} turnRate    Radians per second the animal can rotate.
     * @property {number} [maxPrey]   Largest prey radius this predator will attack.
     *   Set explicitly per species rather than derived from the hunter's own size —
     *   an eagle and a wolf are close in mass but take very different prey.
     */

    /** @type {Object<string, {id:string,label:string,blurb:string,stats:SpeciesStats,art:object}>} */
    const Species = {

        /* ============================================================== *
         * CARNIVORES
         * ============================================================== */

        lion: {
            id: 'lion', label: 'Lion', order: 0,
            blurb: 'Apex predator. Patient, powerful, and hungry.',
            traits: ['Apex predator', 'Strong', 'Hunts in the open'],
            stats: {
                diet: 'carnivore',
                walkSpeed: 40, runSpeed: 112, sense: 215, radius: 27, maxPrey: 31,
                maxEnergy: 140, energyDrain: 0.20, breedChance: 0.030,
                huntable: true, threat: 1.0, turnRate: 3.0
            },
            art: extend(QUADRUPED, {
                palette: {
                    base: '#c48c4e', shade: '#a06f38', light: '#ddaa6d', belly: '#e6d0a4',
                    limb: '#b8834a', foot: '#8f6134', nose: '#3b2418', eye: '#211307',
                    accent: '#7d4a20', accentLight: '#a06630'
                },
                body: { cy: 41, len: 64, h: 28, taper: 0.86, chest: 1.1 },
                neck: { x: 26, y: 47, len: 14, angle: 20, thickBase: 17, thickTip: 12 },
                head: { len: 24, h: 18, shape: 'feline', muzzle: { len: 9, h: 10, drop: 3 } },
                ear: { type: 'round', len: 6, w: 7, x: -6, y: 9 },
                legs: { front: { x: 21, y: 41 }, rear: { x: -23, y: 42 }, upper: 23, lower: 23, thickTop: 8.5, foot: 'paw' },
                tail: { len: 36, thick: 3.4, tip: 5, type: 'tuft', x: -31, y: 45, droop: 1.0 },
                mane: { len: 16, spread: 1.22, ruff: 0.9, color: '#7d4a20', light: '#a3652c' },
                gait: { stride: 22, lift: 7, bodyBob: 2.1 }
            })
        },

        tiger: {
            id: 'tiger', label: 'Tiger', order: 1,
            blurb: 'Striped ambusher. Fast off the mark.',
            traits: ['Ambush hunter', 'Fast', 'Solitary'],
            stats: {
                diet: 'carnivore',
                walkSpeed: 44, runSpeed: 124, sense: 195, radius: 26, maxPrey: 27,
                maxEnergy: 120, energyDrain: 0.19, breedChance: 0.026,
                huntable: true, threat: 1.05, turnRate: 3.4
            },
            art: extend(QUADRUPED, {
                palette: {
                    base: '#e08a35', shade: '#b96b22', light: '#f2a553',
                    belly: '#f3e6d2', limb: '#d97f2e', foot: '#a8621f',
                    nose: '#3d2214', eye: '#1d1005', accent: '#2a1a0e'
                },
                body: { cy: 39, len: 66, h: 26, taper: 0.9 },
                neck: { x: 27, y: 45, len: 13, angle: 14, thickBase: 15, thickTip: 11 },
                head: { len: 23, h: 17, shape: 'feline', muzzle: { len: 9, h: 9, drop: 3 } },
                ear: { type: 'round', len: 6, w: 6.5, x: -6, y: 8.5 },
                legs: { front: { x: 22, y: 39 }, rear: { x: -23, y: 40 }, upper: 22, lower: 23, thickTop: 8, foot: 'paw' },
                tail: { len: 40, thick: 3.4, tip: 3.4, type: 'whip', x: -32, y: 43, droop: 0.7 },
                markings: {
                    type: 'stripes', color: '#2a1a0e', count: 13, thickness: 0.030,
                    lean: 0.16, waviness: 0.75, alpha: 0.92, legs: true, tail: true, head: false
                },
                gait: { stride: 23, lift: 7.5, rate: 0.058 }
            })
        },

        crocodile: {
            id: 'crocodile', label: 'Crocodile', order: 2,
            blurb: 'Low, armoured, and terrifyingly patient.',
            traits: ['Ambush predator', 'Armoured', 'Slow on land'],
            stats: {
                diet: 'carnivore',
                walkSpeed: 24, runSpeed: 82, sense: 155, radius: 31, maxPrey: 30,
                maxEnergy: 160, energyDrain: 0.20, breedChance: 0.016,
                huntable: true, threat: 0.95, turnRate: 1.9
            },
            art: extend(QUADRUPED, {
                palette: {
                    base: '#5c6b42', shade: '#43512f', light: '#7a8a56', belly: '#c2bd86',
                    limb: '#526038', foot: '#3a4526', nose: '#2b331d', eye: '#c9b23c',
                    accent: '#38442a'
                },
                body: { cy: 17, len: 74, h: 17, taper: 0.7, chest: 1.0, arch: 0.02 },
                neck: { x: 32, y: 19, len: 8, angle: 2, thickBase: 13, thickTip: 11 },
                head: { len: 30, h: 11, angle: 0, shape: 'reptile', muzzle: { len: 16, h: 6, drop: 0 }, jawLine: 0.8 },
                eye: { x: 0.28, y: 0.85, r: 1.9, shine: true },
                ear: { type: 'none' },
                legs: {
                    front: { x: 22, y: 15 }, rear: { x: -22, y: 15 },
                    upper: 9, lower: 9, thickTop: 6, thickMid: 4.5, thickBot: 3.6,
                    foot: 'talon', footLen: 7, sprawl: 7, spread: 7
                },
                tail: { len: 46, thick: 12, tip: 1.5, type: 'taperFlat', x: -36, y: 17, baseAngle: 4, droop: 0.35, sway: 1.5 },
                dorsal: { count: 13, height: 3.4, from: 0.15, to: 0.95, color: '#43512f' },
                gait: { type: 'sprawl', stride: 13, lift: 3.5, bodyBob: 1.0, headBob: 0.4, rate: 0.05 }
            })
        },

        wolf: {
            id: 'wolf', label: 'Wolf', order: 3,
            blurb: 'Lean, tireless, and relentless in pursuit.',
            traits: ['Pack hunter', 'Endurance', 'Breeds readily'],
            stats: {
                diet: 'carnivore',
                walkSpeed: 50, runSpeed: 128, sense: 205, radius: 21, maxPrey: 23,
                maxEnergy: 100, energyDrain: 0.18, breedChance: 0.042,
                huntable: true, threat: 0.85, turnRate: 3.6
            },
            art: extend(QUADRUPED, {
                palette: {
                    base: '#8d8a86', shade: '#6a6764', light: '#b0aca7', belly: '#ded9d2',
                    limb: '#7e7b77', foot: '#55524f', nose: '#25211f', eye: '#c9a13c',
                    accent: '#4a4744'
                },
                body: { cy: 36, len: 56, h: 22, taper: 0.82 },
                neck: { x: 23, y: 42, len: 13, angle: 22, thickBase: 14, thickTip: 10 },
                head: { len: 22, h: 14, shape: 'canine', muzzle: { len: 11, h: 7, drop: 2 } },
                ear: { type: 'point', len: 9, w: 6.5, x: -5, y: 8, angle: -8 },
                legs: { front: { x: 19, y: 36 }, rear: { x: -20, y: 37 }, upper: 21, lower: 21, thickTop: 6.5, thickBot: 3.6, foot: 'paw', footLen: 6 },
                tail: { len: 30, thick: 6.5, tip: 5, type: 'bushy', x: -27, y: 39, baseAngle: 4, droop: 1.2 },
                gait: { stride: 21, lift: 7, rate: 0.062, bodyBob: 1.8 }
            })
        },

        eagle: {
            id: 'eagle', label: 'Eagle', order: 4,
            blurb: 'Hunts on the wing. Nothing small is safe.',
            traits: ['Flies', 'Huge range', 'Takes small prey'],
            stats: {
                diet: 'carnivore',
                walkSpeed: 66, runSpeed: 158, sense: 265, radius: 19, maxPrey: 14,
                maxEnergy: 80, energyDrain: 0.18, breedChance: 0.024,
                huntable: false, threat: 0.6, turnRate: 4.4
            },
            art: extend(QUADRUPED, {
                flightHeight: 46,
                /** Palette key used for the skull, giving the eagle its white head. */
                headColor: 'accent',
                palette: {
                    base: '#6b4a30', shade: '#4d3421', light: '#8a6440', belly: '#7a5433',
                    limb: '#d8b64a', foot: '#c69a2e', nose: '#e8c04a', eye: '#f2d98a',
                    accent: '#f3efe6', accentLight: '#ffffff'
                },
                body: { cy: 22, len: 30, h: 20, taper: 0.7, arch: 0.1 },
                neck: { x: 12, y: 28, len: 6, angle: 26, thickBase: 12, thickTip: 10 },
                head: { len: 14, h: 12, shape: 'avian', muzzle: { len: 8, h: 5, drop: 2 } },
                eye: { x: 0.5, y: 0.66, r: 2.0, shine: true },
                ear: { type: 'none' },
                legs: {
                    front: null,
                    rear: { x: -2, y: 14 }, upper: 7, lower: 7,
                    thickTop: 3.6, thickMid: 2.8, thickBot: 2.4, foot: 'talon', footLen: 6, spread: 4
                },
                tail: { len: 20, thick: 11, tip: 13, type: 'fan', x: -15, y: 22, baseAngle: -6, droop: 0.2 },
                wings: { span: 42, chord: 15, feathers: 7, color: '#5c3f28', light: '#7d5837', tip: '#3a2718' },
                gait: { type: 'fly', stride: 0, lift: 0, bodyBob: 3.2, headBob: 0.6, rate: 0.04 }
            })
        },

        /* ============================================================== *
         * HERBIVORES
         * ============================================================== */

        elephant: {
            id: 'elephant', label: 'Elephant', order: 10,
            blurb: 'Too large to be hunted. Eats constantly.',
            traits: ['Immune to predators', 'Huge appetite', 'Slow'],
            stats: {
                diet: 'herbivore',
                walkSpeed: 25, runSpeed: 54, sense: 130, radius: 42,
                maxEnergy: 230, energyDrain: 0.85, breedChance: 0.004,
                huntable: false, threat: 0, turnRate: 1.5,
                /*
                 * An elephant works the lower branches rather than the crown, so it
                 * takes less per tree than a giraffe — but with an appetite this size
                 * it is the reason a stand of acacia goes bare.
                 */
                browse: 0.038
            },
            art: extend(QUADRUPED, {
                scale: 1.16,
                palette: {
                    base: '#8e8b87', shade: '#6d6a67', light: '#a8a4a0', belly: '#7c7975',
                    limb: '#847f7b', foot: '#c9c2b6', nose: '#5c5854', eye: '#2a2320',
                    accent: '#e8e2d4'
                },
                body: { cy: 54, len: 74, h: 44, taper: 0.94, chest: 1.02, arch: 0.14 },
                neck: { x: 32, y: 60, len: 7, angle: 6, thickBase: 30, thickTip: 26 },
                head: { len: 26, h: 26, angle: -4, shape: 'blunt', muzzle: { len: 4, h: 8, drop: 6 } },
                eye: { x: 0.42, y: 0.6, r: 1.8, shine: true },
                ear: { type: 'elephant', len: 26, w: 24, x: -9, y: 4, angle: 0 },
                legs: {
                    front: { x: 24, y: 52 }, rear: { x: -25, y: 52 },
                    upper: 30, lower: 30, thickTop: 14, thickMid: 12, thickBot: 12.5,
                    foot: 'pad', footLen: 13, spread: 7, frontBend: -0.35, rearBend: 0.35
                },
                tail: { len: 26, thick: 3, tip: 4.5, type: 'tuft', x: -35, y: 56, baseAngle: -8, droop: 1.5 },
                trunk: { len: 40, segments: 10, thickBase: 10, thickTip: 3.4, curl: 0.55, sway: 1.4 },
                tusk: { len: 20, thick: 4.2, curve: 0.75, color: '#eee6d2', y: -3 },
                gait: { stride: 20, lift: 5, bodyBob: 1.5, headBob: 0.9, rate: 0.036 }
            })
        },

        zebra: {
            id: 'zebra', label: 'Zebra', order: 11,
            blurb: 'Skittish and quick. Stripes confuse the chase.',
            traits: ['Very fast', 'Alert', 'Herds up'],
            stats: {
                diet: 'herbivore',
                walkSpeed: 44, runSpeed: 138, sense: 180, radius: 26,
                maxEnergy: 115, energyDrain: 0.65, breedChance: 0.02,
                huntable: true, threat: 0, turnRate: 3.8
            },
            art: extend(QUADRUPED, {
                palette: {
                    base: '#f0ece2', shade: '#cfc9bd', light: '#ffffff', belly: '#fbf8f1',
                    limb: '#e8e3d8', foot: '#3c3733', nose: '#2e2a27', eye: '#1a1512',
                    accent: '#221f1c'
                },
                body: { cy: 46, len: 62, h: 27, taper: 0.9, arch: 0.08 },
                neck: { x: 25, y: 54, len: 22, angle: 46, thickBase: 15, thickTip: 10 },
                head: { len: 24, h: 13.5, angle: -50, shape: 'equine', muzzle: { len: 10, h: 8, drop: 1 } },
                eye: { x: 0.5, y: 0.66, r: 2.0 },
                ear: { type: 'point', len: 9, w: 5, x: -6, y: 5, angle: -12 },
                legs: { front: { x: 21, y: 45 }, rear: { x: -22, y: 46 }, upper: 26, lower: 26, thickTop: 7, thickMid: 4.2, thickBot: 3.2, foot: 'hoof', footLen: 5 },
                tail: { len: 28, thick: 2.4, tip: 5, type: 'tuft', x: -30, y: 48, baseAngle: -10, droop: 1.4 },
                mane: { len: 5, spread: 1, ruff: 0, crest: true, color: '#221f1c', light: '#4a4642' },
                markings: {
                    type: 'stripes', color: '#221f1c', count: 15, thickness: 0.030,
                    lean: 0.3, waviness: 0.45, alpha: 1, legs: true, neck: true, tail: false, head: false
                },
                gait: { stride: 25, lift: 8, rate: 0.05, bodyBob: 2.0 }
            })
        },

        giraffe: {
            id: 'giraffe', label: 'Giraffe', order: 12,
            blurb: 'Browses high. Sees trouble long before it arrives.',
            traits: ['Tallest', 'Great eyesight', 'Slow to breed'],
            stats: {
                diet: 'herbivore',
                walkSpeed: 38, runSpeed: 100, sense: 240, radius: 30,
                maxEnergy: 145, energyDrain: 0.62, breedChance: 0.007,
                huntable: true, threat: 0, turnRate: 2.2,
                /*
                 * Browsing.
                 *
                 * How much of an acacia's crown this animal can take per second. The
                 * blurb above has always said a giraffe browses high; now it does. A
                 * giraffe reaches the whole crown, which is the point of the neck, and
                 * gets a good deal more out of a tree than an elephant working the
                 * lower branches.
                 */
                browse: 0.055
            },
            art: extend(QUADRUPED, {
                scale: 1.08,
                palette: {
                    base: '#e0bb72', shade: '#c39c56', light: '#f2d795', belly: '#f4e7c4',
                    limb: '#e6c684', foot: '#4d3a22', nose: '#5d4426', eye: '#241a0c',
                    accent: '#8a5a26'
                },
                body: { cy: 62, len: 52, h: 28, taper: 0.72, arch: 0.2 },
                neck: { x: 22, y: 72, len: 52, angle: 64, thickBase: 15, thickTip: 9 },
                head: { len: 19, h: 10, angle: -72, shape: 'equine', muzzle: { len: 8, h: 6, drop: 1 } },
                eye: { x: 0.44, y: 0.68, r: 1.9 },
                ear: { type: 'leaf', len: 9, w: 6, x: -5, y: 4, angle: -34 },
                horn: { type: 'ossicone', count: 2, len: 8, thick: 3, knob: 2.6, color: '#7d5a2e' },
                // Bones sized close to the standing height: a giraffe's legs are almost
                // straight, and extra slack reads as a crossed-over knock-kneed stance.
                legs: { front: { x: 19, y: 60 }, rear: { x: -19, y: 58 }, upper: 31, lower: 31, thickTop: 7.5, thickMid: 4.4, thickBot: 3.4, foot: 'hoof', footLen: 5.5 },
                tail: { len: 32, thick: 2, tip: 5, type: 'tuft', x: -25, y: 62, baseAngle: -14, droop: 1.5 },
                mane: { len: 5, spread: 1, ruff: 0, crest: true, color: '#8a5a26', light: '#a87439' },
                markings: {
                    type: 'patches', color: '#96601f', count: 30, size: 0.15,
                    alpha: 0.94, gap: 0.22, legs: true, neck: true
                },
                gait: { stride: 26, lift: 8, rate: 0.034, bodyBob: 2.4, headBob: 3.0, style: 'pace' }
            })
        },

        hippo: {
            id: 'hippo', label: 'Hippo', order: 13,
            blurb: 'A barrel of bad temper. Predators know better.',
            traits: ['Immune to predators', 'Loves water', 'Heavy'],
            stats: {
                diet: 'herbivore',
                walkSpeed: 27, runSpeed: 70, sense: 140, radius: 35,
                maxEnergy: 175, energyDrain: 0.7, breedChance: 0.007,
                huntable: false, threat: 0, turnRate: 1.8
            },
            art: extend(QUADRUPED, {
                scale: 1.04,
                palette: {
                    base: '#8f7580', shade: '#6f5a63', light: '#a88e99', belly: '#c3a3a8',
                    limb: '#856b76', foot: '#4f4046', nose: '#4a3a40', eye: '#20161a',
                    accent: '#d9c3c6'
                },
                body: { cy: 34, len: 68, h: 34, taper: 0.96, chest: 1.0, arch: 0.05 },
                neck: { x: 30, y: 38, len: 6, angle: 2, thickBase: 27, thickTip: 24 },
                head: { len: 30, h: 21, angle: -2, shape: 'hippo', muzzle: { len: 13, h: 15, drop: 2 }, jawLine: 0.85 },
                eye: { x: 0.3, y: 0.86, r: 2.1 },
                ear: { type: 'round', len: 5, w: 5.5, x: -10, y: 9 },
                legs: {
                    front: { x: 22, y: 32 }, rear: { x: -23, y: 32 },
                    upper: 19, lower: 19, thickTop: 11, thickMid: 10, thickBot: 10,
                    foot: 'pad', footLen: 10, spread: 6, frontBend: -0.4, rearBend: 0.4
                },
                tail: { len: 14, thick: 4, tip: 3, type: 'stub', x: -33, y: 38, baseAngle: -20, droop: 0.9 },
                gait: { stride: 15, lift: 4, bodyBob: 1.6, headBob: 0.8, rate: 0.044 }
            })
        },

        rabbit: {
            id: 'rabbit', label: 'Rabbit', order: 14,
            blurb: 'Breeds explosively. Everything eats it.',
            traits: ['Breeds fast', 'Tiny', 'Bottom of the food chain'],
            stats: {
                diet: 'herbivore',
                walkSpeed: 42, runSpeed: 142, sense: 155, radius: 13,
                maxEnergy: 70, energyDrain: 0.55, breedChance: 0.0525,
                huntable: true, threat: 0, turnRate: 5.5
            },
            art: extend(QUADRUPED, {
                scale: 0.82,
                palette: {
                    base: '#a89684', shade: '#867567', light: '#c6b6a4', belly: '#efe6da',
                    limb: '#9c8a78', foot: '#7a6b5c', nose: '#c98a92', eye: '#241a14',
                    accent: '#efe6da'
                },
                body: { cy: 17, len: 26, h: 19, taper: 1.12, arch: 0.22 },
                neck: { x: 10, y: 22, len: 4, angle: 34, thickBase: 12, thickTip: 10 },
                head: { len: 13, h: 11, angle: -14, shape: 'rodent', muzzle: { len: 4, h: 5, drop: 2 } },
                eye: { x: 0.46, y: 0.6, r: 2.0 },
                ear: { type: 'longEar', len: 19, w: 5.5, x: -2, y: 5, angle: 8, pair: true },
                legs: {
                    front: { x: 8, y: 14 }, rear: { x: -8, y: 16 },
                    upper: 9, lower: 9, thickTop: 4, thickMid: 3, thickBot: 2.6,
                    foot: 'pad', footLen: 6, spread: 3, rearBend: 1.4
                },
                tail: { len: 5, thick: 4, tip: 4, type: 'stub', x: -13, y: 19, baseAngle: 10, droop: 0 },
                gait: { type: 'hop', stride: 22, lift: 13, bodyBob: 4.5, headBob: 1.2, rate: 0.062 }
            })
        },

        deer: {
            id: 'deer', label: 'Deer', order: 15,
            blurb: 'Delicate, quick, and permanently nervous.',
            traits: ['Fast', 'Nervous', 'Common prey'],
            stats: {
                diet: 'herbivore',
                walkSpeed: 46, runSpeed: 142, sense: 190, radius: 22,
                maxEnergy: 100, energyDrain: 0.62, breedChance: 0.024,
                huntable: true, threat: 0, turnRate: 4.2
            },
            art: extend(QUADRUPED, {
                scale: 0.94,
                palette: {
                    base: '#b07a45', shade: '#8f5f33', light: '#cb9a63', belly: '#f0e0c8',
                    limb: '#a87446', foot: '#3f2e1e', nose: '#2f2118', eye: '#1c1108',
                    accent: '#e8d8bc'
                },
                body: { cy: 44, len: 52, h: 23, taper: 0.82, arch: 0.1 },
                neck: { x: 21, y: 52, len: 20, angle: 52, thickBase: 12, thickTip: 8 },
                head: { len: 19, h: 10, angle: -58, shape: 'equine', muzzle: { len: 7, h: 6, drop: 1 } },
                eye: { x: 0.46, y: 0.66, r: 1.9 },
                ear: { type: 'leaf', len: 10, w: 6.5, x: -5, y: 4, angle: -26 },
                horn: { type: 'antler', tines: 3, len: 15, thick: 2.4, spread: 0.5, color: '#8d7350' },
                legs: { front: { x: 18, y: 43 }, rear: { x: -19, y: 44 }, upper: 25, lower: 25, thickTop: 5.5, thickMid: 3.4, thickBot: 2.8, foot: 'splitHoof', footLen: 4.5 },
                tail: { len: 12, thick: 5, tip: 5, type: 'flag', x: -25, y: 47, baseAngle: -6, droop: 0.8 },
                markings: {
                    type: 'spots', color: '#f0e2c6', count: 16, size: 0.045, alpha: 0.5, rows: 2
                },
                gait: { stride: 24, lift: 9, rate: 0.056, bodyBob: 2.2 }
            })
        }
    };

    /**
     * Validate every rig at load time.
     *
     * A limb whose bones cannot span the distance from its anchor to the ground is
     * pinned at full extension by the IK solver, which reads as a stiff-legged animal
     * walking on tiptoe. Rather than let a future proportion tweak reintroduce that
     * silently, lengthen the bones and say so.
     */
    (function validateRigs() {
        /** Bones are sized to this multiple of the standing height, leaving room to bend. */
        const REACH_MARGIN = 1.1;

        for (const id in Species) {
            const art = Species[id].art;
            const legs = art.legs;
            if (art.gait.type === 'fly') continue;

            const anchors = [legs.front, legs.rear].filter(Boolean);
            const tallest = anchors.reduce((m, a) => Math.max(m, a.y), 0);
            const reach = legs.upper + legs.lower;
            const needed = tallest * REACH_MARGIN;

            if (reach < needed) {
                const k = needed / reach;
                legs.upper *= k;
                legs.lower *= k;
                console.warn('[Species] "' + id + '" limbs could not reach the ground (' +
                    reach.toFixed(1) + ' < ' + needed.toFixed(1) + '); scaled bones by ' +
                    k.toFixed(2) + '. Adjust the authored values.');
            }
        }
    })();

    /**
     * Approximate standing height of each rig, in art units.
     *
     * Used to park interface elements (health bars, selection markers) just above an
     * animal without overlapping it. Derived once from the rig rather than measured per
     * frame, and deliberately generous — a bar floating slightly high reads far better
     * than one clipping through a giraffe's head.
     */
    (function computeHeights() {
        const DEG = Math.PI / 180;

        for (const id in Species) {
            const art = Species[id].art;

            // Top of the torso.
            let top = art.body.cy + art.body.h * 0.5;

            // Neck rises from its attachment point at the authored angle.
            const neckTop = art.neck.y + Math.sin(art.neck.angle * DEG) * art.neck.len;
            top = Math.max(top, neckTop + art.head.h * 0.6);

            // Headgear and ears sit above the skull.
            if (art.horn) top += art.horn.len * 0.8;
            if (art.ear && art.ear.type === 'longEar') top += art.ear.len * 0.7;

            art.approxHeight = (top + (art.flightHeight || 0)) * art.scale;
        }
    })();

    /** Ordered id lists used by the UI dock. */
    const CARNIVORES = Object.keys(Species)
        .filter((k) => Species[k].stats.diet === 'carnivore')
        .sort((a, b) => Species[a].order - Species[b].order);

    const HERBIVORES = Object.keys(Species)
        .filter((k) => Species[k].stats.diet === 'herbivore')
        .sort((a, b) => Species[a].order - Species[b].order);

    Safari.Species = Species;
    Safari.SpeciesLists = { CARNIVORES, HERBIVORES, ALL: CARNIVORES.concat(HERBIVORES) };
    Safari.QUADRUPED = QUADRUPED;

})(window.Safari);
