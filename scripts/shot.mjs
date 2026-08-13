/**
 * Safari Simulator 3D — Screenshot harness.
 *
 *   node scripts/shot.mjs                 the standard set
 *   node scripts/shot.mjs reserve         one named shot
 *   node scripts/shot.mjs zebra 17.4      ...at a given hour
 *
 * Each shot drives `window.SS3D` into a specific state and captures it. Nothing here
 * plays the game to get somewhere: the hook steps the simulation directly, so a shot of
 * a herd at golden hour costs a second rather than four in-game days.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'file:///' + join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = join(ROOT, 'shots');

/**
 * The standard set.
 *
 * `setup` runs inside the page with `SS3D` in scope and may return nothing; `bare`
 * strips the interface panels for shots that are about the reserve rather than the
 * game.
 */
const SHOTS = {
    reserve: {
        size: [1600, 1000],
        bare: true,
        setup: (S, hour) => {
            S.begin({ animals: 40, hour: hour ?? 15.4 });
            S.step(160);
            S.hour(hour ?? 15.4);
            const a = S.scene.ecology.animals[2];
            S.cam(a.x, a.y, 26, 1.15, 0.42);
        }
    },

    play: {
        size: [1440, 900],
        setup: (S, hour) => {
            S.begin({ animals: 36, hour: hour ?? 9.6 });
            S.step(200);
            S.hour(hour ?? 9.6);
            const a = S.scene.ecology.animals[3];
            S.cam(a.x, a.y, 20, 1.1, 0.40);
        }
    },

    zebra: {
        size: [1280, 800],
        bare: true,
        setup: (S, hour) => {
            S.begin({ animals: 36, hour: hour ?? 9.5 });
            S.step(90);
            S.hour(hour ?? 9.5);
            const a = S.find('zebra', 3.6) || S.scene.ecology.animals[0];
            S.cam(a.x, a.y, 3.8, 1.4, 0.34);
        }
    },

    dusk: {
        size: [1600, 1000],
        bare: true,
        setup: (S) => {
            S.begin({ animals: 40, hour: 18.9 });
            S.step(140);
            S.hour(18.9);
            const a = S.scene.ecology.animals[1];
            S.cam(a.x, a.y, 16, 2.3, 0.16);
        }
    },

    night: {
        size: [1600, 1000],
        bare: true,
        setup: (S) => {
            S.begin({ animals: 40, hour: 1.2 });
            S.step(140);
            S.hour(1.2);
            const a = S.scene.ecology.animals[1];
            S.cam(a.x, a.y, 14, 0.8, 0.22);
        }
    },

    station: {
        size: [1280, 800],
        bare: true,
        setup: (S, hour) => {
            S.begin({ animals: 24, hour: hour ?? 8.4 });
            S.step(90);
            S.hour(hour ?? 8.4);
            const st = S.scene.station;
            S.cam(st.x, st.y, 9, 1.9, 0.30);
        }
    }
};

const [, , which, hourArg] = process.argv;
const hour = hourArg === undefined ? undefined : Number(hourArg);
const names = which ? [which] : Object.keys(SHOTS);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
let failed = 0;

for (const name of names) {
    const shot = SHOTS[name];
    if (!shot) {
        console.error('unknown shot "' + name + '"; try: ' + Object.keys(SHOTS).join(', '));
        failed++;
        continue;
    }

    const page = await browser.newPage({
        viewport: { width: shot.size[0], height: shot.size[1] }
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(PAGE);
    await page.waitForFunction(() => !!window.SS3D, null, { timeout: 20000 });
    await page.waitForTimeout(1200);

    await page.evaluate(([src, h, bare]) => {
        const S = window.SS3D;
        if (bare) S.bare();
        // eslint-disable-next-line no-new-func
        new Function('S', 'hour', 'return (' + src + ')(S, hour)')(S, h);
    }, [shot.setup.toString(), hour, !!shot.bare]);

    // Let the interface settle — the screen transitions are CSS, not frames — then
    // freeze and draw one deliberate frame so the capture is of a known state.
    await page.waitForTimeout(shot.bare ? 300 : 2400);
    await page.evaluate(() => {
        window.SS3D.game.ticker.stop();
        window.SS3D.draw();
    });

    const path = join(OUT, name + '.png');
    await page.screenshot({ path });
    await page.close();

    if (errors.length) {
        failed++;
        console.error('FAIL ' + name + ': ' + errors[0]);
    } else {
        console.log('ok   ' + name + ' -> shots/' + name + '.png');
    }
}

await browser.close();
process.exit(failed ? 1 : 0);
