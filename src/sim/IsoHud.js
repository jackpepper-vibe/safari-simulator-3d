/**
 * Safari Simulator — Interface, isometric build.
 *
 * Drives the DOM overlay for the isometric reserve: the species dock, the statistics
 * rail, the clock, the event feed, the hover inspector and the minimap.
 *
 * Dock portraits are rendered with the same `IsoCreatureArt` that draws the world, so a
 * button can never drift from the animal it places. The minimap is baked once from the
 * tile world and then only overlaid, because the terrain itself never changes.
 */
(function (Safari) {
    'use strict';

    const {
        MathUtils, Color, Config, Species, Events, Palettes,
        IsoSpecies, IsoSpeciesLists, IsoCreatureArt, IsoAnimal, TileWorld,
        IsoGoals
    } = Safari;

    const SUB = TileWorld.SUB;
    const TAU = MathUtils.TAU;

    /**
     * The icon set is shared with the side-on interface rather than duplicated. The two
     * builds render different worlds, but they are one product and should look it.
     */
    const ICONS = Safari.HUD ? Safari.HUD.ICONS : {};

    /** Minimap colours per substrate, kept flat and legible rather than realistic. */
    const MAP_COLORS = [
        '#7d9147', // GRASS
        '#a8a45e', // DRY_GRASS
        '#98794c', // DIRT
        '#c9b68a', // SAND
        '#8b8478', // ROCK
        '#37697a'  // WATER
    ];

    /**
     * "A zebra", but "an elephant".
     *
     * Every species name in the feed goes through this. Eagle and elephant are the two
     * that catch it, and "a elephant starved" undoes a lot of careful writing elsewhere.
     */
    function article(word, capital) {
        const a = /^[aeiou]/i.test(word) ? 'an' : 'a';
        return (capital ? a.charAt(0).toUpperCase() + a.slice(1) : a) + ' ' + word;
    }

    /** Player-facing names for the behaviour states. */
    const STATE_LABELS = {
        wander: 'Roaming', forage: 'Foraging', drink: 'Drinking',
        hunt: 'Hunting', flee: 'Fleeing', rest: 'Resting', wallow: 'Wallowing',
        sleep: 'Sleeping', tranquilized: 'Sedated', dying: 'Dying'
    };

    const METERS = [
        { key: 'energy', label: 'Fed', color: (v) => v > 0.55 ? '#7fd68a' : (v > 0.28 ? '#e9a94a' : '#ef5a50') },
        { key: 'thirst', label: 'Water', color: (v) => v > 0.5 ? '#6fd0e8' : (v > 0.22 ? '#e9a94a' : '#ef5a50') }
    ];

    class IsoHud {
        /**
         * @param {Safari.EventBus} bus
         * @param {object} refs
         */
        constructor(bus, refs) {
            this.bus = bus;
            this.el = refs;
            this.time = 0;

            this.display = {};
            this.targets = {};
            this.logEntries = [];
            this.toasts = [];
            this.soundOn = true;

            this.clockCtx = refs.clockCanvas ? refs.clockCanvas.getContext('2d') : null;

            /** Species currently armed for placement, or null. */
            this.selected = null;

            this.portraitLight = Palettes.sample(9.5);
            this.mapBaked = null;

            this._buildDock();
            this._buildStats();
            this._bindEvents();
        }

        /* -------------------------------------------------------------- *
         * Dock
         * -------------------------------------------------------------- */

        _buildDock() {
            const dock = this.el.dock;
            if (!dock) return;
            dock.innerHTML = '';

            const groups = [
                { id: 'carnivore', diet: 'carnivore', label: 'Predators',
                    ids: IsoSpeciesLists.CARNIVORES },
                { id: 'herbivore', diet: 'herbivore', label: 'Grazers',
                    ids: IsoSpeciesLists.HERBIVORES }
            ];

            this.cards = [];
            /*
             * The allowances, one per group, sitting in the group heading.
             *
             * They are the most important numbers in the game — everything the brief
             * asks for is paid out of them — and they belong beside the cards they
             * govern rather than in a single pooled figure. A pooled counter gave no
             * hint that spending it all on grazers left the predator objectives
             * permanently out of reach.
             */
            this._stock = {};
            for (const group of groups) {
                const section = document.createElement('div');
                section.className = 'dock-group dock-group--' + group.id;

                const heading = document.createElement('div');
                heading.className = 'dock-group__label';
                heading.innerHTML = '<span>' + group.label + '</span>' +
                    '<b class="dock-group__stock"></b>';
                section.appendChild(heading);

                this._stock[group.diet] = {
                    section,
                    n: heading.querySelector('.dock-group__stock'),
                    ids: group.ids,
                    left: -1
                };

                const row = document.createElement('div');
                row.className = 'dock-group__row';
                for (const id of group.ids) row.appendChild(this._card(id));
                section.appendChild(row);
                dock.appendChild(section);
            }

            dock.appendChild(this._rangerGroup());
        }

        /**
         * The ranger's own group.
         *
         * Commanding the vehicle used to be bound to the right mouse button, which
         * meant every stray right-click anywhere on the map sent it driving. It is a
         * tool like any other now: arm it from the dock, then click what you want it
         * to do — ground to drive, an animal to sedate.
         */
        _rangerGroup() {
            const section = document.createElement('div');
            section.className = 'dock-group dock-group--ranger';

            const heading = document.createElement('div');
            heading.className = 'dock-group__label';
            heading.textContent = 'Ranger';
            section.appendChild(heading);

            const row = document.createElement('div');
            row.className = 'dock-group__row';

            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'card card--ranger';
            card.dataset.species = 'ranger';
            card.setAttribute('aria-label', 'Command the ranger');

            const art = Safari.IsoVehicleArt.makePortrait(66, 52, this.portraitLight);
            art.className = 'card__art';
            card.appendChild(art);

            const name = document.createElement('span');
            name.className = 'card__name';
            name.textContent = 'Ranger';
            card.appendChild(name);

            const tip = document.createElement('span');
            tip.className = 'tooltip';
            tip.innerHTML =
                '<b>Ranger</b>' +
                '<i>Your one direct hand in the reserve.</i>' +
                '<span class="tooltip__stats">' +
                '<em>Click ground</em>Drive there' +
                '<em>Click animal</em>Sedate it' +
                '<em>Dart</em>Wears off in ' + Math.round(Config.sim.tranquilizerDuration) + 's' +
                '</span>';
            card.appendChild(tip);

            card.addEventListener('click', () => this.select('ranger'));
            this.cards.push(card);
            row.appendChild(card);
            section.appendChild(row);
            return section;
        }

        _card(id) {
            const spec = IsoSpecies[id];
            const stats = Species[id].stats;

            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'card';
            card.dataset.species = id;
            card.setAttribute('aria-label', 'Place a ' + spec.label);

            // Rendered with the world's own art, measured and fitted to the tile, so a
            // button can never drift from the animal it places.
            const portrait = IsoCreatureArt.makePortrait(id, 66, 52, this.portraitLight);
            portrait.className = 'card__art';
            card.appendChild(portrait);

            const name = document.createElement('span');
            name.className = 'card__name';
            name.textContent = spec.label;
            card.appendChild(name);

            const tip = document.createElement('span');
            tip.className = 'tooltip';
            const speed = stats.runSpeed > 130 ? 'Very fast'
                : stats.runSpeed > 105 ? 'Fast'
                    : stats.runSpeed > 75 ? 'Steady' : 'Slow';
            tip.innerHTML =
                '<b>' + spec.label + '</b>' +
                '<i>' + Species[id].blurb + '</i>' +
                '<span class="tooltip__stats">' +
                '<em>Speed</em>' + speed +
                '<em>Stamina</em>' + Math.round(stats.maxEnergy) +
                '<em>Senses</em>' + (stats.sense / IsoAnimal.UNITS_PER_TILE).toFixed(0) + ' tiles' +
                '</span>';
            card.appendChild(tip);

            card.addEventListener('click', () => this.select(id));
            this.cards.push(card);
            return card;
        }

        /** Arm a species for placement, or disarm if it was already armed. */
        select(id) {
            this.selected = this.selected === id ? null : id;
            for (const card of this.cards) {
                card.classList.toggle('is-armed', card.dataset.species === this.selected);
            }
            document.body.classList.toggle('is-arming', !!this.selected);
            document.body.classList.toggle('is-ranging', this.selected === 'ranger');
        }

        /* -------------------------------------------------------------- *
         * Statistics
         * -------------------------------------------------------------- */

        _buildStats() {
            const rail = this.el.stats;
            if (!rail) return;
            rail.innerHTML = '';

            const defs = [
                { key: 'predators', label: 'Predators', tone: 'warm', icon: 'predator' },
                { key: 'grazers', label: 'Grazers', tone: 'cool', icon: 'prey' },
                { key: 'born', label: 'Born', tone: 'good', icon: 'born' },
                { key: 'eaten', label: 'Hunted', tone: 'warm', icon: 'eaten' },
                { key: 'starved', label: 'Starved', tone: 'bad', icon: 'starved' },
                { key: 'moved', label: 'Relocated', tone: 'cool', icon: 'tranq' }
            ];

            this.statEls = {};
            for (const d of defs) {
                const chip = document.createElement('div');
                chip.className = 'chip chip--' + d.tone;
                chip.innerHTML =
                    (ICONS[d.icon] ? '<span class="chip__icon">' + ICONS[d.icon] + '</span>' : '') +
                    '<span class="chip__value">0</span>' +
                    '<span class="chip__label">' + d.label + '</span>';
                rail.appendChild(chip);
                this.statEls[d.key] = chip.querySelector('.chip__value');
                this.display[d.key] = 0;
                this.targets[d.key] = 0;
            }
        }

        _bindEvents() {
            const bus = this.bus;
            bus.on(Events.ANIMAL_BORN, (p) =>
                this.log(article(IsoSpecies[p.animal.species].label.toLowerCase(), true) +
                    ' calf was born', 'good'));
            bus.on(Events.ANIMAL_STARVED, (p) =>
                this.log(article(IsoSpecies[p.animal.species].label.toLowerCase(), true) +
                    ' starved', 'bad'));
            bus.on(Events.ANIMAL_DIED, (p) => {
                if (p.cause === 'eaten' && p.by) {
                    this.log(IsoSpecies[p.by.species].label + ' brought down ' +
                        article(IsoSpecies[p.animal.species].label.toLowerCase()), 'warm');
                }
            });
            bus.on(Events.ANIMAL_TRANQUILIZED, (p) =>
                this.log(IsoSpecies[p.animal.species].label + ' sedated', 'cool'));
            bus.on(Events.TIME_DAY_CHANGED, (p) => {
                this.log('Day ' + p.day + ' begins', 'good');
                this.toast('Day ' + p.day, 'good');
            });
            bus.on(Events.WEATHER_CHANGED, (p) => {
                this.log(p.to.label, 'muted');
                this.toast(p.to.label, 'muted');
            });
            bus.on(Events.TIME_PERIOD_CHANGED, (p) => {
                if (p.to.id === 'golden') this.toast('Golden hour', 'warm');
                else if (p.to.id === 'dawn') this.toast('Dawn breaks', 'warm');
                else if (p.to.id === 'night' || p.to.id === 'night2') this.toast('Nightfall', 'cool');
            });
            bus.on(Events.TOAST, (p) => this.toast(p.message, p.tone));

            /* --- Pressure on the reserve --------------------------------- */
            bus.on(Events.DROUGHT_STARTED, (p) =>
                this.log('Drought — the grass will not come back for ' +
                    Math.round(p.days) + ' days', 'bad'));
            bus.on(Events.DROUGHT_ENDED, () => this.log('The rains return', 'good'));
            bus.on(Events.FIRE_STARTED, () => this.log('Fire on the reserve', 'bad'));
            bus.on(Events.FIRE_OUT, (p) =>
                this.log('Fire out — ' + p.scar + ' tiles burnt', 'muted'));
            bus.on(Events.POACHER_SIGHTED, () =>
                this.log('Poachers on the reserve', 'bad'));
            bus.on(Events.POACHER_DRIVEN_OFF, (p) =>
                this.log(p.kills ? 'Poachers gone, ' + p.kills + ' taken'
                    : 'Poachers driven off empty-handed', p.kills ? 'warm' : 'good'));
            bus.on(Events.POACHER_KILLED_ANIMAL, (p) =>
                this.log('Poachers took ' +
                    article(IsoSpecies[p.animal.species].label.toLowerCase()), 'bad'));

            /* --- Relocation ---------------------------------------------- */
            bus.on(Events.ANIMAL_LOADED, (p) =>
                this.log(IsoSpecies[p.animal.species].label + ' loaded', 'cool'));
            bus.on(Events.ANIMAL_RELOCATED, (p) =>
                this.log(IsoSpecies[p.species].label + ' left the reserve', 'good'));
        }

        /** Clear everything that belongs to a finished run. */
        reset() {
            for (const e of this.logEntries) e.el.remove();
            this.logEntries.length = 0;
            for (const t of this.toasts) t.el.remove();
            this.toasts.length = 0;
            this.select(null);
            for (const key in this.display) {
                this.display[key] = 0;
                this.targets[key] = 0;
            }
            this._inspected = null;
            if (this.el.inspector) this.el.inspector.classList.remove('is-visible');
        }

        /** A brief centred message, for things the feed would bury. */
        toast(message, tone) {
            const host = this.el.toasts;
            if (!host) return;
            const el = document.createElement('div');
            el.className = 'toast toast--' + (tone || 'muted');
            el.textContent = message;
            host.appendChild(el);
            void el.offsetWidth;
            el.classList.add('is-in');
            this.toasts.push({ el, life: Config.ui.toastDuration });
        }

        log(message, tone) {
            const feed = this.el.feed;
            if (!feed) return;
            const entry = document.createElement('div');
            entry.className = 'feed__entry feed__entry--' + (tone || 'muted');
            entry.textContent = message;
            feed.insertBefore(entry, feed.firstChild);
            void entry.offsetWidth;
            entry.classList.add('is-in');
            this.logEntries.unshift({ el: entry, life: Config.ui.logEntryLifetime });
            while (this.logEntries.length > Config.ui.maxLogEntries) {
                this.logEntries.pop().el.remove();
            }
        }

        /* -------------------------------------------------------------- *
         * Minimap
         * -------------------------------------------------------------- */

        /**
         * Bake the terrain into the minimap once.
         *
         * The tile world never changes after generation, so this is drawn a single time
         * and only overlaid thereafter — panning the camera costs one blit and a few
         * dots, not a re-render of the whole reserve.
         */
        bakeMap(world) {
            const size = 180;
            const canvas = Safari.Utils.createCanvas(size, size);
            const ctx = canvas.getContext('2d');
            const img = ctx.createImageData(size, size);
            const data = img.data;

            for (let py = 0; py < size; py++) {
                for (let px = 0; px < size; px++) {
                    const tx = Math.floor(px / size * world.size);
                    const ty = Math.floor(py / size * world.size);
                    const k = world.index(tx, ty);
                    const c = Color.parse(MAP_COLORS[world.substrate[k]] || MAP_COLORS[0]);

                    // Shade by elevation so relief reads on the map too.
                    const lit = 0.78 + MathUtils.clamp01(
                        world.height[k] / Config.terrain.relief.maxHeight) * 0.5;
                    const o = (py * size + px) * 4;
                    data[o] = MathUtils.clamp(c.r * lit, 0, 255);
                    data[o + 1] = MathUtils.clamp(c.g * lit, 0, 255);
                    data[o + 2] = MathUtils.clamp(c.b * lit, 0, 255);
                    data[o + 3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);
            this.mapBaked = canvas;
            this.mapSize = size;
        }

        /**
         * Overlay animals and the current viewport onto the baked map.
         *
         * @param {Safari.CameraRig} camera
         */
        drawMap(world, ecology, camera) {
            const canvas = this.el.minimap;
            if (!canvas || !this.mapBaked) return;

            const size = this.mapSize;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            if (canvas.width !== size * dpr) {
                canvas.width = size * dpr;
                canvas.height = size * dpr;
            }
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.drawImage(this.mapBaked, 0, 0);

            const k = size / world.size;

            // Animals: predators warm, grazers cool.
            for (const a of ecology.animals) {
                if (!a.alive) continue;
                ctx.fillStyle = a.diet === 'carnivore' ? '#f0894c' : '#9fe8b0';
                ctx.fillRect(a.x * k - 1, a.y * k - 1, 2.5, 2.5);
            }

            /*
             * Viewport outline.
             *
             * In the 2D build this was the four corners of the screen rectangle pushed
             * back through the isometric inverse, which gave a diamond. A perspective
             * camera over relief has no closed-form inverse, so the rig picks the four
             * corners by raycast instead — same four points, and it stays correct at any
             * yaw, pitch and zoom rather than only for one fixed rake.
             */
            const corners = camera.viewCorners(world, this._mapCorners ||
                (this._mapCorners = []));
            ctx.strokeStyle = 'rgba(255,246,225,0.85)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            for (let i = 0; i < 4; i++) {
                const c = corners[i];
                if (i === 0) ctx.moveTo(c.x * k, c.y * k);
                else ctx.lineTo(c.x * k, c.y * k);
            }
            ctx.closePath();
            ctx.stroke();
        }

        /* -------------------------------------------------------------- *
         * Frame
         * -------------------------------------------------------------- */

        update(dt, scene) {
            this.time += dt;
            const eco = scene.ecology;
            const st = eco.stats;

            this.targets.predators = eco.countByDiet('carnivore');
            this.targets.grazers = eco.countByDiet('herbivore');
            this.targets.born = st.born;
            this.targets.eaten = st.eaten;
            this.targets.starved = st.starved;
            this.targets.moved = scene.relocation ? scene.relocation.relocated : 0;

            for (const key in this.statEls) {
                this.display[key] = MathUtils.damp(this.display[key], this.targets[key], 12, dt);
                if (Math.abs(this.display[key] - this.targets[key]) < 0.51) {
                    this.display[key] = this.targets[key];
                }
                this.statEls[key].textContent = Math.round(this.display[key]);
            }

            if (this.el.population) this.el.population.textContent = eco.population;
            if (this.el.clockTime) this.el.clockTime.textContent = scene.time.clockString;
            if (this.el.clockDay) {
                // The deadline belongs next to the date. A tenure the player cannot see
                // running down is not a deadline.
                this.el.clockDay.textContent =
                    'Day ' + scene.time.day + ' / ' + Config.goal.tenureDays;
            }
            if (this.el.periodLabel) this.el.periodLabel.textContent = scene.time.period.label;
            if (this.el.weatherLabel) this.el.weatherLabel.textContent = scene.weather.label;

            this._icon(this.el.periodIcon, scene.time.period.icon);
            this._icon(this.el.weatherIcon, scene.weather.icon);

            if (this.el.soundBtn) {
                this.el.soundBtn.innerHTML = this.soundOn ? ICONS.sound : ICONS.mute;
                this.el.soundBtn.classList.toggle('is-muted', !this.soundOn);
            }

            if (this.el.pressure) {
                const ev = scene.events;
                const bits = [];
                if (ev.drought.severity > 0.15) {
                    bits.push('<b class="is-bad">Drought</b>');
                }
                if (ev.fire.size) bits.push('<b class="is-bad">Fire</b>');
                if (ev.poachers.length) bits.push('<b class="is-bad">Poachers</b>');
                if (scene.relocation.lorry.cargo.length) {
                    bits.push('<b class="is-cool">Lorry ' +
                        scene.relocation.lorry.cargo.length + '/' +
                        scene.relocation.lorry.capacity + '</b>');
                }
                if (scene.relocation.pending) {
                    bits.push('<b class="is-cool">' + scene.relocation.pending +
                        ' awaiting pickup</b>');
                }
                const html = bits.join('<i>·</i>');
                if (this._pressureHtml !== html) {
                    this._pressureHtml = html;
                    this.el.pressure.innerHTML = html;
                    this.el.pressure.classList.toggle('is-visible', !!html);
                }
            }

            this._updateStock(eco);
            this._updateObjectives(scene);
            this._drawClockArc(scene);
            this.drawMap(scene.world, eco, scene.camera);
            this._updateInspector(scene.hovered);
            this._expire(dt);
        }

        /**
         * The stocking allowance, and the dock's response to running out.
         *
         * Spent cards are disabled rather than hidden: the player should be able to see
         * what they chose not to bring, and a dock that reflowed at zero would be a
         * worse way to learn the allowance is gone than one that greys out.
         *
         * The two groups are independent, so running out of grazers never greys out the
         * predators — which is the whole point of splitting the allowance.
         */
        _updateStock(eco) {
            if (!this._stock) return;

            for (const diet of Object.keys(this._stock)) {
                const g = this._stock[diet];
                const left = eco.stockLeft(diet);
                if (left === g.left) continue;
                g.left = left;

                g.n.textContent = left + ' left';
                g.section.classList.toggle('is-low', left > 0 && left <= 3);
                g.section.classList.toggle('is-spent', left === 0);

                for (const card of this.cards) {
                    if (g.ids.indexOf(card.dataset.species) < 0) continue;
                    card.disabled = left === 0;
                    card.classList.toggle('is-spent', left === 0);
                }
                if (left === 0 && g.ids.indexOf(this.selected) >= 0) this.select(null);
            }
        }

        /**
         * The brief, ticking over live.
         *
         * Built once and then only updated, because this runs every frame. The rows are
         * rendered from the same evaluation the end-of-run report uses, so what the
         * player watches filling up is exactly what they are graded on — keeping those
         * two apart would be the easiest way to make the ending feel arbitrary.
         */
        _updateObjectives(scene) {
            const host = this.el.objectives;
            if (!host) return;

            const goals = IsoGoals.evaluate(scene);

            if (!this._goalRows) {
                host.innerHTML = '<div class="goals__title">The brief</div>';
                this._goalRows = {};
                for (const item of goals.items) {
                    const row = document.createElement('div');
                    row.className = 'goal';
                    row.innerHTML =
                        '<span class="goal__tick"></span>' +
                        '<span class="goal__label"></span>' +
                        '<span class="goal__detail"></span>';
                    host.appendChild(row);
                    this._goalRows[item.id] = {
                        row,
                        label: row.querySelector('.goal__label'),
                        detail: row.querySelector('.goal__detail')
                    };
                    this._goalRows[item.id].label.textContent = item.label;
                }
            }

            for (const item of goals.items) {
                const r = this._goalRows[item.id];
                if (!r) continue;
                if (r.detail.textContent !== item.detail) r.detail.textContent = item.detail;
                if (r.done !== item.done) {
                    r.done = item.done;
                    r.row.classList.toggle('is-done', item.done);
                }
            }
        }

        /** Swap an icon only when it actually changes; innerHTML is not free. */
        _icon(el, name) {
            if (!el || !name || el.dataset.icon === name) return;
            el.dataset.icon = name;
            el.innerHTML = ICONS[name] || ICONS.sun || '';
        }

        /**
         * The day arc.
         *
         * The dial is the upper half-circle: midnight at the left end, noon at the top,
         * midnight again at the right — so an hour maps onto the sweep from PI to 2PI.
         * The daylight span is coloured from the live sky, which means the dial ages
         * through the day along with the reserve.
         */
        _drawClockArc(scene) {
            const ctx = this.clockCtx;
            if (!ctx) return;

            const canvas = this.el.clockCanvas;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const w = 132, h = 46;
            if (canvas.width !== w * dpr) {
                canvas.width = w * dpr;
                canvas.height = h * dpr;
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const cx = w / 2, cy = h - 6, r = w / 2 - 10;
            const light = scene.light;
            const hour = scene.time.hour;
            const angleFor = (t) => Math.PI + (t / 24) * Math.PI;

            ctx.lineCap = 'round';
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(255,255,255,0.10)';
            ctx.beginPath();
            ctx.arc(cx, cy, r, Math.PI, TAU);
            ctx.stroke();

            const grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
            grad.addColorStop(0, Color.css(light.haze));
            grad.addColorStop(0.5, Color.css(Color.lighten(light.sunTint, 0.25)));
            grad.addColorStop(1, Color.css(light.haze));
            ctx.strokeStyle = grad;
            ctx.lineWidth = 3.4;
            ctx.beginPath();
            ctx.arc(cx, cy, r, angleFor(Palettes.SUNRISE), angleFor(Palettes.SUNSET));
            ctx.stroke();

            ctx.strokeStyle = 'rgba(255,255,255,0.16)';
            ctx.lineWidth = 1;
            for (let hh = 0; hh <= 24; hh += 6) {
                const ta = angleFor(hh);
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(ta) * (r - 4), cy + Math.sin(ta) * (r - 4));
                ctx.lineTo(cx + Math.cos(ta) * (r + 4), cy + Math.sin(ta) * (r + 4));
                ctx.stroke();
            }

            const a = angleFor(hour);
            const mx = cx + Math.cos(a) * r;
            const my = cy + Math.sin(a) * r;
            const isDay = hour >= Palettes.SUNRISE && hour <= Palettes.SUNSET;

            ctx.beginPath();
            ctx.arc(mx, my, 5.6, 0, TAU);
            ctx.fillStyle = isDay ? Color.css(Color.lighten(light.sunTint, 0.3)) : '#dfe6f5';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(mx, my, 9, 0, TAU);
            ctx.fillStyle = isDay ? Color.rgba(light.sunTint, 0.28) : 'rgba(200,215,255,0.22)';
            ctx.fill();

            if (!isDay) {
                // Carve a crescent so the night marker reads as a moon.
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                ctx.beginPath();
                ctx.arc(mx + 2.4, my - 1.6, 4.6, 0, TAU);
                ctx.fill();
                ctx.restore();
            }
        }

        _updateInspector(animal) {
            const el = this.el.inspector;
            if (!el) return;

            if (!animal || !animal.alive) {
                if (this._inspected) {
                    el.classList.remove('is-visible');
                    this._inspected = null;
                }
                return;
            }

            const fresh = this._inspected !== animal;
            this._inspected = animal;

            if (fresh) {
                el.classList.add('is-visible');
                this.el.inspectorName.textContent =
                    (animal.isBaby ? 'Young ' : '') + IsoSpecies[animal.species].label;
                this.el.inspectorMeters.innerHTML = METERS.map((m) =>
                    '<div class="meter">' +
                    '<span class="meter__label">' + m.label + '</span>' +
                    '<span class="meter__track">' +
                    '<span class="meter__fill" data-meter="' + m.key + '"></span>' +
                    '</span><span class="meter__value" data-value="' + m.key + '"></span></div>'
                ).join('');
                this._meterEls = {};
                for (const m of METERS) {
                    this._meterEls[m.key] = {
                        fill: this.el.inspectorMeters.querySelector('[data-meter="' + m.key + '"]'),
                        value: this.el.inspectorMeters.querySelector('[data-value="' + m.key + '"]')
                    };
                }
            }

            this.el.inspectorState.textContent =
                STATE_LABELS[animal.state] || animal.state;

            const values = {
                energy: animal.energyRatio,
                thirst: 1 - MathUtils.clamp01(animal.thirst / Config.sim.thirstThreshold)
            };
            for (const m of METERS) {
                const v = MathUtils.clamp01(values[m.key]);
                const e = this._meterEls[m.key];
                e.fill.style.width = (v * 100).toFixed(0) + '%';
                e.fill.style.background = m.color(v);
                e.value.textContent = Math.round(v * 100) + '%';
            }

            const notes = [];
            if (animal.energyRatio < 0.3) notes.push('Starving');
            else if (animal.energyRatio < 0.55) notes.push('Hungry');
            if (values.thirst < 0.25) notes.push('Thirsty');
            if (animal.isBaby) notes.push('Not yet grown');
            if (notes.length === 0) notes.push(animal.diet === 'carnivore' ? 'Predator' : 'Grazer');
            this.el.inspectorFoot.textContent = notes.join(' · ');
        }

        _expire(dt) {
            for (let i = this.toasts.length - 1; i >= 0; i--) {
                const t = this.toasts[i];
                t.life -= dt;
                if (t.life <= 0) {
                    t.el.classList.add('is-out');
                    if (t.life < -0.5) {
                        t.el.remove();
                        this.toasts.splice(i, 1);
                    }
                }
            }

            for (let i = this.logEntries.length - 1; i >= 0; i--) {
                const e = this.logEntries[i];
                e.life -= dt;
                if (e.life <= 0) {
                    e.el.classList.add('is-out');
                    if (e.life < -0.45) {
                        e.el.remove();
                        this.logEntries.splice(i, 1);
                    }
                }
            }
        }
    }

    IsoHud.MAP_COLORS = MAP_COLORS;
    Safari.IsoHud = IsoHud;

})(window.Safari);
