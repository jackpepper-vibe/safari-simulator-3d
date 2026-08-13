/**
 * Safari Simulator — Vehicle base.
 *
 * Everything the reserve's vehicles share: driving to a destination, steering around
 * ground they cannot cross, sliding along obstructions rather than stopping dead on
 * them, suspension, and giving up when a route turns out to be impossible.
 *
 * Extracted from the ranger's jeep once the loader and the lorry needed the same
 * behaviour. All of it was hard-won — the sliding and the stuck detection between them
 * are what stopped vehicles jamming against banks and revving — and none of it is
 * specific to what a vehicle is carrying.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, Events, IsoAnimal } = Safari;
    const UNITS_PER_TILE = IsoAnimal.UNITS_PER_TILE;
    const TAU = MathUtils.TAU;

    /** Below this distance a vehicle just steers; beyond it, it routes. */
    const ROUTE_MIN = 6;
    /** How many times a vehicle will re-plan before accepting the road is shut. */
    const MAX_REPLANS = 3;

    class IsoVehicle {
        /**
         * @param {number} tx Tile coordinates.
         * @param {number} ty
         * @param {object} [opts] `{speed, wheelR, probe, turnRate}`.
         */
        constructor(tx, ty, opts) {
            const o = opts || {};

            this.x = tx;
            this.y = ty;
            this.targetX = tx;
            this.targetY = ty;

            this.facing = 0;
            this.heading = 0;
            this.speed = 0;
            /** Tiles per second flat out. */
            this.maxSpeed = (o.speed || 300) / UNITS_PER_TILE;
            /** Wheel radius, for rolling the tyres by distance covered. */
            this.wheelR = o.wheelR || 6.4;
            /** How far ahead to test the ground when steering. */
            this.probe = o.probe || 1.8;
            this.turnRate = o.turnRate || 2.6;

            /** Final destination, as opposed to the next waypoint on the way there. */
            this.destX = tx;
            this.destY = ty;
            /** Where the route could actually get to, which may be short of the wish. */
            this.reachX = tx;
            this.reachY = ty;
            /** @type {Array<{x:number,y:number}>|null} */
            this.route = null;
            this.routeIndex = 0;
            this.replanCooldown = 0;
            this.replans = 0;

            /** Where it lives, and returns to when idle. */
            this.home = null;
            this.idle = 0;
            /** Seconds without closing on the destination, and the best gap so far. */
            this.stuck = 0;
            this.bestApproach = Infinity;

            this.wheelPhase = 0;
            this.bounce = 0;
            this.bounceVel = 0;

            this.renderState = {
                facing: 0, speed01: 0, wheelPhase: 0, bounce: 0,
                aiming: 0, aimAngle: null, time: 0, cargo: null
            };
        }

        /**
         * Send the vehicle to a tile.
         *
         * A destination more than a short hop away is routed rather than steered
         * toward: steering follows the shoreline of the first lake it meets into a dead
         * end, which is how a loaded lorry spent twenty-five in-game minutes never
         * reaching a gate seventy tiles away. Nearby destinations skip the search — the
         * loader nudging up to a sedated animal does not need a route.
         */
        driveTo(tx, ty, world) {
            const moved = Math.hypot(tx - this.destX, ty - this.destY) > 1.5;
            if (moved) {
                this.bestApproach = Infinity;
                this.stuck = 0;
                this.replans = 0;
            }
            this.destX = tx;
            this.destY = ty;

            if (!world || Math.hypot(tx - this.x, ty - this.y) < ROUTE_MIN) {
                this.route = null;
                this.reachX = tx;
                this.reachY = ty;
                this.targetX = tx;
                this.targetY = ty;
                return;
            }
            /*
             * Re-plan sparingly.
             *
             * Chasing something that moves means driveTo is called with a new
             * destination every tick, and re-routing on each one runs a full A* search
             * several times a second — a fleeing zebra turns the ranger into a
             * pathfinding storm, and four scripted playtests failed to finish because
             * of it. Between searches the existing route is still broadly right, and
             * the steering closes the last of the gap.
             */
            if (!this.route) this._route(world);
            else if (moved && this.replanCooldown <= 0) this._route(world);
        }

        /** Compute a route to the current destination, or fall back to steering. */
        _route(world) {
            const path = Safari.IsoPath;
            this.route = path.find(world, this.x, this.y, this.destX, this.destY,
                (w, x, y) => this._routable(w, x, y));

            // Nowhere with clearance? Take a tighter line rather than refusing to go.
            if (!this.route) {
                this.route = path.find(world, this.x, this.y, this.destX, this.destY,
                    (w, x, y) => this._standable(w, x, y));
            }
            this.routeIndex = 0;
            this.replanCooldown = 1.5;
            this.bestApproach = Infinity;
            this.stuck = 0;

            /*
             * Adopt the goal the search could actually reach.
             *
             * A* slides a destination it cannot stand on to the nearest tile it can.
             * Keeping the original meant a vehicle drove its route correctly, ran off
             * the end, and then ground freehand against the scarp beyond — which is the
             * whole of the "stuck in the mountains" fault. Where the route ends is now
             * where the vehicle considers itself to have arrived.
             */
            this.reachX = this.destX;
            this.reachY = this.destY;
            if (this.route && path.find.goal) {
                this.reachX = path.find.goal.x;
                this.reachY = path.find.goal.y;
            }

            if (this.route && this.route.length) {
                this.targetX = this.route[0].x;
                this.targetY = this.route[0].y;
            } else {
                this.targetX = this.reachX;
                this.targetY = this.reachY;
            }
        }

        /**
         * Passability for routing, which is stricter than for driving.
         *
         * A vehicle is not a point. The pathfinder works on tile centres while the
         * stepper checks the vehicle's actual position, so a route that hugs a shoreline
         * leaves the lorry itself in the water — and every jam measured on realistic
         * journeys was on flat ground at the edge of a lake, not up a mountain.
         * Requiring the neighbours to be clear as well keeps routes off the very edge.
         */
        _routable(world, x, y) {
            if (!this._standable(world, x, y)) return false;
            return this._standable(world, x + 1, y) && this._standable(world, x - 1, y) &&
                this._standable(world, x, y + 1) && this._standable(world, x, y - 1);
        }

        /** Reverse away from whatever the vehicle is wedged against. */
        _backOff(world) {
            for (let i = 0; i < 8; i++) {
                const a = this.heading + Math.PI + (i % 2 ? 1 : -1) * Math.floor(i / 2) * 0.5;
                const bx = this.x + Math.cos(a) * 2.2;
                const by = this.y + Math.sin(a) * 2.2;
                if (this._standable(world, bx, by)) {
                    this.x = bx;
                    this.y = by;
                    this.speed = 0;
                    return true;
                }
            }
            return false;
        }

        /** Advance along the route as waypoints are reached. */
        _followRoute(dt) {
            if (this.replanCooldown > 0) this.replanCooldown -= dt;
            if (!this.route || this.routeIndex >= this.route.length) return;

            const wp = this.route[this.routeIndex];
            // Generous, because the vehicle only has to pass near a waypoint, not stop
            // on it — and tightening this makes them visibly hunt around each corner.
            if (Math.hypot(wp.x - this.x, wp.y - this.y) < 1.8) {
                this.routeIndex++;
                if (this.routeIndex >= this.route.length) {
                    this.targetX = this.reachX;
                    this.targetY = this.reachY;
                    this.route = null;
                    return;
                }
            }
            const next = this.route[this.routeIndex];
            this.targetX = next.x;
            this.targetY = next.y;
        }

        get arrived() {
            if (this.route) return false;
            // Measured against what was reachable, not against what was asked for.
            return Math.hypot(this.reachX - this.x, this.reachY - this.y) < 0.9 ||
                Math.hypot(this.destX - this.x, this.destY - this.y) < 0.9;
        }

        get atHome() {
            return !!this.home &&
                Math.hypot(this.home.x - this.x, this.home.y - this.y) < 1.4;
        }

        /**
         * Drive one tick toward the current destination.
         *
         * @param {number} dt
         * @param {object} ctx `{world, bus}`.
         * @param {number} [throttle] 0..1 scale on top speed, for creeping.
         * @returns {boolean} False if the route was abandoned as impossible.
         */
        drive(dt, ctx, throttle) {
            const world = ctx.world;
            this._followRoute(dt);
            const dx = this.targetX - this.x;
            const dy = this.targetY - this.y;
            const dist = Math.hypot(dx, dy);
            let ok = true;

            if (dist > 0.35) {
                // Ease into the destination rather than snapping to a stop on it.
                const approach = MathUtils.smoothstep(0, 3.5, dist);
                const want = this.maxSpeed * approach * (throttle === undefined ? 1 : throttle);
                this.speed = MathUtils.damp(this.speed, want, 4.5, dt);

                let bearing = Math.atan2(dy, dx);

                /*
                 * Sweep for a heading the ground allows — but only when steering
                 * freehand. On a route the sweep is actively harmful: A* threads a
                 * valid tile-by-tile path through a gap, the sweep looks two and a half
                 * tiles ahead, sees the obstruction the path is squeezing past, and
                 * turns away; the route then pulls the vehicle back, and it deadlocks
                 * on the spot. A loaded lorry sat in exactly that stalemate for
                 * twenty-five in-game minutes. The route is already known to be
                 * passable, and `_step` still refuses to enter bad ground, so following
                 * it needs no second opinion.
                 */
                if (!this.route && !this._passable(world, bearing, this.probe)) {
                    let found = false;
                    for (let step = 1; step <= 7 && !found; step++) {
                        for (const sign of [1, -1]) {
                            const a = bearing + sign * step * 0.42;
                            if (this._passable(world, a, this.probe)) {
                                bearing = a;
                                found = true;
                                break;
                            }
                        }
                    }
                    if (!found) bearing += Math.PI;
                }

                this.heading = MathUtils.angleLerp(this.heading, bearing,
                    MathUtils.clamp01(this.turnRate * dt));

                const moved = this._step(world,
                    Math.cos(this.heading) * this.speed * dt,
                    Math.sin(this.heading) * this.speed * dt, dt);

                // Wheels turn with ground covered, so they never spin while parked and
                // never spin while jammed against a bank either.
                this.wheelPhase = MathUtils.wrap(
                    this.wheelPhase + moved * UNITS_PER_TILE / this.wheelR, TAU);
                this.facing = this.heading;

                /*
                 * Progress, not motion. Measuring whether the vehicle moved at all lets
                 * it jitter against an obstruction for ever: each tiny slide counts as
                 * movement and resets the timer. What matters is whether the gap to the
                 * destination is closing.
                 */
                const gap = Math.hypot(this.reachX - this.x, this.reachY - this.y);
                if (gap < this.bestApproach - 0.15) {
                    this.bestApproach = gap;
                    this.stuck = 0;
                } else {
                    this.stuck += dt;
                    if (this.stuck > 1.5) {
                        this.stuck = 0;
                        this.speed = 0;
                        /*
                         * A road that turned out to be shut. Re-plan once before giving
                         * up: the world does change under a vehicle — the station gets
                         * built, a route is computed from a slightly different spot —
                         * and a single retry recovers nearly all of it.
                         */
                        this.replans++;
                        if (this.replans <= MAX_REPLANS &&
                            Math.hypot(this.reachX - this.x,
                                this.reachY - this.y) > ROUTE_MIN) {
                            /*
                             * Reverse out before trying again.
                             *
                             * Re-planning from the spot the vehicle is wedged in returns
                             * the same route into the same corner, and it sat motionless
                             * through several attempts — six seconds of nothing, which
                             * from the outside is simply a stuck lorry. Backing off a
                             * couple of tiles first gives the next search somewhere
                             * different to start from.
                             */
                            this._backOff(world);
                            this._route(world);
                        } else {
                            // A destination that cannot be reached will consume
                            // re-plans for ever, and a vehicle grinding against a bank
                            // while it does is worse than one that admits defeat.
                            this.route = null;
                            ok = false;
                        }
                    }
                }
            } else {
                this.speed = MathUtils.damp(this.speed, 0, 8, dt);
            }

            /* --- Suspension ------------------------------------------------- */
            // A damped spring driven by the ground being crossed, so a vehicle pitches
            // over rough country and settles when it stops.
            const rough = Math.sin(this.x * 2.1) * Math.cos(this.y * 2.6);
            const push = rough * (this.speed / this.maxSpeed) * 1.5;
            this.bounceVel += (push - this.bounce * 9) * dt * 10;
            this.bounceVel *= Math.pow(0.02, dt);
            this.bounce = MathUtils.clamp(this.bounce + this.bounceVel * dt, -1.4, 1.4);

            const rs = this.renderState;
            rs.facing = this.facing;
            rs.speed01 = this.speed / this.maxSpeed;
            rs.wheelPhase = this.wheelPhase;
            rs.bounce = this.bounce;
            rs.time = ctx.time;

            return ok;
        }

        /**
         * Head home if there is nothing else to do.
         * @returns {boolean} True once parked.
         */
        returnHome(dt, delay) {
            if (!this.home) return false;
            if (this.atHome) { this.idle = 0; return true; }

            if (this.arrived) {
                this.idle += dt;
                if (this.idle > (delay === undefined ? 6 : delay)) {
                    this.targetX = this.home.x;
                    this.targetY = this.home.y;
                }
            }
            return false;
        }

        /**
         * Take a step, sliding along whatever blocks it.
         *
         * All-or-nothing collision stops a vehicle dead when it meets a bank on a
         * diagonal, even though it could drive along that bank perfectly well.
         *
         * @returns {number} Distance actually covered.
         */
        _step(world, dx, dy, dt) {
            if (this._standable(world, this.x + dx, this.y + dy)) {
                this.x += dx;
                this.y += dy;
                return Math.hypot(dx, dy);
            }

            let movedX = 0, movedY = 0;
            if (dx !== 0 && this._standable(world, this.x + dx, this.y)) {
                this.x += dx;
                movedX = dx;
            }
            if (dy !== 0 && this._standable(world, this.x, this.y + dy)) {
                this.y += dy;
                movedY = dy;
            }

            if (movedX || movedY) {
                this.heading = MathUtils.angleLerp(this.heading,
                    Math.atan2(movedY, movedX), MathUtils.clamp01(4 * dt));
            } else {
                this.speed *= 0.3;
            }
            return Math.hypot(movedX, movedY);
        }

        _passable(world, angle, dist) {
            return this._standable(world,
                this.x + Math.cos(angle) * dist, this.y + Math.sin(angle) * dist);
        }

        /** Road vehicles: no deep water, no escarpments, nothing built on. */
        _standable(world, tx, ty) {
            if (tx < 2 || ty < 2 || tx >= world.size - 2 || ty >= world.size - 2) return false;
            if (world.isBlocked(tx, ty)) return false;
            if (world.waterAt(tx, ty) > Config.terrain.water.wadeDepth * 0.6) return false;
            return world.slopeAt(tx, ty) < Config.terrain.maxWalkableSlope * 0.8;
        }
    }

    IsoVehicle.UNITS_PER_TILE = UNITS_PER_TILE;
    Safari.IsoVehicle = IsoVehicle;

})(window.Safari);
