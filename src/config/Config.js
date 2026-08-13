/**
 * Safari Simulator — Global tuning constants.
 *
 * Every magic number that governs feel lives here rather than being scattered through
 * the systems that consume it. Values are grouped by the subsystem they belong to.
 */
(function (Safari) {
    'use strict';

    const Config = {

        /* -------------------------------------------------------------- *
         * World geometry
         * -------------------------------------------------------------- */
        /* -------------------------------------------------------------- *
         * Camera
         * -------------------------------------------------------------- */
        camera: {
            minZoom: 0.42,
            maxZoom: 2.0,
            startZoom: 1.0,
            /** World units per second at zoom 1 for keyboard and edge panning. */
            panSpeed: 900,
            /** Convergence rates for position and zoom easing. */
            smoothing: 14,
            zoomSmoothing: 12,
            /** Wheel zoom step per notch. */
            zoomStep: 1.14,
            /** Pointer distance from the viewport edge that triggers edge panning. */
            edgeScrollMargin: 26,
            edgeScrollEnabled: true
        },

        world: {
            /**
             * The reserve, in world units. Several viewports across, so the player
             * pans and zooms around a landscape rather than watching a single screen.
             */
            width: 4400,
            /** Depth of the ground plane: y = 0 at the horizon, y = groundDepth nearest. */
            groundDepth: 1750,
            /** World units of sky visible above the far edge before the camera stops. */
            skyDepth: 620,
            /** Slack below the near edge so the bottom row is not jammed against the dock. */
            nearMargin: 90,

            /** Fraction of the viewport height occupied by sky. */
            horizonRatio: 0.34,
            /**
             * Ground margin, in pixels, that entities are kept inside. Wide enough
             * that a large animal's body stays fully on screen at its own edge.
             */
            edgePadding: 62,
            /**
             * Pseudo-perspective: an entity at the horizon renders at `scaleFar`,
             * one at the bottom of the screen at `scaleNear`. This single trick does
             * most of the work of making a flat 2D field read as depth.
             */
            scaleFar: 0.62,
            scaleNear: 1.22,
            /** Entities are never placed within this many pixels of the horizon. */
            horizonBuffer: 14,
            /**
             * Animals are drawn slightly larger than strict scale against the terrain.
             * They are the subject of the scene, and reading their gait and species at
             * a glance matters more than exact proportion to a tree.
             */
            creatureScale: 1.24
        },

        /* -------------------------------------------------------------- *
         * Time of day
         * -------------------------------------------------------------- */
        time: {
            /** Real seconds for one full in-game day at 1x speed. */
            secondsPerDay: 210,
            /** Hour the simulation starts at. */
            startHour: 7.4,
            /** Animals treat these hours as night for sleeping purposes. */
            nightStart: 19.6,
            nightEnd: 5.8,
            /** Named periods, used for HUD labels and ambience switching. */
            periods: [
                { id: 'night', label: 'Night', from: 0.0, icon: 'moon' },
                { id: 'dawn', label: 'Dawn', from: 5.4, icon: 'dawn' },
                { id: 'morning', label: 'Morning', from: 7.2, icon: 'sun' },
                { id: 'day', label: 'Midday', from: 10.5, icon: 'sun' },
                { id: 'afternoon', label: 'Afternoon', from: 14.5, icon: 'sun' },
                { id: 'golden', label: 'Golden Hour', from: 17.0, icon: 'dusk' },
                { id: 'sunset', label: 'Sunset', from: 18.5, icon: 'dusk' },
                { id: 'dusk', label: 'Dusk', from: 19.4, icon: 'dusk' },
                { id: 'night2', label: 'Night', from: 20.6, icon: 'moon' }
            ]
        },

        /* -------------------------------------------------------------- *
         * Simulation rules
         * -------------------------------------------------------------- */
        sim: {
            /** Speed presets exposed by the HUD. */
            speeds: [0, 0.5, 1, 2, 4],
            defaultSpeedIndex: 2,

            /**
             * Hard population ceiling. Also a legibility limit: much beyond this the
             * field reads as soup regardless of how fast it draws.
             */
            maxAnimals: 112,
            /** Soft ceiling above which breeding chance decays to zero. */
            softPopulationCap: 78,

            /**
             * Simulated seconds before a newborn becomes an adult.
             *
             * Roughly two and a half in-game days. It was 26 seconds — about three
             * in-game hours — which was invisible: a calf was grown before the player
             * had finished noticing it was born. Growth is drawn continuously across
             * this window, so the number is how long a young animal reads as young.
             */
            maturityTime: 520,
            /** Seconds a parent must wait between births. */
            breedCooldown: 18,
            /** Fraction of max energy required to consider breeding. */
            breedEnergyThreshold: 0.68,
            /** Energy each parent spends on a birth, as a fraction of max. */
            breedEnergyCost: 0.22,
            /** Radius within which two adults of a species can pair. */
            breedRadius: 74,

            /**
             * Local carrying capacity, in tiles and in animals-per-radius.
             *
             * The reserve only ever had a global ceiling, which for animals that stay
             * put means nothing: a hippo pod bred to twenty in one small lake because
             * no rule counted its neighbours. The cap is divided by the animal's own
             * radius, so a pool holds a handful of hippos or a great many rabbits.
             */
            localCrowdRadius: 9,
            localCrowdCap: 6,

            /** Energy restored, as a fraction of the prey's max energy. */
            preyEnergyYield: 0.95,
            /** Seconds a carcass remains on the ground before decaying. */
            carcassLifetime: 26,

            /** Seconds a tranquilised animal stays down. */
            tranquilizerDuration: 42,
            /** Pixel radius within which a dart counts as a hit. */
            dartHitRadius: 34,
            /** Dart flight speed, pixels per second. */
            dartSpeed: 900,
            /** Seconds the ranger must wait between shots. */
            dartCooldown: 1.1,

            /** Plants the isometric reserve regrows toward. */
            plantTarget: 130,

            /** Ambient food spawning. */
            foodTargetDensity: 0.00011,    // items per square pixel of ground
            foodSpawnInterval: 1.6,        // seconds between spawn attempts
            foodBurstCount: [7, 12],       // manual "add food" burst range
            maxFood: 90,

            /** Thirst — animals periodically break off to drink at water. */
            thirstRate: 0.9,               // thirst points per simulated second
            thirstThreshold: 62,           // above this, seeking water outranks food
            drinkRate: 34,                 // thirst removed per second while drinking

            /** Perception. */
            fleeMemory: 2.4,               // seconds a prey animal stays panicked
            stalkDistance: 130,            // predators crouch inside this range
            pounceDistance: 58             // ...and sprint inside this one
        },

        /* -------------------------------------------------------------- *
         * The job
         * -------------------------------------------------------------- *
         *
         * A warden's tenure: a fixed span of days, and what the reserve is expected to
         * look like at the end of it. Everything else in the game — the ecology, the
         * ranger, the droughts — is the means; this is the thing being asked for.
         *
         * The targets are deliberately reachable but not simultaneously easy. Herds
         * grow on their own, so the population and diversity goals mostly need the
         * reserve kept healthy; the relocation goal cannot be met by watching, and the
         * poaching goal cannot be met by ignoring the ranger.
         */
        goal: {
            /** In-game days the warden is responsible for. */
            tenureDays: 10,

            /**
             * Animals the warden may introduce across the whole tenure.
             *
             * The point of the game. Without a limit on stocking, every target that
             * describes the state of the reserve can simply be bought from the dock —
             * place two hundred animals and eight grazers survive by accident. A fixed
             * allowance makes each placement a decision, and makes the difference
             * between a reserve that was managed and one that was merely filled.
             *
             * Split by diet rather than pooled. A single pool let the warden spend the
             * lot on zebra in the first thirty seconds and lock themselves out of three
             * objectives permanently, before they had learned anything — an unrecoverable
             * loss reached by a reasonable-looking first move is a trap, not a decision.
             * Two allowances make the choice legible and keep every term reachable.
             */
            stock: { predators: 7, grazers: 40 },

            /** What must be standing at the end. */
            predators: 2,
            species: 7,

            /** What the warden has to have done, and not let happen. */
            relocate: 5,
            maxPoached: 2,
            maxStarved: 12
        },

        /* -------------------------------------------------------------- *
         * Pressure on the reserve
         * -------------------------------------------------------------- */
        events: {
            /** In-game days of calm before anything can go wrong at the start. */
            gracePeriod: 3 * 210,
            /** Minimum quiet between events, so they do not pile onto each other. */
            quietPeriod: 1.6 * 210,

            /** Expected occurrences per in-game day, before conditions weight them. */
            fireChance: 0.10,
            droughtChance: 0.14,
            raidChance: 0.18,

            /**
             * What a full drought does to grass regrowth and standing water.
             *
             * Softened from 0.18: at that rate a single drought took a healthy reserve
             * from thirty-two animals to one. A drought should force the player to
             * thin the herds and move animals on, not settle the run on its own.
             */
            droughtRegrowth: 0.34,
            droughtWaterLoss: 0.45,
            /** Longest a drought will run, in in-game days. */
            droughtDays: [2, 3.5]
        },

        /* -------------------------------------------------------------- *
         * Rendering
         * -------------------------------------------------------------- */
        render: {
            /** Upper bound on devicePixelRatio — 3x on a 4K display is wasted work. */
            maxPixelRatio: 2,
            /** Star count in the night sky. */
            starCount: 260,
            /** Simultaneous drifting clouds. */
            cloudCount: 6,
            /** Grass tufts scattered across the ground plane. */
            grassCount: 460,
            /** Distinct pre-rendered grass tuft sprites. */
            grassVariants: 8,
            /** Ambient motes (pollen by day, fireflies by night). */
            moteCount: 70,
            /** Particle ceiling. */
            maxParticles: 900,
            /** Wind strength and speed, driving grass/canopy sway. */
            windStrength: 1,
            windSpeed: 0.55,
            /** Vignette darkness at the corners, 0..1. */
            vignette: 0.42,
            /** Film grain opacity, 0 disables the pass. */
            grain: 0.028,
            /** Enable the heat-shimmer pass during the hottest hours. */
            heatHaze: true,
            /** Enable crepuscular rays when the sun is low. */
            godRays: true
        },

        /* -------------------------------------------------------------- *
         * Terrain generation
         * -------------------------------------------------------------- */
        terrain: {
            /**
             * Reserve size, in tiles. Square grid rendered as an isometric diamond.
             *
             * Tightened twice, from 160 to 120 to 86, each time for the same reason:
             * area is the enemy of a food chain. At 120 tiles a lion could quarter the
             * ground for an in-game day without crossing a herd, and measured across six
             * seeds the reserve averaged a handful of kills and no surviving predators.
             * At 86 — still five screens across at default zoom — every seed sustains
             * hunting. Density, not size, is what makes the ecosystem read as alive.
             */
            tiles: 86,

            /**
             * Relief shaping. Most of the reserve is walkable plain; rises are
             * occasional and terraced into benches so slopes read as escarpments.
             */
            relief: {
                /**
                 * Savanna, not mountains: the great majority of the reserve is flat
                 * plain, with occasional low rises and rocky kopjes.
                 */
                plainLevel: 0.68,
                /** Elevation levels at the highest point. */
                maxHeight: 3.0,
                /** Benches the relief is terraced into. */
                benches: 3,
                /** Fraction of max height above which ground turns to bare rock. */
                rockLevel: 0.66
            },

            water: {
                /** Pool-field value above which standing water forms. */
                level: 0.78,
                /** Field range mapped onto full depth. */
                depthScale: 0.14,
                /** Depth a land animal can still wade through. */
                wadeDepth: 0.30
            },

            /** Steepest gradient a land animal will cross. */
            maxWalkableSlope: 0.85,

            /**
             * Large props attempted per tile; rejection sampling thins this further.
             * Savanna is open country — trees are landmarks, not a canopy.
             */
            propDensity: 0.085,

            /** Chunk size, in tiles, for baked terrain canvases. */
            chunkTiles: 12,
            /** Chunks rasterised per frame; the rest wait their turn. */
            chunkBudget: 2,
            /** Resolution the ground is rasterised at, then upscaled. */
            chunkDetail: 0.5,

            waterholes: [2, 3],
            trees: [7, 11],
            bushes: [10, 16],
            rocks: [8, 13],
            termiteMounds: [2, 4],
            deadwood: [3, 5],
            /** Minimum separation between large features, in pixels. */
            featureSpacing: 96,
            /** Parallax ridge layers behind the horizon. */
            ridgeLayers: 3,
            /** Acacia silhouettes along the horizon line. */
            horizonTrees: [9, 14]
        },

        /* -------------------------------------------------------------- *
         * Audio
         * -------------------------------------------------------------- */
        audio: {
            masterVolume: 0.55,
            ambienceVolume: 0.32,
            sfxVolume: 0.7,
            /** Minimum seconds between two instances of the same cue. */
            cueThrottle: 0.06
        },

        /* -------------------------------------------------------------- *
         * UI
         * -------------------------------------------------------------- */
        ui: {
            /** Condition bars appear once an animal drops below this energy ratio. */
            healthVisibleBelow: 0.62,
            maxLogEntries: 7,
            logEntryLifetime: 9,
            toastDuration: 2.6,
            /** Seconds a stat chip stays highlighted after changing. */
            statPulse: 0.9
        }
    };

    Safari.Config = Config;

})(window.Safari);
