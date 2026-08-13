/**
 * Safari Simulator 3D — Sky and light.
 *
 * One interpolated `LightingState` still lights everything, exactly as in the 2D build:
 * sky gradient, haze, exposure, sun colour, star opacity and shadow geometry all come
 * from the same sampled state, so nothing in the reserve can disagree about the time of
 * day. What changed is what consumes it — a dome, a key light and a shadow camera
 * rather than a canvas gradient and a hand-drawn shadow ellipse.
 *
 * The key light follows whichever body is up. The 2D build derived `shadowDir` and
 * `shadowLength` from the sun by day and the moon by night; here that same rule places
 * a single directional light, which is why moonlight rakes the opposite way to the
 * afternoon sun without anything special being written for night.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, Config, R3D } = Safari;

    /** Radius of the dome. Well outside the far plane of anything else. */
    const DOME = 420;

    const _dir = new THREE.Vector3();
    const _c = new THREE.Color();
    const WHITE = new THREE.Color(1, 1, 1);

    /* ------------------------------------------------------------------ *
     * Textures
     * ------------------------------------------------------------------ */

    /** A soft round blob, used for stars, the sun disc and cloud sprites. */
    function blobTexture(hardness) {
        const size = 64;
        const canvas = Safari.Utils.createCanvas(size, size);
        const ctx = canvas.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(hardness, 'rgba(255,255,255,0.85)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        const tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;
        return tex;
    }

    /* ------------------------------------------------------------------ *
     * Sky
     * ------------------------------------------------------------------ */

    class Sky3D {
        /**
         * @param {THREE.Scene} scene
         * @param {number} worldTiles
         * @param {Safari.Rng} rng
         */
        constructor(scene, worldTiles, rng) {
            this.scene = scene;
            this.worldTiles = worldTiles;

            this._buildDome();
            this._buildStars(rng);
            this._buildBodies();
            this._buildClouds(rng);
            this._buildLights();

            this.scene.fog = new THREE.Fog(0xbcd0d8, 60, 340);
        }

        /* -------------------------------------------------------------- *
         * Dome
         * -------------------------------------------------------------- */

        /**
         * The sky gradient, as a shader over an inverted sphere.
         *
         * The keyframes hold up to five stops from zenith to horizon; they are handed
         * straight to the shader as uniforms and interpolated there, so the dome is the
         * same gradient the 2D build painted across the top of the screen.
         */
        _buildDome() {
            const colors = [];
            const stops = [];
            for (let i = 0; i < 5; i++) {
                colors.push(new THREE.Color(0.1, 0.2, 0.4));
                stops.push(i / 4);
            }

            this.domeMaterial = new THREE.ShaderMaterial({
                side: THREE.BackSide,
                depthWrite: false,
                fog: false,
                uniforms: {
                    uColors: { value: colors },
                    uStops: { value: stops },
                    uHaze: { value: new THREE.Color(0.8, 0.8, 0.8) }
                },
                vertexShader: [
                    'varying vec3 vDir;',
                    'void main() {',
                    '  vDir = normalize(position);',
                    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
                    '}'
                ].join('\n'),
                fragmentShader: [
                    'uniform vec3 uColors[5];',
                    'uniform float uStops[5];',
                    'uniform vec3 uHaze;',
                    'varying vec3 vDir;',
                    'void main() {',
                    // p runs 0 at the zenith to 1 at the horizon, matching the keyframes.
                    '  float p = clamp(1.0 - clamp(vDir.y, 0.0, 1.0), 0.0, 1.0);',
                    '  vec3 c = uColors[0];',
                    '  for (int i = 0; i < 4; i++) {',
                    '    float t = smoothstep(uStops[i], uStops[i + 1], p);',
                    '    c = mix(c, uColors[i + 1], t);',
                    '  }',
                    // Below the horizon the dome fades into the haze band, so a low
                    // camera sees atmosphere rather than a hard edge under the terrain.
                    '  float below = smoothstep(0.0, -0.18, vDir.y);',
                    '  c = mix(c, uHaze, below);',
                    '  gl_FragColor = vec4(c, 1.0);',
                    /*
                     * Colour management, by hand.
                     *
                     * Three inserts these into its own materials but not into a custom
                     * shader, so a hand-written one writes linear values straight into
                     * an sRGB framebuffer. The sky is the largest surface in the frame
                     * and the mistake reads as dusk at three in the afternoon.
                     */
                    '#include <tonemapping_fragment>',
                    '#include <encodings_fragment>',
                    '}'
                ].join('\n')
            });

            this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME, 24, 16), this.domeMaterial);
            this.dome.renderOrder = -100;
            this.dome.frustumCulled = false;
            this.scene.add(this.dome);
        }

        /* -------------------------------------------------------------- *
         * Stars, sun and moon
         * -------------------------------------------------------------- */

        _buildStars(rng) {
            const count = Config.render.starCount;
            const pos = new Float32Array(count * 3);
            const sizes = new Float32Array(count);

            for (let i = 0; i < count; i++) {
                // Upper hemisphere only, biased away from the horizon where haze eats them.
                const u = rng.range(-1, 1);
                const theta = rng.range(0, MathUtils.TAU);
                const r = Math.sqrt(Math.max(0, 1 - u * u));
                const y = Math.abs(u) * 0.92 + 0.08;
                pos[i * 3] = Math.cos(theta) * r * DOME * 0.92;
                pos[i * 3 + 1] = y * DOME * 0.92;
                pos[i * 3 + 2] = Math.sin(theta) * r * DOME * 0.92;
                sizes[i] = rng.range(1.4, 4.2);
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

            this.starMaterial = new THREE.PointsMaterial({
                size: 2.4,
                sizeAttenuation: false,
                map: blobTexture(0.25),
                transparent: true,
                depthWrite: false,
                fog: false,
                opacity: 0,
                color: 0xffffff
            });

            this.stars = new THREE.Points(geo, this.starMaterial);
            this.stars.renderOrder = -99;
            this.stars.frustumCulled = false;
            this.scene.add(this.stars);
        }

        _buildBodies() {
            const disc = blobTexture(0.55);

            this.sunMaterial = new THREE.SpriteMaterial({
                map: disc, transparent: true, depthWrite: false, fog: false,
                blending: THREE.AdditiveBlending, color: 0xffe8b0
            });
            this.sun = new THREE.Sprite(this.sunMaterial);
            this.sun.scale.set(46, 46, 1);
            this.sun.renderOrder = -98;
            this.sun.frustumCulled = false;
            this.scene.add(this.sun);

            this.moonMaterial = new THREE.SpriteMaterial({
                map: disc, transparent: true, depthWrite: false, fog: false,
                color: 0xdfe6f6
            });
            this.moon = new THREE.Sprite(this.moonMaterial);
            this.moon.scale.set(22, 22, 1);
            this.moon.renderOrder = -98;
            this.moon.frustumCulled = false;
            this.scene.add(this.moon);
        }

        /**
         * A handful of drifting cloud sprites.
         *
         * Flat billboards rather than volumes: at the altitude they sit and the angles
         * the camera reaches, the difference is invisible and the cost is not.
         */
        _buildClouds(rng) {
            const tex = blobTexture(0.35);
            this.cloudMaterial = new THREE.SpriteMaterial({
                map: tex, transparent: true, depthWrite: false, fog: false,
                opacity: 0.5, color: 0xffffff
            });

            this.clouds = [];
            const n = this.worldTiles;
            for (let i = 0; i < Config.render.cloudCount; i++) {
                const s = new THREE.Sprite(this.cloudMaterial);
                const w = rng.range(45, 110);
                s.scale.set(w, w * rng.range(0.28, 0.46), 1);
                s.position.set(
                    rng.range(-n, n * 2),
                    rng.range(48, 78),
                    rng.range(-n, n * 2));
                s.renderOrder = -97;
                this.clouds.push(s);
                this.scene.add(s);
            }
        }

        /* -------------------------------------------------------------- *
         * Lights
         * -------------------------------------------------------------- */

        _buildLights() {
            /*
             * One key light, following whichever body is up.
             *
             * The 2D build's shadow geometry came from the sun by day and the moon by
             * night, from a single rule. Keeping that rule here means night is lit and
             * shadowed by the moon without a line of special handling, and the whole
             * day cycle is one light moving.
             */
            this.key = new THREE.DirectionalLight(0xffffff, 1);
            this.key.castShadow = true;
            this.key.shadow.mapSize.set(2048, 2048);
            this.key.shadow.camera.near = 1;
            this.key.shadow.camera.far = 220;
            this.key.shadow.bias = -0.0012;
            this.key.shadow.normalBias = 0.03;
            this._setShadowExtent(38);
            this.scene.add(this.key);
            this.scene.add(this.key.target);

            /** Sky and bounced ground light. */
            this.ambient = new THREE.HemisphereLight(0x9fc4e8, 0x6b5f3e, 0.7);
            this.scene.add(this.ambient);
        }

        _setShadowExtent(half) {
            const c = this.key.shadow.camera;
            c.left = -half;
            c.right = half;
            c.top = half;
            c.bottom = -half;
            c.updateProjectionMatrix();
        }

        /* -------------------------------------------------------------- *
         * Frame
         * -------------------------------------------------------------- */

        /**
         * @param {object} light The sampled `LightingState`.
         * @param {Safari.CameraRig} rig
         * @param {number} dt
         * @param {number} wind
         */
        /**
         * Keep the dome and the stars centred on the camera.
         *
         * Split out of `update` because they are the one part of the sky that must be
         * right at *draw* time rather than at step time — the test hook moves the camera
         * between the two, and so does anything that renders without stepping.
         */
        follow(rig) {
            this.dome.position.copy(rig.camera.position);
            this.stars.position.copy(rig.camera.position);
        }

        update(light, rig, dt, wind) {
            const cam = rig.camera;

            // The dome, the stars and the bodies ride with the camera; they are
            // directions, not places.
            this.follow(rig);

            /* --- Gradient ------------------------------------------------ */
            const u = this.domeMaterial.uniforms;
            for (let i = 0; i < 5; i++) {
                const stop = light.sky[Math.min(i, light.sky.length - 1)];
                u.uColors.value[i].setRGB(stop.c.r / 255, stop.c.g / 255, stop.c.b / 255)
                    .convertSRGBToLinear();
                u.uStops.value[i] = stop.p;
            }
            u.uHaze.value.setRGB(light.haze.r / 255, light.haze.g / 255, light.haze.b / 255)
                .convertSRGBToLinear();

            /* --- Fog ----------------------------------------------------- */
            // The haze band the 2D build drew at the horizon is the fog colour here, so
            // distance still washes out toward the same tone at every hour.
            /*
             * Fog closes in far enough to swallow the boundary.
             *
             * The reserve is 86 tiles square and its edge is a cliff into nothing; from
             * a low camera that edge draws a hard line across the sky. Pulling the far
             * plane inside the map diagonal turns the boundary into distance, which is
             * what the 2D build's horizon haze was doing by other means.
             */
            this.scene.fog.color.copy(u.uHaze.value);
            this.scene.fog.near = 22 + rig.dist * 0.9;
            this.scene.fog.far = 105 + rig.dist * 2.8;

            /* --- Celestial geometry --------------------------------------- */
            this._bodyDirection(light.sunAzimuth, light.sunAltitude, _dir);
            this.sun.position.copy(cam.position).addScaledVector(_dir, DOME * 0.86);
            this.sunMaterial.opacity = MathUtils.clamp01(light.sunAltitude * 3 + 0.15);
            _c.setRGB(light.sunTint.r / 255, light.sunTint.g / 255, light.sunTint.b / 255);
            this.sunMaterial.color.copy(_c);
            this.sun.visible = light.sunAltitude > -0.12;

            this._bodyDirection(light.moonAzimuth, light.moonAltitude, _dir);
            this.moon.position.copy(cam.position).addScaledVector(_dir, DOME * 0.86);
            this.moon.visible = light.moonAltitude > -0.05;
            this.moonMaterial.opacity = MathUtils.clamp01(light.moonAltitude * 2.5) *
                MathUtils.clamp01(1 - light.daylight * 1.4);

            this.starMaterial.opacity = light.starAlpha;
            this.stars.visible = light.starAlpha > 0.01;

            /* --- Key light ------------------------------------------------ */
            const sunUp = light.sunAltitude > 0;
            this._bodyDirection(
                sunUp ? light.sunAzimuth : light.moonAzimuth,
                Math.max(0.10, sunUp ? light.sunAltitude : light.moonAltitude * 0.8),
                _dir);

            // The light is placed relative to the focus, not the world origin, so the
            // shadow camera always has the ground the player is looking at inside it.
            const fx = rig.focusX, fz = rig.focusY, fy = rig.focusH;
            this.key.position.set(fx + _dir.x * 90, fy + _dir.y * 90, fz + _dir.z * 90);
            this.key.target.position.set(fx, fy, fz);
            this.key.target.updateMatrixWorld();

            _c.setRGB(light.sunTint.r / 255, light.sunTint.g / 255, light.sunTint.b / 255)
                .convertSRGBToLinear();
            this.key.color.copy(_c);
            this.key.intensity = 0.30 + light.sunStrength * 1.05;

            // Shadows tighten around the player as they zoom in, so a close look at a
            // herd gets crisp shadows and a wide view still has them everywhere.
            this._setShadowExtent(MathUtils.clamp(rig.dist * 1.15, 16, 90));

            /* --- Ambient -------------------------------------------------- */
            const horizon = light.sky[light.sky.length - 1].c;
            this.ambient.color.setRGB(horizon.r / 255, horizon.g / 255, horizon.b / 255)
                .convertSRGBToLinear();
            this.ambient.groundColor
                .setRGB(light.groundWarm.r / 255, light.groundWarm.g / 255,
                    light.groundWarm.b / 255)
                .convertSRGBToLinear();
            this.ambient.intensity = 0.35 + light.ambientAmount * 0.55;

            /* --- Clouds ---------------------------------------------------- */
            const drift = (0.5 + wind * 1.4) * dt;
            const span = this.worldTiles * 2;
            for (const c of this.clouds) {
                c.position.x += drift;
                if (c.position.x > this.worldTiles * 2) c.position.x -= span * 1.5;
            }
            _c.setRGB(light.haze.r / 255, light.haze.g / 255, light.haze.b / 255);
            this.cloudMaterial.color.copy(_c).lerp(WHITE, 0.35);
            this.cloudMaterial.opacity = 0.16 + light.daylight * 0.30;
        }

        /**
         * A body's direction in the sky.
         *
         * Azimuth runs 0 at rise to 1 at set; the arc is tilted so the sun passes to one
         * side of the zenith rather than straight overhead, which is what gives the
         * reserve modelling light instead of flat noon lighting for most of the day.
         */
        _bodyDirection(azimuth, altitude, out) {
            const a = (azimuth - 0.5) * Math.PI * 1.02;
            const theta = MathUtils.clamp(altitude, -0.25, 1) * Math.PI * 0.48;
            const ct = Math.cos(theta);
            return out.set(-Math.sin(a) * ct, Math.sin(theta), ct * 0.42 + 0.12).normalize();
        }
    }

    Safari.Sky3D = Sky3D;

})(window.Safari, window.THREE);
