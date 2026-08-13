/**
 * Safari Simulator — Ranger jeep and tranquilliser darts.
 *
 * The player's one direct hand in the reserve. Armed from the dock, then given work by
 * clicking: open ground to drive there, an animal to sedate it. A sedated animal is the
 * start of the relocation chain — the loader collects it and the lorry takes it out
 * through the gate — so the dart is the beginning of a job, not the end of one.
 *
 * Driving lives in `IsoVehicle`. What is here is the gun and the quarry.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, Events, IsoAnimal, IsoVehicle } = Safari;
    const UNITS_PER_TILE = IsoAnimal.UNITS_PER_TILE;

    /** How close the jeep must get before poachers lose their nerve, in tiles. */
    const SCARE_RANGE = 11;

    /** Dart flight, in tile space with a real height so it arcs over the ground. */
    class Dart {
        constructor(x, y, z, target) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.target = target;

            const dx = target.x - x;
            const dy = target.y - y;
            this.distance = Math.hypot(dx, dy) || 0.001;
            this.dirX = dx / this.distance;
            this.dirY = dy / this.distance;
            this.angle = Math.atan2(dy, dx);

            this.travelled = 0;
            this.startZ = z;
            this.alive = true;
        }

        update(dt) {
            const step = (Config.sim.dartSpeed / UNITS_PER_TILE) * dt;
            this.travelled += step;
            this.x += this.dirX * step;
            this.y += this.dirY * step;

            // A shallow arc, peaking halfway. Purely for legibility — a dart that
            // travels flat is indistinguishable from a stationary dot.
            const t = MathUtils.clamp01(this.travelled / this.distance);
            this.z = this.startZ + Math.sin(t * Math.PI) * 6 - t * (this.startZ - 8);

            if (this.travelled >= this.distance) this.alive = false;
        }
    }

    class IsoRanger extends IsoVehicle {
        constructor(tx, ty) {
            super(tx, ty, { speed: 300, wheelR: 6.4, probe: 1.8, turnRate: 2.6 });

            /** Animal the ranger has been ordered to sedate, if any. */
            this.quarry = null;
            this.cooldown = 0;
            this.aiming = 0;

            /** @type {Dart[]} */
            this.darts = [];
        }

        /** Close on an animal and dart it. */
        pursue(animal) {
            this.quarry = animal;
        }

        get dartRange() {
            return (Config.sim.stalkDistance * 1.4) / UNITS_PER_TILE;
        }

        /**
         * @param {number} dt
         * @param {object} ctx {world, ecology, bus, time}
         */
        update(dt, ctx) {
            if (this.cooldown > 0) this.cooldown -= dt;

            /* --- Standing order ------------------------------------------- */
            let aimAngle = null;
            const q = this.quarry;

            if (q && (!q.alive || q.state === IsoAnimal.State.TRANQUILIZED)) {
                this.quarry = null;
            } else if (q) {
                const dist = Math.hypot(q.x - this.x, q.y - this.y);
                aimAngle = Math.atan2(q.y - this.y, q.x - this.x);

                if (dist > this.dartRange * 0.72) {
                    // Still closing: drive at the quarry, not at where it was. Routed,
                    // because the animal the player picked may be right across the map.
                    this.driveTo(q.x, q.y, ctx.world);
                    this.aiming = MathUtils.damp(this.aiming, 0.35, 5, dt);
                } else {
                    // In range: hold position, settle the shot, then fire.
                    this.driveTo(this.x, this.y);
                    this.aiming = MathUtils.damp(this.aiming, 1, 4, dt);
                    if (this.aiming > 0.75 && this.cooldown <= 0) this._fire(q, ctx);
                }
            } else {
                this.aiming = MathUtils.damp(this.aiming, 0, 6, dt);
                this.returnHome(dt);
            }

            /* --- Drive ------------------------------------------------------ */
            if (!this.drive(dt, ctx, this.aiming > 0.5 ? 0.3 : 1)) {
                // A real dead end: abandon the order and go home rather than revving
                // against the obstruction for ever.
                this.quarry = null;
                if (this.home) this.driveTo(this.home.x, this.home.y, ctx.world);
                else this.driveTo(this.x, this.y);
                ctx.bus.emit(Events.TOAST,
                    { message: 'Ranger could not get through', tone: 'bad' });
            }

            /*
             * Poachers.
             *
             * Nothing is fired at them — the ranger's gun holds sedatives, not rounds.
             * Simply being close is the deterrent: they lose their nerve and run for the
             * boundary, which turns dealing with them into a chase across the reserve
             * rather than a button press.
             */
            if (ctx.poachers && ctx.poachers.length) {
                for (const p of ctx.poachers) {
                    const d = Math.hypot(p.x - this.x, p.y - this.y);
                    if (d < SCARE_RANGE) {
                        p.scare(dt * (1.6 - d / SCARE_RANGE));
                    }
                }
            }

            /* --- Darts -------------------------------------------------------- */
            for (let i = this.darts.length - 1; i >= 0; i--) {
                const d = this.darts[i];
                d.update(dt);
                if (!d.alive) {
                    this._resolve(d, ctx);
                    this.darts.splice(i, 1);
                }
            }

            const rs = this.renderState;
            rs.aiming = this.aiming;
            rs.aimAngle = aimAngle !== null ? aimAngle : (this.aiming > 0.02 ? this.facing : null);
        }

        _fire(target, ctx) {
            this.cooldown = Config.sim.dartCooldown;
            this.aiming = 0.5;
            this.darts.push(new Dart(this.x, this.y,
                Safari.IsoVehicleArt.DIM.floorZ + 20, target));
            ctx.bus.emit(Events.RANGER_FIRED, { ranger: this, target });
        }

        /** A dart has reached the end of its flight; see whether it found its mark. */
        _resolve(dart, ctx) {
            const t = dart.target;
            const hitRadius = Config.sim.dartHitRadius / UNITS_PER_TILE;
            const hit = t && t.alive &&
                Math.hypot(t.x - dart.x, t.y - dart.y) <= hitRadius + t.radius;

            if (!hit) {
                ctx.bus.emit(Events.DART_MISS, { x: dart.x, y: dart.y });
                return;
            }
            if (t.tranquilize(Config.sim.tranquilizerDuration)) {
                ctx.bus.emit(Events.DART_HIT, { animal: t, by: this });
                ctx.bus.emit(Events.ANIMAL_TRANQUILIZED, { animal: t, by: this });
            }
        }
    }

    IsoRanger.Dart = Dart;
    Safari.IsoRanger = IsoRanger;

})(window.Safari);
