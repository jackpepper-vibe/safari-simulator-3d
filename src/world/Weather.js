/**
 * Safari Simulator — Weather.
 *
 * A slow state machine over four conditions. Weather never blocks play; it modulates
 * the lighting state (cloud cover dims and desaturates), drives the wind field that
 * grass and canopies sway to, and emits rain.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Rng, Events } = Safari;

    /**
     * @typedef {object} WeatherCondition
     * @property {string} id
     * @property {string} label
     * @property {number} cloudCover 0..1 — dims the sun and flattens shadows.
     * @property {number} wind       Baseline wind strength.
     * @property {number} rain       Drops emitted per second.
     * @property {number} minMinutes Shortest time this condition persists.
     * @property {number} maxMinutes Longest.
     * @property {number} weight     Relative likelihood of being chosen next.
     */

    /** @type {Object<string, WeatherCondition>} */
    const CONDITIONS = {
        clear: {
            id: 'clear', label: 'Clear', icon: 'sun',
            cloudCover: 0.05, wind: 0.45, rain: 0,
            minMinutes: 2.5, maxMinutes: 6, weight: 4
        },
        breezy: {
            id: 'breezy', label: 'Breezy', icon: 'wind',
            cloudCover: 0.22, wind: 1.15, rain: 0,
            minMinutes: 1.5, maxMinutes: 3.5, weight: 3
        },
        overcast: {
            id: 'overcast', label: 'Overcast', icon: 'cloud',
            cloudCover: 0.78, wind: 0.7, rain: 0,
            minMinutes: 1.2, maxMinutes: 3, weight: 2
        },
        rain: {
            id: 'rain', label: 'Rain', icon: 'rain',
            cloudCover: 0.95, wind: 1.0, rain: 46,
            minMinutes: 0.8, maxMinutes: 2.2, weight: 1.2
        }
    };

    /** Conditions can only move to plausible neighbours — no clear sky to downpour. */
    const TRANSITIONS = {
        clear: ['breezy', 'clear', 'overcast'],
        breezy: ['clear', 'overcast', 'breezy'],
        overcast: ['rain', 'breezy', 'clear'],
        rain: ['overcast', 'overcast', 'breezy']
    };

    class Weather {
        /**
         * @param {Safari.EventBus} bus
         * @param {number} seed
         */
        constructor(bus, seed) {
            this.bus = bus;
            this.rng = new Rng((seed || 1) ^ 0x7EA7);
            this.current = CONDITIONS.clear;
            this.next = CONDITIONS.clear;

            /** Smoothly interpolated values actually used by the renderers. */
            this.cloudCover = this.current.cloudCover;
            this.windStrength = this.current.wind;
            this.rainRate = 0;
            /** Signed wind direction, drifting slowly. */
            this.wind = this.current.wind;
            this.wetness = 0;

            this.timer = this._duration(this.current);
            this.time = 0;
            this._rainCarry = 0;
        }

        reset() {
            this.current = CONDITIONS.clear;
            this.next = CONDITIONS.clear;
            this.cloudCover = this.current.cloudCover;
            this.windStrength = this.current.wind;
            this.rainRate = 0;
            this.wetness = 0;
            this.timer = this._duration(this.current);
            this.time = 0;
        }

        _duration(condition) {
            return this.rng.range(condition.minMinutes, condition.maxMinutes) * 60;
        }

        /** Weighted pick from the conditions that may follow the current one. */
        _pickNext() {
            const options = TRANSITIONS[this.current.id];
            let total = 0;
            for (const id of options) total += CONDITIONS[id].weight;
            let r = this.rng.next() * total;
            for (const id of options) {
                r -= CONDITIONS[id].weight;
                if (r <= 0) return CONDITIONS[id];
            }
            return CONDITIONS.clear;
        }

        /**
         * @param {number} dt Seconds of simulated time.
         * @param {Safari.ParticleSystem} particles
         */
        update(dt, particles) {
            this.time += dt;
            this.timer -= dt;

            if (this.timer <= 0) {
                const previous = this.current;
                this.current = this._pickNext();
                this.timer = this._duration(this.current);
                if (this.current.id !== previous.id) {
                    this.bus.emit(Events.WEATHER_CHANGED, {
                        from: previous, to: this.current
                    });
                }
            }

            // Ease toward the target so weather arrives rather than snapping on.
            this.cloudCover = MathUtils.damp(this.cloudCover, this.current.cloudCover, 0.35, dt);
            this.windStrength = MathUtils.damp(this.windStrength, this.current.wind, 0.4, dt);
            this.rainRate = MathUtils.damp(this.rainRate, this.current.rain, 0.5, dt);

            // Ground stays damp for a while after the rain stops.
            const targetWet = this.current.rain > 0 ? 1 : 0;
            this.wetness = MathUtils.damp(this.wetness, targetWet, targetWet ? 0.5 : 0.06, dt);

            // Gusting wind: a slow base plus a faster flutter.
            this.wind = this.windStrength * (
                0.72 +
                0.34 * Math.sin(this.time * 0.21) +
                0.16 * Math.sin(this.time * 0.83 + 1.7)
            );

            if (this.rainRate > 0.5 && particles) {
                this._rainCarry += this.rainRate * dt;
                const n = Math.floor(this._rainCarry);
                if (n > 0) {
                    this._rainCarry -= n;
                    particles.rain(n, this.wind);
                }
            }
        }

        /**
         * Fold weather into the lighting state, in place.
         * Cloud cover kills direct sun, flattens shadows and drains saturation.
         *
         * @param {object} light LightingState.
         */
        applyTo(light) {
            const cc = this.cloudCover;
            if (cc <= 0.02) return light;

            light.exposure *= MathUtils.lerp(1, 0.66, cc);
            light.sunStrength *= MathUtils.lerp(1, 0.12, cc);
            light.saturation *= MathUtils.lerp(1, 0.80, cc);
            light.shadowAlpha *= MathUtils.lerp(1, 0.22, cc);
            light.ambientAmount = MathUtils.clamp01(light.ambientAmount + cc * 0.16);

            // Overcast skies flatten toward a uniform grey-blue.
            const grey = { r: 138, g: 146, b: 156 };
            for (let i = 0; i < light.sky.length; i++) {
                const c = light.sky[i].c;
                c.r = MathUtils.lerp(c.r, grey.r, cc * 0.62);
                c.g = MathUtils.lerp(c.g, grey.g, cc * 0.62);
                c.b = MathUtils.lerp(c.b, grey.b, cc * 0.62);
            }
            light.haze.r = MathUtils.lerp(light.haze.r, grey.r, cc * 0.55);
            light.haze.g = MathUtils.lerp(light.haze.g, grey.g, cc * 0.55);
            light.haze.b = MathUtils.lerp(light.haze.b, grey.b, cc * 0.55);

            return light;
        }

        get label() {
            return this.current.label;
        }

        get icon() {
            return this.current.icon;
        }
    }

    Weather.CONDITIONS = CONDITIONS;
    Safari.Weather = Weather;

})(window.Safari);
