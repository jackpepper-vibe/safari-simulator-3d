/**
 * Safari Simulator — Colour science and the day-cycle lighting model.
 *
 * The whole scene is lit from a single interpolated `LightingState` sampled from a
 * table of hand-authored sky keyframes. Every renderer reads from that one state, so
 * sky, water, foliage, fur and shadows always agree about the time of day.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Color } = Safari;

    /**
     * @typedef {object} SkyStop
     * @property {number} p Vertical position, 0 = top of sky, 1 = horizon.
     * @property {string} c Colour.
     */

    /**
     * @typedef {object} SkyKeyframe
     * @property {number} hour           Time of day this keyframe describes (0..24).
     * @property {SkyStop[]} sky         Vertical gradient from zenith to horizon.
     * @property {string} haze           Colour of the atmospheric band at the horizon.
     * @property {string} ambient        Multiply tint applied to the ground and entities.
     * @property {number} ambientAmount  Strength of that tint, 0..1.
     * @property {number} exposure       Overall brightness multiplier for lit surfaces.
     * @property {string} sunTint        Colour of direct sunlight (rim light + glow).
     * @property {number} sunStrength    Intensity of direct light, 0..1.
     * @property {number} starAlpha      Star field opacity, 0..1.
     * @property {number} saturation     World saturation multiplier (night is greyer).
     * @property {string} groundWarm     Warm bounce colour mixed into lit ground.
     * @property {number} groundWarmth   Strength of that bounce, 0..1.
     */

    /**
     * The day, in twelve authored moments. Times between them are interpolated.
     * Ordered by hour and treated as cyclic — 24:00 wraps to 00:00.
     *
     * @type {SkyKeyframe[]}
     */
    const SKY_KEYFRAMES = [
        {   // Deep night — moonlit, cold, high contrast stars.
            hour: 0,
            sky: [
                { p: 0.00, c: '#040711' },
                { p: 0.42, c: '#091230' },
                { p: 0.76, c: '#12224a' },
                { p: 1.00, c: '#1c2f57' }
            ],
            haze: '#22355e',
            ambient: '#3d5490', ambientAmount: 0.80,
            exposure: 0.46,
            sunTint: '#8fa8dd', sunStrength: 0.10,
            starAlpha: 1.00, saturation: 0.55,
            groundWarm: '#2c3f6b', groundWarmth: 0.20
        },
        {   // Pre-dawn — the sky lifts before any colour arrives.
            hour: 4.6,
            sky: [
                { p: 0.00, c: '#080e22' },
                { p: 0.40, c: '#12203f' },
                { p: 0.74, c: '#22355c' },
                { p: 1.00, c: '#3a4c72' }
            ],
            haze: '#42557b',
            ambient: '#4a5f96', ambientAmount: 0.72,
            exposure: 0.52,
            sunTint: '#9db2e0', sunStrength: 0.14,
            starAlpha: 0.72, saturation: 0.62,
            groundWarm: '#3a4d78', groundWarmth: 0.22
        },
        {   // Astronomical dawn — first cold blue, stars fading.
            hour: 5.5,
            sky: [
                { p: 0.00, c: '#132046' },
                { p: 0.38, c: '#243f6e' },
                { p: 0.70, c: '#4a5f88' },
                { p: 1.00, c: '#7b7590' }
            ],
            haze: '#8a7f96',
            ambient: '#5f6f9e', ambientAmount: 0.62,
            exposure: 0.52,
            sunTint: '#c3a3b8', sunStrength: 0.22,
            starAlpha: 0.34, saturation: 0.70,
            groundWarm: '#5b5f86', groundWarmth: 0.26
        },
        {   // Civil dawn — the pink band arrives at the horizon.
            hour: 6.2,
            sky: [
                { p: 0.00, c: '#20406f' },
                { p: 0.34, c: '#4a6293' },
                { p: 0.64, c: '#9c7f96' },
                { p: 0.86, c: '#e0937c' },
                { p: 1.00, c: '#f6b273' }
            ],
            haze: '#f2b482',
            ambient: '#9b7d8e', ambientAmount: 0.46,
            exposure: 0.70,
            sunTint: '#ffb977', sunStrength: 0.44,
            starAlpha: 0.06, saturation: 0.86,
            groundWarm: '#c98a6a', groundWarmth: 0.36
        },
        {   // Sunrise — full gold across the lower sky.
            hour: 7.0,
            sky: [
                { p: 0.00, c: '#3d78b8' },
                { p: 0.32, c: '#74a2cc' },
                { p: 0.60, c: '#c5b39c' },
                { p: 0.83, c: '#f5b06d' },
                { p: 1.00, c: '#ffcb7d' }
            ],
            haze: '#ffcf90',
            ambient: '#e0a878', ambientAmount: 0.30,
            exposure: 0.88,
            sunTint: '#ffd08a', sunStrength: 0.76,
            starAlpha: 0, saturation: 1.02,
            groundWarm: '#f0b070', groundWarmth: 0.40
        },
        {   // Mid-morning — clean savanna blue.
            hour: 9.2,
            sky: [
                { p: 0.00, c: '#2f7ec4' },
                { p: 0.38, c: '#63a8d8' },
                { p: 0.72, c: '#a3ceea' },
                { p: 1.00, c: '#d6e9f4' }
            ],
            haze: '#dbeaf3',
            ambient: '#f4ead6', ambientAmount: 0.10,
            exposure: 1.00,
            sunTint: '#fff3d0', sunStrength: 0.94,
            starAlpha: 0, saturation: 1.05,
            groundWarm: '#ffe6ab', groundWarmth: 0.22
        },
        {   // Noon — bleached, high, hard shadows.
            hour: 12.0,
            sky: [
                { p: 0.00, c: '#2d84cf' },
                { p: 0.40, c: '#66b0e0' },
                { p: 0.74, c: '#aad6ef' },
                { p: 1.00, c: '#e2f0f7' }
            ],
            haze: '#e8f2f8',
            ambient: '#fffaf0', ambientAmount: 0.05,
            exposure: 1.06,
            sunTint: '#fffbe8', sunStrength: 1.00,
            starAlpha: 0, saturation: 1.00,
            groundWarm: '#fff0bf', groundWarmth: 0.16
        },
        {   // Afternoon — light begins to warm and lengthen.
            hour: 15.6,
            sky: [
                { p: 0.00, c: '#3383c8' },
                { p: 0.38, c: '#6fadd8' },
                { p: 0.72, c: '#b3d3e4' },
                { p: 1.00, c: '#e6e7dc' }
            ],
            haze: '#eae5d2',
            ambient: '#ffeccc', ambientAmount: 0.12,
            exposure: 1.00,
            sunTint: '#ffe6b0', sunStrength: 0.92,
            starAlpha: 0, saturation: 1.06,
            groundWarm: '#ffdd9e', groundWarmth: 0.26
        },
        {   // Golden hour — the signature safari look.
            hour: 17.7,
            sky: [
                { p: 0.00, c: '#3f80bd' },
                { p: 0.30, c: '#84a8c4' },
                { p: 0.58, c: '#d3b489' },
                { p: 0.82, c: '#f4a862' },
                { p: 1.00, c: '#ffc978' }
            ],
            haze: '#ffcb85',
            ambient: '#f0b478', ambientAmount: 0.30,
            exposure: 0.94,
            sunTint: '#ffc177', sunStrength: 0.84,
            starAlpha: 0, saturation: 1.14,
            groundWarm: '#ffb266', groundWarmth: 0.46
        },
        {   // Sunset — deep reds, the sun on the horizon.
            hour: 18.9,
            sky: [
                { p: 0.00, c: '#2b3f75' },
                { p: 0.26, c: '#6a5286' },
                { p: 0.52, c: '#bf6f79' },
                { p: 0.78, c: '#ef8a5c' },
                { p: 1.00, c: '#ffab5c' }
            ],
            haze: '#ff9f60',
            ambient: '#cf7f6e', ambientAmount: 0.46,
            exposure: 0.76,
            sunTint: '#ff9b56', sunStrength: 0.60,
            starAlpha: 0.04, saturation: 1.12,
            groundWarm: '#e8804f', groundWarmth: 0.48
        },
        {   // Dusk — indigo overhead, embers at the horizon.
            hour: 19.9,
            sky: [
                { p: 0.00, c: '#131c44' },
                { p: 0.32, c: '#2d2c5c' },
                { p: 0.62, c: '#5c3d68' },
                { p: 0.86, c: '#94505e' },
                { p: 1.00, c: '#b8654f' }
            ],
            haze: '#a25a53',
            ambient: '#7a5f83', ambientAmount: 0.62,
            exposure: 0.60,
            sunTint: '#d1795e', sunStrength: 0.30,
            starAlpha: 0.42, saturation: 0.90,
            groundWarm: '#8a5666', groundWarmth: 0.36
        },
        {   // Nightfall — settles back into the 00:00 keyframe.
            hour: 21.2,
            sky: [
                { p: 0.00, c: '#060a1a' },
                { p: 0.40, c: '#0c1533' },
                { p: 0.74, c: '#16264d' },
                { p: 1.00, c: '#233a58' }
            ],
            haze: '#2a3d63',
            ambient: '#43598f', ambientAmount: 0.76,
            exposure: 0.48,
            sunTint: '#93a9dd', sunStrength: 0.12,
            starAlpha: 0.92, saturation: 0.60,
            groundWarm: '#33477a', groundWarmth: 0.22
        }
    ];

    /* Pre-parse every keyframe colour once, so sampling never touches string parsing. */
    const PARSED = SKY_KEYFRAMES.map((kf) => ({
        hour: kf.hour,
        sky: kf.sky.map((s) => ({ p: s.p, c: Color.parse(s.c) })),
        haze: Color.parse(kf.haze),
        ambient: Color.parse(kf.ambient),
        ambientAmount: kf.ambientAmount,
        exposure: kf.exposure,
        sunTint: Color.parse(kf.sunTint),
        sunStrength: kf.sunStrength,
        starAlpha: kf.starAlpha,
        saturation: kf.saturation,
        groundWarm: Color.parse(kf.groundWarm),
        groundWarmth: kf.groundWarmth
    }));

    /** Sky gradients must share a stop count to interpolate; pad to the longest. */
    const MAX_STOPS = PARSED.reduce((m, kf) => Math.max(m, kf.sky.length), 0);
    PARSED.forEach((kf) => {
        while (kf.sky.length < MAX_STOPS) {
            // Duplicate the horizon stop; a repeated stop is visually inert but keeps
            // stop indices aligned across keyframes.
            const last = kf.sky[kf.sky.length - 1];
            const prev = kf.sky[kf.sky.length - 2] || last;
            kf.sky.splice(kf.sky.length - 1, 0, {
                p: (prev.p + last.p) / 2,
                c: Color.mix(prev.c, last.c, 0.5)
            });
        }
    });

    /**
     * @typedef {object} LightingState
     * @property {number} hour
     * @property {Array<{p:number, c:{r:number,g:number,b:number}}>} sky
     * @property {{r:number,g:number,b:number}} haze
     * @property {{r:number,g:number,b:number}} ambient
     * @property {number} ambientAmount
     * @property {number} exposure
     * @property {{r:number,g:number,b:number}} sunTint
     * @property {number} sunStrength
     * @property {number} starAlpha
     * @property {number} saturation
     * @property {{r:number,g:number,b:number}} groundWarm
     * @property {number} groundWarmth
     * @property {number} sunAltitude   -1 (nadir) .. 1 (zenith).
     * @property {number} sunAzimuth    0 = due east/left, 1 = due west/right.
     * @property {number} moonAltitude  -1 .. 1.
     * @property {number} moonAzimuth   0 .. 1.
     * @property {number} daylight      0 at night, 1 in full day.
     * @property {number} shadowDir     Horizontal shadow direction, -1 .. 1.
     * @property {number} shadowLength  Shadow length multiplier.
     * @property {number} shadowAlpha   Shadow opacity.
     */

    /** Civil sunrise/sunset used for celestial arcs and shadow geometry. */
    const SUNRISE = 6.1;
    const SUNSET = 19.1;

    /**
     * Interpolate the lighting state for a given hour.
     *
     * @param {number} hour 0..24 (values outside are wrapped).
     * @param {LightingState} [out] Optional target to mutate, avoiding allocation.
     * @returns {LightingState}
     */
    function sample(hour, out) {
        const h = MathUtils.wrap(hour, 24);

        // Locate the bracketing keyframes, treating the table as cyclic.
        let i0 = PARSED.length - 1;
        let i1 = 0;
        for (let i = 0; i < PARSED.length; i++) {
            const next = PARSED[(i + 1) % PARSED.length];
            const cur = PARSED[i];
            const spanEnd = next.hour > cur.hour ? next.hour : next.hour + 24;
            const hh = h >= cur.hour ? h : h + 24;
            if (hh >= cur.hour && hh < spanEnd) { i0 = i; i1 = (i + 1) % PARSED.length; break; }
        }

        const a = PARSED[i0];
        const b = PARSED[i1];
        const start = a.hour;
        const end = b.hour > a.hour ? b.hour : b.hour + 24;
        const hh = h >= start ? h : h + 24;
        // Smoothstep the blend so transitions ease rather than change linearly.
        const t = MathUtils.smoothstep(start, end, hh);

        const state = out || { sky: [] };
        state.hour = h;

        if (!state.sky || state.sky.length !== MAX_STOPS) {
            state.sky = new Array(MAX_STOPS);
            for (let i = 0; i < MAX_STOPS; i++) state.sky[i] = { p: 0, c: { r: 0, g: 0, b: 0 } };
        }
        for (let i = 0; i < MAX_STOPS; i++) {
            const sa = a.sky[i], sb = b.sky[i];
            const dst = state.sky[i];
            dst.p = MathUtils.lerp(sa.p, sb.p, t);
            dst.c.r = MathUtils.lerp(sa.c.r, sb.c.r, t);
            dst.c.g = MathUtils.lerp(sa.c.g, sb.c.g, t);
            dst.c.b = MathUtils.lerp(sa.c.b, sb.c.b, t);
        }

        state.haze = Color.mix(a.haze, b.haze, t);
        state.ambient = Color.mix(a.ambient, b.ambient, t);
        state.ambientAmount = MathUtils.lerp(a.ambientAmount, b.ambientAmount, t);
        state.exposure = MathUtils.lerp(a.exposure, b.exposure, t);
        state.sunTint = Color.mix(a.sunTint, b.sunTint, t);
        state.sunStrength = MathUtils.lerp(a.sunStrength, b.sunStrength, t);
        state.starAlpha = MathUtils.lerp(a.starAlpha, b.starAlpha, t);
        state.saturation = MathUtils.lerp(a.saturation, b.saturation, t);
        state.groundWarm = Color.mix(a.groundWarm, b.groundWarm, t);
        state.groundWarmth = MathUtils.lerp(a.groundWarmth, b.groundWarmth, t);

        /* Celestial geometry ------------------------------------------- */

        const dayLen = SUNSET - SUNRISE;
        const sunT = (h - SUNRISE) / dayLen;              // 0 at sunrise, 1 at sunset
        const sunUp = h >= SUNRISE && h <= SUNSET;
        state.sunAzimuth = MathUtils.clamp01(sunT);
        state.sunAltitude = sunUp
            ? Math.sin(sunT * Math.PI)
            : -Math.sin(MathUtils.wrap(h - SUNSET, 24) / (24 - dayLen) * Math.PI) * 0.8;

        // The moon runs the opposite arc, rising as the sun sets.
        const nightLen = 24 - dayLen;
        const moonT = MathUtils.wrap(h - SUNSET, 24) / nightLen;
        const moonUp = !sunUp;
        state.moonAzimuth = MathUtils.clamp01(moonT);
        state.moonAltitude = moonUp ? Math.sin(moonT * Math.PI) : -0.5;

        state.daylight = MathUtils.clamp01(MathUtils.smoothstep(-0.06, 0.20, state.sunAltitude));

        /* Shadow geometry ----------------------------------------------- */

        // Shadows fall away from whichever body is up, stretching as it nears the horizon.
        const bodyAz = sunUp ? state.sunAzimuth : state.moonAzimuth;
        const bodyAlt = Math.max(0.04, sunUp ? state.sunAltitude : state.moonAltitude * 0.7);
        state.shadowDir = (bodyAz - 0.5) * -2;                    // sun east → shadow west
        state.shadowLength = MathUtils.clamp(0.55 / bodyAlt, 0.9, 4.2);
        state.shadowAlpha = MathUtils.lerp(0.13, 0.34, MathUtils.clamp01(bodyAlt * 1.4)) *
            MathUtils.lerp(0.55, 1, state.daylight);

        return state;
    }

    /**
     * Build a CSS linear-gradient-equivalent canvas gradient for the current sky.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {LightingState} light
     * @param {number} top Y coordinate of the zenith.
     * @param {number} horizon Y coordinate of the horizon.
     */
    function skyGradient(ctx, light, top, horizon) {
        const grad = ctx.createLinearGradient(0, top, 0, horizon);
        for (let i = 0; i < light.sky.length; i++) {
            const s = light.sky[i];
            grad.addColorStop(MathUtils.clamp01(s.p), Color.css(s.c));
        }
        return grad;
    }

    /**
     * Apply the current lighting to a base surface colour.
     *
     * Surfaces are authored at "noon albedo" and pushed through ambient tint,
     * exposure and saturation here, so a single palette works at every hour.
     *
     * @param {{r:number,g:number,b:number}} base
     * @param {LightingState} light
     * @param {number} [warmth] Extra receptivity to warm bounce light, 0..1.
     * @returns {{r:number,g:number,b:number}}
     */
    function litColor(base, light, warmth) {
        let c = Color.tint(base, light.ambient, light.ambientAmount);
        if (warmth) {
            c = Color.mix(c, Color.tint(c, light.groundWarm, 1), light.groundWarmth * warmth);
        }
        c = Color.scale(c, light.exposure);
        if (light.saturation !== 1) {
            c = light.saturation < 1
                ? Color.desaturate(c, 1 - light.saturation)
                : saturate(c, light.saturation - 1);
        }
        return c;
    }

    /** Increase saturation by pushing components away from their luminance. */
    function saturate(c, amount) {
        const l = Color.luminance(c);
        return {
            r: MathUtils.clamp(l + (c.r - l) * (1 + amount), 0, 255),
            g: MathUtils.clamp(l + (c.g - l) * (1 + amount), 0, 255),
            b: MathUtils.clamp(l + (c.b - l) * (1 + amount), 0, 255)
        };
    }

    /**
     * Ground and terrain base palette, authored at noon albedo.
     * Distance bands let the ground shift from parched and hazy at the horizon to
     * saturated and detailed in the foreground.
     */
    const TERRAIN = {
        // The savanna is parched at distance and only greens up in the foreground;
        // that gradient is what gives the flat plane its depth.
        groundFar: '#d6c294',
        groundMid: '#c0b070',
        groundNear: '#9da456',
        groundDeep: '#7d8c42',

        dirt: '#b8925e',
        dirtDark: '#96703f',
        sand: '#ddc79a',

        grassBlade: '#9aa855',
        grassBladeDry: '#cdba6c',
        grassBladeLush: '#7a9a44',

        rock: '#a09484',
        rockLight: '#c4b8a5',
        rockDark: '#655a4c',

        // Termite earth is a distinctly redder clay than the surrounding dust.
        mound: '#a56b45',
        moundLight: '#c98d5f',
        moundDark: '#6d4227',

        trunk: '#6b5238',
        trunkLight: '#8d6d4b',
        trunkDark: '#41301f',

        // Acacia foliage is a dusty olive, not the deep green of temperate woodland.
        canopy: '#5d6b38',
        canopyLight: '#7c8a4a',
        canopyDark: '#3b4522',

        bush: '#69713d',
        bushLight: '#868c52',

        waterDeep: '#2f6b7d',
        waterShallow: '#4f97a4',
        waterEdge: '#8a9a6a',

        meat: '#b04a44',
        meatDark: '#7d2f2c',
        bone: '#e6dcc4'
    };

    Safari.Palettes = {
        SKY_KEYFRAMES,
        TERRAIN,
        SUNRISE,
        SUNSET,
        sample,
        skyGradient,
        litColor,
        saturate
    };

})(window.Safari);
