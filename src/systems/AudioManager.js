/**
 * Safari Simulator — Audio.
 *
 * Every sound is synthesised at runtime through the Web Audio API; the game ships no
 * audio files. Alongside one-shot cues there is a continuous ambience bed — filtered
 * wind whose character follows the weather, night crickets, dawn birdsong and distant
 * calls — which is what stops a quiet savanna from sounding like a dead one.
 *
 * The context is created lazily on the first user gesture, as browsers require.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Config, Events } = Safari;

    class AudioManager {
        /** @param {Safari.EventBus} bus */
        constructor(bus) {
            this.bus = bus;
            /** @type {AudioContext|null} */
            this.ctx = null;
            this.enabled = true;
            this.ready = false;

            this.master = null;
            this.sfxBus = null;
            this.ambienceBus = null;

            /** Wind bed nodes. */
            this.wind = null;
            /** Last time each cue fired, for throttling. */
            this._lastCue = Object.create(null);

            this.time = 0;
            this._cricketTimer = 0;
            this._birdTimer = 0;
            this._callTimer = 14;

            /** Environment, pushed in by the game each frame. */
            this.env = { night: 0, dawn: 0, wind: 0.5, rain: 0 };

            this._bindEvents();
        }

        /* -------------------------------------------------------------- *
         * Lifecycle
         * -------------------------------------------------------------- */

        /**
         * Listen to a different event bus.
         *
         * The isometric build discards its whole scene — and with it the bus — when a
         * new reserve is generated, because terrain, props and noise fields all derive
         * from one seed. The audio graph is expensive and stateful, so it outlives the
         * scene and is simply re-pointed. The old bus goes with the old scene, so there
         * is nothing to unsubscribe.
         */
        attach(bus) {
            if (this.bus === bus) return;
            this.bus = bus;
            this._bindEvents();
        }

        /** Create the audio graph. Safe to call repeatedly. */
        init() {
            if (this.ctx) {
                if (this.ctx.state === 'suspended') this.ctx.resume();
                return;
            }
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;

            this.ctx = new AC();

            this.master = this.ctx.createGain();
            this.master.gain.value = this.enabled ? Config.audio.masterVolume : 0;
            this.master.connect(this.ctx.destination);

            // A gentle compressor keeps overlapping cues from clipping.
            const comp = this.ctx.createDynamicsCompressor();
            comp.threshold.value = -18;
            comp.knee.value = 22;
            comp.ratio.value = 6;
            comp.attack.value = 0.004;
            comp.release.value = 0.22;
            comp.connect(this.master);

            this.sfxBus = this.ctx.createGain();
            this.sfxBus.gain.value = Config.audio.sfxVolume;
            this.sfxBus.connect(comp);

            this.ambienceBus = this.ctx.createGain();
            this.ambienceBus.gain.value = Config.audio.ambienceVolume;
            this.ambienceBus.connect(comp);

            this._buildWind();
            this.ready = true;
        }

        setEnabled(on) {
            this.enabled = !!on;
            if (this.master) {
                const t = this.ctx.currentTime;
                this.master.gain.cancelScheduledValues(t);
                this.master.gain.setTargetAtTime(
                    this.enabled ? Config.audio.masterVolume : 0, t, 0.08);
            }
        }

        /** Long-lived filtered noise source used as the wind bed. */
        _buildWind() {
            const ctx = this.ctx;

            // Two seconds of noise, looped — long enough that the loop is inaudible.
            const length = ctx.sampleRate * 2;
            const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            // Simple one-pole lowpass over white noise gives a browner, less hissy base.
            let last = 0;
            for (let i = 0; i < length; i++) {
                const white = Math.random() * 2 - 1;
                last = (last + 0.02 * white) / 1.02;
                data[i] = last * 3.2;
            }

            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.loop = true;

            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 420;
            filter.Q.value = 0.6;

            const gain = ctx.createGain();
            gain.gain.value = 0.0;

            source.connect(filter);
            filter.connect(gain);
            gain.connect(this.ambienceBus);
            source.start();

            this.wind = { source, filter, gain };
        }

        /* -------------------------------------------------------------- *
         * Synthesis primitives
         * -------------------------------------------------------------- */

        /**
         * A single enveloped oscillator.
         * @param {object} o
         * @param {number} o.freq
         * @param {number} [o.freqEnd] Sweep target.
         * @param {number} o.dur
         * @param {string} [o.type]
         * @param {number} [o.gain]
         * @param {number} [o.delay]
         * @param {number} [o.attack]
         * @param {AudioNode} [o.dest]
         */
        tone(o) {
            if (!this.ready || !this.enabled) return;
            const ctx = this.ctx;
            const t0 = ctx.currentTime + (o.delay || 0);
            const dur = o.dur;
            const peak = (o.gain === undefined ? 0.3 : o.gain);
            const attack = o.attack === undefined ? Math.min(0.012, dur * 0.25) : o.attack;

            const osc = ctx.createOscillator();
            osc.type = o.type || 'sine';
            osc.frequency.setValueAtTime(o.freq, t0);
            if (o.freqEnd !== undefined) {
                osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), t0 + dur);
            }

            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

            osc.connect(gain);

            if (o.filter) {
                const f = ctx.createBiquadFilter();
                f.type = o.filter.type || 'lowpass';
                f.frequency.value = o.filter.freq || 1200;
                f.Q.value = o.filter.q || 1;
                gain.connect(f);
                f.connect(o.dest || this.sfxBus);
            } else {
                gain.connect(o.dest || this.sfxBus);
            }

            osc.start(t0);
            osc.stop(t0 + dur + 0.02);
        }

        /**
         * A burst of filtered noise — impacts, footsteps, water, rustling.
         */
        noise(o) {
            if (!this.ready || !this.enabled) return;
            const ctx = this.ctx;
            const t0 = ctx.currentTime + (o.delay || 0);
            const dur = o.dur;

            const length = Math.max(1, Math.ceil(ctx.sampleRate * dur));
            const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

            const src = ctx.createBufferSource();
            src.buffer = buffer;

            const filter = ctx.createBiquadFilter();
            filter.type = o.type || 'bandpass';
            filter.frequency.setValueAtTime(o.freq || 900, t0);
            if (o.freqEnd !== undefined) {
                filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + dur);
            }
            filter.Q.value = o.q === undefined ? 1.1 : o.q;

            const gain = ctx.createGain();
            const peak = o.gain === undefined ? 0.25 : o.gain;
            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + Math.min(0.01, dur * 0.2));
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

            src.connect(filter);
            filter.connect(gain);
            gain.connect(o.dest || this.sfxBus);
            src.start(t0);
        }

        /* -------------------------------------------------------------- *
         * Cues
         * -------------------------------------------------------------- */

        /**
         * Play a named cue, throttled so a stampede does not machine-gun the mix.
         * @param {string} name
         * @param {object} [opts]
         */
        cue(name, opts) {
            if (!this.ready || !this.enabled) return;
            const now = this.ctx.currentTime;
            const last = this._lastCue[name] || -99;
            const throttle = (opts && opts.throttle) || Config.audio.cueThrottle;
            if (now - last < throttle) return;
            this._lastCue[name] = now;

            const fn = CUES[name];
            if (fn) fn.call(this, opts || {});
        }

        /* -------------------------------------------------------------- *
         * Ambience
         * -------------------------------------------------------------- */

        /**
         * @param {number} dt Real seconds.
         * @param {object} env {night 0..1, dawn 0..1, wind 0..1, rain 0..1}
         */
        update(dt, env) {
            if (!this.ready) return;
            this.time += dt;
            const e = this.env;
            e.night = env.night;
            e.dawn = env.dawn;
            e.wind = env.wind;
            e.rain = env.rain;

            // Wind bed: louder and brighter as the wind picks up, plus rain hiss.
            const t = this.ctx.currentTime;
            const windGain = 0.05 + env.wind * 0.10 + env.rain * 0.26;
            const windFreq = 300 + env.wind * 460 + env.rain * 1900;
            this.wind.gain.gain.setTargetAtTime(windGain, t, 0.5);
            this.wind.filter.frequency.setTargetAtTime(windFreq, t, 0.6);

            if (!this.enabled) return;

            // Crickets after dark.
            if (env.night > 0.35 && env.rain < 0.4) {
                this._cricketTimer -= dt;
                if (this._cricketTimer <= 0) {
                    this._cricketTimer = 0.16 + Math.random() * 0.5;
                    this._cricket(env.night);
                }
            }

            // Birdsong around dawn and through the morning.
            if (env.dawn > 0.15 && env.rain < 0.5) {
                this._birdTimer -= dt;
                if (this._birdTimer <= 0) {
                    this._birdTimer = 0.7 + Math.random() * 3.2;
                    this._birdCall(env.dawn);
                }
            }

            // An occasional distant call, day or night. Sets the scale of the place.
            this._callTimer -= dt;
            if (this._callTimer <= 0) {
                this._callTimer = 22 + Math.random() * 40;
                this._distantCall(env.night);
            }
        }

        _cricket(intensity) {
            const base = 3400 + Math.random() * 1100;
            const pulses = 3 + ((Math.random() * 3) | 0);
            for (let i = 0; i < pulses; i++) {
                this.noise({
                    freq: base, q: 22, dur: 0.028,
                    gain: 0.020 * intensity,
                    delay: i * 0.055,
                    dest: this.ambienceBus
                });
            }
        }

        _birdCall(intensity) {
            const kind = Math.random();
            const g = 0.030 * intensity;
            if (kind < 0.4) {
                // Two-note whistle.
                const f = 1900 + Math.random() * 900;
                this.tone({ freq: f, freqEnd: f * 1.5, dur: 0.11, type: 'sine', gain: g, dest: this.ambienceBus });
                this.tone({ freq: f * 1.4, freqEnd: f * 1.1, dur: 0.13, type: 'sine', gain: g * 0.9, delay: 0.16, dest: this.ambienceBus });
            } else if (kind < 0.75) {
                // Descending trill.
                const f = 2600 + Math.random() * 800;
                for (let i = 0; i < 5; i++) {
                    this.tone({
                        freq: f - i * 90, dur: 0.05, type: 'sine',
                        gain: g * (1 - i * 0.12), delay: i * 0.058, dest: this.ambienceBus
                    });
                }
            } else {
                // Single sharp chirp.
                const f = 3000 + Math.random() * 1400;
                this.tone({ freq: f, freqEnd: f * 0.6, dur: 0.09, type: 'triangle', gain: g, dest: this.ambienceBus });
            }
        }

        /** A low, distant animal call with a long tail. */
        _distantCall(night) {
            const low = 90 + Math.random() * 70;
            const g = 0.05 * (0.6 + night * 0.6);
            this.tone({
                freq: low, freqEnd: low * 0.72, dur: 1.5, type: 'sawtooth',
                gain: g, attack: 0.22,
                filter: { type: 'lowpass', freq: 380, q: 2 },
                dest: this.ambienceBus
            });
            this.tone({
                freq: low * 2.02, freqEnd: low * 1.5, dur: 1.3, type: 'sine',
                gain: g * 0.5, attack: 0.25, delay: 0.05, dest: this.ambienceBus
            });
        }

        /* -------------------------------------------------------------- *
         * Event wiring
         * -------------------------------------------------------------- */

        _bindEvents() {
            const bus = this.bus;
            const E = Events;

            bus.on(E.ANIMAL_PLACED, () => this.cue('place'));
            bus.on(E.ANIMAL_BORN, () => this.cue('birth'));
            bus.on(E.ANIMAL_STARVED, () => this.cue('death'));
            bus.on(E.ANIMAL_EATEN, () => this.cue('hunt'));
            bus.on(E.ANIMAL_ATE, () => this.cue('eat', { throttle: 0.16 }));
            bus.on(E.ANIMAL_DRANK, () => this.cue('drink', { throttle: 0.4 }));
            bus.on(E.ANIMAL_TRANQUILIZED, () => this.cue('tranqHit'));
            bus.on(E.ANIMAL_WOKE, () => this.cue('wake'));
            bus.on(E.RANGER_DEPLOYED, () => this.cue('engine'));
            bus.on(E.RANGER_SELECTED, () => this.cue('select'));
            bus.on(E.RANGER_DESELECTED, () => this.cue('deselect'));
            bus.on(E.RANGER_FIRED, () => this.cue('tranqFire', { throttle: 0.05 }));
            bus.on(E.DART_MISS, () => this.cue('dartMiss'));
            bus.on(E.FOOD_SPAWNED, () => this.cue('food'));
            bus.on(E.TIME_DAY_CHANGED, () => this.cue('newDay'));
            bus.on(E.GAME_START, () => this.cue('gameStart'));
            bus.on(E.GAME_END, () => this.cue('gameEnd'));
            bus.on(E.WEATHER_CHANGED, (p) => {
                if (p.to.id === 'rain') this.cue('thunder');
            });
            bus.on(E.TIME_PERIOD_CHANGED, (p) => {
                if (p.to.id === 'dawn') this.cue('dawn');
                else if (p.to.id === 'night2' || p.to.id === 'night') this.cue('nightfall');
            });
        }
    }

    /* ------------------------------------------------------------------ *
     * Cue definitions
     * ------------------------------------------------------------------ */

    /**
     * Each cue is a short arrangement of tones and noise bursts. Kept declarative and
     * together so the palette of the game's sound can be reasoned about in one place.
     */
    const CUES = {
        place() {
            this.noise({ freq: 320, freqEnd: 140, dur: 0.16, gain: 0.20, q: 0.8, type: 'lowpass' });
            this.tone({ freq: 220, freqEnd: 320, dur: 0.14, type: 'triangle', gain: 0.14 });
        },

        eat() {
            for (let i = 0; i < 3; i++) {
                this.noise({
                    freq: 700 + i * 260, q: 3, dur: 0.045,
                    gain: 0.10, delay: i * 0.055
                });
            }
        },

        drink() {
            this.tone({ freq: 420, freqEnd: 700, dur: 0.14, type: 'sine', gain: 0.10 });
            this.noise({ freq: 1400, freqEnd: 700, dur: 0.2, gain: 0.06, q: 2, delay: 0.05 });
        },

        hunt() {
            this.tone({ freq: 180, freqEnd: 70, dur: 0.34, type: 'sawtooth', gain: 0.22,
                filter: { type: 'lowpass', freq: 700, q: 3 } });
            this.noise({ freq: 900, freqEnd: 200, dur: 0.22, gain: 0.16, q: 0.9 });
        },

        birth() {
            const notes = [523.25, 659.25, 783.99];
            notes.forEach((f, i) => {
                this.tone({ freq: f, dur: 0.22, type: 'sine', gain: 0.16, delay: i * 0.09 });
                this.tone({ freq: f * 2, dur: 0.16, type: 'sine', gain: 0.05, delay: i * 0.09 });
            });
        },

        death() {
            this.tone({ freq: 220, freqEnd: 82, dur: 0.7, type: 'triangle', gain: 0.16,
                filter: { type: 'lowpass', freq: 900, q: 1 } });
            this.tone({ freq: 110, freqEnd: 55, dur: 0.9, type: 'sine', gain: 0.10, delay: 0.08 });
        },

        tranqFire() {
            this.noise({ freq: 2600, freqEnd: 700, dur: 0.07, gain: 0.24, q: 0.7 });
            this.tone({ freq: 1400, freqEnd: 2600, dur: 0.05, type: 'sine', gain: 0.12 });
        },

        tranqHit() {
            this.tone({ freq: 700, freqEnd: 240, dur: 0.24, type: 'sine', gain: 0.22 });
            this.tone({ freq: 350, freqEnd: 120, dur: 0.4, type: 'triangle', gain: 0.12, delay: 0.04 });
            this.noise({ freq: 1800, freqEnd: 400, dur: 0.1, gain: 0.10, q: 1.4 });
        },

        dartMiss() {
            this.noise({ freq: 900, freqEnd: 260, dur: 0.12, gain: 0.10, q: 1.2 });
        },

        wake() {
            [330, 415, 494].forEach((f, i) => {
                this.tone({ freq: f, dur: 0.16, type: 'sine', gain: 0.12, delay: i * 0.08 });
            });
        },

        select() {
            this.tone({ freq: 660, dur: 0.06, type: 'sine', gain: 0.14 });
            this.tone({ freq: 990, dur: 0.07, type: 'sine', gain: 0.09, delay: 0.05 });
        },

        deselect() {
            this.tone({ freq: 880, dur: 0.06, type: 'sine', gain: 0.11 });
            this.tone({ freq: 587, dur: 0.08, type: 'sine', gain: 0.08, delay: 0.05 });
        },

        engine() {
            this.tone({ freq: 62, freqEnd: 96, dur: 0.9, type: 'sawtooth', gain: 0.16,
                filter: { type: 'lowpass', freq: 260, q: 3 } });
            this.noise({ freq: 220, dur: 0.6, gain: 0.09, q: 0.6, type: 'lowpass' });
        },

        food() {
            this.noise({ freq: 2200, freqEnd: 900, dur: 0.16, gain: 0.10, q: 1.4 });
            this.tone({ freq: 700, freqEnd: 1050, dur: 0.12, type: 'sine', gain: 0.10 });
        },

        dawn() {
            [392, 523.25, 659.25, 784].forEach((f, i) => {
                this.tone({ freq: f, dur: 0.9, type: 'sine', gain: 0.07, attack: 0.2, delay: i * 0.16 });
            });
        },

        nightfall() {
            [392, 311, 261.63].forEach((f, i) => {
                this.tone({ freq: f, dur: 1.3, type: 'sine', gain: 0.07, attack: 0.3, delay: i * 0.22 });
            });
        },

        newDay() {
            [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
                this.tone({ freq: f, dur: 0.4, type: 'triangle', gain: 0.10, delay: i * 0.12 });
            });
        },

        thunder() {
            this.noise({ freq: 140, freqEnd: 50, dur: 1.9, gain: 0.24, q: 0.5, type: 'lowpass' });
            this.tone({ freq: 48, freqEnd: 30, dur: 2.2, type: 'sine', gain: 0.14, attack: 0.05 });
        },

        gameStart() {
            [261.63, 329.63, 392, 523.25].forEach((f, i) => {
                this.tone({ freq: f, dur: 0.55, type: 'triangle', gain: 0.13, delay: i * 0.13 });
                this.tone({ freq: f / 2, dur: 0.6, type: 'sine', gain: 0.07, delay: i * 0.13 });
            });
        },

        gameEnd() {
            [523.25, 440, 349.23, 261.63].forEach((f, i) => {
                this.tone({ freq: f, dur: 0.7, type: 'sine', gain: 0.13, delay: i * 0.19 });
            });
        }
    };

    AudioManager.CUES = CUES;
    Safari.AudioManager = AudioManager;

})(window.Safari);
