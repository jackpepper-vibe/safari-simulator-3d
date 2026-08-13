/**
 * Safari Simulator — Time of day.
 *
 * Advances the clock, tracks the day counter, resolves the named period for the HUD
 * and produces the LightingState every renderer reads. Periods are emitted as events
 * so audio ambience and behaviour can react without polling.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, Palettes, Events } = Safari;

    class TimeSystem {
        /** @param {Safari.EventBus} bus */
        constructor(bus) {
            this.bus = bus;
            /** Current time of day, 0..24. */
            this.hour = Config.time.startHour;
            this.day = 1;
            /** Total simulated seconds elapsed. */
            this.elapsed = 0;

            this.period = this._periodFor(this.hour);
            /** Reusable lighting state — sampled in place to avoid per-frame garbage. */
            this.light = Palettes.sample(this.hour);
        }

        reset() {
            this.hour = Config.time.startHour;
            this.day = 1;
            this.elapsed = 0;
            this.period = this._periodFor(this.hour);
            Palettes.sample(this.hour, this.light);
        }

        /** In-game hours per second of simulated time. */
        get hoursPerSecond() {
            return 24 / Config.time.secondsPerDay;
        }

        /**
         * @param {number} dt Simulated seconds (already scaled by game speed).
         */
        update(dt) {
            this.elapsed += dt;
            const previousHour = this.hour;
            this.hour += dt * this.hoursPerSecond;

            if (this.hour >= 24) {
                this.hour -= 24;
                this.day++;
                this.bus.emit(Events.TIME_DAY_CHANGED, { day: this.day });
            }

            const period = this._periodFor(this.hour);
            if (period.id !== this.period.id) {
                const previous = this.period;
                this.period = period;
                this.bus.emit(Events.TIME_PERIOD_CHANGED, { from: previous, to: period });
            }

            Palettes.sample(this.hour, this.light);
        }

        _periodFor(hour) {
            const periods = Config.time.periods;
            let match = periods[0];
            for (let i = 0; i < periods.length; i++) {
                if (hour >= periods[i].from) match = periods[i];
            }
            return match;
        }

        /** True during the hours animals treat as night. */
        get isNight() {
            return this.hour >= Config.time.nightStart || this.hour < Config.time.nightEnd;
        }

        /** 0 at deep night, 1 in full daylight — drives sleep and activity. */
        get daylight() {
            return this.light.daylight;
        }

        /** `HH:MM` for display. */
        get clockString() {
            const h = Math.floor(this.hour);
            const m = Math.floor((this.hour - h) * 60);
            return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        }

        /** Position through the day, 0..1, for the HUD's day arc. */
        get dayProgress() {
            return this.hour / 24;
        }
    }

    Safari.TimeSystem = TimeSystem;

})(window.Safari);
