/**
 * Safari Simulator 3D — The flat overlay.
 *
 * Condition bars and thirst pips, drawn on a 2D canvas over the render.
 *
 * This is deliberate, and it is the same call Iron Dominion 3D made about its command
 * overlay: a bar that foreshortened with the ground and shrank with distance would be
 * more immersive and much harder to read, and the entire job of a condition bar is to
 * be readable at a glance across a field of ninety animals. Anything that belongs *on*
 * the ground — hover rings, the dart range, the placement footprint — is real geometry
 * in the scene instead, because those genuinely are things lying on the terrain.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, Painter, Creature3D, R3D } = Safari;

    const _p = { x: 0, y: 0, visible: false, depth: 0 };

    class Overlay2D {
        /** @param {HTMLCanvasElement} canvas */
        constructor(canvas) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.dpr = 1;
            this.width = 1;
            this.height = 1;
        }

        resize(width, height, dpr) {
            this.dpr = dpr;
            this.width = width;
            this.height = height;
            this.canvas.width = Math.round(width * dpr);
            this.canvas.height = Math.round(height * dpr);
        }

        /**
         * @param {Safari.Scene3D} scene
         */
        render(scene) {
            const ctx = this.ctx;
            ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
            ctx.clearRect(0, 0, this.width, this.height);

            this._vitals(ctx, scene);
        }

        /**
         * Condition bars above the animals.
         *
         * Hidden while an animal is healthy so the reserve stays uncluttered, faded in
         * as its condition drops, and pulsing once it is critical — an animal in trouble
         * has to be findable at a glance, but a field of full bars is noise.
         */
        _vitals(ctx, scene) {
            const rig = scene.rig;
            const world = scene.world;
            const hovered = scene.hovered;
            const threshold = Config.ui.healthVisibleBelow;
            const clock = scene.clock;

            for (let i = 0; i < scene.agents.length; i++) {
                const a = scene.agents[i];
                if (!a.alive) continue;

                const ratio = a.energyRatio;
                const isHovered = a === hovered;
                let visibility = isHovered ? 1 : MathUtils.clamp01((threshold - ratio) / 0.14);
                if (visibility <= 0.01) continue;

                const top = R3D.groundY(world, a.x, a.y) +
                    Creature3D.topOf(a.spec) * (a.renderState.baby ? 0.6 : 1) + 0.22;
                rig.worldToScreen(a.x, top, a.y, _p);
                if (!_p.visible) continue;

                // Distance fade: a bar over an animal on the far boundary is unreadable
                // clutter, and drawing ninety of them costs more than it says.
                const dist = rig.distanceTo(a.x, a.y);
                const range = MathUtils.clamp01((70 - dist) / 18);
                if (range <= 0.02) continue;
                visibility *= range;

                if (ratio < 0.2) visibility *= 0.6 + 0.4 * Math.sin(clock * 7);

                // Bars shrink with distance, but only so far: legibility wins over
                // strict perspective, which is the whole reason they are flat.
                const s = MathUtils.clamp(26 / Math.max(4, dist * 0.35), 0.55, 1.25);
                const w = 30 * s;
                const bh = 4.5 * s;
                const x = _p.x - w / 2;
                const y = _p.y;

                ctx.save();
                ctx.globalAlpha = visibility;

                Painter.roundRect(ctx, x - 1, y - 1, w + 2, bh + 2, (bh + 2) / 2);
                ctx.fillStyle = 'rgba(8,10,8,0.55)';
                ctx.fill();

                Painter.roundRect(ctx, x, y, w, bh, bh / 2);
                ctx.fillStyle = 'rgba(30,34,28,0.9)';
                ctx.fill();

                Painter.roundRect(ctx, x, y, Math.max(bh, w * ratio), bh, bh / 2);
                ctx.fillStyle = ratio > 0.55 ? '#7fd68a' : (ratio > 0.28 ? '#e9a94a' : '#ef5a50');
                ctx.fill();

                const thirst = a.thirst / Config.sim.thirstThreshold;
                if (thirst > 0.75 || isHovered) {
                    const th = 2.6 * s;
                    const ty = y + bh + 1.8 * s;
                    Painter.roundRect(ctx, x, ty, w, th, th / 2);
                    ctx.fillStyle = 'rgba(12,14,10,0.5)';
                    ctx.fill();
                    Painter.roundRect(ctx, x, ty,
                        Math.max(th, w * MathUtils.clamp01(thirst)), th, th / 2);
                    ctx.fillStyle = 'rgba(111,208,232,0.9)';
                    ctx.fill();
                }
                ctx.restore();
            }
        }
    }

    Safari.Overlay2D = Overlay2D;

})(window.Safari);
