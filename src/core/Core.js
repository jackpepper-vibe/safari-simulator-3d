/**
 * Safari Simulator — Core runtime primitives.
 *
 * Establishes the `Safari` namespace and provides the foundational services every
 * other module depends on: a typed event bus, a fixed-timestep ticker, deterministic
 * pseudo-random number generation with value noise, maths/colour helpers and pooling.
 *
 * No module below this one may depend on anything above it.
 */
(function (global) {
    'use strict';

    /** @namespace */
    const Safari = global.Safari || (global.Safari = {});

    Safari.VERSION = '2.0.0';

    /* ------------------------------------------------------------------ *
     * Maths
     * ------------------------------------------------------------------ */

    const TAU = Math.PI * 2;

    /**
     * Scalar maths helpers. All functions are pure.
     * @namespace Safari.MathUtils
     */
    const MathUtils = {
        TAU,
        HALF_PI: Math.PI / 2,
        DEG: Math.PI / 180,

        /** @returns {number} `v` constrained to [min, max]. */
        clamp(v, min, max) {
            return v < min ? min : (v > max ? max : v);
        },

        /** @returns {number} `v` constrained to [0, 1]. */
        clamp01(v) {
            return v < 0 ? 0 : (v > 1 ? 1 : v);
        },

        /** Linear interpolation. */
        lerp(a, b, t) {
            return a + (b - a) * t;
        },

        /** Inverse lerp: where does `v` sit between `a` and `b`, as 0..1 (unclamped). */
        invLerp(a, b, v) {
            return b === a ? 0 : (v - a) / (b - a);
        },

        /** Remap `v` from one range to another, clamped to the destination range. */
        remap(v, inMin, inMax, outMin, outMax) {
            const t = MathUtils.clamp01(MathUtils.invLerp(inMin, inMax, v));
            return outMin + (outMax - outMin) * t;
        },

        /** Hermite smoothstep between two edges. */
        smoothstep(edge0, edge1, v) {
            const t = MathUtils.clamp01(MathUtils.invLerp(edge0, edge1, v));
            return t * t * (3 - 2 * t);
        },

        /** Quintic smootherstep — zero first *and* second derivative at the edges. */
        smootherstep(edge0, edge1, v) {
            const t = MathUtils.clamp01(MathUtils.invLerp(edge0, edge1, v));
            return t * t * t * (t * (t * 6 - 15) + 10);
        },

        /**
         * Frame-rate independent exponential approach — the correct replacement for
         * `a = lerp(a, b, 0.1)` inside a variable-timestep loop.
         *
         * @param {number} a Current value.
         * @param {number} b Target value.
         * @param {number} lambda Convergence rate (higher = snappier).
         * @param {number} dt Delta time in seconds.
         */
        damp(a, b, lambda, dt) {
            return MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt));
        },

        /** Move `a` toward `b` by at most `maxDelta`. */
        approach(a, b, maxDelta) {
            const d = b - a;
            if (Math.abs(d) <= maxDelta) return b;
            return a + Math.sign(d) * maxDelta;
        },

        /** Wrap `v` into [0, range). */
        wrap(v, range) {
            return ((v % range) + range) % range;
        },

        /** Shortest signed angular difference from `a` to `b`, in radians. */
        angleDelta(a, b) {
            return MathUtils.wrap(b - a + Math.PI, TAU) - Math.PI;
        },

        /** Interpolate between angles along the shortest arc. */
        angleLerp(a, b, t) {
            return a + MathUtils.angleDelta(a, b) * t;
        },

        /** Frame-rate independent angular damping. */
        angleDamp(a, b, lambda, dt) {
            return a + MathUtils.angleDelta(a, b) * (1 - Math.exp(-lambda * dt));
        },

        dist(ax, ay, bx, by) {
            return Math.hypot(bx - ax, by - ay);
        },

        /** Squared distance — prefer this for comparisons. */
        dist2(ax, ay, bx, by) {
            const dx = bx - ax, dy = by - ay;
            return dx * dx + dy * dy;
        },

        /* Easing curves ------------------------------------------------- */
        easeInQuad: (t) => t * t,
        easeOutQuad: (t) => t * (2 - t),
        easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
        easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
        easeInCubic: (t) => t * t * t,
        easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
        easeOutQuart: (t) => 1 - Math.pow(1 - t, 4),
        easeOutExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),

        /** Overshooting "pop" ease, good for UI and spawn animations. */
        easeOutBack(t, overshoot) {
            const c1 = overshoot === undefined ? 1.70158 : overshoot;
            const c3 = c1 + 1;
            return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
        },

        /** Decaying elastic bounce, 0..1. */
        easeOutElastic(t) {
            if (t <= 0) return 0;
            if (t >= 1) return 1;
            const p = 0.3;
            return Math.pow(2, -10 * t) * Math.sin((t - p / 4) * TAU / p) + 1;
        },

        /** A cheap 0..1 pulse that peaks at the midpoint. */
        arch(t) {
            return Math.sin(MathUtils.clamp01(t) * Math.PI);
        }
    };

    Safari.MathUtils = MathUtils;

    /* ------------------------------------------------------------------ *
     * Colour
     * ------------------------------------------------------------------ */

    /**
     * Colour parsing, mixing and formatting. Colours are represented internally as
     * `{r, g, b}` with components in 0..255 (floats permitted during interpolation).
     *
     * @namespace Safari.Color
     */
    const Color = {
        /** @type {Map<string, {r:number,g:number,b:number}>} */
        _cache: new Map(),

        /**
         * Parse `#rgb`, `#rrggbb` or `rgb()/rgba()` into an rgb triple.
         * Results are memoised because this runs inside render loops.
         */
        parse(input) {
            if (typeof input !== 'string') return { r: 0, g: 0, b: 0 };
            const cached = Color._cache.get(input);
            if (cached) return cached;

            let out = { r: 0, g: 0, b: 0 };
            const s = input.trim();

            if (s.charCodeAt(0) === 35 /* # */) {
                const hex = s.slice(1);
                if (hex.length === 3) {
                    out = {
                        r: parseInt(hex[0] + hex[0], 16),
                        g: parseInt(hex[1] + hex[1], 16),
                        b: parseInt(hex[2] + hex[2], 16)
                    };
                } else if (hex.length >= 6) {
                    out = {
                        r: parseInt(hex.slice(0, 2), 16),
                        g: parseInt(hex.slice(2, 4), 16),
                        b: parseInt(hex.slice(4, 6), 16)
                    };
                }
            } else {
                const m = s.match(/-?\d+(\.\d+)?/g);
                if (m && m.length >= 3) {
                    out = { r: +m[0], g: +m[1], b: +m[2] };
                }
            }

            Color._cache.set(input, out);
            return out;
        },

        /** Format an rgb triple as `rgb(...)`, rounding components. */
        css(c) {
            return 'rgb(' + (c.r | 0) + ',' + (c.g | 0) + ',' + (c.b | 0) + ')';
        },

        /** Format an rgb triple as `rgba(...)` with the supplied alpha. */
        rgba(c, alpha) {
            return 'rgba(' + (c.r | 0) + ',' + (c.g | 0) + ',' + (c.b | 0) + ',' + alpha + ')';
        },

        /** Format a hex/`rgb()` string as `rgba()` with the supplied alpha. */
        alpha(input, a) {
            return Color.rgba(Color.parse(input), a);
        },

        /** Linear RGB-space mix of two triples. */
        mix(a, b, t) {
            return {
                r: a.r + (b.r - a.r) * t,
                g: a.g + (b.g - a.g) * t,
                b: a.b + (b.b - a.b) * t
            };
        },

        /** Mix two colour strings, returning a triple. */
        mixCss(a, b, t) {
            return Color.mix(Color.parse(a), Color.parse(b), t);
        },

        /**
         * Multiply-blend `c` toward `tint` by `amount` — the standard way to apply an
         * ambient light colour to a surface colour.
         */
        tint(c, tint, amount) {
            return {
                r: c.r * (1 - amount) + (c.r * tint.r / 255) * amount,
                g: c.g * (1 - amount) + (c.g * tint.g / 255) * amount,
                b: c.b * (1 - amount) + (c.b * tint.b / 255) * amount
            };
        },

        /** Scale brightness, clamping to the 0..255 range. */
        scale(c, k) {
            return {
                r: MathUtils.clamp(c.r * k, 0, 255),
                g: MathUtils.clamp(c.g * k, 0, 255),
                b: MathUtils.clamp(c.b * k, 0, 255)
            };
        },

        /** Push a colour toward white by `t`. */
        lighten(c, t) {
            return Color.mix(c, { r: 255, g: 255, b: 255 }, t);
        },

        /** Push a colour toward black by `t`. */
        darken(c, t) {
            return Color.mix(c, { r: 0, g: 0, b: 0 }, t);
        },

        /** Perceptual-ish luminance, 0..255. */
        luminance(c) {
            return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        },

        /** Reduce saturation toward the colour's own luminance. */
        desaturate(c, t) {
            const l = Color.luminance(c);
            return Color.mix(c, { r: l, g: l, b: l }, t);
        }
    };

    Safari.Color = Color;

    /* ------------------------------------------------------------------ *
     * Deterministic randomness
     * ------------------------------------------------------------------ */

    /**
     * Seedable PRNG (mulberry32) plus deterministic value noise.
     *
     * Every piece of generated content — terrain layout, fur markings, star fields,
     * mountain ridges — draws from a seeded instance so a given world always looks
     * identical, which makes visual regressions reproducible.
     */
    class Rng {
        /** @param {number} [seed] */
        constructor(seed) {
            this.seed = (seed === undefined ? (Math.random() * 4294967296) >>> 0 : seed >>> 0);
            this._state = this.seed || 1;
        }

        /** Restart the sequence from the original seed. */
        reset() {
            this._state = this.seed || 1;
            return this;
        }

        /** @returns {number} Uniform float in [0, 1). */
        next() {
            let t = (this._state += 0x6D2B79F5);
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }

        /** Uniform float in [min, max). */
        range(min, max) {
            return min + this.next() * (max - min);
        }

        /** Uniform integer in [min, max]. */
        int(min, max) {
            return Math.floor(min + this.next() * (max - min + 1));
        }

        /** Symmetric noise in [-mag, mag). */
        spread(mag) {
            return (this.next() * 2 - 1) * mag;
        }

        /** True with probability `p`. */
        chance(p) {
            return this.next() < p;
        }

        /** Uniform choice from an array. */
        pick(arr) {
            return arr[Math.floor(this.next() * arr.length)];
        }

        /** In-place Fisher–Yates shuffle. */
        shuffle(arr) {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(this.next() * (i + 1));
                const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
            }
            return arr;
        }

        /** Approximately normal deviate via the sum of three uniforms. */
        gaussian(mean, stdDev) {
            const u = (this.next() + this.next() + this.next()) / 3;
            return mean + (u - 0.5) * 3.464 * stdDev;
        }

        /** Fork a child generator — useful for isolating sub-systems from each other. */
        fork(salt) {
            return new Rng((this.seed ^ Math.imul(salt | 0, 0x9E3779B9)) >>> 0);
        }
    }

    Safari.Rng = Rng;

    /**
     * Deterministic gradient/value noise in one and two dimensions.
     * Used for ridgelines, cloud shapes, ground mottling and wind fields.
     *
     * @namespace Safari.Noise
     */
    const Noise = {
        /** Integer hash → float in [0, 1). */
        hash(n) {
            let x = Math.imul(n ^ 0x27d4eb2d, 0x85ebca6b);
            x ^= x >>> 13;
            x = Math.imul(x, 0xc2b2ae35);
            return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
        },

        hash2(x, y) {
            return Noise.hash(Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263));
        },

        /** Smooth 1D value noise. */
        value1(x) {
            const i = Math.floor(x);
            const f = x - i;
            const u = f * f * (3 - 2 * f);
            return MathUtils.lerp(Noise.hash(i), Noise.hash(i + 1), u);
        },

        /** Smooth 2D value noise. */
        value2(x, y) {
            const ix = Math.floor(x), iy = Math.floor(y);
            const fx = x - ix, fy = y - iy;
            const ux = fx * fx * (3 - 2 * fx);
            const uy = fy * fy * (3 - 2 * fy);
            const a = Noise.hash2(ix, iy);
            const b = Noise.hash2(ix + 1, iy);
            const c = Noise.hash2(ix, iy + 1);
            const d = Noise.hash2(ix + 1, iy + 1);
            return MathUtils.lerp(
                MathUtils.lerp(a, b, ux),
                MathUtils.lerp(c, d, ux),
                uy
            );
        },

        /** Fractal Brownian motion over 1D value noise. */
        fbm1(x, octaves, lacunarity, gain) {
            const oct = octaves || 4;
            const lac = lacunarity || 2;
            const g = gain || 0.5;
            let sum = 0, amp = 0.5, freq = 1, norm = 0;
            for (let i = 0; i < oct; i++) {
                sum += Noise.value1(x * freq) * amp;
                norm += amp;
                freq *= lac;
                amp *= g;
            }
            return sum / norm;
        },

        /** Fractal Brownian motion over 2D value noise. */
        fbm2(x, y, octaves, lacunarity, gain) {
            const oct = octaves || 4;
            const lac = lacunarity || 2;
            const g = gain || 0.5;
            let sum = 0, amp = 0.5, freq = 1, norm = 0;
            for (let i = 0; i < oct; i++) {
                sum += Noise.value2(x * freq, y * freq) * amp;
                norm += amp;
                freq *= lac;
                amp *= g;
            }
            return sum / norm;
        }
    };

    Safari.Noise = Noise;

    /* ------------------------------------------------------------------ *
     * Event bus
     * ------------------------------------------------------------------ */

    /**
     * Minimal synchronous publish/subscribe hub.
     *
     * Systems communicate through this rather than holding references to one another,
     * so gameplay, audio, HUD and particle responses to (say) a birth can evolve
     * independently.
     */
    class EventBus {
        constructor() {
            /** @type {Map<string, Array<{fn: Function, ctx: *, once: boolean}>>} */
            this._handlers = new Map();
            this._muted = false;
        }

        /**
         * Subscribe to an event.
         * @returns {Function} An unsubscribe function.
         */
        on(type, fn, ctx) {
            let list = this._handlers.get(type);
            if (!list) { list = []; this._handlers.set(type, list); }
            list.push({ fn, ctx: ctx || null, once: false });
            return () => this.off(type, fn, ctx);
        }

        /** Subscribe for a single invocation. */
        once(type, fn, ctx) {
            let list = this._handlers.get(type);
            if (!list) { list = []; this._handlers.set(type, list); }
            list.push({ fn, ctx: ctx || null, once: true });
            return () => this.off(type, fn, ctx);
        }

        /** Remove a handler previously registered with the same fn/ctx pair. */
        off(type, fn, ctx) {
            const list = this._handlers.get(type);
            if (!list) return;
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i].fn === fn && (ctx === undefined || list[i].ctx === (ctx || null))) {
                    list.splice(i, 1);
                }
            }
            if (list.length === 0) this._handlers.delete(type);
        }

        /** Drop every handler, or every handler for one event type. */
        clear(type) {
            if (type) this._handlers.delete(type);
            else this._handlers.clear();
        }

        /**
         * Dispatch an event synchronously. Handler exceptions are contained so one
         * broken listener cannot halt the frame.
         */
        emit(type, payload) {
            if (this._muted) return;
            const list = this._handlers.get(type);
            if (!list || list.length === 0) return;

            // Iterate a copy: handlers routinely subscribe/unsubscribe during dispatch.
            const snapshot = list.slice();
            for (let i = 0; i < snapshot.length; i++) {
                const h = snapshot[i];
                if (h.once) this.off(type, h.fn, h.ctx);
                try {
                    h.fn.call(h.ctx, payload, type);
                } catch (err) {
                    console.error('[EventBus] handler for "' + type + '" threw:', err);
                }
            }
        }

        /** Temporarily suppress dispatch (used during teardown/reset). */
        setMuted(muted) {
            this._muted = !!muted;
        }
    }

    Safari.EventBus = EventBus;

    /**
     * Canonical event names. Using constants instead of string literals keeps typos
     * from silently becoming dead subscriptions.
     * @enum {string}
     */
    Safari.Events = {
        GAME_START: 'game:start',
        GAME_END: 'game:end',
        GAME_RESET: 'game:reset',
        GAME_PAUSE: 'game:pause',
        GAME_RESUME: 'game:resume',

        ANIMAL_PLACED: 'animal:placed',
        ANIMAL_BORN: 'animal:born',
        ANIMAL_DIED: 'animal:died',
        ANIMAL_EATEN: 'animal:eaten',
        ANIMAL_STARVED: 'animal:starved',
        ANIMAL_ATE: 'animal:ate',
        ANIMAL_TRANQUILIZED: 'animal:tranquilized',
        ANIMAL_WOKE: 'animal:woke',
        ANIMAL_DRANK: 'animal:drank',

        ANIMAL_LOADED: 'animal:loaded',
        ANIMAL_RELOCATED: 'animal:relocated',
        LORRY_LOADED: 'lorry:loaded',

        DROUGHT_STARTED: 'event:drought',
        DROUGHT_ENDED: 'event:droughtEnd',
        FIRE_STARTED: 'event:fire',
        FIRE_OUT: 'event:fireOut',
        POACHER_SIGHTED: 'event:poacher',
        POACHER_DRIVEN_OFF: 'event:poacherOff',
        POACHER_KILLED_ANIMAL: 'event:poached',

        RANGER_DEPLOYED: 'ranger:deployed',
        RANGER_SELECTED: 'ranger:selected',
        RANGER_DESELECTED: 'ranger:deselected',
        RANGER_FIRED: 'ranger:fired',
        DART_HIT: 'dart:hit',
        DART_MISS: 'dart:miss',

        FOOD_SPAWNED: 'food:spawned',
        TIME_PERIOD_CHANGED: 'time:period',
        TIME_DAY_CHANGED: 'time:day',
        WEATHER_CHANGED: 'weather:changed',

        STATS_CHANGED: 'stats:changed',
        LOG: 'ui:log',
        TOAST: 'ui:toast',
        SPEED_CHANGED: 'ui:speed',
        RESIZE: 'view:resize'
    };

    /* ------------------------------------------------------------------ *
     * Object pooling
     * ------------------------------------------------------------------ */

    /**
     * Fixed-behaviour object pool. Particles churn thousands of instances per second;
     * recycling them keeps the garbage collector out of the frame budget.
     *
     * @template T
     */
    class ObjectPool {
        /**
         * @param {() => T} factory Creates a fresh instance.
         * @param {(obj: T) => void} [reset] Prepares a recycled instance for reuse.
         * @param {number} [prealloc] Instances to build up front.
         */
        constructor(factory, reset, prealloc) {
            this._factory = factory;
            this._reset = reset || null;
            /** @type {T[]} */
            this._free = [];
            this.created = 0;

            const n = prealloc || 0;
            for (let i = 0; i < n; i++) {
                this._free.push(factory());
                this.created++;
            }
        }

        /** @returns {T} */
        acquire() {
            const obj = this._free.pop();
            if (obj) {
                if (this._reset) this._reset(obj);
                return obj;
            }
            this.created++;
            return this._factory();
        }

        /** @param {T} obj */
        release(obj) {
            this._free.push(obj);
        }

        get available() {
            return this._free.length;
        }
    }

    Safari.ObjectPool = ObjectPool;

    /* ------------------------------------------------------------------ *
     * Ticker
     * ------------------------------------------------------------------ */

    /**
     * requestAnimationFrame driver with a fixed-timestep accumulator.
     *
     * Simulation advances in constant slices so behaviour is deterministic and stable
     * regardless of display refresh rate, while rendering happens once per frame with
     * an interpolation factor available for smoothing.
     */
    class Ticker {
        /**
         * @param {object} [options]
         * @param {number} [options.fixedStep] Simulation slice, in seconds.
         * @param {number} [options.maxFrameTime] Largest real delta honoured per frame.
         */
        constructor(options) {
            const opts = options || {};
            this.fixedStep = opts.fixedStep || 1 / 60;
            this.maxFrameTime = opts.maxFrameTime || 0.1;

            /** Simulation rate multiplier; 0 pauses the simulation but keeps rendering. */
            this.timeScale = 1;
            this.running = false;
            this.frame = 0;
            /** Seconds of simulated time since start (scaled). */
            this.elapsed = 0;
            /** Seconds of wall-clock time since start (unscaled) — drives UI animation. */
            this.wallClock = 0;
            /** Smoothed frames per second. */
            this.fps = 60;

            this._accumulator = 0;
            this._lastTime = 0;
            this._rafId = 0;
            /** @type {Array<(dt:number, ctx:Ticker)=>void>} */
            this._updateCbs = [];
            /** @type {Array<(dt:number, alpha:number, ctx:Ticker)=>void>} */
            this._renderCbs = [];

            this._loop = this._loop.bind(this);
        }

        /** Register a fixed-timestep simulation callback. */
        onUpdate(fn) {
            this._updateCbs.push(fn);
            return this;
        }

        /** Register a per-frame render callback. */
        onRender(fn) {
            this._renderCbs.push(fn);
            return this;
        }

        start() {
            if (this.running) return;
            this.running = true;
            this._lastTime = performance.now();
            this._accumulator = 0;
            this._rafId = requestAnimationFrame(this._loop);
        }

        stop() {
            this.running = false;
            if (this._rafId) cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }

        _loop(now) {
            if (!this.running) return;
            this._rafId = requestAnimationFrame(this._loop);

            let frameTime = (now - this._lastTime) / 1000;
            this._lastTime = now;

            // A backgrounded tab produces enormous deltas; clamp rather than
            // simulating minutes of world time in a single frame.
            if (frameTime > this.maxFrameTime) frameTime = this.maxFrameTime;
            if (frameTime < 0) frameTime = 0;

            this.wallClock += frameTime;
            this.fps += ((frameTime > 0 ? 1 / frameTime : 60) - this.fps) * 0.06;

            const scaled = frameTime * this.timeScale;
            this._accumulator += scaled;

            // Cap catch-up iterations so a slow machine degrades in speed rather than
            // spiralling into an ever-growing backlog.
            let steps = 0;
            const maxSteps = 8;
            while (this._accumulator >= this.fixedStep && steps < maxSteps) {
                this.elapsed += this.fixedStep;
                for (let i = 0; i < this._updateCbs.length; i++) {
                    this._updateCbs[i](this.fixedStep, this);
                }
                this._accumulator -= this.fixedStep;
                steps++;
            }
            if (steps >= maxSteps) this._accumulator = 0;

            const alpha = this._accumulator / this.fixedStep;
            this.frame++;
            for (let i = 0; i < this._renderCbs.length; i++) {
                this._renderCbs[i](frameTime, alpha, this);
            }
        }
    }

    Safari.Ticker = Ticker;

    /* ------------------------------------------------------------------ *
     * Small shared utilities
     * ------------------------------------------------------------------ */

    /** @namespace Safari.Utils */
    Safari.Utils = {
        /** Create a detached canvas + 2D context, sized in device pixels. */
        createCanvas(width, height) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.ceil(width));
            canvas.height = Math.max(1, Math.ceil(height));
            return canvas;
        },

        /** Remove an item from an array by identity. Returns whether it was present. */
        remove(arr, item) {
            const i = arr.indexOf(item);
            if (i === -1) return false;
            arr.splice(i, 1);
            return true;
        },

        /**
         * Compact an array in place, keeping items for which `predicate` is true.
         * Avoids the allocation of `Array#filter` in hot loops.
         */
        retain(arr, predicate) {
            let w = 0;
            for (let r = 0; r < arr.length; r++) {
                if (predicate(arr[r])) arr[w++] = arr[r];
            }
            arr.length = w;
            return arr;
        },

        /** Format an integer with thousands separators. */
        formatNumber(n) {
            return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        },

        /** `true` when the user has asked the OS to minimise motion. */
        prefersReducedMotion() {
            return typeof matchMedia === 'function' &&
                matchMedia('(prefers-reduced-motion: reduce)').matches;
        }
    };

})(typeof window !== 'undefined' ? window : globalThis);
