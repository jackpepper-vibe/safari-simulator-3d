/**
 * Safari Simulator — Vehicle routing.
 *
 * Steering alone cannot cross a reserve. It is fine for an animal, which only ever
 * wants to get a few tiles nearer something it can see, but a lorry told to drive
 * seventy tiles to the boundary gate meets the first lake, sweeps for a heading that
 * is not underwater, and follows the shoreline into a dead end — which is exactly what
 * it did: four animals aboard, twenty-five in-game minutes, never arrived.
 *
 * So vehicles get a route. A* over the tile grid, eight-connected, with the diagonal
 * cost that stops it producing staircases. The reserve is small enough — a few thousand
 * tiles — that a full search costs less than a frame, and routes are only computed when
 * a destination changes or a road turns out to be shut.
 */
(function (Safari) {
    'use strict';

    const { MathUtils } = Safari;

    const SQRT2 = Math.SQRT2;

    /** Neighbour offsets, orthogonals first so ties prefer straight lines. */
    const NEIGHBOURS = [
        [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
        [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]
    ];

    /**
     * Scratch buffers, sized to the world once and reused.
     *
     * A* allocating three typed arrays per call would churn megabytes a minute with
     * three vehicles re-routing; these are cleared with a generation stamp instead of
     * being refilled, so a search touches only the tiles it visits.
     */
    let _size = 0;
    let _cost = null;
    let _from = null;
    let _seen = null;
    let _closed = null;
    let _gen = 0;

    function ensure(size) {
        if (_size === size) return;
        _size = size;
        const n = size * size;
        _cost = new Float32Array(n);
        _from = new Int32Array(n);
        _seen = new Int32Array(n);
        _closed = new Uint8Array(n);
        _gen = 0;
    }

    /**
     * Binary heap of tile indices, ordered by their f-score.
     *
     * A sorted array was the obvious thing and was measurably worse: the open set gets
     * to a few hundred entries on a long route and re-sorting it on every push dominated
     * the search.
     */
    const _heap = [];
    const _fScore = new Map();
    let _heapLen = 0;

    function heapPush(node, f) {
        _fScore.set(node, f);
        _heap[_heapLen] = node;
        let i = _heapLen++;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (_fScore.get(_heap[parent]) <= f) break;
            _heap[i] = _heap[parent];
            _heap[parent] = node;
            i = parent;
        }
    }

    function heapPop() {
        const top = _heap[0];
        const last = _heap[--_heapLen];
        if (_heapLen > 0) {
            _heap[0] = last;
            const lastF = _fScore.get(last);
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let best = i;
                let bestF = lastF;
                if (l < _heapLen && _fScore.get(_heap[l]) < bestF) {
                    best = l; bestF = _fScore.get(_heap[l]);
                }
                if (r < _heapLen && _fScore.get(_heap[r]) < bestF) {
                    best = r; bestF = _fScore.get(_heap[r]);
                }
                if (best === i) break;
                _heap[i] = _heap[best];
                _heap[best] = last;
                i = best;
            }
        }
        return top;
    }

    /**
     * Route between two tile positions.
     *
     * @param {Safari.TileWorld} world
     * @param {number} sx Start, in continuous tile coordinates.
     * @param {number} sy
     * @param {number} tx Destination.
     * @param {number} ty
     * @param {(world, x, y) => boolean} passable
     * @param {number} [budget] Ceiling on tiles examined, so a hopeless search cannot
     *   stall the frame. Returns null if it runs out.
     * @returns {Array<{x:number,y:number}>|null} Waypoints, start excluded.
     */
    function find(world, sx, sy, tx, ty, passable, budget) {
        const size = world.size;
        ensure(size);
        _gen++;

        const startX = MathUtils.clamp(sx | 0, 0, size - 1);
        const startY = MathUtils.clamp(sy | 0, 0, size - 1);
        let goalX = MathUtils.clamp(tx | 0, 0, size - 1);
        let goalY = MathUtils.clamp(ty | 0, 0, size - 1);

        /*
         * A destination on ground the vehicle cannot occupy — the gate's own tile, a
         * spot inside the station fence — would make the search fail outright. Slide it
         * to the nearest tile that works, so "drive to the gate" means "drive as close
         * to the gate as the ground allows".
         */
        if (!passable(world, goalX + 0.5, goalY + 0.5)) {
            let found = false;
            for (let r = 1; r <= 6 && !found; r++) {
                for (let a = 0; a < 12 && !found; a++) {
                    const ang = (a / 12) * MathUtils.TAU;
                    const nx = MathUtils.clamp((goalX + Math.cos(ang) * r) | 0, 0, size - 1);
                    const ny = MathUtils.clamp((goalY + Math.sin(ang) * r) | 0, 0, size - 1);
                    if (passable(world, nx + 0.5, ny + 0.5)) {
                        goalX = nx; goalY = ny; found = true;
                    }
                }
            }
            if (!found) return null;
        }

        /*
         * Where the search settled on going, which is not always where it was asked.
         *
         * Callers need this. A vehicle that keeps the original destination after the
         * goal has been slid onto reachable ground drives its route perfectly, runs off
         * the end of it, and then grinds freehand against the scarp it was never going
         * to cross — twenty-five of forty test journeys ended exactly that way.
         */
        find.goal = { x: goalX + 0.5, y: goalY + 0.5 };

        const start = startY * size + startX;
        const goal = goalY * size + goalX;
        if (start === goal) return [];

        const limit = budget || 9000;
        let examined = 0;

        _heapLen = 0;
        _fScore.clear();
        _cost[start] = 0;
        _from[start] = -1;
        _seen[start] = _gen;
        _closed[start] = 0;
        heapPush(start, 0);

        while (_heapLen > 0) {
            const current = heapPop();
            if (current === goal) return rebuild(current, size);
            if (_closed[current] === 1 && _seen[current] === _gen) continue;
            _closed[current] = 1;

            if (++examined > limit) return null;

            const cx = current % size;
            const cy = (current / size) | 0;
            const base = _cost[current];

            for (let i = 0; i < 8; i++) {
                const n = NEIGHBOURS[i];
                const nx = cx + n[0];
                const ny = cy + n[1];
                if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;

                const idx = ny * size + nx;
                if (_seen[idx] === _gen && _closed[idx] === 1) continue;
                if (!passable(world, nx + 0.5, ny + 0.5)) continue;

                // Diagonals may not cut a corner between two blocked tiles.
                if (n[2] > 1) {
                    if (!passable(world, cx + n[0] + 0.5, cy + 0.5)) continue;
                    if (!passable(world, cx + 0.5, cy + n[1] + 0.5)) continue;
                }

                const step = base + n[2];
                if (_seen[idx] === _gen && step >= _cost[idx]) continue;

                _seen[idx] = _gen;
                _closed[idx] = 0;
                _cost[idx] = step;
                _from[idx] = current;

                // Octile distance: admissible for eight-connected movement, and much
                // better guidance than Euclidean on a grid.
                const dx = Math.abs(nx - goalX);
                const dy = Math.abs(ny - goalY);
                const h = (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy);
                heapPush(idx, step + h);
            }
        }
        return null;
    }

    /** Walk the parent chain back to the start, smoothing out collinear runs. */
    function rebuild(goal, size) {
        const raw = [];
        let node = goal;
        while (node >= 0) {
            raw.push(node);
            node = _from[node];
        }
        raw.reverse();

        /*
         * Drop waypoints that lie on the same bearing as their neighbours. The steering
         * interpolates between them anyway, and a route of two hundred single-tile hops
         * makes a vehicle crab along visibly correcting its heading.
         */
        const out = [];
        for (let i = 1; i < raw.length; i++) {
            const keep = i === raw.length - 1 ||
                bearing(raw[i - 1], raw[i], size) !== bearing(raw[i], raw[i + 1], size);
            if (keep) {
                out.push({ x: (raw[i] % size) + 0.5, y: ((raw[i] / size) | 0) + 0.5 });
            }
        }
        return out;
    }

    function bearing(a, b, size) {
        const ax = a % size, ay = (a / size) | 0;
        const bx = b % size, by = (b / size) | 0;
        return (Math.sign(bx - ax) + 1) * 3 + (Math.sign(by - ay) + 1);
    }

    Safari.IsoPath = { find };

})(window.Safari);
