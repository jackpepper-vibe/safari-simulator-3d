/**
 * Safari Simulator 3D — Smoke test.
 *
 *   node scripts/smoke.mjs
 *
 * This covers the parts a screenshot cannot. The fork rewrote every path between the
 * pointer and the simulation — screen-to-world is a raycast against a heightfield now,
 * the minimap's viewport outline comes from four picking rays, and animals are picked
 * against the ground rather than against a projection — so those get asserted rather
 * than eyeballed. It also checks the things that only go wrong on the *second* run:
 * scene teardown, shared geometry, and rebuilding a reserve.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file:///' + join(ROOT, 'index.html').replace(/\\/g, '/');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
});

await page.goto(PAGE);
await page.waitForFunction(() => !!window.SS3D, null, { timeout: 20000 });
await page.waitForTimeout(1000);

const results = await page.evaluate(() => {
    const out = [];
    const check = (name, fn) => {
        try {
            const detail = fn();
            out.push({ name, pass: true, detail: detail === undefined ? '' : String(detail) });
        } catch (e) {
            out.push({ name, pass: false, detail: e.message });
        }
    };
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    const S = window.SS3D;
    const game = S.game;

    /* --- The world is actually built ------------------------------------ */

    check('scene builds terrain, flora and sky', () => {
        const s = S.scene;
        assert(s.terrain.ground.geometry.attributes.position.count > 10000, 'ground too small');
        assert(s.flora.meshes.length > 2, 'no flora');
        assert(s.sky.dome && s.sky.key, 'no sky or key light');
        return s.terrain.ground.geometry.attributes.position.count + ' ground vertices';
    });

    check('a run stocks the reserve and builds a mesh per animal', () => {
        S.begin({ animals: 24 });
        S.step(5);
        S.draw();
        const n = S.scene.agents.length;
        assert(n >= 20, 'expected a stocked reserve, got ' + n);
        assert(S.scene.animalMeshes.size === n, 'meshes ' + S.scene.animalMeshes.size + ' vs animals ' + n);
        return n + ' animals';
    });

    /* --- Picking -------------------------------------------------------- */

    check('screen-to-world round-trips through the heightfield', () => {
        const cam = S.camera;
        const world = S.world;
        // Take a point on the ground, project it to the screen, then pick it back.
        const tx = cam.focusX + 3.5;
        const ty = cam.focusY - 2.5;
        const y = Safari.R3D.surfaceY(world, tx, ty);
        const p = cam.worldToScreen(tx, y, ty, {});
        assert(p.visible, 'test point is off screen');
        const back = cam.screenToTile(p.x, p.y, world, {});
        assert(back.hit, 'ray missed the terrain');
        const err = Math.hypot(back.x - tx, back.y - ty);
        assert(err < 0.25, 'round trip drifted ' + err.toFixed(3) + ' tiles');
        return 'error ' + err.toFixed(4) + ' tiles';
    });

    check('picking works on raised ground too', () => {
        const world = S.world;
        // Find the highest tile in the reserve and aim at it.
        let bx = 0, by = 0, best = -1;
        for (let ty = 4; ty < world.size - 4; ty += 2) {
            for (let tx = 4; tx < world.size - 4; tx += 2) {
                const h = world.heightAt(tx, ty);
                if (h > best) { best = h; bx = tx; by = ty; }
            }
        }
        assert(best > 0.2, 'reserve has no relief to test');
        S.cam(bx, by, 12, 0.9, 0.5);
        const y = Safari.R3D.surfaceY(world, bx, by);
        const p = S.camera.worldToScreen(bx, y, by, {});
        const back = S.camera.screenToTile(p.x, p.y, world, {});
        const err = Math.hypot(back.x - bx, back.y - by);
        assert(err < 0.35, 'drifted ' + err.toFixed(3) + ' tiles on a rise of ' + best.toFixed(2));
        return 'rise ' + best.toFixed(2) + ', error ' + err.toFixed(4);
    });

    check('the minimap viewport is four ground points', () => {
        const corners = S.camera.viewCorners(S.world, []);
        assert(corners.length === 4, 'expected 4 corners');
        for (const c of corners) {
            assert(Number.isFinite(c.x) && Number.isFinite(c.y), 'corner is not a number');
        }
        for (const c of corners) {
            assert(c.x >= 0 && c.x <= S.world.size && c.y >= 0 && c.y <= S.world.size,
                'corner is off the map: ' + c.x.toFixed(1) + ',' + c.y.toFixed(1));
        }

        /*
         * The quad has to contain what the camera is looking at. That is the property
         * the minimap depends on, and the one that breaks if the yaw convention is ever
         * inverted — an outline of the right size in the wrong place.
         */
        const fx = S.camera.focusX;
        const fy = S.camera.focusY;
        let inside = false;
        for (let i = 0, j = 3; i < 4; j = i++) {
            const a = corners[i], b = corners[j];
            if ((a.y > fy) !== (b.y > fy) &&
                fx < (b.x - a.x) * (fy - a.y) / (b.y - a.y) + a.x) {
                inside = !inside;
            }
        }
        assert(inside, 'the focus is outside the viewport outline');
        return 'four corners on the map, focus inside';
    });

    /* --- Orders --------------------------------------------------------- */

    check('clicking the ground places the armed species', () => {
        const before = S.scene.agents.length;
        game.hud.select('zebra');
        const tx = S.camera.focusX;
        const ty = S.camera.focusY;
        const y = Safari.R3D.surfaceY(S.world, tx, ty);
        const p = S.camera.worldToScreen(tx, y, ty, {});
        game._click(p.x, p.y);
        const after = S.scene.agents.length;
        assert(after === before + 1, 'placed ' + (after - before) + ' animals');
        game.hud.select(null);
        return 'population ' + before + ' -> ' + after;
    });

    check('clicking the ground with the ranger armed sends it there', () => {
        const ranger = S.scene.ranger;
        game.hud.select('ranger');
        const tx = Math.round(S.camera.focusX) + 4;
        const ty = Math.round(S.camera.focusY) + 4;
        const y = Safari.R3D.surfaceY(S.world, tx, ty);
        const p = S.camera.worldToScreen(tx, y, ty, {});
        assert(p.visible, 'target is off screen');
        game._click(p.x, p.y);
        const err = Math.hypot(ranger.targetX - tx, ranger.targetY - ty);
        assert(err < 3.5, 'ranger was sent ' + err.toFixed(1) + ' tiles from the click');
        game.hud.select(null);
        return 'target within ' + err.toFixed(2) + ' tiles';
    });

    check('clicking an animal with the ranger armed takes it as quarry', () => {
        const ranger = S.scene.ranger;
        ranger.quarry = null;
        const a = S.spawn('deer', S.camera.focusX + 1, S.camera.focusY + 1);
        assert(a, 'could not place a deer to shoot at');
        game.hud.select('ranger');
        game._commandRanger({ x: a.x, y: a.y });
        assert(ranger.quarry === a, 'ranger did not take the deer as quarry');
        game.hud.select(null);
        return 'quarry set';
    });

    check('hover picking finds the nearest animal to the ground point', () => {
        const a = S.scene.agents.find((x) => x.alive);
        const found = game._animalUnder(a.x, a.y);
        assert(found === a, 'picked the wrong animal');
        const miss = game._animalUnder(a.x + 40, a.y + 40);
        assert(miss !== a, 'picked an animal 40 tiles away');
        return 'hit and miss both correct';
    });

    /* --- Presentation follows the simulation ---------------------------- */

    check('the gait advances the skeleton', () => {
        const a = S.scene.agents.find((x) => x.alive && !x.flies);
        const mesh = S.scene.animalMeshes.get(a);
        assert(mesh, 'animal has no mesh');
        const hip = mesh.userData.bones[mesh.userData.rig.index.hip0];
        // Drive the pose directly: a standing animal need not be walking on its own.
        Safari.Creature3D.pose(mesh, { phase: 0.0, speed01: 1, facing: 0, time: 0, seed: 1 });
        const a0 = hip.quaternion.clone();
        Safari.Creature3D.pose(mesh, { phase: 0.35, speed01: 1, facing: 0, time: 0, seed: 1 });
        const moved = a0.angleTo(hip.quaternion);
        assert(moved > 0.05, 'hip barely moved through the stride: ' + moved.toFixed(4));
        return 'hip swung ' + moved.toFixed(3) + ' rad';
    });

    check('animals stand on the terrain, not through it', () => {
        S.draw();
        let worst = 0;
        for (const a of S.scene.agents) {
            if (!a.alive || a.flies) continue;
            const mesh = S.scene.animalMeshes.get(a);
            const want = Safari.R3D.surfaceY(S.world, a.x, a.y);
            worst = Math.max(worst, Math.abs(mesh.position.y - want));
        }
        assert(worst < 0.01, 'an animal is ' + worst.toFixed(3) + ' units off the ground');
        return 'worst offset ' + worst.toFixed(5);
    });

    check('a dead animal loses its mesh', () => {
        const a = S.scene.agents.find((x) => x.alive);
        const mesh = S.scene.animalMeshes.get(a);
        S.scene.ecology.animals.splice(S.scene.ecology.animals.indexOf(a), 1);
        S.draw();
        assert(!S.scene.animalMeshes.has(a), 'mesh outlived its animal');
        assert(!mesh.parent, 'mesh is still in the scene graph');
        return 'removed';
    });

    check('grazing and fire reach the ground through the overlay', () => {
        const t = S.scene.terrain;
        const world = S.world;
        const k = world.index(20, 20);
        world.fertility[k] = 1;
        world.graze[k] = 0;
        world.grazeStamp[k] = S.scene.simTime;
        t.updateOverlay(S.scene.simTime, new Set([world.index(21, 21)]));
        assert(t.overlayData[k * 4] > 200, 'grazed tile did not darken: ' + t.overlayData[k * 4]);
        assert(t.overlayData[world.index(21, 21) * 4 + 1] === 255, 'burnt tile not marked');
        return 'worn ' + t.overlayData[k * 4] + ', burnt flagged';
    });

    /* --- Second run ------------------------------------------------------ */

    check('a second reserve builds cleanly over the first', () => {
        const firstWorld = S.scene.world;
        game.start();
        S.step(3);
        S.draw();
        assert(S.scene.world !== firstWorld, 'the reserve was not rebuilt');
        assert(S.scene.terrain.ground.parent, 'new ground is not in the scene');
        S.begin({ animals: 12 });
        S.step(3);
        S.draw();
        assert(S.scene.animalMeshes.size === S.scene.agents.length, 'mesh count drifted');
        return 'rebuilt with ' + S.scene.agents.length + ' animals';
    });

    check('the renderer survives it without losing its context', () => {
        const gl = game.renderer.getContext();
        assert(!gl.isContextLost(), 'WebGL context was lost');
        return 'context intact';
    });

    return out;
});

await browser.close();

let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? '  — ' + r.detail : ''));
}

if (errors.length) {
    failed++;
    console.log('FAIL page errors:');
    for (const e of errors.slice(0, 8)) console.log('     ' + e);
}

console.log(failed ? '\n' + failed + ' failing' : '\nall ' + results.length + ' checks passed');
process.exit(failed ? 1 : 0);
