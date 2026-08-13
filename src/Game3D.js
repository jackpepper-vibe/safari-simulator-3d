/**
 * Safari Simulator 3D — Game shell.
 *
 * Composition root for the reserve: owns the renderer, the scene, the interface, the
 * audio and the screen flow, and runs the frame loop.
 *
 * Forked from the 2D build's shell and deliberately still recognisable as it — the
 * tenure, the stocking allowance, the clear-reserve confirmation and the end conditions
 * are the game, not the presentation, and a change to any of them should be diffable
 * against the original. What is genuinely different is the input: every path between
 * the pointer and the simulation had to be rewritten, because screen-to-world is now a
 * raycast against a heightfield rather than an invertible projection.
 */
(function (Safari, THREE) {
    'use strict';

    const {
        MathUtils, Config, Ticker, Events,
        Scene3D, IsoHud, IsoSpecies, Screens, AudioManager, IsoGoals, Overlay2D, R3D
    } = Safari;

    const Screen = Screens.Screen;

    /** How long the clear-reserve button stays armed before it forgets. */
    const CLEAR_CONFIRM_MS = 4000;

    /** A drag shorter than this is a click, not a pan. */
    const CLICK_SLOP = 5;

    class Game3D {
        /** @param {object} refs DOM references from the bootstrap. */
        constructor(refs) {
            this.refs = refs;
            this.canvas = refs.canvas;
            this.dpr = Math.min(Config.render.maxPixelRatio, window.devicePixelRatio || 1);

            this.speedIndex = Config.sim.defaultSpeedIndex;
            this.running = false;
            this.soundOn = true;

            /*
             * One renderer for the life of the page.
             *
             * A run builds a whole new reserve, and browsers hard-limit how many WebGL
             * contexts a page may hold — creating one per reserve loses the earliest
             * ones after about a dozen runs and the screen goes black. So the context
             * outlives the scenes that draw into it.
             */
            this.renderer = new THREE.WebGLRenderer({
                canvas: this.canvas,
                antialias: true,
                powerPreference: 'high-performance'
            });
            this.renderer.outputEncoding = THREE.sRGBEncoding;
            this.renderer.toneMapping = THREE.LinearToneMapping;
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

            this.overlay = new Overlay2D(refs.overlay);

            this.scene = new Scene3D(this.renderer, (Math.random() * 0xffffff) | 0);
            this.hud = new IsoHud(this.scene.bus, refs);
            this.hud.bakeMap(this.scene.world);

            this.screens = new Screens(this.scene.bus, refs);
            this.audio = new AudioManager(this.scene.bus);
            this.audio.attach(this.scene.bus);

            /** Tile position under the pointer, updated on move. */
            this.pointerTile = { x: 0, y: 0, hit: false };
            this.pointerInside = false;
            this.pointerScreen = { x: 0, y: 0 };

            this.ticker = new Ticker({ fixedStep: 1 / 60 });
            this.ticker.onRender((dt) => this.frame(dt));

            this._wireInput();
            this._wireUi();
            this.resize();
        }

        /* -------------------------------------------------------------- *
         * Lifecycle
         * -------------------------------------------------------------- */

        run() {
            this.toTitle();
            this.ticker.start();
        }

        /** Show the title over a reserve that is already running. */
        toTitle() {
            this._disarmClear();
            this._hadLife = false;
            this.running = false;
            this._newReserve(30, 90);
            this.scene.ecology.stats = this.scene.ecology._blankStats();
            this.screens.show(Screen.TITLE);
        }

        /** Begin a fresh run. */
        start() {
            this._disarmClear();
            this._hadLife = false;
            this.audio.init();
            this.audio.setEnabled(this.soundOn);

            this.hud.reset();
            this._newReserve(0, 40);

            this.setSpeed(Config.sim.defaultSpeedIndex);
            this.running = true;
            this.screens.show(Screen.PLAYING);

            this.scene.bus.emit(Events.GAME_START, {});
            this.hud.toast('Pick a species, then click the ground', 'good');
        }

        /**
         * End the run and show the report.
         *
         * @param {string} [reason] 'tenure' when the term is served, 'extinct' when
         *   there is nothing left to manage, 'quit' when the player stops early.
         */
        end(reason) {
            if (!this.running) return;
            this.running = false;
            this.hud.select(null);
            this._disarmClear();

            const speciesCounts = {};
            let predators = 0, grazers = 0;
            for (const a of this.scene.ecology.animals) {
                if (!a.alive) continue;
                speciesCounts[a.species] = (speciesCounts[a.species] || 0) + 1;
                if (a.diet === 'carnivore') predators++; else grazers++;
            }

            const ev = this.scene.events;
            const report = {
                reason: reason || 'quit',
                days: this.scene.time.day,
                tenure: Config.goal.tenureDays,
                stats: this.scene.ecology.stats,
                population: predators + grazers,
                predators,
                grazers,
                speciesCounts,
                relocated: this.scene.relocation.relocated,
                poached: ev.stats.poached,
                droughts: ev.stats.droughts,
                fires: ev.stats.fires,
                burnt: ev.burntTiles,
                goals: IsoGoals.evaluate(this.scene)
            };

            this.screens.renderSummary(report);
            this.screens.show(Screen.SUMMARY);
            this.scene.bus.emit(Events.GAME_END, report);
        }

        /**
         * Build a new reserve.
         *
         * A whole new scene rather than a reset: the terrain, its meshes, the scattered
         * props and the seeded fields all derive from one seed, and threading a reseed
         * through every one of them would be more code and more ways to leave something
         * stale. The GPU resources of the outgoing scene are released explicitly.
         */
        _newReserve(animals, forage) {
            if (this.scene) this.scene.dispose();

            const seed = (Math.random() * 0xffffff) | 0;
            this.scene = new Scene3D(this.renderer, seed);

            this.hud.bus = this.scene.bus;
            this.hud._bindEvents();
            this.hud.bakeMap(this.scene.world);
            this.screens.bus = this.scene.bus;
            this.audio.attach(this.scene.bus);

            this.resize();
            if (animals > 0) this.scene.populateMixed(animals);
            this.scene.ecology.scatterForage(forage);
            this.scene.focusOnAgents();
        }

        /* -------------------------------------------------------------- *
         * Setup
         * -------------------------------------------------------------- */

        resize() {
            const w = window.innerWidth;
            const h = window.innerHeight;
            this.scene.resize(w, h, this.dpr);
            this.overlay.resize(w, h, this.dpr);
        }

        get speed() {
            return Config.sim.speeds[this.speedIndex];
        }

        setSpeed(index) {
            this.speedIndex = MathUtils.clamp(index | 0, 0, Config.sim.speeds.length - 1);
            const buttons = this.refs.speeds ? this.refs.speeds.children : [];
            for (let i = 0; i < buttons.length; i++) {
                buttons[i].classList.toggle('is-active', i === this.speedIndex);
            }
            this.scene.bus.emit(Events.SPEED_CHANGED, {
                index: this.speedIndex, multiplier: this.speed
            });
        }

        toggleSound() {
            this.soundOn = !this.soundOn;
            this.hud.soundOn = this.soundOn;
            this.audio.setEnabled(this.soundOn);
        }

        _wireUi() {
            const r = this.refs;

            if (r.speeds) {
                Config.sim.speeds.forEach((mult, i) => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'speed-btn';
                    btn.textContent = mult === 0 ? '❙❙' : mult + '×';
                    btn.title = mult === 0 ? 'Pause' : mult + '× speed';
                    btn.addEventListener('click', () => this.setSpeed(i));
                    r.speeds.appendChild(btn);
                });
                this.setSpeed(this.speedIndex);
            }

            r.startBtn?.addEventListener('click', () => this.start());
            r.replayBtn?.addEventListener('click', () => this.start());
            r.menuBtn?.addEventListener('click', () => this.toTitle());
            r.exitBtn?.addEventListener('click', () => this.end());
            r.soundBtn?.addEventListener('click', () => this.toggleSound());
            r.forageBtn?.addEventListener('click', () => {
                this._disarmClear();
                this.scatterForage();
            });
            r.clearBtn?.addEventListener('click', () => this._clearReserve());
            r.sendBtn?.addEventListener('click', () => this._sendLorry());

            r.minimap?.addEventListener('pointerdown', (e) => {
                const rect = r.minimap.getBoundingClientRect();
                const size = this.scene.world.size;
                this.scene.camera.snapToTile(
                    (e.clientX - rect.left) / rect.width * size,
                    (e.clientY - rect.top) / rect.height * size);
            });

            document.body.classList.add('is-iso');
            window.addEventListener('resize', () => this.resize());
        }

        /**
         * Scatter forage in front of the player.
         *
         * Dropped where the view is centred, not across the whole reserve: an action
         * whose result you cannot see is indistinguishable from one that did nothing.
         */
        scatterForage() {
            const scene = this.scene;
            const cam = scene.camera;
            const items = scene.ecology.scatterForage(undefined,
                { x: cam.focusX, y: cam.focusY, radius: 7 });

            for (const item of items) {
                scene.particles.sparkle(
                    item.x, R3D.surfaceY(scene.world, item.x, item.y), item.y,
                    { r: 150, g: 220, b: 140 });
            }

            this.hud.toast(items.length
                ? 'Scattered ' + items.length + ' forage'
                : 'No ground to scatter on', items.length ? 'good' : 'bad');
        }

        /** Run the lorry out early, without waiting for a full load. */
        _sendLorry() {
            const lorry = this.scene.relocation.lorry;
            if (!lorry.cargo.length) {
                this.hud.toast('Nothing aboard the lorry', 'muted');
                return;
            }
            if (!lorry.depart({ bus: this.scene.bus })) {
                this.hud.toast('The lorry is already out', 'muted');
            }
        }

        /**
         * Remove every animal, on a second press.
         *
         * The only irreversible thing in the game, sitting next to the button that
         * scatters forage. It arms first and says what it is about to destroy, then
         * commits, and disarms itself after a few seconds so an armed button is never
         * left lying in wait.
         */
        _clearReserve() {
            const n = this.scene.ecology.population;
            if (!n) {
                this.hud.toast('The reserve is already empty', 'muted');
                return;
            }
            if (!this._clearArmed) {
                this._armClear(n);
                return;
            }

            this._disarmClear();
            this.scene.ecology.animals.length = 0;
            this.scene.ranger.quarry = null;
            this.scene.relocation.queue.length = 0;
            this.hud.toast('Reserve cleared — ' + n +
                (n === 1 ? ' animal removed' : ' animals removed'), 'bad');
        }

        _armClear(count) {
            const btn = this.refs.clearBtn;
            this._clearArmed = true;
            if (btn) {
                if (this._clearLabel === undefined) this._clearLabel = btn.textContent;
                btn.textContent = 'Remove all ' + count + '?';
                btn.classList.add('is-confirming');
            }
            clearTimeout(this._clearTimer);
            this._clearTimer = setTimeout(() => this._disarmClear(), CLEAR_CONFIRM_MS);
        }

        _disarmClear() {
            const btn = this.refs.clearBtn;
            this._clearArmed = false;
            clearTimeout(this._clearTimer);
            if (btn && this._clearLabel !== undefined) {
                btn.textContent = this._clearLabel;
                btn.classList.remove('is-confirming');
            }
        }

        /* -------------------------------------------------------------- *
         * Input
         * -------------------------------------------------------------- */

        /**
         * Pointer handling.
         *
         * The 2D build had one drag gesture, because there was nothing to rotate. Here
         * the left button drags the ground and the right button orbits, which is the
         * convention every 3D strategy game uses and which leaves the left button free
         * to mean "act on this" exactly as it did before.
         */
        _wireInput() {
            const canvas = this.canvas;
            let drag = null;

            canvas.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 && e.button !== 2 && e.button !== 1) return;
                drag = { x: e.clientX, y: e.clientY, button: e.button, moved: 0 };
                this.scene.camera.dragging = e.button === 0;
                if (e.button === 0) canvas.classList.add('is-dragging');
                canvas.setPointerCapture(e.pointerId);
            });

            canvas.addEventListener('pointermove', (e) => {
                this._updatePointer(e.clientX, e.clientY);
                if (!drag) return;
                const dx = e.clientX - drag.x;
                const dy = e.clientY - drag.y;
                drag.moved += Math.abs(dx) + Math.abs(dy);

                if (drag.button === 0) this.scene.camera.panByScreen(dx, dy);
                else this.scene.camera.orbitByScreen(dx, dy);

                drag.x = e.clientX;
                drag.y = e.clientY;
            });

            const release = (e) => {
                if (!drag) return;
                const wasDrag = drag.moved >= CLICK_SLOP;
                const button = drag.button;
                drag = null;
                this.scene.camera.dragging = false;
                canvas.classList.remove('is-dragging');

                if (wasDrag) return;
                // A press that barely moved is a click, not a gesture.
                if (button === 0) this._click(e.clientX, e.clientY);
                else if (button === 2 && this.hud.selected) this.hud.select(null);
            };
            canvas.addEventListener('pointerup', release);
            canvas.addEventListener('pointercancel', () => {
                drag = null;
                this.scene.camera.dragging = false;
                canvas.classList.remove('is-dragging');
            });
            canvas.addEventListener('pointerleave', () => { this.pointerInside = false; });

            canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const rect = canvas.getBoundingClientRect();
                this.scene.camera.zoomAt(
                    e.clientX - rect.left, e.clientY - rect.top,
                    e.deltaY < 0 ? Config.camera.zoomStep : 1 / Config.camera.zoomStep,
                    this.scene.world);
            }, { passive: false });

            canvas.addEventListener('contextmenu', (e) => e.preventDefault());

            this.keys = Object.create(null);
            window.addEventListener('keydown', (e) => {
                const k = e.key.toLowerCase();
                this.keys[k] = true;

                if (k === 'escape') {
                    if (this._clearArmed) { this._disarmClear(); return; }
                    if (this.hud.selected) this.hud.select(null);
                    else if (this.running) this.end();
                    return;
                }
                if (!this.running) {
                    if (k === 'enter' && this.screens.current !== Screen.PLAYING) this.start();
                    return;
                }

                if (k === 'f') this._followHovered();
                if (k === 'g') this.scatterForage();
                if (k === 'm') this.toggleSound();
                if (k === 'r') this.scene.camera.snapToTile(this.scene.ranger.x, this.scene.ranger.y);
                if (k === 'q') this.scene.camera.targetYaw -= Math.PI / 8;
                if (k === 'e') this.scene.camera.targetYaw += Math.PI / 8;
                if (k === ' ') {
                    e.preventDefault();
                    this.setSpeed(this.speedIndex === 0 ? Config.sim.defaultSpeedIndex : 0);
                }
                if (k >= '1' && k <= '5') this.setSpeed(parseInt(k, 10) - 1);
            });
            window.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });
        }

        /**
         * Follow whatever is under the pointer, or fall back to the busiest herd.
         *
         * The 2D build's `F` recentred on the herd. With a camera that can orbit, the
         * more useful thing is to lock onto one animal and let the player walk around
         * it, so `F` does that when the pointer is over something.
         */
        _followHovered() {
            const target = this._animalUnder(this.pointerTile.x, this.pointerTile.y);
            if (target) {
                this.scene.camera.follow(target);
                this.hud.toast('Following the ' +
                    IsoSpecies[target.species].label.toLowerCase(), 'cool');
            } else {
                this.scene.focusOnAgents();
            }
        }

        _updatePointer(clientX, clientY) {
            const rect = this.canvas.getBoundingClientRect();
            this.pointerScreen.x = clientX - rect.left;
            this.pointerScreen.y = clientY - rect.top;
            this.scene.camera.screenToTile(
                this.pointerScreen.x, this.pointerScreen.y, this.scene.world, this.pointerTile);
            this.pointerInside = true;
        }

        /** Act on whatever the dock has armed. */
        _click(clientX, clientY) {
            this._updatePointer(clientX, clientY);
            if (!this.running) return;

            const t = this.pointerTile;
            const w = this.scene.world;
            if (!t.hit || t.x < 2 || t.y < 2 || t.x >= w.size - 2 || t.y >= w.size - 2) return;

            const id = this.hud.selected;
            if (!id && this._overRanger(t)) {
                this.hud.select('ranger');
                return;
            }
            if (!id) return;

            if (id === 'ranger') {
                this._commandRanger(t);
                return;
            }

            if (this.scene.ecology.stockLeftFor(id) <= 0) {
                const kind = IsoSpecies[id].diet === 'carnivore' ? 'predators' : 'grazers';
                this.hud.toast('No ' + kind + ' left to bring in', 'bad');
                return;
            }
            if (!this.scene.ecology.spawnNear(id, t.x, t.y, false)) {
                this.hud.toast('No room there', 'bad');
            }
        }

        /**
         * Send the ranger somewhere, or after something.
         *
         * Clicking an animal is the tranquiliser: inside dart range the shot goes off
         * where the jeep stands, otherwise the jeep closes first and fires on arrival.
         */
        _commandRanger(tile) {
            const ranger = this.scene.ranger;
            const quarry = this._animalUnder(tile.x, tile.y);

            if (quarry) {
                const dist = Math.hypot(quarry.x - ranger.x, quarry.y - ranger.y);
                ranger.pursue(quarry);
                const name = IsoSpecies[quarry.species].label.toLowerCase();
                this.hud.toast(dist <= ranger.dartRange * 0.72
                    ? 'Taking the shot on the ' + name
                    : 'Closing on the ' + name, 'cool');
                return;
            }
            ranger.driveTo(tile.x, tile.y);
        }

        /* -------------------------------------------------------------- *
         * Frame
         * -------------------------------------------------------------- */

        frame(dt) {
            const cam = this.scene.camera;
            const k = this.keys;
            const playing = this.screens.current === Screen.PLAYING;

            cam.panX = playing ? (k['d'] || k['arrowright'] ? 1 : 0) -
                (k['a'] || k['arrowleft'] ? 1 : 0) : 0;
            cam.panY = playing ? (k['s'] || k['arrowdown'] ? 1 : 0) -
                (k['w'] || k['arrowup'] ? 1 : 0) : 0;

            this.scene.update(dt, this.speed);

            const armed = this.hud.selected;
            const ranging = armed === 'ranger';

            /*
             * Whatever the pointer is over gets a condition read-out and a marker.
             * Placing an animal suppresses it — the ghost is the feedback there — but
             * commanding the ranger does not, because knowing which animal is under the
             * cursor is exactly what the player needs before taking the shot.
             */
            this.scene.hovered = playing && this.pointerInside && (!armed || ranging)
                ? this._animalUnder(this.pointerTile.x, this.pointerTile.y)
                : null;
            this.scene.placing = playing && armed && !ranging && this.pointerInside &&
                this.pointerTile.hit
                ? { id: armed, x: this.pointerTile.x, y: this.pointerTile.y }
                : null;
            this.scene.rangerArmed = playing && ranging;
            this.scene.rangerHover = playing && !armed && this.pointerInside &&
                this._overRanger(this.pointerTile);

            this.scene.render();
            this.overlay.render(this.scene);
            this.hud.update(dt, this.scene);

            if (this.scene.ecology.population) this._hadLife = true;

            if (this.running) {
                if (IsoGoals.tenureComplete(this.scene)) this.end('tenure');
                else if (this._hadLife && !this.scene.ecology.population) this.end('extinct');
            }
            this.audio.update(dt, this._audioEnv());
        }

        /**
         * The ambience the audio bed responds to.
         *
         * Derived from the sun rather than the clock, so a run under heavy overcast gets
         * its crickets early — which is what the reserve looks like too.
         */
        _audioEnv() {
            const light = this.scene.light;
            const e = this._aenv || (this._aenv = { night: 0, dawn: 0, wind: 0.5, rain: 0 });
            e.night = 1 - light.daylight;
            e.dawn = MathUtils.smoothstep(0.02, 0.35, light.sunAltitude) *
                MathUtils.smoothstep(0.85, 0.45, light.sunAltitude);
            e.wind = MathUtils.clamp01(this.scene.weather.wind * 0.5);
            e.rain = MathUtils.clamp01(this.scene.weather.rainRate);
            return e;
        }

        /** Is the pointer over the jeep? Generous, because it is a small target. */
        _overRanger(tile) {
            const r = this.scene.ranger;
            return Math.hypot(r.x - tile.x, r.y - tile.y) < 1.4;
        }

        /**
         * The animal under a ground point.
         *
         * Picking against the ground rather than against the models is deliberate. A
         * raycast into the meshes would be more precise and much worse to use: a giraffe
         * standing behind a bush would be unclickable, and the tolerance would change
         * with the camera angle. The ground point the player is pointing at is stable
         * whatever the pitch is.
         */
        _animalUnder(tx, ty) {
            let best = null;
            let bestDist = 1.2;
            for (const a of this.scene.ecology.animals) {
                if (!a.alive) continue;
                const d = Math.hypot(a.x - tx, a.y - ty);
                if (d < bestDist) { bestDist = d; best = a; }
            }
            return best;
        }
    }

    Safari.Game3D = Game3D;

})(window.Safari, window.THREE);
