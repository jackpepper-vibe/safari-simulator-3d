/**
 * Safari Simulator 3D — Scene.
 *
 * The reserve as a running world: the tile terrain, the day and weather clock, and the
 * full ecology of animals, forage, predation, relocation and disaster standing on it —
 * with a real camera looking at all of it.
 *
 * The division of labour is the important thing here, and it is the same one that made
 * Iron Dominion 3D tractable: **everything below the simulation only ever reads it.**
 * The ecology, the animals, the vehicles and the events are carried over from the 2D
 * build untouched; this file walks their state once a frame and moves meshes to match.
 * If something here ever wants to write to `ecology.animals` or to the tile world, the
 * design has gone wrong.
 */
(function (Safari, THREE) {
    'use strict';

    const {
        MathUtils, Rng, Config, Palettes, EventBus, Events,
        TileWorld, IsoSpecies, IsoEcology, IsoRanger, IsoAnimal, IsoEvents,
        Relocation, TimeSystem, Weather, Vegetation,
        R3D, Terrain3D, Flora3D, Sky3D, Creature3D, Models3D, Particles3D, CameraRig
    } = Safari;

    /** Radius of the built compound, in tiles: what has to be dry to site it. */
    const STATION_RADIUS = 2.6;

    /** Dust tints, so a hoof on sand does not throw up the same cloud as one on grass. */
    const DUST_TINT = [
        { r: 168, g: 176, b: 118 }, // GRASS
        { r: 196, g: 184, b: 128 }, // DRY_GRASS
        { r: 176, g: 148, b: 106 }, // DIRT
        { r: 214, g: 196, b: 150 }, // SAND
        { r: 158, g: 152, b: 142 }, // ROCK
        { r: 190, g: 210, b: 214 }  // WATER
    ];

    const _v = new THREE.Vector3();
    const _colour = new THREE.Color();

    /* ------------------------------------------------------------------ *
     * Ground markers
     * ------------------------------------------------------------------ */

    /**
     * Rings and discs that lie on the terrain.
     *
     * These are real geometry rather than overlay drawing, because they are genuinely
     * things on the ground: a dart range that did not foreshorten with the reserve
     * would tell the player nothing about which animals are inside it.
     */
    function ringMesh(inner, outer, colour, opacity) {
        const geo = new THREE.RingGeometry(inner, outer, 48).rotateX(-Math.PI / 2);
        const mat = new THREE.MeshBasicMaterial({
            color: colour, transparent: true, opacity,
            depthWrite: false, side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 3;
        mesh.visible = false;
        return mesh;
    }

    /* ------------------------------------------------------------------ *
     * Scene
     * ------------------------------------------------------------------ */

    class Scene3D {
        /**
         * @param {THREE.WebGLRenderer} renderer Owned by the shell and reused across
         *   reserves — a new WebGL context per reserve would exhaust the browser's
         *   supply within a dozen runs.
         * @param {number} seed
         */
        constructor(renderer, seed) {
            this.renderer = renderer;
            this.seed = seed || ((Math.random() * 0xffffff) | 0);
            this.rng = new Rng(this.seed);

            this.scene = new THREE.Scene();

            this.world = new TileWorld(Config.terrain.tiles, this.seed);
            this.world.generate();

            /**
             * Standing vegetation, in the world rather than in the renderer.
             *
             * The acacias are a food supply for the tall browsers, so the simulation has
             * to know where they are; the renderer reads this list rather than owning
             * one of its own.
             */
            this.vegetation = new Vegetation(this.world, this.seed);

            this.camera = new CameraRig(this.world.size);
            /** The overlay's name for the same object. */
            this.rig = this.camera;

            /* --- Simulation ------------------------------------------------ */
            this.bus = new EventBus();
            this.time = new TimeSystem(this.bus);
            this.weather = new Weather(this.bus, this.seed);
            this.ecology = new IsoEcology(this.bus, this.world, this.seed);
            this.ecology.ctx.vegetation = this.vegetation;
            this.agents = this.ecology.animals;

            this.ranger = new IsoRanger(this.world.size / 2, this.world.size / 2);

            const site = this._placeStation();
            this.station = { x: site.x, y: site.y, facing: this.rng.range(-0.5, 0.5) };
            this.world.block(this.station.x, this.station.y, 1.5);
            this._parkRanger(this.station);

            this.gate = this._placeGate(this.station);

            this.relocation = new Relocation(this.bus, this.station, this.gate);
            this.relocation.station(this.station.x, this.station.y, this.station.facing);
            this._relocCtx = {
                world: this.world, bus: this.bus, ecology: this.ecology, time: 0
            };

            this.events = new IsoEvents(this.bus, this.world, this.seed);
            this._eventCtx = {
                world: this.world, bus: this.bus, ecology: this.ecology,
                time: 0, wind: 1, windAngle: 0, rain: 0, drought: 0, population: 0
            };

            /* --- Presentation ----------------------------------------------- */
            this.terrain = new Terrain3D(this.world, this.scene);
            this.flora = new Flora3D(this.world, this.scene, this.seed,
                this.terrain.overlay, this.vegetation);
            this.props = this.vegetation.props;
            this.sky = new Sky3D(this.scene, this.world.size, new Rng(this.seed ^ 0x51));
            this.particles = new Particles3D(this.scene, this.seed);

            this._buildFixtures();
            this._buildMarkers();
            this._bindEffects();

            /** Live mesh registries, keyed by the simulation object they follow. */
            this.animalMeshes = new Map();
            this.itemMeshes = new Map();
            this.dartMeshes = [];
            this.poacherRigs = new Map();

            /* --- State ------------------------------------------------------- */
            this.wind = 1;
            this.hovered = null;
            this.placing = null;
            this.rangerArmed = false;
            this.rangerHover = false;

            this.light = Palettes.sample(9.5);
            this.hour = 9.5;
            this.clock = 0;
            this.simTime = 0;
            this.env = { time: 0, isNight: false, heat: 0 };
            this._effectTimer = 0;
            this._fireTimer = 0;

            this.stats = { agents: 0, visible: 0, food: 0, fps: 60 };
            /** Bumped each frame; meshes not stamped with it have lost their owner. */
            this._frameToken = 0;

            this.camera.snapToTile(this.world.size / 2, this.world.size / 2, 34);
        }

        /* -------------------------------------------------------------- *
         * Siting
         * -------------------------------------------------------------- */

        /**
         * Find somewhere to build the station.
         *
         * Carried over from the 2D build: candidate sites are scored over the whole
         * compound footprint rather than a single tile, and the best of a scatter wins,
         * so a hut three tiles across never ends up with half of itself in a lake.
         */
        _placeStation() {
            const w = this.world;
            const r = this.ranger;
            const RADIUS = STATION_RADIUS;

            let best = null;
            let bestScore = -Infinity;

            for (let attempt = 0; attempt < 500; attempt++) {
                const tx = this.rng.range(RADIUS + 3, w.size - RADIUS - 3);
                const ty = this.rng.range(RADIUS + 3, w.size - RADIUS - 3);

                let ok = true;
                for (let a = 0; a < 8 && ok; a++) {
                    for (let d = 0; d <= 2; d++) {
                        const ang = (a / 8) * MathUtils.TAU;
                        const rr = RADIUS * (0.5 + d * 0.25);
                        const px = tx + Math.cos(ang) * rr;
                        const py = ty + Math.sin(ang) * rr;
                        if (w.waterAt(px, py) > 0.02) { ok = false; break; }
                        if (w.slopeAt(px, py) > Config.terrain.maxWalkableSlope * 0.55) {
                            ok = false;
                            break;
                        }
                    }
                }
                if (!ok) continue;
                if (w.waterAt(tx, ty) > 0 || !r._standable(w, tx, ty)) continue;

                const water = w.findWaterNear(tx, ty, 18);
                const toWater = water ? Math.hypot(water.x - tx, water.y - ty) : 40;
                let score = -Math.abs(toWater - 8) * 0.6;
                score -= w.slopeAt(tx, ty) * 14;
                score += Math.min(12, Math.hypot(tx - w.size / 2, ty - w.size / 2)) * 0.15;

                if (score > bestScore) {
                    bestScore = score;
                    best = { x: tx, y: ty };
                }
            }

            if (!best) best = { x: w.size / 2, y: w.size / 2 };
            return best;
        }

        /**
         * Site the boundary gate, on the far side of the reserve from the station.
         *
         * The drive is the point: relocating an animal should cost a journey across the
         * map rather than a click.
         */
        _placeGate(station) {
            const w = this.world;
            const mid = w.size / 2;
            const away = Math.atan2(mid - station.y, mid - station.x);

            let best = null;
            let bestScore = -Infinity;

            for (let sweep = 0; sweep < 48; sweep++) {
                const a = away + (sweep % 2 ? 1 : -1) * Math.floor(sweep / 2) * 0.13;
                for (let inset = 3.5; inset <= 9; inset += 1.5) {
                    const r = w.size / 2 - inset;
                    const gx = mid + Math.cos(a) * r;
                    const gy = mid + Math.sin(a) * r;
                    if (gx < 3 || gy < 3 || gx >= w.size - 3 || gy >= w.size - 3) continue;

                    let clear = 0;
                    for (let k = 0; k < 6; k++) {
                        const px = gx - Math.cos(a) * (k * 1.6);
                        const py = gy - Math.sin(a) * (k * 1.6);
                        if (w.waterAt(px, py) > 0.02) break;
                        if (w.slopeAt(px, py) > Config.terrain.maxWalkableSlope * 0.6) break;
                        clear++;
                    }
                    if (clear < 5) continue;

                    const score = clear * 4 +
                        Math.hypot(gx - station.x, gy - station.y) * 0.35 -
                        w.slopeAt(gx, gy) * 20;
                    if (score > bestScore) {
                        bestScore = score;
                        best = { x: gx, y: gy, angle: a };
                    }
                }
                if (best && sweep > 6) break;
            }

            if (!best) best = { x: mid, y: 4, angle: -Math.PI / 2 };

            const gate = {
                x: best.x,
                y: best.y,
                facing: best.angle,
                open: 0,
                wanted: false,
                approach: {
                    x: best.x - Math.cos(best.angle) * 3.2,
                    y: best.y - Math.sin(best.angle) * 3.2
                },
                exit: {
                    x: best.x + Math.cos(best.angle) * 1.6,
                    y: best.y + Math.sin(best.angle) * 1.6
                }
            };

            // The fence is solid; the gap in it is not.
            for (const side of [1, -1]) {
                for (let d = 1.1; d < 4.5; d += 0.8) {
                    this.world.block(
                        gate.x + Math.cos(best.angle + Math.PI / 2) * side * d,
                        gate.y + Math.sin(best.angle + Math.PI / 2) * side * d, 0.7);
                }
            }
            return gate;
        }

        /** Park the jeep beside the compound, on ground it can actually leave. */
        _parkRanger(station) {
            const r = this.ranger;
            for (let a = 0; a < 16; a++) {
                const ang = (a / 16) * MathUtils.TAU;
                const px = station.x + Math.cos(ang) * (STATION_RADIUS + 0.8);
                const py = station.y + Math.sin(ang) * (STATION_RADIUS + 0.8);
                if (r._standable(this.world, px, py)) {
                    r.x = r.targetX = px;
                    r.y = r.targetY = py;
                    r.home = { x: px, y: py };
                    return;
                }
            }
            r.x = r.targetX = station.x + STATION_RADIUS + 0.8;
            r.y = r.targetY = station.y;
            r.home = { x: r.x, y: r.y };
        }

        /* -------------------------------------------------------------- *
         * Fixtures
         * -------------------------------------------------------------- */

        _buildFixtures() {
            const w = this.world;

            this.stationMesh = Models3D.buildStation();
            this.stationMesh.position.set(
                this.station.x, R3D.surfaceY(w, this.station.x, this.station.y), this.station.y);
            this.stationMesh.rotation.y = R3D.yawFor(this.station.facing);
            this.scene.add(this.stationMesh);

            this.gateMesh = Models3D.buildGate();
            this.gateMesh.position.set(
                this.gate.x, R3D.surfaceY(w, this.gate.x, this.gate.y), this.gate.y);
            this.gateMesh.rotation.y = R3D.yawFor(this.gate.facing);
            this.scene.add(this.gateMesh);

            this.rangerRig = Models3D.jeep();
            this.scene.add(this.rangerRig.object);

            this.loaderRig = Models3D.loader();
            this.scene.add(this.loaderRig.object);

            this.lorryRig = Models3D.lorry();
            this.scene.add(this.lorryRig.object);
        }

        _buildMarkers() {
            this.hoverRing = ringMesh(0.34, 0.44, 0xfff0d2, 0.85);
            this.quarryRing = ringMesh(0.40, 0.52, 0x6fd0e8, 0.9);
            this.rangeRing = ringMesh(0.94, 1.0, 0x6fd0e8, 0.5);
            this.scene.add(this.hoverRing, this.quarryRing, this.rangeRing);

            const disc = new THREE.CircleGeometry(0.5, 28).rotateX(-Math.PI / 2);
            this.placeDisc = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({
                color: 0x7fd68a, transparent: true, opacity: 0.3,
                depthWrite: false, side: THREE.DoubleSide
            }));
            this.placeDisc.renderOrder = 3;
            this.placeDisc.visible = false;
            this.scene.add(this.placeDisc);

            /**
             * The placement ghost is the same mesh the reserve uses, in a translucent
             * material — so what the player previews is exactly what lands.
             */
            this.ghostMaterial = R3D.skinnedMaterial().clone();
            this.ghostMaterial.transparent = true;
            this.ghostMaterial.opacity = 0.5;
            this.ghostMaterial.depthWrite = false;
            this.ghosts = new Map();
            this.ghost = null;
        }

        /* -------------------------------------------------------------- *
         * Stocking
         * -------------------------------------------------------------- */

        populate(speciesId, count) {
            const w = this.world;
            for (let i = 0; i < count; i++) {
                this.ecology.spawnNear(speciesId,
                    this.rng.range(w.size * 0.2, w.size * 0.8),
                    this.rng.range(w.size * 0.2, w.size * 0.8), false);
            }
        }

        /**
         * Stock the reserve with a believable mix, in clusters.
         *
         * Weighted rather than uniform — an even split across eleven species would put
         * as many lions on the plain as zebras — and clustered, because a lion can only
         * see about six tiles and a sprinkled reserve starves its predators.
         */
        populateMixed(count) {
            const MIX = [
                ['zebra', 5], ['deer', 4], ['giraffe', 2], ['elephant', 2],
                ['hippo', 1.5], ['rabbit', 3],
                ['lion', 1.2], ['wolf', 1.2], ['tiger', 0.7],
                ['crocodile', 0.8], ['eagle', 0.8]
            ];
            let total = 0;
            for (const m of MIX) total += m[1];

            const w = this.world;
            const clusters = Math.max(1, Math.round(count / 9));
            const centres = [];
            for (let c = 0; c < clusters; c++) {
                centres.push({
                    x: this.rng.range(w.size * 0.2, w.size * 0.8),
                    y: this.rng.range(w.size * 0.2, w.size * 0.8)
                });
            }

            for (let i = 0; i < count; i++) {
                let r = this.rng.next() * total;
                let id = MIX[0][0];
                for (const m of MIX) {
                    r -= m[1];
                    if (r <= 0) { id = m[0]; break; }
                }
                const c = centres[i % centres.length];
                this.ecology.spawnNear(id,
                    c.x + this.rng.spread(9), c.y + this.rng.spread(9), false);
            }
        }

        /**
         * Centre the camera on the busiest part of the reserve.
         *
         * Not the centroid: animals arrive in clusters, and the average of two herds on
         * opposite sides of the map is the empty plain between them.
         */
        focusOnAgents() {
            const cam = this.camera;
            if (!this.agents.length) {
                cam.snapToTile(this.world.size / 2, this.world.size / 2, 34);
                return;
            }

            const R2 = 14 * 14;
            let best = this.agents[0];
            let bestScore = -1;
            for (const a of this.agents) {
                let n = 0;
                for (const b of this.agents) {
                    const dx = b.x - a.x, dy = b.y - a.y;
                    if (dx * dx + dy * dy < R2) n++;
                }
                if (n > bestScore) { bestScore = n; best = a; }
            }

            let sx = 0, sy = 0, n = 0;
            for (const b of this.agents) {
                const dx = b.x - best.x, dy = b.y - best.y;
                if (dx * dx + dy * dy < R2) { sx += b.x; sy += b.y; n++; }
            }
            cam.snapToTile(sx / n, sy / n, 26);
        }

        resize(width, height, dpr) {
            this.camera.setViewport(width, height);
            this.renderer.setPixelRatio(dpr);
            this.renderer.setSize(width, height, false);
        }

        /* -------------------------------------------------------------- *
         * Simulation step
         * -------------------------------------------------------------- */

        /**
         * @param {number} dt Real seconds.
         * @param {number} speed Simulation multiplier; 0 pauses the world but keeps the
         *   camera and the clock display live.
         */
        update(dt, speed) {
            this.clock += dt;
            this.camera.update(dt, this.world);

            const sim = dt * (speed === undefined ? 1 : speed);
            if (sim > 0) {
                this.time.update(sim);
                this.weather.update(sim, null);
                this.hour = this.time.hour;

                this.simTime += sim;
                this.env.time = this.simTime;
                this.env.isNight = this.time.isNight;
                this.env.heat = MathUtils.clamp01(this.time.light.sunAltitude * 1.3);

                this.ecology.ctx.fire = this.events.fire.size
                    ? (x, y, r) => this.events.fire.nearest(x, y, r)
                    : null;
                this.ecology.update(sim, this.env);

                this._rangerCtx = this._rangerCtx ||
                    { world: this.world, ecology: this.ecology, bus: this.bus, time: 0 };
                this._rangerCtx.time = this.clock;
                this._rangerCtx.poachers = this.events.poachers;
                this.ranger.update(sim, this._rangerCtx);

                this._relocCtx.time = this.clock;
                this.relocation.update(sim, this._relocCtx);

                const ev = this._eventCtx;
                ev.time = this.simTime;
                ev.wind = this.wind;
                ev.windAngle = this.weather.windAngle || 0.9;
                ev.rain = this.weather.rainRate || 0;
                ev.population = this.ecology.population;
                this.events.update(sim, ev);

                this.world.regrowthScale = this.events.regrowthScale;
                this.world.drawdown = this.events.waterDrawdown;

                // A fire takes the crowns in its path with the grass, or a burnt scar
                // stays full of untouched browse.
                for (const cell of this.events.fire.burning.values()) {
                    this.vegetation.scorch(cell.x, cell.y, 1.4, this.simTime);
                }

                this._emitEffects(sim);
            }

            Palettes.sample(this.hour, this.light);
            this.weather.applyTo(this.light);
            this.wind = this.weather.wind;

            this.terrain.update(dt, this.simTime, this.events.fire.burnt);
            this.flora.update(dt, this.wind, this.simTime);
            this.particles.update(dt, this.wind, this._fireCentre());
            this.particles.motes(dt, this.camera, this.light);
            this.sky.update(this.light, this.camera, dt, this.wind);

            this.stats.agents = this.agents.length;
        }

        /* -------------------------------------------------------------- *
         * Effects
         * -------------------------------------------------------------- */

        /**
         * Bind the simulation's events to the particle system.
         *
         * Kept here rather than inside the entities: an animal has no business knowing
         * that a renderer exists, and one list is where the rules for when the reserve
         * throws dust should be readable.
         */
        _bindEffects() {
            const p = this.particles;
            const at = (a) => _v.set(a.x, R3D.surfaceY(this.world, a.x, a.y), a.y);

            this.bus.on(Events.ANIMAL_PLACED, (e) => {
                const s = at(e.animal);
                p.sparkle(s.x, s.y, s.z, { r: 255, g: 226, b: 150 });
            });
            this.bus.on(Events.ANIMAL_BORN, (e) => {
                const s = at(e.animal);
                p.heart(s.x, s.y, s.z);
            });
            this.bus.on(Events.ANIMAL_EATEN, (e) => {
                const s = at(e.animal);
                const c = Safari.Color.parse(IsoSpecies[e.animal.species].palette.base);
                p.puff(s.x, s.y, s.z, c, 1.2);
            });
            this.bus.on(Events.DART_HIT, (e) => {
                const s = at(e.animal);
                p.impact(s.x, s.y + 0.5, s.z, { r: 150, g: 240, b: 255 });
            });
            this.bus.on(Events.DART_MISS, (e) => {
                p.dust(e.x, R3D.surfaceY(this.world, e.x, e.y), e.y, 0.6);
            });
        }

        /**
         * Continuous effects: hoof dust, wading splashes and sleep marks.
         *
         * Sampled on a fixed cadence rather than every frame — a moving herd generates
         * footfalls faster than the eye can resolve individual puffs.
         */
        _emitEffects(dt) {
            this._effectTimer -= dt;
            if (this._effectTimer > 0) return;
            this._effectTimer = 0.09;

            const p = this.particles;
            const world = this.world;
            const cam = this.camera;

            for (let i = 0; i < this.agents.length; i++) {
                const a = this.agents[i];
                if (!a.alive) continue;
                // Off-camera animals emit nothing: the particle would expire unseen.
                if (cam.distanceTo(a.x, a.y) > 60) continue;

                const y = R3D.surfaceY(world, a.x, a.y);
                const speed01 = a.renderState.speed01;
                const depth = world.waterAt(a.x, a.y);

                if (depth > 0.04 && speed01 > 0.12) {
                    p.splash(a.x, y, a.y, speed01 * 0.7, { r: 150, g: 205, b: 220 });
                } else if (speed01 > 0.3 && !a.flies) {
                    const k = world.index(Math.floor(a.x), Math.floor(a.y));
                    p.dust(a.x, y, a.y, speed01 * 0.8 * Math.min(1.4, a.radius * 2.4),
                        DUST_TINT[world.substrate[k]] || DUST_TINT[1]);
                } else if (a.state === IsoAnimal.State.SLEEP && this.rng.next() < 0.05) {
                    p.sleepMark(a.x, y + 0.5, a.y);
                }
            }

            const r = this.ranger;
            if (r.speed / r.maxSpeed > 0.2 && cam.distanceTo(r.x, r.y) < 70) {
                const k = world.index(Math.floor(r.x), Math.floor(r.y));
                p.dust(r.x - Math.cos(r.facing) * 0.4, R3D.surfaceY(world, r.x, r.y),
                    r.y - Math.sin(r.facing) * 0.4, 1,
                    DUST_TINT[world.substrate[k]] || DUST_TINT[1]);
            }

            for (let i = 0; i < r.darts.length; i++) {
                const d = r.darts[i];
                p.dartTrail(d.x, R3D.surfaceY(world, d.x, d.y) + d.z * R3D.PX, d.y);
            }

            // The fire front, sampled from the burning cells rather than emitted by them.
            this._fireTimer -= dt;
            if (this._fireTimer <= 0 && this.events.fire.burning.size) {
                this._fireTimer = 0.06;
                for (const cell of this.events.fire.burning.values()) {
                    if (this.rng.next() > 0.35) continue;
                    if (cam.distanceTo(cell.x, cell.y) > 80) continue;
                    p.fire(cell.x, R3D.surfaceY(world, cell.x, cell.y), cell.y,
                        MathUtils.clamp01(cell.heat));
                }
            }
        }

        /** Where the fire is, for its light. Null when nothing is burning. */
        _fireCentre() {
            const burning = this.events.fire.burning;
            if (!burning.size) return null;
            let sx = 0, sy = 0, heat = 0, n = 0;
            for (const cell of burning.values()) {
                sx += cell.x; sy += cell.y; heat += cell.heat; n++;
            }
            const c = this._fireC || (this._fireC = { x: 0, y: 0, z: 0, heat: 0 });
            c.x = sx / n;
            c.z = sy / n;
            c.y = R3D.surfaceY(this.world, c.x, c.z);
            c.heat = MathUtils.clamp01(heat / n) * MathUtils.clamp01(n / 6);
            return c;
        }

        /* -------------------------------------------------------------- *
         * Frame
         * -------------------------------------------------------------- */

        render() {
            this.sky.follow(this.camera);
            this._syncAnimals();
            this._syncItems();
            this._syncVehicles();
            this._syncDarts();
            this._syncMarkers();

            // Exposure is the one place the 2D lighting model maps straight onto a
            // renderer setting: surfaces are authored at noon albedo and the hour
            // scales them, exactly as `Palettes.litColor` did.
            this.renderer.toneMappingExposure = this.light.exposure;
            this.renderer.render(this.scene, this.camera.camera);

            this.stats.food = this.ecology.food.length;
            this.stats.particles = this.particles.count;
        }

        /**
         * Move every animal's mesh onto its simulation state, adding and removing
         * meshes as the ecology gains and loses members.
         */
        _syncAnimals() {
            const world = this.world;
            const meshes = this.animalMeshes;
            const frame = ++this._frameToken;
            let visible = 0;

            for (const a of this.agents) {
                let mesh = meshes.get(a);
                if (!mesh) {
                    mesh = Creature3D.create(a.spec);
                    meshes.set(a, mesh);
                    this.scene.add(mesh);
                }

                const flight = a.spec.flight ? a.spec.flight.height * R3D.PX : 0;
                mesh.position.set(a.x, R3D.surfaceY(world, a.x, a.y) + flight, a.y);
                this._standOn(mesh, a.x, a.y, a.renderState.facing, flight ? 0 : 0.7);
                Creature3D.pose(mesh, a.renderState);

                // Dying animals fade rather than vanishing mid-step. One shared material
                // cannot fade an individual, so the mesh takes its own for the second it
                // is going — an allocation per death, and there are not many.
                const fade = a.fade;
                if (fade < 1) {
                    if (mesh.material === R3D.skinnedMaterial()) {
                        mesh.material = R3D.skinnedMaterial().clone();
                        mesh.material.transparent = true;
                        mesh.material.depthWrite = false;
                    }
                    mesh.material.opacity = fade;
                }
                mesh.visible = true;
                mesh.userData.frame = frame;
                visible++;
            }

            // Anything the ecology dropped this step was not touched above, so it goes.
            // Marking beats searching the agent list per mesh, which at a hundred
            // animals is ten thousand comparisons a frame for nothing.
            for (const [animal, mesh] of meshes) {
                if (mesh.userData.frame === frame) continue;
                this.scene.remove(mesh);
                if (mesh.material !== R3D.skinnedMaterial()) mesh.material.dispose();
                meshes.delete(animal);
            }

            this.stats.visible = visible;
        }

        /**
         * Tilt an object to the ground it stands on.
         *
         * Cheap, and the single thing that stops everything in the reserve looking like
         * it is standing on an invisible flat plane laid over the relief.
         */
        _standOn(obj, tx, ty, facing, blend) {
            obj.rotation.order = 'YXZ';
            obj.rotation.y = R3D.yawFor(facing || 0);
            if (!blend) {
                obj.rotation.x = 0;
                obj.rotation.z = 0;
                return;
            }
            const d = 0.45;
            const f = obj.rotation.y;
            const fx = Math.cos(-f), fz = Math.sin(-f);
            const ahead = R3D.groundY(this.world, tx + fx * d, ty + fz * d);
            const behind = R3D.groundY(this.world, tx - fx * d, ty - fz * d);
            const left = R3D.groundY(this.world, tx - fz * d, ty + fx * d);
            const right = R3D.groundY(this.world, tx + fz * d, ty - fx * d);
            obj.rotation.z = MathUtils.clamp(-(ahead - behind) / (2 * d), -0.5, 0.5) * blend;
            obj.rotation.x = MathUtils.clamp((left - right) / (2 * d), -0.5, 0.5) * blend;
        }

        _syncItems() {
            const meshes = this.itemMeshes;
            const food = this.ecology.food;
            const frame = this._frameToken;

            for (const item of food) {
                let mesh = meshes.get(item);
                if (!mesh) {
                    mesh = new THREE.Mesh(Models3D.itemGeometry(item.kind), R3D.solidMaterial());
                    mesh.castShadow = true;
                    mesh.rotation.y = (item.x * 7.3 + item.y * 3.1) % MathUtils.TAU;
                    meshes.set(item, mesh);
                    this.scene.add(mesh);
                }
                mesh.position.set(item.x, R3D.surfaceY(this.world, item.x, item.y), item.y);
                mesh.visible = !item.consumed;
                mesh.userData.frame = frame;
            }

            for (const [item, mesh] of meshes) {
                if (mesh.userData.frame === frame) continue;
                this.scene.remove(mesh);
                meshes.delete(item);
            }
        }

        _syncVehicles() {
            const w = this.world;
            this.rangerRig.update(this.ranger, w);
            this.loaderRig.update(this.relocation.loader, w);
            this.lorryRig.update(this.relocation.lorry, w);

            // The loader's arm carries a sedated animal; showing the cargo is what makes
            // the relocation chain legible rather than three vehicles milling about.
            const lift = this.relocation.loader.renderState.lift;
            this.loaderRig.chassis.position.y = 0.02 + (1 - (lift === undefined ? 1 : lift)) * 0.05;

            // Poachers come and go, so their vehicles are created on demand.
            const live = this.events.poachers;
            const frame = this._frameToken;
            for (const p of live) {
                let veh = this.poacherRigs.get(p);
                if (!veh) {
                    veh = Models3D.poacherTruck();
                    this.poacherRigs.set(p, veh);
                    this.scene.add(veh.object);
                }
                veh.update(p, w);
                veh.object.userData.frame = frame;
            }
            for (const [p, veh] of this.poacherRigs) {
                if (veh.object.userData.frame === frame) continue;
                this.scene.remove(veh.object);
                this.poacherRigs.delete(p);
            }

            // The gate barrier lifts for an arriving lorry.
            const barrier = this.gateMesh.userData.barrier;
            barrier.rotation.x = -this.gate.open * 1.3;
        }

        _syncDarts() {
            const darts = this.ranger.darts;
            while (this.dartMeshes.length < darts.length) {
                const mesh = new THREE.Mesh(Models3D.dartGeometry(), R3D.solidMaterial());
                this.dartMeshes.push(mesh);
                this.scene.add(mesh);
            }
            for (let i = 0; i < this.dartMeshes.length; i++) {
                const mesh = this.dartMeshes[i];
                const d = darts[i];
                mesh.visible = !!d;
                if (!d) continue;
                mesh.position.set(d.x, R3D.surfaceY(this.world, d.x, d.y) + d.z * R3D.PX, d.y);
                mesh.rotation.set(0, R3D.yawFor(d.angle), 0);
            }
        }

        /**
         * The in-world interface: what the pointer is over, what the ranger is aimed at,
         * and where the animal on the cursor would land.
         */
        _syncMarkers() {
            const w = this.world;

            const hovered = this.hovered;
            this.hoverRing.visible = !!(hovered && hovered.alive);
            if (this.hoverRing.visible) {
                const r = Math.max(0.35, hovered.radius * 0.9);
                this.hoverRing.scale.setScalar(r / 0.4);
                this.hoverRing.position.set(
                    hovered.x, R3D.surfaceY(w, hovered.x, hovered.y) + 0.05, hovered.y);
            }

            const ranger = this.ranger;
            this.rangeRing.visible = this.rangerArmed;
            if (this.rangeRing.visible) {
                const rad = ranger.dartRange * 0.72;
                this.rangeRing.scale.setScalar(rad);
                this.rangeRing.position.set(
                    ranger.x, R3D.surfaceY(w, ranger.x, ranger.y) + 0.06, ranger.y);
            }

            const quarry = ranger.quarry;
            this.quarryRing.visible = !!(quarry && quarry.alive);
            if (this.quarryRing.visible) {
                this.quarryRing.position.set(
                    quarry.x, R3D.surfaceY(w, quarry.x, quarry.y) + 0.05, quarry.y);
                this.quarryRing.rotation.y = this.clock * 0.8;
            }

            this._syncGhost();
        }

        /** The animal about to be placed, previewed on the ground under the pointer. */
        _syncGhost() {
            const p = this.placing;
            if (this.ghost) this.ghost.visible = false;
            this.placeDisc.visible = false;
            if (!p) return;

            const spec = IsoSpecies[p.id];
            if (!spec) return;

            const w = this.world;
            const tx = Math.floor(p.x) + 0.5;
            const ty = Math.floor(p.y) + 0.5;
            if (tx < 0 || ty < 0 || tx >= w.size || ty >= w.size) return;

            const amphibious = p.id === 'hippo' || p.id === 'crocodile';
            const valid = (w.waterAt(tx, ty) <= Config.terrain.water.wadeDepth || amphibious) &&
                w.slopeAt(tx, ty) < Config.terrain.maxWalkableSlope;

            const y = R3D.surfaceY(w, tx, ty);
            this.placeDisc.visible = true;
            this.placeDisc.position.set(tx, y + 0.04, ty);
            this.placeDisc.material.color.set(valid ? 0x7fd68a : 0xef5a50);
            this.placeDisc.material.opacity = 0.22 + 0.14 * (0.5 + 0.5 * Math.sin(this.clock * 4));

            let ghost = this.ghosts.get(p.id);
            if (!ghost) {
                ghost = Creature3D.create(spec, this.ghostMaterial);
                ghost.castShadow = false;
                ghost.receiveShadow = false;
                this.ghosts.set(p.id, ghost);
                this.scene.add(ghost);
            }
            if (this.ghost && this.ghost !== ghost) this.ghost.visible = false;
            this.ghost = ghost;
            ghost.visible = true;
            ghost.position.set(tx, y, ty);
            ghost.rotation.set(0, R3D.yawFor(0.9), 0);
            Creature3D.pose(ghost, {
                facing: 0.9, phase: 0, speed01: 0, time: this.clock,
                seed: 1, headDown: 0, blink: 0, earFlick: 0
            });
        }

        /* -------------------------------------------------------------- *
         * Teardown
         * -------------------------------------------------------------- */

        /**
         * Release everything this reserve allocated on the GPU.
         *
         * A run builds a new reserve rather than resetting the old one — the terrain,
         * its props and every seeded field derive from one seed, and threading a reseed
         * through all of them would be more code and more ways to leave something stale.
         * The cost of that choice is that this has to be thorough.
         */
        dispose() {
            const seen = new Set();
            this.scene.traverse((obj) => {
                if (!obj.geometry || seen.has(obj.geometry)) return;
                seen.add(obj.geometry);
                // Species rigs and item models are cached across reserves. Disposing
                // them here frees buffers the *next* reserve is about to draw from,
                // which shows up as the second run rendering nothing.
                if (obj.isSkinnedMesh || obj.geometry.userData.shared) return;
                obj.geometry.dispose();
            });
            this.terrain.dispose();
            this.scene.clear();
            this.animalMeshes.clear();
            this.itemMeshes.clear();
            this.ghosts.clear();
        }
    }

    Scene3D.STATION_RADIUS = STATION_RADIUS;
    Safari.Scene3D = Scene3D;

})(window.Safari, window.THREE);
