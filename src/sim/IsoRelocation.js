/**
 * Safari Simulator — Relocation.
 *
 * What happens to an animal after it is darted. The chain is deliberately physical and
 * entirely visible on the map, because that is the point of it: a sedated animal is not
 * a number that ticks up, it is a body lying in the grass that somebody has to come and
 * fetch.
 *
 *   1. The ranger darts an animal; it goes down.
 *   2. The loader leaves the station, drives to it, lifts it into the cradle.
 *   3. It carries the animal back to the lorry and loads it aboard.
 *   4. When the lorry is full — or the player sends it early — it drives to the gate at
 *      the boundary, the barrier lifts, and the animals leave the reserve.
 *   5. Both vehicles return to the station.
 *
 * Every step is a real journey across real ground, so relocating a herd out of an
 * overgrazed reserve costs time, and the player can see it costing time.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, Events, IsoVehicle, IsoAnimal } = Safari;

    /** How many animals the lorry takes before it runs them out. */
    const LORRY_CAPACITY = 4;
    /** Seconds spent lifting an animal into the cradle, and unloading it again. */
    const LIFT_TIME = 2.2;
    /** How long a part load sits before the lorry takes it out anyway. */
    const PART_LOAD_WAIT = 90;

    /* ------------------------------------------------------------------ *
     * Loader
     * ------------------------------------------------------------------ */

    class IsoLoader extends IsoVehicle {
        constructor(tx, ty) {
            super(tx, ty, { speed: 210, wheelR: 5.4, probe: 1.6, turnRate: 2.2 });

            /** 'idle' | 'fetching' | 'lifting' | 'delivering' | 'unloading' */
            this.job = 'idle';
            /** The animal being collected, then carried. */
            this.quarry = null;
            this.cargo = null;
            this.liftTimer = 0;
            /** Cradle arms, 0 down to 1 up. */
            this.armLift = 1;
        }

        get busy() {
            return this.job !== 'idle';
        }

        /** Send the loader out to collect a sedated animal. */
        collect(animal) {
            this.quarry = animal;
            this.job = 'fetching';
        }

        update(dt, ctx) {
            const lorry = ctx.lorry;

            switch (this.job) {
                case 'fetching': {
                    const q = this.quarry;
                    // A quarry that woke up, died or was eaten is no longer a job.
                    if (!q || !q.alive || q.state !== IsoAnimal.State.TRANQUILIZED) {
                        this._abandon(ctx, 'The animal came round before the loader arrived');
                        break;
                    }
                    this.driveTo(q.x, q.y, ctx.world);
                    this.armLift = MathUtils.damp(this.armLift, 0, 3, dt);

                    if (Math.hypot(q.x - this.x, q.y - this.y) < 1.6) {
                        this.job = 'lifting';
                        this.liftTimer = LIFT_TIME;
                    }
                    break;
                }

                case 'lifting': {
                    this.driveTo(this.x, this.y);
                    this.liftTimer -= dt;
                    this.armLift = MathUtils.damp(this.armLift,
                        1 - MathUtils.clamp01(this.liftTimer / LIFT_TIME), 4, dt);

                    if (this.liftTimer <= 0) {
                        const q = this.quarry;
                        if (q && q.alive) {
                            this.cargo = q.species;
                            ctx.ecology.remove(q);
                            ctx.bus.emit(Events.ANIMAL_LOADED, { animal: q, by: this });
                        }
                        this.quarry = null;
                        this.job = this.cargo ? 'delivering' : 'idle';
                    }
                    break;
                }

                case 'delivering': {
                    if (!lorry) { this.job = 'idle'; break; }
                    this.driveTo(lorry.x, lorry.y, ctx.world);
                    this.armLift = 1;

                    if (Math.hypot(lorry.x - this.x, lorry.y - this.y) < 3.2) {
                        this.job = 'unloading';
                        this.liftTimer = LIFT_TIME;
                    }
                    break;
                }

                case 'unloading': {
                    this.driveTo(this.x, this.y);
                    this.liftTimer -= dt;
                    this.armLift = MathUtils.damp(this.armLift, 0.2, 4, dt);

                    if (this.liftTimer <= 0) {
                        if (lorry && this.cargo) lorry.load(this.cargo, ctx);
                        this.cargo = null;
                        this.job = 'idle';
                    }
                    break;
                }

                default:
                    this.armLift = MathUtils.damp(this.armLift, 1, 3, dt);
                    this.returnHome(dt, 3);
            }

            if (!this.drive(dt, ctx)) {
                this._abandon(ctx, 'The loader could not reach it');
            }

            const rs = this.renderState;
            rs.cargo = this.cargo;
            rs.lift = this.armLift;
        }

        /** Give up on the current job and go home, keeping any cargo aboard. */
        _abandon(ctx, message) {
            if (this.job === 'fetching' && message) {
                ctx.bus.emit(Events.TOAST, { message, tone: 'bad' });
            }
            this.quarry = null;
            this.job = this.cargo ? 'delivering' : 'idle';
            if (!this.cargo && this.home) this.driveTo(this.home.x, this.home.y, ctx.world);
        }
    }

    /* ------------------------------------------------------------------ *
     * Lorry
     * ------------------------------------------------------------------ */

    class IsoLorry extends IsoVehicle {
        constructor(tx, ty) {
            super(tx, ty, { speed: 190, wheelR: 6.8, probe: 2.4, turnRate: 1.7 });

            /** 'waiting' | 'departing' | 'returning' */
            this.job = 'waiting';
            /** @type {string[]} Species ids aboard. */
            this.cargo = [];
            this.gate = null;
            /** Seconds a part load has been sitting on the deck. */
            this.waiting = 0;
        }

        get full() {
            return this.cargo.length >= LORRY_CAPACITY;
        }

        get capacity() {
            return LORRY_CAPACITY;
        }

        load(species, ctx) {
            this.cargo.push(species);
            ctx.bus.emit(Events.LORRY_LOADED, {
                species, count: this.cargo.length, capacity: LORRY_CAPACITY
            });
            if (this.full) this.depart(ctx);
        }

        /** Run whatever is aboard out through the gate. */
        depart(ctx) {
            if (!this.cargo.length || this.job !== 'waiting') return false;
            this.job = 'departing';
            this.waiting = 0;
            ctx.bus.emit(Events.TOAST, {
                message: 'Lorry away with ' + this.cargo.length +
                    (this.cargo.length === 1 ? ' animal' : ' animals'),
                tone: 'cool'
            });
            return true;
        }

        update(dt, ctx) {
            const gate = this.gate;

            switch (this.job) {
                case 'departing': {
                    if (!gate) { this.job = 'returning'; break; }
                    // Drive at the far side of the gateway, not at the waiting point:
                    // aiming for the approach parked the lorry short of the barrier
                    // with nothing left to trigger on.
                    const aim = gate.exit || gate;
                    this.driveTo(aim.x, aim.y, ctx.world);
                    gate.wanted = true;

                    if (Math.hypot(gate.x - this.x, gate.y - this.y) < 4.2) {
                        /*
                         * Through the gate. The animals are counted out here rather than
                         * on being darted, so the score only moves when they are
                         * genuinely off the reserve — which is what makes the drive
                         * across the map mean something.
                         */
                        for (const species of this.cargo) {
                            ctx.bus.emit(Events.ANIMAL_RELOCATED, { species });
                        }
                        this.cargo.length = 0;
                        this.job = 'returning';
                    }
                    break;
                }

                case 'returning': {
                    if (gate) gate.wanted = false;
                    if (this.home) this.driveTo(this.home.x, this.home.y, ctx.world);
                    if (this.atHome) this.job = 'waiting';
                    break;
                }

                default:
                    if (gate) gate.wanted = false;
                    this.returnHome(dt, 2);

                    /*
                     * Run a part load out on its own eventually. Waiting only for a full
                     * lorry left animals sedated on the deck for the rest of the run —
                     * three of them, in one unattended game — because the player never
                     * darted a fourth. The Send lorry button is for going sooner, not
                     * for stopping this being forgotten.
                     */
                    if (this.cargo.length) {
                        this.waiting += dt;
                        if (this.waiting > PART_LOAD_WAIT) this.depart(ctx);
                    } else {
                        this.waiting = 0;
                    }
            }

            if (!this.drive(dt, ctx)) {
                // The lorry has one route and must not abandon it; nudge and retry.
                this.driveTo(this.targetX + (Math.random() - 0.5) * 4,
                    this.targetY + (Math.random() - 0.5) * 4, ctx.world);
            }

            this.renderState.cargo = this.cargo;
        }
    }

    /* ------------------------------------------------------------------ *
     * Dispatcher
     * ------------------------------------------------------------------ */

    /**
     * Watches for sedated animals and puts the loader on them.
     *
     * Kept apart from both vehicles because it is a policy, not a machine: it decides
     * what gets collected and in what order, and that is the part most likely to change.
     */
    class Relocation {
        constructor(bus, station, gate) {
            this.bus = bus;
            this.gate = gate;

            this.loader = new IsoLoader(station.x, station.y);
            this.lorry = new IsoLorry(station.x, station.y);
            this.lorry.gate = gate;

            /** Animals darted and awaiting collection. */
            this.queue = [];
            this.relocated = 0;
            this.bySpecies = Object.create(null);

            bus.on(Events.ANIMAL_TRANQUILIZED, (p) => this.request(p.animal));
            bus.on(Events.ANIMAL_RELOCATED, (p) => {
                this.relocated++;
                this.bySpecies[p.species] = (this.bySpecies[p.species] || 0) + 1;
            });
        }

        /** Park both vehicles beside the station. */
        station(x, y, facing) {
            const a = facing || 0;
            this.loader.x = this.loader.targetX = x + Math.cos(a + 1.9) * 3.4;
            this.loader.y = this.loader.targetY = y + Math.sin(a + 1.9) * 3.4;
            this.loader.home = { x: this.loader.x, y: this.loader.y };

            this.lorry.x = this.lorry.targetX = x + Math.cos(a - 1.9) * 4.6;
            this.lorry.y = this.lorry.targetY = y + Math.sin(a - 1.9) * 4.6;
            this.lorry.home = { x: this.lorry.x, y: this.lorry.y };
        }

        request(animal) {
            if (this.queue.indexOf(animal) >= 0) return;
            this.queue.push(animal);
        }

        get pending() {
            return this.queue.length + (this.loader.busy ? 1 : 0);
        }

        update(dt, ctx) {
            ctx.lorry = this.lorry;
            ctx.ecology = ctx.ecology || null;

            // Drop anything that woke up or died before the loader got to it.
            for (let i = this.queue.length - 1; i >= 0; i--) {
                const a = this.queue[i];
                if (!a.alive || a.state !== IsoAnimal.State.TRANQUILIZED) {
                    this.queue.splice(i, 1);
                }
            }

            // One job at a time, nearest first — a loader that criss-crosses the reserve
            // looks broken even when it is being efficient.
            if (!this.loader.busy && this.queue.length && !this.lorry.full) {
                let best = 0;
                let bestDist = Infinity;
                for (let i = 0; i < this.queue.length; i++) {
                    const a = this.queue[i];
                    const d = Math.hypot(a.x - this.loader.x, a.y - this.loader.y);
                    if (d < bestDist) { bestDist = d; best = i; }
                }
                this.loader.collect(this.queue.splice(best, 1)[0]);
            }

            this.loader.update(dt, ctx);
            this.lorry.update(dt, ctx);

            // The gate opens for a lorry that is nearly there.
            if (this.gate) {
                const near = Math.hypot(this.gate.x - this.lorry.x,
                    this.gate.y - this.lorry.y) < 14;
                this.gate.open = MathUtils.damp(this.gate.open,
                    (this.gate.wanted && near) ? 1 : 0, 2.4, dt);
            }
        }
    }

    Relocation.LORRY_CAPACITY = LORRY_CAPACITY;
    Safari.IsoLoader = IsoLoader;
    Safari.IsoLorry = IsoLorry;
    Safari.Relocation = Relocation;

})(window.Safari);
