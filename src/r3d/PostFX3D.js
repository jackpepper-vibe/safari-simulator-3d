/**
 * Safari Simulator 3D — Post-processing.
 *
 * The reserve is rendered into a multisampled half-float target and finished in one
 * full-screen pass: exposure, a filmic tone curve, a colour grade driven by the hour,
 * a vignette, and dithering. Doing that here rather than per material is what lets the
 * lighting carry more range than the screen can show — a noon sun on pale sand and the
 * shade under an acacia in the same frame — and roll it off gracefully instead of
 * clipping to flat white.
 *
 * It is also the single place the look of the game is set. The grade reads the same
 * `LightingState` as everything else, so dawn is cool in the shadows and warm in the
 * light, and noon is neutral, without a single material knowing about it.
 *
 * Where the device cannot render to a half-float target, the pass is skipped and the
 * renderer falls back to drawing straight to the screen with Three's own tone mapping,
 * which is how the game drew before this existed.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils } = Safari;

    const VERTEX = [
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  gl_Position = vec4(position.xy, 0.0, 1.0);',
        '}'
    ].join('\n');

    const FRAGMENT = [
        'uniform sampler2D tColor;',
        'uniform float uExposure;',
        'uniform vec3 uShadowTint;',
        'uniform vec3 uLightTint;',
        'uniform float uSaturation;',
        'uniform float uContrast;',
        'uniform float uVignette;',
        'uniform vec2 uResolution;',
        'varying vec2 vUv;',

        // Filmic curve (Narkowicz ACES fit), rescaled so a mid-grey albedo in full sun
        // lands where the old linear pipeline put it. The shoulder is the point: bright
        // sand keeps its texture instead of clipping.
        'vec3 filmic(vec3 x) {',
        '  x *= 0.86;',
        '  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);',
        '}',

        'float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',

        // Interleaved gradient noise: breaks up banding in the sky and the haze.
        'float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }',

        'void main() {',
        '  vec3 c = texture2D(tColor, vUv).rgb * uExposure;',
        '  c = filmic(c);',

        // Split-tone: shadows lean toward the sky's ambient, light toward the sun.
        '  float l = luma(c);',
        '  vec3 shadowSide = mix(vec3(1.0), uShadowTint, (1.0 - smoothstep(0.0, 0.55, l)) * 0.35);',
        '  vec3 lightSide = mix(vec3(1.0), uLightTint, smoothstep(0.35, 1.0, l) * 0.22);',
        '  c *= shadowSide * lightSide;',

        // Contrast around mid-grey, in display space, then saturation.
        '  c = pow(c, vec3(1.0 / 2.2));',
        '  c = (c - 0.5) * uContrast + 0.5;',
        '  c = mix(vec3(luma(c)), c, uSaturation);',

        // Vignette: gentle, and oval to the screen, so the eye settles on the middle.
        '  vec2 d = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);',
        '  c *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(d));',

        '  c += (ign(gl_FragCoord.xy) - 0.5) / 255.0;',
        '  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);',
        '}'
    ].join('\n');

    const _c = new THREE.Color();

    /**
     * Dynamic resolution.
     *
     * The reserve is drawn into the target at a fraction of the screen's resolution
     * when the device cannot keep up, and the pass scales it back to full size. The
     * governor watches the real frame time and steps the fraction down when frames run
     * long and back up when there is room — so a laptop's integrated graphics holds a
     * steady frame rate and a desktop card draws every pixel.
     */
    const SCALE = {
        min: 0.6,
        max: 1,
        step: 0.1,
        /** Seconds between decisions, so one slow frame does not trigger a change. */
        interval: 1.25,
        /** Average frame time, in ms, above which resolution drops. */
        slow: 21,
        /** ...and below which it may rise again. */
        fast: 17.8
    };

    class PostFX3D {
        /** @param {THREE.WebGLRenderer} renderer */
        constructor(renderer) {
            this.renderer = renderer;
            this.enabled = Safari.R3D.QUALITY.post && PostFX3D.supported(renderer);
            this.width = 1;
            this.height = 1;

            /** Current fraction of full resolution the scene is drawn at. */
            this.scale = 1;
            /**
             * Highest fraction the governor may return to. Lowered each time a rise
             * immediately had to be undone, so the resolution settles instead of
             * oscillating between a speed the device can hold and one it cannot.
             */
            this.ceiling = SCALE.max;
            this._frameMs = 16.7;
            this._timer = 0;
            this._rose = false;
            this._cssWidth = 1;
            this._cssHeight = 1;
            this._dpr = 1;

            if (!this.enabled) {
                renderer.toneMapping = THREE.LinearToneMapping;
                return;
            }

            // Materials write linear, unmapped light; the pass below does the rest.
            renderer.toneMapping = THREE.NoToneMapping;

            const Target = renderer.capabilities.isWebGL2
                ? THREE.WebGLMultisampleRenderTarget
                : THREE.WebGLRenderTarget;
            this.target = new Target(1, 1, {
                format: THREE.RGBAFormat,
                type: THREE.HalfFloatType,
                encoding: THREE.LinearEncoding,
                depthBuffer: true,
                stencilBuffer: false
            });
            if (this.target.samples !== undefined) this.target.samples = 4;

            this.material = new THREE.ShaderMaterial({
                vertexShader: VERTEX,
                fragmentShader: FRAGMENT,
                depthTest: false,
                depthWrite: false,
                uniforms: {
                    tColor: { value: this.target.texture },
                    uExposure: { value: 1 },
                    uShadowTint: { value: new THREE.Color(1, 1, 1) },
                    uLightTint: { value: new THREE.Color(1, 1, 1) },
                    uSaturation: { value: 1.06 },
                    uContrast: { value: 1.04 },
                    uVignette: { value: 0.22 },
                    uResolution: { value: new THREE.Vector2(1, 1) }
                }
            });
            this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
            this.quad.frustumCulled = false;
            this.quadScene = new THREE.Scene();
            this.quadScene.add(this.quad);
            this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        }

        /**
         * Can this device render the scene into a half-float target?
         *
         * WebGL 2 needs `EXT_color_buffer_float` to render to float formats at all;
         * WebGL 1 needs the half-float texture and colour-buffer extensions. Anything
         * less and the pass is skipped rather than drawing a black screen.
         */
        static supported(renderer) {
            const ext = renderer.extensions;
            if (renderer.capabilities.isWebGL2) return !!ext.get('EXT_color_buffer_float');
            return !!ext.get('OES_texture_half_float') && !!ext.get('EXT_color_buffer_half_float');
        }

        /** Match the render target to the drawing buffer, at the current scale. */
        setSize(width, height, dpr) {
            this._cssWidth = width;
            this._cssHeight = height;
            this._dpr = dpr;
            this.width = Math.max(1, Math.floor(width * dpr * this.scale));
            this.height = Math.max(1, Math.floor(height * dpr * this.scale));
            if (!this.enabled) return;
            /*
             * Fewer samples on a very large target. Four-times multisampling of a
             * half-float target at a 4K-class resolution is several hundred megabytes;
             * two samples there still smooth the edges, at half the memory.
             */
            if (this.target.samples !== undefined) {
                const samples = this.width * this.height > 2.2e6 ? 2 : 4;
                if (samples !== this.target.samples) {
                    this.target.samples = samples;
                    this.target.dispose();
                }
            }
            this.target.setSize(this.width, this.height);
            this.material.uniforms.uResolution.value.set(this.width, this.height);
        }

        /**
         * Feed the governor one real frame time.
         * @param {number} dt Seconds since the previous frame.
         */
        adapt(dt) {
            if (!this.enabled || !(dt > 0) || dt > 0.25) return;
            this._frameMs = MathUtils.lerp(this._frameMs, dt * 1000, 0.08);
            this._timer += dt;
            if (this._timer < SCALE.interval) return;
            this._timer = 0;

            let next = this.scale;
            if (this._frameMs > SCALE.slow && this.scale > SCALE.min) {
                next = Math.max(SCALE.min, this.scale - SCALE.step);
                // A rise that could not be held caps the ceiling below it.
                if (this._rose) this.ceiling = Math.max(SCALE.min, this.scale - SCALE.step);
                this._rose = false;
            } else if (this._frameMs < SCALE.fast && this.scale < this.ceiling) {
                next = Math.min(this.ceiling, this.scale + SCALE.step);
                this._rose = true;
            } else {
                this._rose = false;
            }
            if (Math.abs(next - this.scale) > 1e-3) {
                this.scale = Math.round(next * 100) / 100;
                this.setSize(this._cssWidth, this._cssHeight, this._dpr);
            }
        }

        /**
         * Grade from the hour's lighting.
         *
         * The shadow tint is the sky's own ambient and the light tint is the sun's, both
         * pulled toward white so the grade seasons the frame rather than recolouring it.
         *
         * @param {object} light The sampled `LightingState`.
         */
        grade(light) {
            if (!this.enabled) {
                this.renderer.toneMappingExposure = light.exposure;
                return;
            }
            const u = this.material.uniforms;
            u.uExposure.value = light.exposure * 1.08;

            const amb = light.ambient || light.haze;
            _c.setRGB(amb.r / 255, amb.g / 255, amb.b / 255);
            u.uShadowTint.value.copy(_c).lerp(PostFX3D.WHITE, 0.25);

            const sun = light.sunTint;
            _c.setRGB(sun.r / 255, sun.g / 255, sun.b / 255);
            u.uLightTint.value.copy(_c).lerp(PostFX3D.WHITE, 0.2);

            // Night flattens toward a moonlit blue-grey; the day carries full colour.
            u.uSaturation.value = MathUtils.lerp(0.74, 0.94, MathUtils.clamp01(light.daylight));
        }

        /**
         * Draw the scene through the pass, or straight to the screen as a fallback.
         * @param {THREE.Scene} scene
         * @param {THREE.Camera} camera
         */
        render(scene, camera) {
            const r = this.renderer;
            if (!this.enabled) {
                r.setRenderTarget(null);
                r.render(scene, camera);
                return;
            }
            r.setRenderTarget(this.target);
            r.render(scene, camera);
            r.setRenderTarget(null);
            r.render(this.quadScene, this.quadCamera);
        }
    }

    PostFX3D.WHITE = new THREE.Color(1, 1, 1);
    Safari.PostFX3D = PostFX3D;

})(window.Safari, window.THREE);
