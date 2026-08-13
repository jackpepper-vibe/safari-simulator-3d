/**
 * Safari Simulator 3D — Bootstrap.
 *
 * Gathers DOM references, constructs the game and starts the loop. Kept deliberately
 * thin: it is the only file that knows about specific element ids, so the markup and
 * the engine stay decoupled.
 *
 * It also publishes `window.SS3D`, the test hook. Everything the screenshot harness and
 * the smoke test need to drive the reserve without waiting on frames goes through it,
 * and nothing in the game reads it.
 */
(function (Safari) {
    'use strict';

    function boot() {
        const byId = (id) => document.getElementById(id);

        const refs = {
            /* Canvases */
            canvas: byId('world'),
            overlay: byId('overlay'),

            /* Screens */
            title: byId('screen-title'),
            playing: byId('screen-playing'),
            summary: byId('screen-summary'),

            /* Top bar */
            stats: byId('stats'),
            population: byId('population'),
            clockCanvas: byId('clock-arc'),
            clockTime: byId('clock-time'),
            clockDay: byId('clock-day'),
            periodLabel: byId('period-label'),
            periodIcon: byId('period-icon'),
            weatherLabel: byId('weather-label'),
            weatherIcon: byId('weather-icon'),
            speeds: byId('speeds'),
            soundBtn: byId('sound-btn'),
            exitBtn: byId('exit-btn'),

            /* Mid layer */
            feed: byId('feed'),
            toasts: byId('toasts'),
            inspector: byId('inspector'),
            inspectorName: byId('inspector-name'),
            inspectorState: byId('inspector-state'),
            inspectorMeters: byId('inspector-meters'),
            inspectorFoot: byId('inspector-foot'),
            minimap: byId('minimap'),

            /* Dock */
            dock: byId('dock'),
            forageBtn: byId('food-btn'),
            clearBtn: byId('clear-btn'),
            sendBtn: byId('send-btn'),
            pressure: byId('pressure'),
            objectives: byId('objectives'),

            /* Title */
            startBtn: byId('start-btn'),

            /* Summary */
            summaryTitle: byId('summary-title'),
            summaryBlurb: byId('summary-blurb'),
            summaryGrade: byId('summary-grade'),
            summaryStats: byId('summary-stats'),
            summaryGoals: byId('summary-goals'),
            summarySpecies: byId('summary-species'),
            replayBtn: byId('replay-btn'),
            menuBtn: byId('menu-btn')
        };

        const missing = ['canvas', 'overlay', 'dock', 'stats'].filter((k) => !refs[k]);
        if (missing.length) {
            console.error('[Safari] Missing required elements: ' + missing.join(', '));
            return;
        }

        const game = new Safari.Game3D(refs);
        game.run();

        Safari.game = game;
        window.SS3D = makeHook(game);

        // Pause while the tab is hidden, so returning to it does not fast-forward
        // through a night the player never saw.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) game.ticker.stop();
            else game.ticker.start();
        });
    }

    /**
     * The test hook.
     *
     * The fork rewrote every path between the pointer and the simulation, and none of
     * that shows up in a screenshot — so the smoke test drives these directly and
     * asserts on simulation state. The screenshot harness uses the camera and staging
     * calls to reach a specific view without playing the game to get there.
     */
    function makeHook(game) {
        const scene = () => game.scene;

        return {
            game,
            get scene() { return game.scene; },
            get world() { return game.scene.world; },
            get ecology() { return game.scene.ecology; },
            get camera() { return game.scene.camera; },

            /** Start a run, optionally stocked and at a given hour. */
            begin(opts) {
                const o = opts || {};
                game.start();
                if (o.animals) scene().populateMixed(o.animals);
                if (o.hour !== undefined) this.hour(o.hour);
                if (o.speed !== undefined) game.setSpeed(o.speed);
                if (o.animals) scene().focusOnAgents();
                return this;
            },

            /** Jump the clock. The whole lighting model follows from the hour. */
            hour(h) {
                scene().time.hour = h;
                scene().hour = h;
                Safari.Palettes.sample(h, scene().light);
                return this;
            },

            /** Park the camera: focus tile, distance, yaw and pitch in radians. */
            cam(tx, ty, dist, yaw, pitch) {
                const c = scene().camera;
                c.snapToTile(tx, ty, dist);
                if (yaw !== undefined) c.yaw = c.targetYaw = yaw;
                if (pitch !== undefined) c.pitch = c.targetPitch = pitch;
                c.update(0.016, scene().world);
                return this;
            },

            /** Put the camera on the nearest animal of a species, or on any animal. */
            find(species, dist) {
                const a = scene().ecology.animals.find(
                    (x) => x.alive && (!species || x.species === species));
                if (a) this.cam(a.x, a.y, dist === undefined ? 6 : dist);
                return a || null;
            },

            /** Place one animal and return it. */
            spawn(species, tx, ty) {
                return scene().ecology.spawnNear(species, tx, ty, false);
            },

            /** Advance the simulation without waiting for frames. */
            step(n, dt) {
                const s = dt === undefined ? 1 / 30 : dt;
                for (let i = 0; i < (n || 1); i++) scene().update(s, 1);
                return this;
            },

            /** Drive one frame of presentation, for a screenshot after `step`. */
            draw() {
                scene().render();
                game.overlay.render(scene());
                return this;
            },

            /** Hide the title and summary, leaving the reserve and its interface. */
            play() {
                game.screens.show(Safari.Screens.Screen.PLAYING);
                return this;
            },

            /** Strip every panel, for a clean shot of the reserve itself. */
            bare() {
                document.querySelectorAll('.screen').forEach((el) => {
                    el.style.display = 'none';
                });
                return this;
            }
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

})(window.Safari);
