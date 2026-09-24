/**
 * Safari Simulator 3D — Shading kit.
 *
 * The small set of shared resources every surface in the reserve draws its fine detail
 * from, so the ground, the foliage, the rocks and the animals all agree on what "grain"
 * looks like and none of them ships a texture file:
 *
 *   Detail     one 256² tileable noise texture, four independent octaves in its four
 *              channels. Sampled in world space it gives the ground its mottling, the
 *              rock its streaks and the water its ripples, at whatever scale each
 *              surface wants, from one upload.
 *   Foliage    an atlas of leaf clusters painted once on a canvas. Crowns and bushes are
 *              shells of alpha-tested cards cut from it, which is what gives a tree a
 *              broken, leafy silhouette instead of the outline of the blob under it.
 *   Grass      a card of blades, for the ground cover.
 *
 * It also owns the one mechanism by which materials are extended — `patch()` — so every
 * shader edit in the project is written the same way, keyed for the program cache, and
 * shares the same live uniforms (time, wind, the detail texture) without each owner
 * threading them through by hand.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Noise } = Safari;

    /* ------------------------------------------------------------------ *
     * Shared uniforms
     * ------------------------------------------------------------------ */

    /**
     * Uniforms every patched material can see.
     *
     * Held as single objects and referenced — never copied — into each shader, so one
     * write per frame reaches every material that uses them.
     */
    const SHARED = {
        uTime: { value: 0 },
        uWind: { value: 1 },
        uDetail: { value: null }
    };

    /* ------------------------------------------------------------------ *
     * Detail noise
     * ------------------------------------------------------------------ */

    /**
     * Periodic value noise: the lattice wraps every `period` cells, so the texture tiles
     * seamlessly however it is repeated across the ground.
     */
    function periodicValue(x, y, period, salt) {
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = x - ix, fy = y - iy;
        const ux = fx * fx * (3 - 2 * fx);
        const uy = fy * fy * (3 - 2 * fy);
        const wrap = (v) => ((v % period) + period) % period;
        const h = (a, b) => Noise.hash2(wrap(a) + salt * 131, wrap(b) - salt * 71);
        const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
        return MathUtils.lerp(MathUtils.lerp(a, b, ux), MathUtils.lerp(c, d, ux), uy);
    }

    /** Tileable fBm over `periodicValue`, starting at a base period. */
    function periodicFbm(u, v, basePeriod, octaves, salt) {
        let sum = 0, amp = 0.5, norm = 0, period = basePeriod;
        for (let o = 0; o < octaves; o++) {
            sum += periodicValue(u * period, v * period, period, salt + o * 17) * amp;
            norm += amp;
            amp *= 0.5;
            period *= 2;
        }
        return sum / norm;
    }

    let _detail = null;

    /**
     * The shared detail texture.
     *
     * R  broad mottling    (4-cell base, five octaves)
     * G  medium grain      (16-cell base, four octaves)
     * B  ridged streaks    (8-cell base, folded) — rock strata, wind ripples
     * A  fine speckle      (64-cell value noise)
     */
    function detailTexture() {
        if (_detail) return _detail;
        const N = 256;
        const data = new Uint8Array(N * N * 4);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const u = x / N, v = y / N;
                const k = (y * N + x) * 4;
                const r = periodicFbm(u, v, 4, 5, 1);
                const g = periodicFbm(u, v, 16, 4, 2);
                const ridge = 1 - Math.abs(periodicFbm(u, v, 8, 4, 3) * 2 - 1);
                const a = periodicValue(u * 64, v * 64, 64, 4);
                data[k] = (MathUtils.clamp01((r - 0.5) * 1.8 + 0.5) * 255) | 0;
                data[k + 1] = (MathUtils.clamp01((g - 0.5) * 1.8 + 0.5) * 255) | 0;
                data[k + 2] = (ridge * ridge * 255) | 0;
                data[k + 3] = (a * 255) | 0;
            }
        }
        const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        // Shared across every reserve; never disposed with a scene.
        tex.userData = { shared: true };
        _detail = tex;
        SHARED.uDetail.value = tex;
        return tex;
    }

    /* ------------------------------------------------------------------ *
     * Foliage atlas
     * ------------------------------------------------------------------ */

    /**
     * Atlas layout, in UV space. Leaf clusters occupy the left three quarters as a 3x2
     * grid of sprites; the right quarter is a solid, lightly mottled swatch that the
     * opaque inner mass of a bush samples, so body and cards share one material.
     */
    const ATLAS = {
        cols: 3,
        rows: 2,
        leafWidth: 0.75,
        solid: { u0: 0.80, v0: 0.10, u1: 0.95, v1: 0.90 }
    };

    let _foliage = null;

    /** Draw one leaf: a pointed ellipse with a midrib, in the current transform. */
    function drawLeaf(ctx, len, width, shade) {
        ctx.fillStyle = shade;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(width, len * 0.45, 0, len);
        ctx.quadraticCurveTo(-width, len * 0.45, 0, 0);
        ctx.fill();
    }

    /**
     * The foliage atlas: leaf clusters painted with light from above, darker at the
     * core, so a card reads as a clump with depth rather than a flat decal.
     *
     * Colour is kept near-grey-green and bright; the per-vertex colour of each tree
     * supplies the hue, so the one atlas serves acacia, scrub and bush alike.
     */
    function foliageTexture() {
        if (_foliage) return _foliage;
        const W = 1024, H = 512;
        const canvas = Safari.Utils.createCanvas(W, H);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        const cellW = (W * ATLAS.leafWidth) / ATLAS.cols;
        const cellH = H / ATLAS.rows;
        let seed = 11;
        const rnd = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
        };

        for (let row = 0; row < ATLAS.rows; row++) {
            for (let col = 0; col < ATLAS.cols; col++) {
                const cx = col * cellW + cellW / 2;
                const cy = row * cellH + cellH / 2;
                const radius = Math.min(cellW, cellH) * 0.44;
                // Row 0: broad-leaf clumps. Row 1: fine, feathery acacia sprays.
                const fine = row === 1;
                const leaves = fine ? 260 : 150;
                for (let i = 0; i < leaves; i++) {
                    // Dense at the core, sparse at the rim: the clump thins outward.
                    const r = radius * Math.pow(rnd(), fine ? 0.62 : 0.72);
                    const a = rnd() * Math.PI * 2;
                    const x = cx + Math.cos(a) * r;
                    const y = cy + Math.sin(a) * r * 0.86;
                    // Lit from the top of the card; the core is in its own shade.
                    const lit = MathUtils.clamp01(0.55 - (y - cy) / (radius * 2.4) +
                        (r / radius) * 0.25 + (rnd() - 0.5) * 0.35);
                    const g = Math.round(120 + lit * 110);
                    const shade = 'rgb(' + Math.round(g * 0.86) + ',' + g + ',' +
                        Math.round(g * 0.62) + ')';
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(a + Math.PI / 2 + (rnd() - 0.5) * 1.2);
                    drawLeaf(ctx, fine ? radius * 0.16 : radius * 0.24,
                        fine ? radius * 0.035 : radius * 0.085, shade);
                    ctx.restore();
                }
            }
        }

        // The solid swatch, mottled so the inner mass is not one flat tone.
        const sx = W * ATLAS.solid.u0 - 12, sw = W * (ATLAS.solid.u1 - ATLAS.solid.u0) + 24;
        for (let y = 0; y < H; y += 4) {
            for (let x = sx; x < sx + sw; x += 4) {
                const n = Noise.fbm2(x * 0.05, y * 0.05, 3, 2, 0.5);
                const g = Math.round(110 + n * 90);
                ctx.fillStyle = 'rgb(' + Math.round(g * 0.86) + ',' + g + ',' +
                    Math.round(g * 0.62) + ')';
                ctx.fillRect(x, y, 4, 4);
            }
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.anisotropy = 4;
        tex.userData = { shared: true };
        // Painted in sRGB; decoded to linear on sampling so it multiplies the vertex
        // colours in the same space everything else is lit in.
        tex.encoding = THREE.sRGBEncoding;
        _foliage = tex;
        return tex;
    }

    /** UV rectangle of a leaf sprite in the atlas. */
    function leafRect(index, fine) {
        const col = index % ATLAS.cols;
        const row = fine ? 1 : 0;
        const w = ATLAS.leafWidth / ATLAS.cols;
        const h = 1 / ATLAS.rows;
        // Canvas row 0 is at the top; texture v runs bottom-up.
        return { u0: col * w, u1: (col + 1) * w, v0: 1 - (row + 1) * h, v1: 1 - row * h };
    }

    /* ------------------------------------------------------------------ *
     * Grass card
     * ------------------------------------------------------------------ */

    let _grass = null;

    /**
     * A card of grass blades: tall tapered strokes, bases dark and tips bleached, with a
     * few seed heads. The instance colour tints it, so lush and dry grass share it.
     */
    function grassTexture() {
        if (_grass) return _grass;
        const W = 256, H = 256;
        const canvas = Safari.Utils.createCanvas(W, H);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        let seed = 5;
        const rnd = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
        };

        const blades = 46;
        for (let i = 0; i < blades; i++) {
            const bx = W * (0.08 + rnd() * 0.84);
            const height = H * (0.45 + rnd() * 0.52);
            const lean = (rnd() - 0.5) * W * 0.34;
            const width = 3 + rnd() * 4;
            const grad = ctx.createLinearGradient(0, H, 0, H - height);
            const base = Math.round(95 + rnd() * 30);
            grad.addColorStop(0, 'rgb(' + (base - 30) + ',' + (base - 10) + ',' + (base - 50) + ')');
            grad.addColorStop(0.6, 'rgb(' + (base + 60) + ',' + (base + 80) + ',' + (base + 10) + ')');
            grad.addColorStop(1, 'rgb(' + (base + 110) + ',' + (base + 115) + ',' + (base + 60) + ')');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(bx - width, H);
            ctx.quadraticCurveTo(bx + lean * 0.3, H - height * 0.55, bx + lean, H - height);
            ctx.quadraticCurveTo(bx + lean * 0.3 + width * 0.3, H - height * 0.5, bx + width, H);
            ctx.closePath();
            ctx.fill();

            // An occasional seed head, which is what makes savanna grass read as grass
            // rather than as lawn.
            if (rnd() < 0.3) {
                ctx.fillStyle = 'rgb(236,222,170)';
                for (let s = 0; s < 6; s++) {
                    ctx.beginPath();
                    ctx.ellipse(bx + lean + (rnd() - 0.5) * 6, H - height + s * 5 + 2,
                        2.2, 4, lean * 0.004, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.anisotropy = 4;
        tex.encoding = THREE.sRGBEncoding;
        tex.userData = { shared: true };
        _grass = tex;
        return tex;
    }

    /* ------------------------------------------------------------------ *
     * GLSL
     * ------------------------------------------------------------------ */

    /** Declarations every patched shader receives. */
    const GLSL_COMMON = [
        'uniform float uTime;',
        'uniform float uWind;',
        'uniform sampler2D uDetail;',
        // Detail noise at a world-space position and scale, all four channels.
        'vec4 detailAt(vec2 p) { return texture2D(uDetail, p); }',
        // Cheap 3D hash for cellular patterns.
        'vec3 hash33(vec3 p) {',
        '  p = fract(p * vec3(0.1031, 0.1030, 0.0973));',
        '  p += dot(p, p.yxz + 33.33);',
        '  return fract((p.xxy + p.yxx) * p.zyx);',
        '}',
        // Cellular noise: returns (F1, F2).
        'vec2 cellular3(vec3 p) {',
        '  vec3 i = floor(p); vec3 f = fract(p);',
        '  float d1 = 8.0, d2 = 8.0;',
        '  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {',
        '    vec3 g = vec3(float(x), float(y), float(z));',
        '    vec3 o = hash33(i + g);',
        '    vec3 r = g + o - f;',
        '    float d = dot(r, r);',
        '    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }',
        '  }',
        '  return sqrt(vec2(d1, d2));',
        '}'
    ].join('\n');

    /* ------------------------------------------------------------------ *
     * Material patching
     * ------------------------------------------------------------------ */

    /**
     * Extend a built-in material's shaders.
     *
     * Every edit is a list of `[anchor, replacement]` pairs against Three's own
     * `#include` anchors, so a material stays a Three material — lights, shadows, fog,
     * skinning and instancing all keep working — and only the named steps change.
     *
     * @param {THREE.Material} mat
     * @param {string} key Program cache key. Two materials with the same key must have
     *   the same patch, or one will silently draw with the other's shader.
     * @param {object} spec
     * @param {object} [spec.uniforms] Extra uniforms, held by reference.
     * @param {string} [spec.vertexHead] Declarations for the vertex shader.
     * @param {Array<Array<string>>} [spec.vertex] Replacements in the vertex shader.
     * @param {string} [spec.fragmentHead]
     * @param {Array<Array<string>>} [spec.fragment]
     */
    function patch(mat, key, spec) {
        const uniforms = Object.assign({}, SHARED, spec.uniforms || {});
        mat.userData.uniforms = uniforms;
        detailTexture();

        mat.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, uniforms);
            let vs = shader.vertexShader;
            let fs = shader.fragmentShader;
            for (const [anchor, text] of spec.vertex || []) {
                if (vs.indexOf(anchor) < 0) throw new Error('Shading3D.patch(' + key + '): no ' + anchor);
                vs = vs.replace(anchor, text);
            }
            for (const [anchor, text] of spec.fragment || []) {
                if (fs.indexOf(anchor) < 0) throw new Error('Shading3D.patch(' + key + '): no ' + anchor);
                fs = fs.replace(anchor, text);
            }
            shader.vertexShader = GLSL_COMMON + '\n' + (spec.vertexHead || '') + '\n' + vs;
            shader.fragmentShader = GLSL_COMMON + '\n' + (spec.fragmentHead || '') + '\n' + fs;
        };
        mat.customProgramCacheKey = () => 'safari-' + key;
        return mat;
    }

    /**
     * Advance the shared clock and wind. Called once per frame by the scene.
     * @param {number} dt Real seconds.
     * @param {number} wind 0..~2 from the weather.
     */
    function tick(dt, wind) {
        SHARED.uTime.value += dt;
        SHARED.uWind.value = wind;
    }

    Safari.Shading3D = {
        SHARED,
        ATLAS,
        detailTexture,
        foliageTexture,
        grassTexture,
        leafRect,
        patch,
        tick,
        GLSL_COMMON
    };

})(window.Safari, window.THREE);
