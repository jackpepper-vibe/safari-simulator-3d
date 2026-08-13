/**
 * Safari Simulator 3D — Camera.
 *
 * A free orbit around a focus point that slides along the ground. Yaw, pitch and
 * distance are all live, because a wildlife reserve is a thing you want to walk around:
 * the herd you are watching should be viewable from the other side, and a giraffe is
 * worth seeing against the sky rather than always from the same three-quarter rake.
 *
 * The 2D build kept its camera in projected screen space and converted through `Iso`.
 * Here the focus is held in **tile coordinates** — the same space the simulation
 * thinks in — and everything else is derived, so nothing needs a projection function.
 */
(function (Safari, THREE) {
    'use strict';

    const { MathUtils, R3D } = Safari;

    /** Dolly limits, in world units from the focus. */
    const MIN_DIST = 3.2;
    const MAX_DIST = 150;

    /** Pitch limits. Level with the ground is useless; straight down loses the relief. */
    const MIN_PITCH = 0.16;
    const MAX_PITCH = 1.40;

    const _v = new THREE.Vector3();
    const _ray = new THREE.Raycaster();
    const _ndc = new THREE.Vector2();

    class CameraRig {
        constructor(worldTiles) {
            this.worldTiles = worldTiles;

            this.camera = new THREE.PerspectiveCamera(48, 1, 0.35, 900);

            /** Focus point, in tile coordinates, and its ground height in world units. */
            this.focusX = worldTiles / 2;
            this.focusY = worldTiles / 2;
            this.focusH = 0;

            this.targetX = this.focusX;
            this.targetY = this.focusY;

            /** Yaw 0 looks north — down −Z, the same orientation as the reserve map. */
            this.yaw = 0;
            this.pitch = 0.72;
            this.dist = 34;

            this.targetYaw = this.yaw;
            this.targetPitch = this.pitch;
            this.targetDist = this.dist;

            /** Keyboard pan input, −1..1 per axis. */
            this.panX = 0;
            this.panY = 0;

            /** True while a drag is in progress, which suppresses easing. */
            this.dragging = false;

            /** An entity the camera trails, or null. */
            this.followTarget = null;

            this.viewWidth = 1;
            this.viewHeight = 1;
        }

        setViewport(width, height) {
            this.viewWidth = width;
            this.viewHeight = height;
            this.camera.aspect = width / Math.max(1, height);
            this.camera.updateProjectionMatrix();
        }

        /* -------------------------------------------------------------- *
         * Movement
         * -------------------------------------------------------------- */

        /**
         * Drag the ground under the pointer.
         *
         * Scaled by distance so a drag moves roughly the same amount of ground
         * regardless of zoom, and rotated by yaw so dragging right always sends the
         * reserve right whichever way the camera is facing.
         */
        panByScreen(dx, dy) {
            const scale = this.dist * 1.8 / Math.max(1, this.viewHeight);
            // Screen right and screen "into the distance", projected onto the ground.
            const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
            const ex = -dx * scale, ez = -dy * scale / Math.max(0.30, Math.sin(this.pitch));

            this.targetX += ex * cy + ez * sy;
            this.targetY += -ex * sy + ez * cy;
            this.followTarget = null;
            this.clamp();
        }

        /** Orbit the focus. */
        orbitByScreen(dx, dy) {
            this.targetYaw += dx * 0.007;
            this.targetPitch = MathUtils.clamp(
                this.targetPitch - dy * 0.005, MIN_PITCH, MAX_PITCH);
        }

        /** Dolly in or out. `factor` above 1 moves closer. */
        zoomBy(factor) {
            this.targetDist = MathUtils.clamp(this.targetDist / factor, MIN_DIST, MAX_DIST);
        }

        /**
         * Dolly toward whatever is under the pointer.
         *
         * Zooming to the middle of the screen means the thing you are actually looking
         * at drifts away as you close on it, which is the difference between a camera
         * that feels aimed and one that feels shoved.
         */
        zoomAt(screenX, screenY, factor, world) {
            const before = this.screenToTile(screenX, screenY, world, {});
            this.zoomBy(factor);
            if (!before.hit) return;

            // Ease the focus toward the point under the cursor, proportionally to how
            // far the dolly moved. Full correction fights the drag; none feels loose.
            const k = MathUtils.clamp01(Math.abs(1 - 1 / factor) * 1.15);
            this.targetX += (before.x - this.targetX) * k;
            this.targetY += (before.y - this.targetY) * k;
            this.followTarget = null;
            this.clamp();
        }

        /** Centre on a tile immediately. */
        snapToTile(tx, ty, dist) {
            this.targetX = this.focusX = tx;
            this.targetY = this.focusY = ty;
            if (dist !== undefined) this.targetDist = this.dist = dist;
            this.followTarget = null;
            this.clamp();
            this.focusX = this.targetX;
            this.focusY = this.targetY;
        }

        /** Trail an entity with an `x`/`y` in tile space. */
        follow(target) {
            this.followTarget = target || null;
        }

        clamp() {
            const n = this.worldTiles;
            // The focus may leave the reserve slightly, so the boundary fence is
            // reachable rather than always at the edge of the screen.
            const slack = 6;
            this.targetX = MathUtils.clamp(this.targetX, -slack, n + slack);
            this.targetY = MathUtils.clamp(this.targetY, -slack, n + slack);
        }

        /* -------------------------------------------------------------- *
         * Frame
         * -------------------------------------------------------------- */

        update(dt, world) {
            if (this.followTarget) {
                if (this.followTarget.alive === false) {
                    this.followTarget = null;
                } else {
                    this.targetX = this.followTarget.x;
                    this.targetY = this.followTarget.y;
                }
            }

            if (this.panX || this.panY) {
                const len = Math.hypot(this.panX, this.panY) || 1;
                // Pan speed follows the dolly: close in, small steps; zoomed out, strides.
                const speed = (2.2 + this.dist * 0.55) * dt;
                const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
                const ex = (this.panX / len) * speed;
                const ez = (this.panY / len) * speed;
                this.targetX += ex * cy + ez * sy;
                this.targetY += -ex * sy + ez * cy;
                this.followTarget = null;
                this.clamp();
            }

            const lambda = this.dragging ? 40 : 12;
            this.focusX = MathUtils.damp(this.focusX, this.targetX, lambda, dt);
            this.focusY = MathUtils.damp(this.focusY, this.targetY, lambda, dt);
            this.yaw = MathUtils.damp(this.yaw, this.targetYaw, 14, dt);
            this.pitch = MathUtils.damp(this.pitch, this.targetPitch, 14, dt);
            this.dist = MathUtils.damp(this.dist, this.targetDist, 11, dt);

            // The focus rides the terrain, so panning onto a plateau lifts the whole
            // view with it instead of burying the camera in the hillside.
            const h = world ? R3D.groundY(world, this.focusX, this.focusY) : 0;
            this.focusH = MathUtils.damp(this.focusH, h, 8, dt);

            this._place(world);
        }

        /**
         * @param {Safari.TileWorld} [world] Supplied so the camera can stay above the
         *   ground it is looking at.
         */
        _place(world) {
            const cam = this.camera;
            const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
            cam.position.set(
                this.focusX + Math.sin(this.yaw) * cp * this.dist,
                this.focusH + sp * this.dist,
                this.focusY + Math.cos(this.yaw) * cp * this.dist
            );

            /*
             * Never below the ground.
             *
             * A free orbit can be pitched down to graze the horizon, and the moment the
             * focus is anywhere near a rise that puts the camera inside the hill — the
             * reserve turns inside out and the player is looking at the underside of the
             * map. Lifting the eye rather than forcing the pitch keeps the subject
             * framed where it was; the view just rides over the obstruction.
             */
            if (world) {
                const floor = R3D.surfaceY(world, cam.position.x, cam.position.z) +
                    Math.min(1.4, 0.25 + this.dist * 0.05);
                if (cam.position.y < floor) cam.position.y = floor;
            }

            cam.lookAt(this.focusX, this.focusH + this.dist * 0.06, this.focusY);
            cam.updateMatrixWorld();
        }

        /* -------------------------------------------------------------- *
         * Picking
         * -------------------------------------------------------------- */

        /**
         * Screen point → tile coordinates, by marching the view ray into the terrain.
         *
         * The 2D build could invert its projection in closed form. A perspective camera
         * over a heightfield cannot, so the ray is stepped until it passes below the
         * surface and then bisected. Stepping proportionally to the height above ground
         * means a ray along a flat plain takes a handful of samples rather than
         * hundreds.
         *
         * @returns {{x:number, y:number, hit:boolean}}
         */
        screenToTile(screenX, screenY, world, out) {
            const p = out || { x: 0, y: 0, hit: false };
            _ndc.set(
                (screenX / this.viewWidth) * 2 - 1,
                -(screenY / this.viewHeight) * 2 + 1
            );
            _ray.setFromCamera(_ndc, this.camera);

            const o = _ray.ray.origin;
            const d = _ray.ray.direction;
            const surface = (x, z) => (world ? R3D.surfaceY(world, x, z) : 0);

            let t = 0;
            let prevT = 0;
            let hit = false;

            for (let i = 0; i < 260 && t < 600; i++) {
                const gap = (o.y + d.y * t) - surface(o.x + d.x * t, o.z + d.z * t);
                if (gap <= 0) { hit = true; break; }
                prevT = t;
                // Sphere-trace style: never step further than the clearance, but keep a
                // floor on the step so a grazing ray still terminates.
                t += Math.max(0.35, Math.min(gap * 0.9, 12));
            }

            if (hit) {
                // Bisect the bracket for a precise contact point.
                let lo = prevT, hi = t;
                for (let i = 0; i < 18; i++) {
                    const mid = (lo + hi) * 0.5;
                    const y = o.y + d.y * mid;
                    if (y - surface(o.x + d.x * mid, o.z + d.z * mid) > 0) lo = mid;
                    else hi = mid;
                }
                t = (lo + hi) * 0.5;
            } else if (d.y < -1e-4) {
                /*
                 * Looking at ground beyond the terrain: fall back to the base plane,
                 * but not indefinitely. A ray a fraction of a degree below the horizon
                 * meets that plane hundreds of tiles away, and a caller that asked
                 * "what am I looking at" gets an answer off the edge of the world.
                 */
                t = Math.min(-o.y / d.y, 400);
            } else {
                // Looking at the sky. Report the point the focus is on.
                p.x = this.focusX;
                p.y = this.focusY;
                p.hit = false;
                return p;
            }

            p.x = o.x + d.x * t;
            p.y = o.z + d.z * t;
            p.hit = true;
            return p;
        }

        /**
         * Project a world point to screen pixels, for the flat overlay.
         * @returns {{x:number, y:number, visible:boolean}}
         */
        worldToScreen(x, y, z, out) {
            const p = out || { x: 0, y: 0, visible: false };
            _v.set(x, y, z).project(this.camera);
            p.visible = _v.z < 1 && _v.x >= -1.25 && _v.x <= 1.25 && _v.y >= -1.25 && _v.y <= 1.25;
            p.x = (_v.x * 0.5 + 0.5) * this.viewWidth;
            p.y = (-_v.y * 0.5 + 0.5) * this.viewHeight;
            p.depth = _v.z;
            return p;
        }

        /** Rough distance from the camera to a tile point, for level-of-detail work. */
        distanceTo(tx, ty) {
            const c = this.camera.position;
            return Math.hypot(c.x - tx, c.z - ty);
        }

        /**
         * The quadrilateral of ground the camera can see, in tile coordinates.
         *
         * The minimap draws this. In the 2D build it was the inverse-projected corners
         * of the viewport rectangle; here it is four picking rays, which is the same
         * idea and works whatever the yaw and pitch are.
         */
        viewCorners(world, out) {
            const r = out || [];
            const w = this.viewWidth, h = this.viewHeight;
            const pts = [[1, 1], [w - 1, 1], [w - 1, h - 1], [1, h - 1]];
            const n = world ? world.size : this.worldTiles;

            for (let i = 0; i < 4; i++) {
                const p = this.screenToTile(pts[i][0], pts[i][1], world, r[i] || {});
                // The top corners usually look past the reserve — at the horizon, or at
                // the sky. Clamping to the boundary is what the map wants to draw: the
                // part of the reserve on screen, not where the ray eventually landed.
                p.x = MathUtils.clamp(p.x, 0, n);
                p.y = MathUtils.clamp(p.y, 0, n);
                r[i] = p;
            }
            return r;
        }
    }

    CameraRig.MIN_DIST = MIN_DIST;
    CameraRig.MAX_DIST = MAX_DIST;
    Safari.CameraRig = CameraRig;

})(window.Safari, window.THREE);
