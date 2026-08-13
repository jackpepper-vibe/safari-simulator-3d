/**
 * Safari Simulator — Pressure on the reserve.
 *
 * Drought, wildfire and poachers: the three things that arrive uninvited and make
 * managing a reserve different from watching one.
 *
 * They are deliberately built out of fields the simulation already had. Drought is the
 * grass regrowth rate and the water depth turned down, so the herds converge on what
 * water is left and the predators follow them there without a line of code telling them
 * to. Fire is the standing-grass field set to zero along a front that walks with the
 * wind. Only the poachers are new agents, and they exist to give the ranger an
 * adversary rather than a chore.
 *
 * Nothing here scripts an outcome. It changes the conditions and lets the ecology
 * answer, which is the whole reason the ecology was worth building.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, Events, Rng, IsoAnimal, IsoVehicle } = Safari;
    const TAU = MathUtils.TAU;

    /* ------------------------------------------------------------------ *
     * Drought
     * ------------------------------------------------------------------ */

    class Drought {
        constructor() {
            this.active = false;
            /** 0 to 1, eased in and out so it arrives as a season, not a switch. */
            this.severity = 0;
            this.timer = 0;
            this.duration = 0;
        }

        begin(days, bus) {
            if (this.active) return;
            this.active = true;
            this.duration = days * Config.time.secondsPerDay;
            this.timer = this.duration;
            bus.emit(Events.DROUGHT_STARTED, { days });
            bus.emit(Events.TOAST, { message: 'Drought sets in', tone: 'bad' });
        }

        update(dt, bus) {
            if (this.active) {
                this.timer -= dt;
                if (this.timer <= 0) {
                    this.active = false;
                    bus.emit(Events.DROUGHT_ENDED, {});
                    bus.emit(Events.TOAST, { message: 'The rains return', tone: 'good' });
                }
            }

            // A quarter of a day to build and the same to break, so the reserve browns
            // and recovers rather than flicking between states.
            const ramp = dt / (Config.time.secondsPerDay * 0.25);
            const want = this.active ? 1 : 0;
            this.severity = MathUtils.clamp01(this.severity + Math.sign(want - this.severity) *
                Math.min(ramp, Math.abs(want - this.severity)));
        }
    }

    /* ------------------------------------------------------------------ *
     * Wildfire
     * ------------------------------------------------------------------ */

    /**
     * A fire front, as a set of burning tiles that spreads into its neighbours.
     *
     * Spread is biased downwind and by how much grass a tile is carrying, so a fire runs
     * fast through standing pasture, crawls over grazed ground and stops dead at water
     * and bare rock. That means where the herds have been actually changes where the
     * fire goes, which is the kind of consequence the simulation should be producing on
     * its own.
     */
    class Wildfire {
        constructor(world, rng) {
            this.world = world;
            this.rng = rng;
            /** @type {Map<number, {x:number,y:number,life:number,heat:number}>} */
            this.burning = new Map();
            /** Tiles already burnt, kept so the scar renders and cannot reignite. */
            this.burnt = new Set();
            this.spreadTimer = 0;
            this.active = false;
            /** Seconds since ignition; the front loses its drive as it ages. */
            this.age = 0;
        }

        get size() {
            return this.burning.size;
        }

        /** Set light to a tile, if it will take. */
        ignite(tx, ty, bus) {
            const w = this.world;
            const x = tx | 0, y = ty | 0;
            if (!w.inBounds(x, y)) return false;
            const k = w.index(x, y);
            if (this.burning.has(k) || this.burnt.has(k)) return false;
            if (w.water[k] > 0.02) return false;
            if (w.fertility[k] < 0.2) return false;

            this.burning.set(k, { x: x + 0.5, y: y + 0.5, life: 0, heat: 0 });
            if (!this.active) {
                this.active = true;
                this.age = 0;
                this.burnt.clear();
                if (bus) {
                    bus.emit(Events.FIRE_STARTED, { x, y });
                    bus.emit(Events.TOAST, { message: 'Fire on the reserve', tone: 'bad' });
                }
            }
            return true;
        }

        update(dt, ctx) {
            if (!this.burning.size) {
                if (this.active) {
                    this.active = false;
                    ctx.bus.emit(Events.FIRE_OUT, { scar: this.burnt.size });
                    ctx.bus.emit(Events.TOAST, { message: 'The fire is out', tone: 'good' });
                }
                return;
            }

            const w = this.world;
            this.age += dt;

            /* --- Burn down ------------------------------------------------- */
            for (const [k, cell] of this.burning) {
                cell.life += dt;
                cell.heat = Math.min(1, cell.heat + dt * 2);

                // Burning strips the tile: this is the same field grazing eats from, so
                // a burnt paddock is worthless to a herd until it grows back.
                w.graze[k] = 0;
                w.grazeStamp[k] = ctx.time;

                if (cell.life > BURN_TIME) {
                    this.burning.delete(k);
                    this.burnt.add(k);
                }
            }

            /* --- Spread ---------------------------------------------------- */
            this.spreadTimer -= dt;
            if (this.spreadTimer > 0) return;
            this.spreadTimer = SPREAD_INTERVAL;

            // Wind direction as a vector; the fire runs with it.
            const windAngle = ctx.windAngle || 0;
            const wx = Math.cos(windAngle);
            const wy = Math.sin(windAngle);
            /*
             * Spread pressure, and how it dies.
             *
             * The first version had no upper bound on any of this and burnt seventy-
             * seven per cent of the reserve in one go — not a wildfire, an extinction
             * event. A fire now loses its drive as it ages and stops entirely at the
             * lifetime, which is what actually happens: the front outruns its fuel, the
             * wind shifts, and it dies. Tuned to scar a few hundred tiles, so losing a
             * corner of the reserve hurts without ending the run.
             */
            const fade = MathUtils.clamp01(1 - this.age / FIRE_LIFETIME);
            if (fade <= 0) return;

            /*
             * A hard ceiling on the burn.
             *
             * Fading the spread with age was not enough by itself. A front that ignites
             * two neighbours per round doubles, and doubling gets very large before a
             * gentle fade catches it: across three unattended runs the same code scarred
             * eighty-eight tiles once and sixteen hundred the next. Bounding the total
             * makes a fire a disaster of predictable size rather than a coin toss
             * between an inconvenience and the end of the reserve.
             */
            if (this.burnt.size + this.burning.size >= FIRE_MAX_TILES) return;

            const drive = (0.10 + MathUtils.clamp01(ctx.wind || 1) * 0.14 +
                (ctx.drought || 0) * 0.18) * fade;

            const seeds = [];
            for (const cell of this.burning.values()) {
                if (cell.life > BURN_TIME * 0.7) continue;
                seeds.push(cell);
            }

            for (const cell of seeds) {
                for (let i = 0; i < 8; i++) {
                    const a = (i / 8) * TAU;
                    const nx = (cell.x + Math.cos(a)) | 0;
                    const ny = (cell.y + Math.sin(a)) | 0;
                    if (!w.inBounds(nx, ny)) continue;

                    const k = w.index(nx, ny);
                    if (this.burning.has(k) || this.burnt.has(k)) continue;
                    if (w.water[k] > 0.02 || w.fertility[k] < 0.2) continue;

                    // Downwind spreads readily; upwind barely at all.
                    const along = Math.cos(a) * wx + Math.sin(a) * wy;
                    // Grazed ground is a firebreak: the herds' own wear decides where
                    // the fire can run, which is the consequence worth having here.
                    const fuel = w.grazeAt(nx, ny, ctx.time) / Math.max(0.05, w.fertility[k]);
                    if (fuel < 0.3) continue;

                    const chance = drive *
                        (0.12 + 0.88 * MathUtils.clamp01((along + 1) / 2)) * fuel;

                    if (this.rng.chance(chance)) this.ignite(nx, ny, ctx.bus);
                }
            }
        }

        /** Is this point inside the fire? Used by animals to decide to run. */
        nearest(tx, ty, radius) {
            let best = null;
            let bestDist = radius;
            for (const cell of this.burning.values()) {
                const d = Math.hypot(cell.x - tx, cell.y - ty);
                if (d < bestDist) { bestDist = d; best = cell; }
            }
            return best;
        }
    }

    /** Simulated seconds a raid will spend on the reserve before giving up. */
    const RAID_TIME = 150;

    const BURN_TIME = 5.5;
    const SPREAD_INTERVAL = 0.85;
    /** Simulated seconds after which a fire can no longer spread at all. */
    const FIRE_LIFETIME = 70;
    /** And a ceiling on how much ground one fire may take, whatever the conditions. */
    const FIRE_MAX_TILES = 340;

    /* ------------------------------------------------------------------ *
     * Poachers
     * ------------------------------------------------------------------ */

    /**
     * A poacher's truck, entering from the boundary and hunting the biggest animals it
     * can find.
     *
     * Built on the same vehicle base as the ranger's fleet, so it routes around lakes
     * and gets stuck no more than anything else does. It runs for the edge when the
     * ranger closes on it, which is what turns "there are poachers" into a chase.
     */
    class Poacher extends IsoVehicle {
        constructor(tx, ty) {
            super(tx, ty, { speed: 250, wheelR: 6, probe: 2, turnRate: 2.2 });

            /** 'hunting' | 'fleeing' | 'gone' */
            this.job = 'hunting';
            this.quarry = null;
            this.cooldown = 6;
            this.kills = 0;
            this.exit = null;
            this.scared = 0;
            /** A raid has a limited window before they cut their losses and go. */
            this.patience = RAID_TIME;
        }

        /** Frighten it off: the ranger has got close, or put a dart in it. */
        scare(amount) {
            this.scared = Math.min(1.6, this.scared + amount);
            if (this.scared >= 1 && this.job === 'hunting') this.job = 'fleeing';
        }

        update(dt, ctx) {
            if (this.cooldown > 0) this.cooldown -= dt;

            this.patience -= dt;
            if (this.patience <= 0 && this.job === 'hunting') this.job = 'fleeing';

            switch (this.job) {
                case 'hunting': {
                    const q = this.quarry;
                    if (!q || !q.alive) {
                        this.quarry = this._findQuarry(ctx);
                        if (!this.quarry) { this.job = 'fleeing'; break; }
                    } else {
                        this.driveTo(q.x, q.y, ctx.world);
                        const d = Math.hypot(q.x - this.x, q.y - this.y);
                        if (d < 3.2 && this.cooldown <= 0) {
                            this.cooldown = 9;
                            this.kills++;
                            ctx.bus.emit(Events.POACHER_KILLED_ANIMAL, { animal: q });
                            q.die(ctx, 'poached');
                            this.quarry = null;
                            // Two is a raid; more than that and the reserve is a farm.
                            if (this.kills >= 2) this.job = 'fleeing';
                        }
                    }
                    break;
                }

                case 'fleeing': {
                    if (!this.exit) this.exit = this._nearestEdge(ctx.world);
                    this.driveTo(this.exit.x, this.exit.y, ctx.world);
                    if (Math.hypot(this.exit.x - this.x, this.exit.y - this.y) < 3) {
                        this.job = 'gone';
                    }
                    // Long past caring: a truck that cannot find its way out should not
                    // haunt the reserve for ever.
                    if (this.patience < -RAID_TIME) this.job = 'gone';
                    break;
                }

                default:
                    break;
            }

            this.scared = Math.max(0, this.scared - dt * 0.12);
            if (!this.drive(dt, ctx, this.job === 'fleeing' ? 1 : 0.85)) {
                // Nowhere to go: give up on this quarry rather than sitting still.
                this.quarry = null;
                if (this.job === 'fleeing') this.exit = null;
            }
            this.renderState.poacher = true;
        }

        /** The biggest huntable animal within reach: poachers want trophies. */
        _findQuarry(ctx) {
            let best = null;
            let bestScore = -Infinity;
            for (const a of ctx.ecology.animals) {
                if (!a.alive || a.diet !== 'herbivore') continue;
                const d = Math.hypot(a.x - this.x, a.y - this.y);
                if (d > 40) continue;
                const score = a.radius * 12 - d;
                if (score > bestScore) { bestScore = score; best = a; }
            }
            return best;
        }

        _nearestEdge(world) {
            const n = world.size;
            const options = [
                { x: 3, y: this.y }, { x: n - 3, y: this.y },
                { x: this.x, y: 3 }, { x: this.x, y: n - 3 }
            ];
            let best = options[0];
            let bestDist = Infinity;
            for (const o of options) {
                const d = Math.hypot(o.x - this.x, o.y - this.y);
                if (d < bestDist) { bestDist = d; best = o; }
            }
            return best;
        }
    }

    /* ------------------------------------------------------------------ *
     * Scheduler
     * ------------------------------------------------------------------ */

    /**
     * Decides when the reserve gets a bad day.
     *
     * Events are spaced by a minimum quiet period and weighted by conditions, so a fire
     * is far likelier in a drought than after rain — which is both true and gives the
     * player a reason to read the weather rather than the clock.
     */
    class IsoEvents {
        constructor(bus, world, seed) {
            this.bus = bus;
            this.world = world;
            this.rng = new Rng((seed || 1) ^ 0x5EED);

            this.drought = new Drought();
            this.fire = new Wildfire(world, this.rng);
            /** @type {Poacher[]} */
            this.poachers = [];

            this.quiet = Config.events.gracePeriod;
            this.stats = { droughts: 0, fires: 0, raids: 0, poached: 0, burnt: 0 };

            bus.on(Events.POACHER_KILLED_ANIMAL, () => { this.stats.poached++; });
            bus.on(Events.DROUGHT_STARTED, () => { this.stats.droughts++; });
            bus.on(Events.FIRE_STARTED, () => { this.stats.fires++; });
        }

        /** Drought multiplier on grass regrowth, read by TileWorld. */
        get regrowthScale() {
            return MathUtils.lerp(1, Config.events.droughtRegrowth, this.drought.severity);
        }

        /** How far the pools have drawn down, 0 to 1. */
        get waterDrawdown() {
            return this.drought.severity * Config.events.droughtWaterLoss;
        }

        update(dt, ctx) {
            this.drought.update(dt, this.bus);

            ctx.drought = this.drought.severity;
            this.fire.update(dt, ctx);

            for (let i = this.poachers.length - 1; i >= 0; i--) {
                const p = this.poachers[i];
                p.update(dt, ctx);
                if (p.job === 'gone') {
                    this.poachers.splice(i, 1);
                    this.bus.emit(Events.POACHER_DRIVEN_OFF, { kills: p.kills });
                }
            }

            /* --- Scheduling -------------------------------------------------- */
            if (this.quiet > 0) { this.quiet -= dt; return; }

            const day = Config.time.secondsPerDay;
            const roll = this.rng.next();
            const dry = this.drought.severity;

            // Fire is much likelier in a drought, and impossible in the rain.
            const fireChance = (ctx.rain > 0.2 ? 0 : Config.events.fireChance * (1 + dry * 5));
            const droughtChance = this.drought.active ? 0 : Config.events.droughtChance;
            const raidChance = Config.events.raidChance *
                (ctx.population > 12 ? 1 : 0.2);

            const perTick = dt / day;
            if (roll < fireChance * perTick && !this.fire.active) {
                this._startFire(ctx);
                this.quiet = Config.events.quietPeriod;
            } else if (roll < (fireChance + droughtChance) * perTick) {
                const span = Config.events.droughtDays;
                this.drought.begin(this.rng.range(span[0], span[1]), this.bus);
                this.quiet = Config.events.quietPeriod;
            } else if (roll < (fireChance + droughtChance + raidChance) * perTick) {
                this._startRaid(ctx);
                this.quiet = Config.events.quietPeriod;
            }
        }

        /** Light a fire somewhere with fuel, away from the player's station. */
        _startFire(ctx) {
            const w = this.world;
            for (let attempt = 0; attempt < 200; attempt++) {
                const x = this.rng.range(6, w.size - 6);
                const y = this.rng.range(6, w.size - 6);
                if (w.fertilityAt(x, y) < 0.45) continue;
                if (w.waterAt(x, y) > 0) continue;
                if (this.fire.ignite(x, y, this.bus)) {
                    // A front, not a spark, or it reads as a rendering glitch.
                    for (let i = 0; i < 5; i++) {
                        this.fire.ignite(x + this.rng.spread(2), y + this.rng.spread(2), null);
                    }
                    return;
                }
            }
        }

        /** Send in a poacher from the boundary. */
        _startRaid(ctx) {
            const n = this.world.size;
            const side = this.rng.int(0, 3);
            const along = this.rng.range(8, n - 8);
            const spot = [
                { x: 4, y: along }, { x: n - 4, y: along },
                { x: along, y: 4 }, { x: along, y: n - 4 }
            ][side];

            // The edge point may be lake or scarp; find drivable ground near it, or the
            // truck spawns jammed and never moves — which is how the first one behaved.
            const probe = new Poacher(spot.x, spot.y);
            let placed = false;
            for (let r = 0; r <= 14 && !placed; r++) {
                for (let a = 0; a < 12 && !placed; a++) {
                    const ang = (a / 12) * TAU;
                    const px = spot.x + Math.cos(ang) * r;
                    const py = spot.y + Math.sin(ang) * r;
                    if (probe._standable(this.world, px, py)) {
                        probe.x = probe.targetX = probe.destX = px;
                        probe.y = probe.targetY = probe.destY = py;
                        placed = true;
                    }
                }
            }
            if (!placed) return;

            const p = probe;
            this.poachers.push(p);
            this.stats.raids++;
            this.bus.emit(Events.POACHER_SIGHTED, { x: spot.x, y: spot.y });
            this.bus.emit(Events.TOAST, { message: 'Poachers on the reserve', tone: 'bad' });
        }

        get burntTiles() {
            return this.fire.burnt.size;
        }
    }

    IsoEvents.Drought = Drought;
    IsoEvents.Wildfire = Wildfire;
    IsoEvents.Poacher = Poacher;
    Safari.IsoEvents = IsoEvents;

})(window.Safari);
