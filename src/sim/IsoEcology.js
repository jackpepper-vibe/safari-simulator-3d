/**
 * Safari Simulator — Ecology, isometric build.
 *
 * Populations and the rules that connect them, in tile space: spatial queries, hunting,
 * breeding, forage growth and decay, and the running statistics.
 *
 * Forage does not spawn uniformly here as it did on the flat field. The world has a
 * fertility field, so plants grow where the ground actually supports them — which means
 * grazers gather in the green hollows and the dry ground genuinely is poor country.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, Species, IsoSpecies, Events, Rng, IsoAnimal, IsoItemArt,
        Color } = Safari;

    /** Uniform bucket grid over the tile field. */
    class TileGrid {
        constructor(cell) {
            this.cell = cell || 6;
            this.cells = new Map();
            this.cols = 0;
        }

        configure(size) {
            this.cols = Math.ceil(size / this.cell) + 2;
        }

        _key(x, y) {
            return (Math.floor(y / this.cell) + 1) * this.cols +
                Math.floor(x / this.cell) + 1;
        }

        rebuild(items) {
            this.cells.clear();
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const k = this._key(item.x, item.y);
                let bucket = this.cells.get(k);
                if (!bucket) { bucket = []; this.cells.set(k, bucket); }
                bucket.push(item);
            }
        }

        query(x, y, radius, visit) {
            const r = Math.ceil(radius / this.cell);
            const cx = Math.floor(x / this.cell) + 1;
            const cy = Math.floor(y / this.cell) + 1;
            for (let gy = cy - r; gy <= cy + r; gy++) {
                for (let gx = cx - r; gx <= cx + r; gx++) {
                    const bucket = this.cells.get(gy * this.cols + gx);
                    if (!bucket) continue;
                    for (let i = 0; i < bucket.length; i++) visit(bucket[i]);
                }
            }
        }
    }

    class IsoEcology {
        /**
         * @param {Safari.EventBus} bus
         * @param {Safari.TileWorld} world
         * @param {number} seed
         */
        constructor(bus, world, seed) {
            this.bus = bus;
            this.world = world;
            this.rng = new Rng((seed || 1) ^ 0xEC02);

            /** @type {IsoAnimal[]} */
            this.animals = [];
            /** @type {Array} */
            this.food = [];

            this.animalGrid = new TileGrid(6);
            this.foodGrid = new TileGrid(6);
            this.animalGrid.configure(world.size);
            this.foodGrid.configure(world.size);

            this.foodTimer = 0;
            this._foodSeed = 1;
            this.stats = this._blankStats();

            // Counted here because an animal dies inside its own update, which has no
            // reference to the statistics.
            bus.on(Events.ANIMAL_STARVED, () => { this.stats.starved++; });
            bus.on(Events.ANIMAL_TRANQUILIZED, () => { this.stats.tranquilized++; });

            this.ctx = {
                bus, world,
                rng: this.rng,
                time: 0, isNight: false, heat: 0,
                nearestPrey: this.nearestPrey.bind(this),
                nearestThreat: this.nearestThreat.bind(this),
                nearestFood: this.nearestFood.bind(this),
                consumeFood: this.consumeFood.bind(this),
                killPrey: this.killPrey.bind(this),
                countNear: this.countNear.bind(this),
                /** Set by the scene each tick when a fire is burning. */
                fire: null
            };
        }

        _blankStats() {
            return {
                placedCarnivores: 0, placedHerbivores: 0,
                born: 0, eaten: 0, starved: 0, tranquilized: 0, fed: 0,
                peakPopulation: 0
            };
        }

        reset() {
            this.animals.length = 0;
            this.food.length = 0;
            this.stats = this._blankStats();
            this.foodTimer = 0;
        }

        get population() { return this.animals.length; }

        /**
         * Take an animal out of the reserve without killing it.
         *
         * Used when the loader lifts a sedated animal aboard: it has left the ecology,
         * but nothing died and nothing should be counted as a loss.
         */
        remove(animal) {
            const i = this.animals.indexOf(animal);
            if (i < 0) return false;
            this.animals.splice(i, 1);
            animal.alive = false;
            animal.removed = true;
            return true;
        }

        countByDiet(diet) {
            let n = 0;
            for (const a of this.animals) if (a.alive && a.diet === diet) n++;
            return n;
        }

        /**
         * How many of a species are within reach of a point.
         *
         * The reserve had no notion of local density at all — only a global ceiling —
         * so a pod could keep breeding in one pool until the whole population was
         * standing in it.
         */
        countNear(x, y, radius, species) {
            let n = 0;
            this.animalGrid.query(x, y, radius, (a) => {
                if (!a.alive) return;
                if (species && a.species !== species) return;
                if (Math.hypot(a.x - x, a.y - y) <= radius) n++;
            });
            return n;
        }

        /* -------------------------------------------------------------- *
         * Population
         * -------------------------------------------------------------- */

        /** Animals the warden has introduced from the dock. Births do not count. */
        get introduced() {
            return this.stats.placedCarnivores + this.stats.placedHerbivores;
        }

        /**
         * How many of a diet's allowance is left.
         * @param {string} diet 'carnivore' for the predator allowance, anything else
         *     for the grazer one.
         */
        stockLeft(diet) {
            return diet === 'carnivore'
                ? Math.max(0, Config.goal.stock.predators - this.stats.placedCarnivores)
                : Math.max(0, Config.goal.stock.grazers - this.stats.placedHerbivores);
        }

        /** How many of a species may still be brought in. */
        stockLeftFor(speciesId) {
            const spec = IsoSpecies[speciesId];
            return spec ? this.stockLeft(spec.diet) : 0;
        }

        spawn(speciesId, tx, ty, isBaby) {
            if (this.animals.length >= Config.sim.maxAnimals) return null;
            // The stocking allowance is enforced here rather than at the click, so no
            // route into the reserve — dock, debug console, future scenario script —
            // can quietly hand out animals the brief assumes were never available.
            if (!isBaby && this.stockLeftFor(speciesId) <= 0) return null;
            const animal = new IsoAnimal(speciesId, tx, ty, isBaby, this.rng);
            this.animals.push(animal);

            if (isBaby) {
                this.stats.born++;
                this.bus.emit(Events.ANIMAL_BORN, { animal });
            } else {
                if (animal.diet === 'carnivore') this.stats.placedCarnivores++;
                else this.stats.placedHerbivores++;
                this.bus.emit(Events.ANIMAL_PLACED, { animal });
            }
            this.stats.peakPopulation = Math.max(this.stats.peakPopulation, this.animals.length);
            return animal;
        }

        /** Place an animal on ground it can actually stand on, near a preferred spot. */
        spawnNear(speciesId, tx, ty, isBaby) {
            const w = this.world;
            const amphibious = speciesId === 'hippo' || speciesId === 'crocodile';
            for (let r = 0; r < 14; r++) {
                for (let attempt = 0; attempt < 8; attempt++) {
                    const a = this.rng.next() * MathUtils.TAU;
                    const nx = tx + Math.cos(a) * r;
                    const ny = ty + Math.sin(a) * r;
                    if (nx < 2 || ny < 2 || nx >= w.size - 2 || ny >= w.size - 2) continue;
                    const depth = w.waterAt(nx, ny);
                    if (depth > Config.terrain.water.wadeDepth && !amphibious) continue;
                    if (w.slopeAt(nx, ny) >= Config.terrain.maxWalkableSlope) continue;
                    return this.spawn(speciesId, nx, ny, isBaby);
                }
            }
            return null;
        }

        /* -------------------------------------------------------------- *
         * Queries
         * -------------------------------------------------------------- */

        nearestPrey(hunter, range) {
            let best = null, bestDist = range;
            const maxPrey = (hunter.stats.maxPrey || hunter.stats.radius * 1.15) /
                IsoAnimal.UNITS_PER_TILE;

            this.animalGrid.query(hunter.x, hunter.y, range, (a) => {
                if (!a.alive || a === hunter) return;
                if (a.diet !== 'herbivore' || !a.stats.huntable) return;
                if (a.state === IsoAnimal.State.TRANQUILIZED) return;
                if (a.radius > maxPrey) return;
                const d = Math.hypot(a.x - hunter.x, a.y - hunter.y);
                if (d < bestDist) { bestDist = d; best = a; }
            });
            return best;
        }

        nearestThreat(prey, range) {
            let best = null, bestDist = range;
            this.animalGrid.query(prey.x, prey.y, range, (a) => {
                if (!a.alive || a === prey) return;
                if (a.diet !== 'carnivore') return;
                if (a.state === IsoAnimal.State.TRANQUILIZED ||
                    a.state === IsoAnimal.State.SLEEP) return;
                // Flee only from predators that would actually give chase.
                const maxPrey = (a.stats.maxPrey || a.stats.radius * 1.15) /
                    IsoAnimal.UNITS_PER_TILE;
                if (prey.radius > maxPrey) return;
                const d = Math.hypot(a.x - prey.x, a.y - prey.y);
                if (d < bestDist) { bestDist = d; best = a; }
            });
            return best;
        }

        nearestFood(animal, diet, range) {
            let best = null, bestDist = range;
            this.foodGrid.query(animal.x, animal.y, range, (f) => {
                if (f.consumed) return;
                if (IsoItemArt.KINDS[f.kind].diet !== diet) return;
                const d = Math.hypot(f.x - animal.x, f.y - animal.y);
                if (d < bestDist) { bestDist = d; best = f; }
            });
            return best;
        }

        /* -------------------------------------------------------------- *
         * Interactions
         * -------------------------------------------------------------- */

        consumeFood(animal, item) {
            if (item.consumed) return;
            const kind = IsoItemArt.KINDS[item.kind];

            if (item.kind === 'carcass') {
                item.decay = Math.min(1, (item.decay || 0) + 0.34);
                animal.feed(kind.energy * 0.45);
                if (item.decay >= 1) item.consumed = true;
            } else {
                item.consumed = true;
                animal.feed(kind.energy);
            }
            this.stats.fed++;
            this.bus.emit(Events.ANIMAL_ATE, { animal, item });
        }

        killPrey(hunter, prey) {
            if (!prey.alive) return;
            hunter.feed(prey.maxEnergy * Config.sim.preyEnergyYield);
            this.stats.eaten++;
            prey.die(this.ctx, 'eaten');
            this.spawnCarcass(prey.x, prey.y);
            this.bus.emit(Events.ANIMAL_DIED, { animal: prey, cause: 'eaten', by: hunter });
        }

        tryBreed(animal, dt) {
            if (animal.isBaby || animal.breedCooldown > 0) return;
            if (animal.energyRatio < Config.sim.breedEnergyThreshold) return;
            if (animal.state === IsoAnimal.State.FLEE ||
                animal.state === IsoAnimal.State.TRANQUILIZED ||
                animal.state === IsoAnimal.State.DYING) return;
            if (this.animals.length >= Config.sim.maxAnimals) return;

            const pressure = MathUtils.clamp01(
                (this.animals.length - Config.sim.softPopulationCap) /
                Math.max(1, Config.sim.maxAnimals - Config.sim.softPopulationCap));

            /*
             * Local carrying capacity.
             *
             * The global soft cap says nothing about whether *this* patch of ground can
             * support another mouth, and for animals that stay put it says nothing
             * useful at all: a hippo pod bred itself to twenty in one small lake,
             * dying and calving in the same water, because nothing counted the
             * neighbours. Big animals need more room than small ones, so the limit
             * scales with the space one of them takes up.
             */
            const local = Config.sim.localCrowdRadius;
            const limit = Math.max(2, Math.round(Config.sim.localCrowdCap /
                Math.max(0.5, animal.radius)));
            if (this.countNear(animal.x, animal.y, local, animal.species) >= limit) return;

            if (!this.rng.chance(animal.stats.breedChance * (1 - pressure) * dt)) return;

            const radius = Config.sim.breedRadius / IsoAnimal.UNITS_PER_TILE;
            let partner = null;
            this.animalGrid.query(animal.x, animal.y, radius, (a) => {
                if (partner || a === animal || !a.alive || a.isBaby) return;
                if (a.species !== animal.species) return;
                if (a.breedCooldown > 0) return;
                if (a.energyRatio < Config.sim.breedEnergyThreshold) return;
                if (a.state === IsoAnimal.State.TRANQUILIZED ||
                    a.state === IsoAnimal.State.DYING) return;
                if (Math.hypot(a.x - animal.x, a.y - animal.y) < radius) partner = a;
            });
            if (!partner) return;

            const baby = this.spawnNear(animal.species,
                (animal.x + partner.x) / 2, (animal.y + partner.y) / 2, true);
            if (!baby) return;

            animal.breedCooldown = Config.sim.breedCooldown;
            partner.breedCooldown = Config.sim.breedCooldown;
            const cost = Config.sim.breedEnergyCost;
            animal.energy -= animal.maxEnergy * cost;
            partner.energy -= partner.maxEnergy * cost;
        }

        /* -------------------------------------------------------------- *
         * Forage
         * -------------------------------------------------------------- */

        _makeItem(kind, x, y) {
            return {
                kind, x, y,
                seed: this._foodSeed++,
                consumed: false, eaten: 0, decay: 0, life: 0
            };
        }

        /**
         * Grow one plant somewhere the ground supports it.
         *
         * Candidates are accepted in proportion to fertility, so forage appears in the
         * green hollows rather than scattered evenly over rock and sand. This is what
         * gives the reserve good country and poor country.
         */
        /**
         * Grow one plant somewhere the ground supports it.
         *
         * @param {object} [area] `{x, y, radius}` in tiles to place within. Ambient
         *   growth passes nothing and takes the whole reserve.
         * @param {number} [cap] Item ceiling to respect.
         */
        growPlant(area, cap) {
            if (this.food.length >= (cap || Config.sim.maxFood)) return null;
            const w = this.world;

            for (let attempt = 0; attempt < 30; attempt++) {
                let x, y;
                if (area) {
                    const a = this.rng.next() * MathUtils.TAU;
                    const d = Math.sqrt(this.rng.next()) * area.radius;
                    x = MathUtils.clamp(area.x + Math.cos(a) * d, 2, w.size - 2);
                    y = MathUtils.clamp(area.y + Math.sin(a) * d, 2, w.size - 2);
                } else {
                    x = this.rng.range(2, w.size - 2);
                    y = this.rng.range(2, w.size - 2);
                }

                if (w.waterAt(x, y) > 0) continue;
                const fert = w.fertilityAt(x, y);
                // A hand-scattered bale lands where it is thrown; only ambient growth
                // is fussy about the ground being good.
                if (!area) {
                    if (fert < 0.15) continue;
                    if (!this.rng.chance(fert)) continue;
                } else if (w.slopeAt(x, y) >= Config.terrain.maxWalkableSlope) {
                    continue;
                }

                const item = this._makeItem(IsoItemArt.randomPlant(this.rng), x, y);
                this.food.push(item);
                return item;
            }
            return null;
        }

        /**
         * Scatter a burst by hand.
         *
         * Two things made the button appear to do nothing at all. It dropped a dozen
         * items anywhere across seven thousand tiles, so they almost never landed in
         * view; and it obeyed the same ceiling the ambient spawner keeps the reserve
         * pinned against, so most presses placed nothing whatsoever. A hand-scattered
         * burst now lands in a tight patch where the player is looking, and carries its
         * own headroom above the ambient cap.
         *
         * @param {number} [count]
         * @param {object} [area] `{x, y, radius}` in tiles; defaults to the whole map.
         * @returns {object[]} The items actually placed.
         */
        scatterForage(count, area) {
            const [min, max] = Config.sim.foodBurstCount;
            const n = count || this.rng.int(min, max);
            const cap = area ? Config.sim.maxFood + n : Config.sim.maxFood;

            const placed = [];
            for (let i = 0; i < n; i++) {
                const item = this.growPlant(area, cap);
                if (item) placed.push(item);
            }
            this.bus.emit(Events.FOOD_SPAWNED, { count: placed.length, items: placed });
            return placed;
        }

        spawnCarcass(x, y) {
            const item = this._makeItem('carcass', x, y);
            this.food.push(item);
            return item;
        }

        _countPlants() {
            let n = 0;
            for (const f of this.food) {
                if (!f.consumed && IsoItemArt.KINDS[f.kind].diet === 'plant') n++;
            }
            return n;
        }

        /* -------------------------------------------------------------- *
         * Tick
         * -------------------------------------------------------------- */

        /**
         * Keep animals out of each other.
         *
         * Nothing in the reserve had any collision with anything else, so animals could
         * and did occupy the same point. It went unnoticed while everything was walking,
         * because a herd on the move spreads itself out — but the moment a group stopped
         * in the same place, which is exactly what a hippo pod does on reaching water,
         * they stacked into one animal-shaped heap.
         *
         * Resolved as a position correction after everyone has moved, rather than as a
         * steering force during movement: a steering force does nothing for an animal
         * that is deliberately standing still, which is the case that shows.
         *
         * Anything down — sedated, dying — has infinite mass. Being shoved across the
         * ground while unconscious looks worse than the overlap did.
         */
        _separate(dt) {
            const list = this.animals;
            const push = Math.min(1, dt * 9);

            for (let i = 0; i < list.length; i++) {
                const a = list[i];
                if (!a.alive || a.flies) continue;

                const reach = a.radius * 2.4;
                this.animalGrid.query(a.x, a.y, reach, (b) => {
                    if (b === a || !b.alive || b.flies) return;
                    // Each pair is resolved once, by the lower id.
                    if (b.id < a.id) return;

                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const want = (a.radius + b.radius) * 0.85;
                    let d = Math.hypot(dx, dy);
                    if (d >= want) return;

                    // Exactly coincident: shove apart along a stable arbitrary axis.
                    let nx, ny;
                    if (d < 1e-4) {
                        const ang = ((a.id * 2654435761) % 628) / 100;
                        nx = Math.cos(ang);
                        ny = Math.sin(ang);
                        d = 0.001;
                    } else {
                        nx = dx / d;
                        ny = dy / d;
                    }

                    const overlap = (want - d) * push;
                    const aFixed = a.isDown;
                    const bFixed = b.isDown;
                    if (aFixed && bFixed) return;

                    // Heavier animals give less ground, and a downed one gives none.
                    const aw = aFixed ? 0 : (bFixed ? 1 : b.radius / (a.radius + b.radius));
                    const bw = bFixed ? 0 : (aFixed ? 1 : a.radius / (a.radius + b.radius));

                    this._nudge(a, -nx * overlap * aw, -ny * overlap * aw);
                    this._nudge(b, nx * overlap * bw, ny * overlap * bw);
                });
            }
        }

        /** Move an animal by a small offset, but never onto ground it cannot stand on. */
        _nudge(animal, dx, dy) {
            if (dx === 0 && dy === 0) return;
            const w = this.world;
            if (animal._standable(w, animal.x + dx, animal.y + dy)) {
                animal.x += dx;
                animal.y += dy;
            } else if (animal._standable(w, animal.x + dx, animal.y)) {
                animal.x += dx;
            } else if (animal._standable(w, animal.x, animal.y + dy)) {
                animal.y += dy;
            }
        }

        update(dt, env) {
            const ctx = this.ctx;
            ctx.time = env.time;
            ctx.isNight = env.isNight;
            ctx.heat = env.heat;

            this.animalGrid.rebuild(this.animals);
            this.foodGrid.rebuild(this.food);

            let write = 0;
            for (let i = 0; i < this.animals.length; i++) {
                const a = this.animals[i];
                a.update(dt, ctx);
                if (a.alive) this.tryBreed(a, dt);
                else if (a.isExpired) continue;
                this.animals[write++] = a;
            }
            this.animals.length = write;

            this._separate(dt);

            write = 0;
            for (let i = 0; i < this.food.length; i++) {
                const f = this.food[i];
                f.life += dt;
                if (f.consumed) {
                    f.eaten = Math.min(1, f.eaten + dt * 3.2);
                    if (f.eaten >= 1) continue;
                } else if (f.kind === 'carcass' && f.life > Config.sim.carcassLifetime) {
                    f.consumed = true;
                }
                this.food[write++] = f;
            }
            this.food.length = write;

            /* Ambient growth ------------------------------------------------ */
            this.foodTimer -= dt;
            if (this.foodTimer <= 0) {
                this.foodTimer = Config.sim.foodSpawnInterval;
                const target = Config.sim.plantTarget;
                const plants = this._countPlants();
                if (plants < target) {
                    // Regrow faster the emptier the reserve gets.
                    const urgency = MathUtils.clamp01((target - plants) / target);
                    const n = 1 + Math.floor(urgency * 3);
                    for (let i = 0; i < n; i++) this.growPlant();
                }
            }
        }

        /** Apply a dart at a tile point. */
        applyDart(x, y) {
            let best = null;
            let bestDist = Config.sim.dartHitRadius / IsoAnimal.UNITS_PER_TILE;
            for (const a of this.animals) {
                if (!a.alive || a.state === IsoAnimal.State.TRANQUILIZED) continue;
                const d = Math.hypot(a.x - x, a.y - y) - a.radius * 0.55;
                if (d < bestDist) { bestDist = d; best = a; }
            }
            if (best && best.tranquilize(Config.sim.tranquilizerDuration)) {
                this.stats.tranquilized++;
                this.bus.emit(Events.ANIMAL_TRANQUILIZED, { animal: best });
                return best;
            }
            return null;
        }
    }

    IsoEcology.TileGrid = TileGrid;
    Safari.IsoEcology = IsoEcology;

})(window.Safari);
