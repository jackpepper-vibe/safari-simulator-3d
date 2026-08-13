/**
 * Safari Simulator — Animal entity, isometric build.
 *
 * The behaviour of the side-on `Animal`, rebuilt to work in continuous tile
 * coordinates on the isometric world. The state machine, the priority ordering and
 * the metabolism are deliberately unchanged — that balance was measured and tuned, and
 * none of it depends on the projection.
 *
 * Only distances change units. Species stats are authored in the pixel scale of the
 * original build, so anything spatial is divided by `UNITS_PER_TILE` on the way in.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, Species, Events } = Safari;
    const TAU = MathUtils.TAU;

    /**
     * Pixels of the old build per tile of the new one.
     *
     * Chosen so a grazer covers roughly a tile and a quarter per second and can see
     * about five tiles — fast enough to cross the reserve in a few in-game days,
     * far-sighted enough to find forage without wandering blindly.
     */
    const UNITS_PER_TILE = 34;

    /** @enum {string} */
    const State = {
        WANDER: 'wander',
        FORAGE: 'forage',
        DRINK: 'drink',
        HUNT: 'hunt',
        FLEE: 'flee',
        REST: 'rest',
        WALLOW: 'wallow',
        SLEEP: 'sleep',
        TRANQUILIZED: 'tranquilized',
        DYING: 'dying'
    };

    /**
     * Grazing. `GRAZE_RATE` is tile-fertility stripped per second by an average-sized
     * grazer; `GRAZE_ENERGY` is what a whole tile's worth of grass is worth as a
     * fraction of the animal's own maximum.
     *
     * A tile is a mouthful, not a meal — about a third of a tank. Set generously the
     * herds simply grew to the population ceiling and sat there, because pasture that
     * fills an animal in one tile is not a constraint on anything. At this value the
     * land has a carrying capacity, which is the whole point of the game.
     */
    const GRAZE_RATE = 0.42;
    const GRAZE_ENERGY = 0.30;

    /**
     * How far a grazer will detour for a scattered pickup rather than eating the grass
     * it is standing on. A few paces: near enough that forage the player throws down
     * actually gets eaten, short enough that nothing crosses the reserve for a melon.
     */
    const PLANT_DETOUR = 3.5;

    /**
     * Seconds of flat-out running before prey is blown, and how far it drops.
     *
     * Without this no chase ever ends: the fast grazers outrun every predator, and they
     * start running at five tiles while the pounce only reaches four.
     */
    const FLEE_STAMINA = 11;

    /** Water this deep or more counts as somewhere a hippo or crocodile can lie up. */
    const WALLOW_DEPTH = 0.34;

    /**
     * What counts as one pool, and how much of one animal it will hold. Divided by the
     * animal's own radius, so a pool takes a few hippos or a good many crocodiles.
     */
    const POOL_RADIUS = 7;
    /*
     * Sits between the size of a breeding family and the local breeding limit.
     *
     * Set equal to the breeding limit, a pod just parks at the cap and never pushes
     * anyone out — capped, but still every hippo in the reserve in one lake. Set below
     * a family, a pair and its calf trip dispersal the moment the calf arrives, the
     * parents are split up, and the species never breeds at all. A pod therefore grows
     * to about four, and its surplus goes looking for water of its own.
     */
    const POOL_CAP = 4;

    let nextId = 1;

    class IsoAnimal {
        /**
         * @param {string} speciesId
         * @param {number} tx Tile coordinates.
         * @param {number} ty
         * @param {boolean} isBaby
         * @param {Safari.Rng} rng
         */
        constructor(speciesId, tx, ty, isBaby, rng) {
            const def = Species[speciesId];

            this.id = nextId++;
            this.species = speciesId;
            this.def = def;
            this.stats = def.stats;
            this.diet = def.stats.diet;
            this.spec = Safari.IsoSpecies[speciesId];

            this.x = tx;
            this.y = ty;
            this.facing = rng.next() * TAU;
            this.heading = this.facing;
            this.seed = rng.int(0, 9999);

            this.alive = true;
            this.isBaby = !!isBaby;
            this.age = 0;

            this.maxEnergy = def.stats.maxEnergy * (isBaby ? 0.55 : 1);
            this.energy = this.maxEnergy * (isBaby ? 0.75 : 0.9);
            this.thirst = rng.range(0, 30);
            /** Seconds spent walking at water without reaching it, and the cool-off. */
            this.thirstSeek = 0;
            this.drinkGiveUp = 0;
            /** Seconds spent trying to move without getting anywhere. */
            this.stuck = 0;
            /** Seconds spent fleeing without a break, which is what tires an animal. */
            this.fleeTime = 0;
            /** How far the animal has collapsed, 0 standing to 1 down. */
            this.downAmount = 0;
            /** Water-dwellers only: driven ashore by hunger, and not yet fed. */
            this.feedingAshore = false;
            /** Closest the animal has come to its current target, and time without gain. */
            this.bestApproach = Infinity;
            this.noProgress = 0;
            /** A food item recently found unreachable, and how long to keep ignoring it. */
            this.foodIgnore = null;
            this.foodIgnoreTimer = 0;
            /** Water-dwellers only: seconds left of a commitment to move pools. */
            this.disperseTimer = 0;

            this.state = State.WANDER;
            this.stateTime = 0;
            this.target = null;
            this.targetAnimal = null;
            this.targetFood = null;

            this.breedCooldown = isBaby ? Config.sim.maturityTime : rng.range(0, 6);
            this.panic = 0;
            this.tranqTimer = 0;
            this.deathTimer = 0;
            this.eatTimer = 0;

            this.wanderAngle = this.facing;
            this.wanderTimer = 0;

            this.speed = 0;
            this.phase = rng.next();
            this.headDown = 0;
            this.blinkTimer = rng.range(1, 5);
            this._blink = 0;

            /** Mutated in place and handed to the renderer. */
            this.renderState = {
                facing: this.facing, phase: this.phase, speed01: 0,
                time: 0, seed: this.seed, headDown: 0, blink: 0, earFlick: 0
            };
        }

        /* -------------------------------------------------------------- *
         * Derived stats, in tile units
         * -------------------------------------------------------------- */

        get walkSpeed() {
            return this.stats.walkSpeed / UNITS_PER_TILE * (this.isBaby ? 0.72 : 1);
        }

        get runSpeed() {
            return this.stats.runSpeed / UNITS_PER_TILE * (this.isBaby ? 0.72 : 1);
        }

        get sense() {
            return this.stats.sense / UNITS_PER_TILE;
        }

        get radius() {
            return this.stats.radius / UNITS_PER_TILE * (this.isBaby ? 0.6 : 1);
        }

        get maxSpeed() {
            const running = this.state === State.FLEE || this.state === State.HUNT;
            let base = running ? this.runSpeed : this.walkSpeed;

            /*
             * The pounce.
             *
             * On a plain this size a chase between two animals of similar top speed
             * simply never ends: the wolf holds the hunt for a minute, burns energy at
             * one and a half times the normal rate, and dies still two tiles behind a
             * zebra. Predators get a short burst inside pouncing range, which is what
             * actually decides a hunt in the field, and it costs them dearly if they
             * miss because the drain is already elevated.
             */
            if (this.state === State.HUNT && this.targetAnimal) {
                const d = MathUtils.dist(this.x, this.y,
                    this.targetAnimal.x, this.targetAnimal.y);
                if (d < Config.sim.pounceDistance / UNITS_PER_TILE) base *= 1.32;
            }

            /*
             * Flagging.
             *
             * A starving animal slows down — but not a predator mid-chase. Hunger is
             * what sent it, and slowing it makes hunger self-reinforcing: a lion at a
             * third of its energy ran at 121 against a healthy zebra's 138, so the
             * hungrier it got the less able it was to eat. Measured across a tenure:
             * two predators, thirty-four grazers, four kills in ten days, both starved
             * while the herd bred to ninety-five.
             */
            if (this.state === State.HUNT) return base;

            /*
             * Prey tires. Sustained flight costs, so a committed hunter wears its quarry
             * down rather than trailing two tiles behind it for ever. This is what lets
             * a chase resolve at all: every predator is slower flat out than the fast
             * grazers, and prey bolts at five tiles while the pounce only reaches four.
             */
            let flagging = MathUtils.lerp(0.55, 1, MathUtils.clamp01(this.energyRatio * 2));
            if (this.state === State.FLEE) {
                flagging *= MathUtils.lerp(1, 0.72,
                    MathUtils.clamp01(this.fleeTime / FLEE_STAMINA));
            }
            return base * flagging;
        }

        get energyRatio() {
            return MathUtils.clamp01(this.energy / this.maxEnergy);
        }

        get isDown() {
            return this.state === State.TRANQUILIZED || this.state === State.SLEEP ||
                this.state === State.DYING;
        }

        /** Can this animal enter deep water? */
        get amphibious() {
            return this.species === 'hippo' || this.species === 'crocodile';
        }

        /** Fliers ignore terrain entirely. */
        get flies() {
            return !!this.spec.flight;
        }

        /* -------------------------------------------------------------- *
         * Tick
         * -------------------------------------------------------------- */

        update(dt, ctx) {
            this.stateTime += dt;
            this.renderState.time = ctx.time;

            if (this.state === State.DYING) {
                this.deathTimer -= dt;
                this._animate(dt, ctx);
                return;
            }

            this.age += dt;
            if (this.isBaby && this.age >= Config.sim.maturityTime) {
                this.isBaby = false;
                this.maxEnergy = this.stats.maxEnergy;
            }

            if (this.breedCooldown > 0) this.breedCooldown -= dt;
            if (this.panic > 0) this.panic -= dt;
            // Recovers several times slower than it is spent, so repeated harrying tells.
            if (this.state === State.FLEE) this.fleeTime += dt;
            else this.fleeTime = Math.max(0, this.fleeTime - dt * 0.35);
            if (this.eatTimer > 0) this.eatTimer -= dt;
            if (this.foodIgnoreTimer > 0) {
                this.foodIgnoreTimer -= dt;
                if (this.foodIgnoreTimer <= 0) this.foodIgnore = null;
            }
            if (this.disperseTimer > 0) this.disperseTimer -= dt;

            if (this.state === State.TRANQUILIZED) {
                this.tranqTimer -= dt;
                this.energy = Math.min(this.maxEnergy, this.energy + 1.4 * dt);
                if (this.tranqTimer <= 0) {
                    this._setState(State.WANDER);
                    ctx.bus.emit(Events.ANIMAL_WOKE, { animal: this });
                }
                this._animate(dt, ctx);
                return;
            }

            /* --- Needs --------------------------------------------------- */
            const active = this.state !== State.SLEEP && this.state !== State.REST;
            const drain = this.stats.energyDrain * (this.isBaby ? 0.7 : 1) *
                (this.state === State.HUNT || this.state === State.FLEE ? 1.25 : 1) *
                (active ? 1 : 0.25);
            this.energy -= drain * dt;
            this.thirst += Config.sim.thirstRate * dt * (active ? 1 : 0.4);

            if (this.energy <= 0) {
                this.die(ctx, 'starved');
                return;
            }

            this._decide(dt, ctx);
            this._move(dt, ctx);
            this._animate(dt, ctx);
        }

        /**
         * Priorities run outward from survival: escaping a predator beats drinking,
         * drinking beats eating, eating beats wandering.
         */
        _decide(dt, ctx) {
            const night = ctx.isNight;

            /* Threat ------------------------------------------------------ */
            if (this.diet === 'herbivore' && this.stats.huntable) {
                const threat = ctx.nearestThreat(this, this.sense);
                if (threat) {
                    this.panic = Config.sim.fleeMemory;
                    this.targetAnimal = threat;
                    this._setState(State.FLEE);
                    return;
                }
            }
            if (this.panic > 0 && this.state === State.FLEE) {
                // Keep running briefly after losing sight — but never to the point of
                // starving with grass underfoot.
                if (this.energyRatio > 0.45) return;
                this.panic = 0;
            }

            /* Sleep -------------------------------------------------------- */
            if (night && this.diet === 'herbivore') {
                if (this.energyRatio > 0.35 && this.thirst < Config.sim.thirstThreshold) {
                    if (this.state !== State.SLEEP && ctx.rng.chance(dt * 0.6)) {
                        this._setState(State.SLEEP);
                    }
                    if (this.state === State.SLEEP) {
                        this.energy = Math.min(this.maxEnergy, this.energy + 0.9 * dt);
                        return;
                    }
                }
            } else if (this.state === State.SLEEP) {
                this._setState(State.WANDER);
            }

            /* Thirst ------------------------------------------------------- */
            /*
             * Thirst outranks hunger, but not starvation. Without the second clause an
             * animal that cannot reach water — the far bank of a lake, the wrong side
             * of a scarp — walks toward it until it dies with grass under its feet.
             */
            if (this.drinkGiveUp > 0) this.drinkGiveUp -= dt;

            if (this.thirst > Config.sim.thirstThreshold && this.energyRatio > 0.32 &&
                this.drinkGiveUp <= 0) {
                const water = ctx.world.findWaterNear(this.x, this.y, this.sense * 2.2);
                if (water) {
                    this._aimAt(water);
                    // Big animals reach the water from further back than small ones.
                    if (MathUtils.dist(this.x, this.y, water.x, water.y) < 1.3 + this.radius) {
                        this._setState(State.DRINK);
                        this.thirstSeek = 0;
                        this.thirst -= Config.sim.drinkRate * dt;
                        if (this.thirst <= 6) {
                            this.thirst = 0;
                            this._setState(State.WANDER);
                            ctx.bus.emit(Events.ANIMAL_DRANK, { animal: this });
                        }
                        return;
                    }

                    /*
                     * Give up on unreachable water.
                     *
                     * A bank can be visible and still be impossible to get to — across
                     * the lake, behind a scarp, on the far side of a reed bed the
                     * steering will not cross. Without this the animal walks at it
                     * forever: it was the single largest cause of death in the reserve,
                     * with grazers dying of hunger having spent ninety per cent of their
                     * lives travelling toward a drink they never took. After half a
                     * minute of failing, thirst is set aside long enough to go and eat.
                     */
                    this.thirstSeek += dt;
                    if (this.thirstSeek > 30) {
                        this.thirstSeek = 0;
                        this.drinkGiveUp = 70;
                        this.target = null;
                    } else {
                        this._setState(State.FORAGE);   // travelling; reuse the walk pose
                        return;
                    }
                }
            }

            /* Fire ----------------------------------------------------------- */
            /*
             * Above everything, including predators. A zebra that keeps grazing while
             * the grass burns is not a zebra, and a fire that animals ignore is scenery.
             */
            if (ctx.fire) {
                const blaze = ctx.fire(this.x, this.y, this.sense * 2.2);
                if (blaze) {
                    this.panic = Config.sim.fleeMemory;
                    this._setState(State.FLEE);
                    this.target = null;
                    this.targetAnimal = null;
                    // Run directly away; the ordinary flee steering handles the terrain.
                    this.wanderAngle = Math.atan2(this.y - blaze.y, this.x - blaze.x);
                    this.heading = MathUtils.angleLerp(this.heading, this.wanderAngle,
                        MathUtils.clamp01(this.stats.turnRate * 2 * dt));
                    return;
                }
            }

            /* Water-dwellers ------------------------------------------------ */
            // Ahead of hunger, because a hippo's day is spent in the river and its
            // feeding is what fits around that, not the other way round.
            if (this.amphibious && this._wallow(dt, ctx, night)) return;

            /* Hunger -------------------------------------------------------- */
            const hungry = this.energyRatio < 0.82;

            if (this.diet === 'carnivore') {
                const meat = ctx.nearestFood(this, 'meat', this.sense);
                if (meat && hungry) {
                    this.targetFood = meat;
                    this._aimAt(meat);
                    this._setState(State.FORAGE);
                    if (MathUtils.dist(this.x, this.y, meat.x, meat.y) < this.radius + 0.4) {
                        ctx.consumeFood(this, meat);
                        this._setState(State.WANDER);
                    }
                    return;
                }
                /*
                 * Hold the chase.
                 *
                 * Re-running the search every tick meant the hunt was dropped the
                 * moment a fleeing zebra crossed six tiles — which is the first thing a
                 * fleeing zebra does. The predator fell back to wandering, the zebra
                 * calmed down, and the two repeated that until the predator starved.
                 * Once committed, a hunter stays committed until the prey is well clear.
                 */
                const locked = this.targetAnimal;
                if (locked && locked.alive && hungry &&
                    locked.state !== State.TRANQUILIZED &&
                    MathUtils.dist(this.x, this.y, locked.x, locked.y) < this.sense * 2.6) {
                    this._aimAt(locked);
                    this._setState(State.HUNT);
                    if (MathUtils.dist(this.x, this.y, locked.x, locked.y) <
                        this.radius + locked.radius * 0.8) {
                        ctx.killPrey(this, locked);
                        this._setState(State.WANDER);
                    }
                    return;
                }

                const prey = ctx.nearestPrey(this, this.sense);
                if (prey && hungry) {
                    this.targetAnimal = prey;
                    this._aimAt(prey);
                    this._setState(State.HUNT);
                    if (MathUtils.dist(this.x, this.y, prey.x, prey.y) <
                        this.radius + prey.radius * 0.8) {
                        ctx.killPrey(this, prey);
                        this._setState(State.WANDER);
                    }
                    return;
                }

                /*
                 * Scent.
                 *
                 * A lion sees about six tiles. On a reserve of fourteen thousand it will
                 * never blunder into a herd by chance, and the first balance runs killed
                 * every predator before the second day without a single kill. A hungry
                 * carnivore therefore ranges toward the nearest prey it can smell — four
                 * times its sight — but only closes and hunts within sight, so the chase
                 * itself is unchanged.
                 */
                if (this.energyRatio < 0.55) {
                    const distant = ctx.nearestPrey(this, this.sense * 4.5);
                    if (distant) {
                        this._aimAt(distant);
                        this._setState(State.FORAGE);   // travelling; reuse the walk pose
                        return;
                    }
                }
            } else if (hungry) {
                /*
                 * Feeding priority, nearest first.
                 *
                 * Checking scattered forage before grazing was the single largest cause
                 * of starvation: with ninety items over the reserve there was nearly
                 * always one somewhere inside seven tiles of vision, so animals spent
                 * their lives walking toward pickups instead of eating the pasture they
                 * were standing in. Putting grazing first fixed that but went too far
                 * the other way — nothing ever ate the forage the player scattered,
                 * because there was always grass underfoot.
                 *
                 * So: a pickup within a few paces wins, because it is worth far more
                 * than a mouthful of grass and it is right there. Otherwise eat where
                 * you stand. Only when the ground is bare is a long walk to a pickup
                 * worth making.
                 */
                const near = ctx.nearestFood(this, 'plant', this.radius + PLANT_DETOUR);
                if (near && near !== this.foodIgnore && this._takePlant(near, ctx)) return;

                if (this._graze(dt, ctx)) return;

                const far = ctx.nearestFood(this, 'plant', this.sense * 1.35);
                if (far && far !== this.foodIgnore && this._takePlant(far, ctx)) return;

                if (this._seekPasture(ctx)) return;
            }

            /* Rest ---------------------------------------------------------- */
            if (!night && this.energyRatio > 0.88 && ctx.heat > 0.7 &&
                this.diet === 'herbivore' && ctx.rng.chance(dt * 0.15)) {
                this._setState(State.REST);
                return;
            }
            if (this.state === State.REST &&
                (this.stateTime > 6 || this.energyRatio < 0.7)) {
                this._setState(State.WANDER);
            }
            if (this.state === State.REST) return;

            if (this.state !== State.WANDER) this._setState(State.WANDER);
        }

        /**
         * Lie up in the water.
         *
         * Hippos and crocodiles were amphibious in the sense that the terrain would let
         * them in, but nothing ever gave them a reason to go, so they wandered the plain
         * like everything else. Both are water animals and should read as such from
         * across the reserve.
         *
         * A hippo spends the hot part of the day submerged and comes ashore after dark
         * to graze, which is what real ones do and also gives the reserve a rhythm. A
         * crocodile lies in the shallows more or less permanently and only leaves when
         * hunger drives it to hunt.
         *
         * @returns {boolean} True if the animal is settled in water, or heading there.
         */
        _wallow(dt, ctx, night) {
            const world = ctx.world;
            const croc = this.species === 'crocodile';

            // How much this animal wants to be in the water right now.
            let want;
            if (croc) {
                want = this.energyRatio > 0.5 ? 1 : 0.2;
            } else {
                want = night ? 0.15 : MathUtils.lerp(0.55, 1, ctx.heat);
            }

            /*
             * Hunger always wins in the end; nothing lies in the river and starves.
             *
             * With a bare threshold it very nearly did. A hippo only feeds ashore, and
             * it turned back for the water the moment its energy crept a hair above the
             * line — so a day that started badly became a cycle of leaving at 0.34,
             * eating a mouthful, returning at 0.35, and draining again. Once hunger has
             * driven it out it now stays out until it is properly fed, which guarantees
             * a whole feeding trip rather than a nibble.
             */
            if (this.energyRatio < 0.45) this.feedingAshore = true;
            else if (this.feedingAshore && this.energyRatio > 0.8) this.feedingAshore = false;

            if (want < 0.3 || this.feedingAshore) return false;

            /*
             * Dispersal.
             *
             * Left to itself a pod never moves: every hippo asks for the nearest deep
             * water, and the pool it was born in is always the nearest. Calves grew up
             * and stayed, and after half an hour of play one small lake held twenty
             * animals dying and calving in the same water.
             *
             * So a crowded pool pushes its occupants out. The search then explicitly
             * excludes anything close by, which is what makes it find a *different*
             * lake rather than shuffling along the same bank.
             */
            const crowd = ctx.countNear
                ? ctx.countNear(this.x, this.y, POOL_RADIUS, this.species)
                : 0;
            const roomHere = Math.max(2, Math.round(POOL_CAP / Math.max(0.5, this.radius)));

            if (crowd > roomHere) {
                if (this.disperseTimer <= 0) {
                    /*
                     * Search from a point offset in the animal's own direction, so a
                     * crowded pod scatters instead of every member picking the same
                     * "next nearest" water and rebuilding the crowd a lake over.
                     */
                    const bearing = (this.seed % 628) / 100;
                    const lead = POOL_RADIUS * 2.5;
                    const far = world.findWaterDeep(
                        this.x + Math.cos(bearing) * lead,
                        this.y + Math.sin(bearing) * lead,
                        this.sense * 12, WALLOW_DEPTH, POOL_RADIUS * 1.6);
                    if (far) {
                        this._aimAt(far);
                        this._setState(State.FORAGE);
                        // Commit to the journey, or it turns back the moment the pool
                        // behind it thins by one.
                        this.disperseTimer = 90;
                        return true;
                    }
                }
            }

            const depth = world.waterAt(this.x, this.y);
            if (depth >= WALLOW_DEPTH) {
                this._setState(State.WALLOW);
                this.target = null;
                this.speed = MathUtils.damp(this.speed, 0, 6, dt);

                // Drifting slowly rather than sitting rigid, and thirst is not a
                // problem when you are lying in the drink.
                this.thirst = 0;
                if (ctx.rng.chance(dt * 0.25)) this.wanderAngle += ctx.rng.spread(1.4);
                return true;
            }

            const water = world.findWaterDeep(this.x, this.y, this.sense * 3.5, WALLOW_DEPTH);
            if (!water) return false;

            /*
             * Aim past the nearest deep tile, not at it.
             *
             * The nearest one is by definition the near edge of the pool, so a group all
             * converged on the same spot on the shoreline and sat in a heap. A stable
             * per-animal offset, seeded from its own id, sends each one to a different
             * part of the water and further in.
             */
            const spread = 1 + this.radius * 2;
            const a = (this.seed % 360) * (Math.PI / 180);
            const jx = water.x + Math.cos(a) * spread;
            const jy = water.y + Math.sin(a) * spread;
            const deeper = world.waterAt(jx, jy) >= WALLOW_DEPTH;

            this._aimAt(deeper ? { x: jx, y: jy } : water);
            this._setState(State.FORAGE);   // travelling; reuse the walk pose
            return true;
        }

        /**
         * Walk to a scattered plant, and eat it on arrival.
         * @returns {boolean} True if the animal is committed to this item.
         */
        _takePlant(plant, ctx) {
            this.targetFood = plant;
            this._aimAt(plant);
            this._setState(State.FORAGE);
            if (MathUtils.dist(this.x, this.y, plant.x, plant.y) < this.radius + 0.35) {
                ctx.consumeFood(this, plant);
                this._setState(State.WANDER);
            }
            return true;
        }

        /**
         * Eat the ground.
         *
         * The scattered forage items are a bonus; standing grass is the food supply, and
         * it is everywhere the moisture field says it is. A grazer with no pickup in
         * sight puts its head down where it stands, strips the tile, and moves on when
         * the tile runs out — which is what turns a herd into something that drifts
         * across the plain rather than milling on the spot.
         *
         * @returns {boolean} True if the animal is grazing and should not do anything else.
         */
        _graze(dt, ctx) {
            const world = ctx.world;
            const available = world.grazeAt(this.x, this.y, ctx.time);
            if (available < 0.12) return false;
            this._setState(State.FORAGE);
            this.target = null;

            // Rate scales with body size: an elephant strips a tile far faster than a
            // rabbit, and needs to, because its appetite is an order of magnitude larger.
            const rate = GRAZE_RATE * (0.5 + this.radius * 1.6);
            const taken = world.consumeGraze(this.x, this.y, rate * dt, ctx.time);
            if (taken <= 0) return false;

            this.feed(taken * GRAZE_ENERGY * this.maxEnergy);
            this.speed = 0;
            return true;
        }

        /**
         * Head for better pasture.
         *
         * Rather than wandering blindly off a patch it has just stripped, the animal
         * samples a ring around itself and walks to the best of it. Eight probes is
         * enough to find the gradient and cheap enough to run on every hungry grazer.
         *
         * @returns {boolean} True if a better patch was found and is being walked to.
         */
        _seekPasture(ctx) {
            const world = ctx.world;
            const here = world.grazeAt(this.x, this.y, ctx.time);

            /*
             * Three rings, widening.
             *
             * The near ring finds the next mouthful; the middle one gets the animal off
             * a patch it has stripped. The far one is the important one: a third of the
             * reserve carries no grass at all, and a grazer that only ever looked a few
             * tiles ahead would walk into a barren belt, find nothing in any direction,
             * and wander at random until it starved — which was how most of them died.
             *
             * The far ring reads the *static* fertility field rather than what is
             * standing, because it is choosing a direction to march in, not a tile to
             * eat; and for the same reason it does not require the sample point itself
             * to be standable, since the ordinary steering will find the way round
             * whatever is in between.
             */
            if (this._probeRing(ctx, this.sense * 0.8, here, 8, true)) {
                this._setState(State.FORAGE);
                return true;
            }
            if (this._probeRing(ctx, this.sense * 3.2, here, 8, true)) {
                this._setState(State.FORAGE);
                return true;
            }
            if (this._probeRing(ctx, this.sense * 6.5, here, 16, false)) {
                this._setState(State.FORAGE);
                return true;
            }

            /*
             * Last resort for a water-dweller: get ashore.
             *
             * Water is walkable to a hippo, so an animal adrift in a lake with no
             * pasture in sight has nothing to steer toward and wanders at random — which
             * keeps it in the lake. Heading for dry land at least puts it where ordinary
             * foraging can take over.
             */
            if (this.amphibious && ctx.world.waterAt(this.x, this.y) > 0.05) {
                const land = ctx.world.findLandNear(this.x, this.y, this.sense * 5);
                if (land) {
                    this._aimAt(land);
                    this._setState(State.FORAGE);
                    return true;
                }
            }

            return false;
        }

        /**
         * Sample a ring of points and steer to the greenest, if it beats where we are.
         *
         * @param {number} radius Ring radius, in tiles.
         * @param {number} here Grass available underfoot, as the bar to beat.
         * @param {number} spokes How many directions to sample.
         * @param {boolean} standable Whether the sample point itself must be walkable.
         * @returns {boolean} True if a target was set.
         */
        _probeRing(ctx, radius, here, spokes, standable) {
            const world = ctx.world;
            let bestX = 0, bestY = 0, best = here + 0.1;

            for (let i = 0; i < spokes; i++) {
                const a = (i / spokes) * TAU + this.seed;
                const cosA = Math.cos(a);
                const sinA = Math.sin(a);

                /*
                 * Sample along each spoke, not just at its end.
                 *
                 * A ring at a fixed radius is blind to everything inside it. That killed
                 * animals: a hippo was found dead in the shallows with grass one tile
                 * away, because all three rings landed further out — the nearest sampled
                 * three tiles off, the others further still, and none of them ever
                 * looked at the bank it was standing against.
                 */
                for (let step = 1; step <= 3; step++) {
                    const d = radius * (step / 3);
                    const px = this.x + cosA * d;
                    const py = this.y + sinA * d;
                    if (px < 2 || py < 2 ||
                        px >= world.size - 2 || py >= world.size - 2) continue;

                    const v = standable
                        ? world.grazeAt(px, py, ctx.time)
                        : world.fertilityAt(px, py);
                    if (v <= best) continue;
                    if (standable && !this._standable(world, px, py)) continue;

                    best = v; bestX = px; bestY = py;
                }
            }

            if (bestX === 0 && bestY === 0) return false;
            this._aimAt({ x: bestX, y: bestY });
            return true;
        }

        /** Point the animal at a new destination, resetting the progress watchdog. */
        _aimAt(target) {
            if (this.target !== target) this.bestApproach = Infinity;
            this.target = target;
        }

        _setState(next) {
            if (this.state === next) return;
            this.state = next;
            this.stateTime = 0;
            if (next !== State.HUNT) this.targetAnimal = null;
            if (next !== State.FORAGE) this.targetFood = null;
            if (next === State.WANDER || next === State.REST) this.target = null;
        }

        /**
         * Steering and integration in tile space.
         *
         * Terrain matters here in a way it did not in the side-on build: animals must
         * not walk into deep water or up a scarp, so the desired direction is tested
         * against the world before it is taken.
         */
        _move(dt, ctx) {
            const world = ctx.world;

            if (this.state === State.SLEEP || this.state === State.REST ||
                this.state === State.DRINK || this.state === State.WALLOW) {
                this.speed = MathUtils.damp(this.speed, 0, 8, dt);
                return;
            }

            let dx = 0, dy = 0;

            if (this.state === State.FLEE && this.targetAnimal) {
                dx = this.x - this.targetAnimal.x;
                dy = this.y - this.targetAnimal.y;
            } else if (this.state === State.FLEE && !this.target) {
                // Running from something that is not an animal — fire, most likely.
                dx = Math.cos(this.wanderAngle);
                dy = Math.sin(this.wanderAngle);
            } else if (this.target) {
                dx = this.target.x - this.x;
                dy = this.target.y - this.y;
            } else {
                /*
                 * A hungry predator quarters the ground: it holds a heading for much
                 * longer and turns less. Random milling covers almost no distance, and
                 * on a reserve this size a lion that wanders aimlessly simply starves
                 * before it ever meets a zebra.
                 */
                const searching = this.diet === 'carnivore' && this.energyRatio < 0.8;
                this.wanderTimer -= dt;
                if (this.wanderTimer <= 0) {
                    this.wanderTimer = searching
                        ? ctx.rng.range(8, 16)
                        : ctx.rng.range(2, 5);
                    this.wanderAngle += ctx.rng.spread(searching ? 0.7 : 1.5);
                }
                dx = Math.cos(this.wanderAngle);
                dy = Math.sin(this.wanderAngle);
            }

            const len = Math.hypot(dx, dy) || 1;
            let desired = Math.atan2(dy / len, dx / len);

            /* --- Terrain avoidance ---------------------------------------- */
            // Probe ahead; if the way is blocked, sweep for the nearest heading that
            // is not. Turning by a fixed amount just walks animals into corners.
            /*
             * The probe reaches further ahead than "arrived" does, which for anything
             * approaching the edge of water was fatal: an elephant probing 2.6 tiles
             * ahead was steered off the bank before it could ever get within drinking
             * range, so it circled the lake until it starved. Close to a target the
             * sweep is switched off and the step test below is left to do the work —
             * long-range steering avoids obstacles, the hard check stops at the shore.
             */
            const probe = 1.4 + this.radius;
            const arriving = this.target &&
                MathUtils.dist(this.x, this.y, this.target.x, this.target.y) < probe + 1.2;

            if (!this.flies && !arriving) {
                if (!this._passable(world, desired, probe)) {
                    let found = false;
                    for (let step = 1; step <= 6 && !found; step++) {
                        for (const sign of [1, -1]) {
                            const a = desired + sign * step * 0.5;
                            if (this._passable(world, a, probe)) {
                                desired = a;
                                found = true;
                                break;
                            }
                        }
                    }
                    if (!found) desired += Math.PI;
                    this.wanderAngle = desired;
                }
            }

            // Keep inside the reserve.
            const n = world.size;
            const margin = 5;
            if (this.x < margin || this.x > n - margin ||
                this.y < margin || this.y > n - margin) {
                desired = Math.atan2(n / 2 - this.y, n / 2 - this.x);
                this.wanderAngle = desired;
            }

            /* --- Integrate -------------------------------------------------- */
            const turn = this.stats.turnRate * (this.state === State.FLEE ? 1.6 : 1);
            this.heading = MathUtils.angleLerp(this.heading, desired,
                MathUtils.clamp01(turn * dt));
            this.facing = this.heading;

            this.speed = MathUtils.damp(this.speed, this.maxSpeed, 5, dt);

            const stepX = Math.cos(this.heading) * this.speed * dt;
            const stepY = Math.sin(this.heading) * this.speed * dt;
            const moved = this._step(world, stepX, stepY, dt);

            this.x = MathUtils.clamp(this.x, 1, n - 2);
            this.y = MathUtils.clamp(this.y, 1, n - 2);

            /*
             * Stuck detection.
             *
             * Anything with a target recomputes its heading from that target every
             * tick, so nudging the wander angle when a step failed did nothing at all:
             * the animal simply pushed into the shoreline for ever, at full speed, with
             * its legs still cycling — which is what "stuck and shaking in place" was.
             *
             * Sliding along the obstruction resolves nearly all of it. What is left is
             * a genuine dead end, and the only answer there is to give up.
             */
            if (moved > this.speed * dt * 0.35) this.stuck = 0;
            else this.stuck += dt;

            /*
             * Progress, not motion.
             *
             * Measuring whether the animal moved at all is not enough: one was found
             * dead of starvation standing on full pasture, because it had locked onto a
             * forage plant two tiles away that it could not reach, and jittered back and
             * forth at it until it died — never once eating the grass under its feet.
             * The movement test saw motion every tick and never fired.
             *
             * What matters is whether it is getting closer. If the best approach has not
             * improved in a few seconds the destination is unreachable, whatever the
             * reason, and it is abandoned.
             */
            if (this.target) {
                const d = MathUtils.dist(this.x, this.y, this.target.x, this.target.y);
                if (d < this.bestApproach - 0.12) {
                    this.bestApproach = d;
                    this.noProgress = 0;
                } else {
                    this.noProgress += dt;
                }
            } else {
                this.bestApproach = Infinity;
                this.noProgress = 0;
            }

            if (this.stuck <= 1.2 && this.noProgress <= 3.5) return;

            // Refuse this particular item for a while, or it is picked straight back up.
            if (this.targetFood) {
                this.foodIgnore = this.targetFood;
                this.foodIgnoreTimer = 14;
            }
            this.stuck = 0;
            this.noProgress = 0;
            this.bestApproach = Infinity;
            this.target = null;
            this.targetFood = null;

            // Turn away from whatever is in front and commit to it for a while, so the
            // next tick does not immediately steer back into the same corner.
            this.wanderAngle = this.heading + Math.PI + ctx.rng.spread(1.1);
            this.heading = this.wanderAngle;
            this.wanderTimer = ctx.rng.range(2.5, 4.5);
            this.speed = 0;
            if (this.state !== State.FLEE) this._setState(State.WANDER);
        }

        /**
         * Take a step, sliding along whatever blocks it.
         *
         * A single all-or-nothing test against the destination means an animal walking
         * at a shoreline on a diagonal is stopped dead, even though it could perfectly
         * well travel along the bank. Trying each axis on its own recovers that, and it
         * is what turns "pinned against the water" into "walks around the lake".
         *
         * @returns {number} Distance actually covered.
         */
        _step(world, dx, dy, dt) {
            if (this.flies) {
                this.x += dx;
                this.y += dy;
                return Math.hypot(dx, dy);
            }

            if (this._standable(world, this.x + dx, this.y + dy)) {
                this.x += dx;
                this.y += dy;
                return Math.hypot(dx, dy);
            }

            // Slide: keep whichever component the ground still allows.
            let movedX = 0, movedY = 0;
            if (dx !== 0 && this._standable(world, this.x + dx, this.y)) {
                this.x += dx;
                movedX = dx;
            }
            if (dy !== 0 && this._standable(world, this.x, this.y + dy)) {
                this.y += dy;
                movedY = dy;
            }

            // Sliding means the heading no longer matches the travel, so bend the
            // facing toward what actually happened rather than moonwalking.
            if (movedX || movedY) {
                this.heading = MathUtils.angleLerp(this.heading,
                    Math.atan2(movedY, movedX), MathUtils.clamp01(6 * dt));
                this.facing = this.heading;
            }
            return Math.hypot(movedX, movedY);
        }

        _passable(world, angle, dist) {
            return this._standable(world,
                this.x + Math.cos(angle) * dist,
                this.y + Math.sin(angle) * dist);
        }

        /** Can this particular animal stand here? Amphibians may enter water. */
        _standable(world, tx, ty) {
            if (tx < 1 || ty < 1 || tx >= world.size - 1 || ty >= world.size - 1) return false;
            if (world.isBlocked(tx, ty)) return false;
            const depth = world.waterAt(tx, ty);
            if (depth > Config.terrain.water.wadeDepth && !this.amphibious) return false;
            return world.slopeAt(tx, ty) < Config.terrain.maxWalkableSlope;
        }

        /** Derive the pose the renderer draws. */
        _animate(dt, ctx) {
            const rs = this.renderState;

            if (this.flies) {
                this.phase = MathUtils.wrap(this.phase + dt * 2.2, 1);
            } else {
                // Gait advances with distance, so hooves never skate.
                this.phase = MathUtils.wrap(this.phase + this.speed * dt * 0.62, 1);
            }

            rs.facing = this.facing;
            rs.phase = this.phase;
            rs.speed01 = MathUtils.damp(rs.speed01,
                MathUtils.clamp01(this.speed / Math.max(0.01, this.runSpeed)), 8, dt);
            rs.seed = this.seed;

            const down = (this.state === State.FORAGE && this.eatTimer > 0) ||
                this.state === State.DRINK ? 1 :
                (this.state === State.REST ? 0.4 : 0);
            this.headDown = MathUtils.damp(this.headDown, down, 3.5, dt);
            rs.headDown = this.headDown;

            /*
             * Collapse. Eased rather than snapped, so a darted animal visibly sinks
             * onto its knees over a second or so and climbs back up when it comes
             * round — the moment of going down is what tells the player the shot landed.
             */
            const wantDown = this.state === State.TRANQUILIZED ? 1 :
                (this.state === State.SLEEP ? 0.55 : 0);
            this.downAmount = MathUtils.damp(this.downAmount, wantDown, 2.4, dt);
            rs.down = this.downAmount;

            /*
             * Growing up.
             *
             * Newborns were simulated as young — slower, smaller radius, less energy —
             * but drawn at full adult size, so nothing in the reserve ever looked like
             * a calf. This eases from 1 at birth to 0 at maturity, so a young animal
             * visibly grows into the herd rather than popping to adult size the instant
             * its timer runs out.
             */
            rs.baby = this.isBaby
                ? 1 - MathUtils.clamp01(this.age / Config.sim.maturityTime)
                : 0;

            /*
             * How much of the animal is under water.
             *
             * Derived from the depth it is actually standing in rather than from any
             * state, so a zebra wading a shallow crossing is knee-deep and a hippo out
             * in the river is submerged to the eyes, and neither needs to be a special
             * case.
             */
            const depth = ctx.world ? ctx.world.waterAt(this.x, this.y) : 0;
            rs.submerged = this.flies ? 0 : MathUtils.clamp01(depth / 0.85);

            this.blinkTimer -= dt;
            if (this.blinkTimer <= 0) {
                this.blinkTimer = 2 + Math.random() * 5;
                this._blink = 0.18;
            }
            if (this._blink > 0) this._blink -= dt;
            // A sleeping or sedated animal keeps its eyes shut.
            rs.blink = (this.isDown && this.state !== State.DYING) ? 1 :
                (this._blink > 0 ? 1 : 0);
            rs.earFlick = Math.sin(rs.time * 2.1 + this.seed) * 0.3;
        }

        /* -------------------------------------------------------------- *
         * Events
         * -------------------------------------------------------------- */

        feed(amount) {
            this.energy = Math.min(this.maxEnergy, this.energy + amount);
            this.eatTimer = 1.4;
        }

        tranquilize(duration) {
            if (this.state === State.DYING) return false;
            this._setState(State.TRANQUILIZED);
            this.tranqTimer = duration;
            this.speed = 0;
            return true;
        }

        die(ctx, cause) {
            if (!this.alive) return;
            this.alive = false;
            this.state = State.DYING;
            this.stateTime = 0;
            this.deathTimer = 0.9;
            this.speed = 0;
            ctx.bus.emit(cause === 'eaten' ? Events.ANIMAL_EATEN : Events.ANIMAL_STARVED,
                { animal: this, cause });
        }

        get isExpired() {
            return this.state === State.DYING && this.deathTimer <= 0;
        }

        get fade() {
            if (this.state !== State.DYING) return 1;
            return MathUtils.clamp01(this.deathTimer / 0.9);
        }
    }

    IsoAnimal.State = State;
    IsoAnimal.UNITS_PER_TILE = UNITS_PER_TILE;
    Safari.IsoAnimal = IsoAnimal;

})(window.Safari);
