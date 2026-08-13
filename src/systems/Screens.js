/**
 * Safari Simulator — Screen flow.
 *
 * Manages the transitions between the title screen, the run itself and the summary,
 * and composes the end-of-run report. The title screen deliberately renders the live
 * world behind it, so the game is already alive before the player presses anything.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, Species, Events } = Safari;

    /** @enum {string} */
    const Screen = {
        TITLE: 'title',
        PLAYING: 'playing',
        SUMMARY: 'summary'
    };

    class Screens {
        /**
         * @param {Safari.EventBus} bus
         * @param {object} refs
         */
        constructor(bus, refs) {
            this.bus = bus;
            this.el = refs;
            this.current = Screen.TITLE;
            this.transitioning = false;
        }

        /**
         * Switch screens with a short cross-fade.
         * @param {string} screen
         */
        show(screen) {
            if (this.current === screen) return;
            this.current = screen;

            const map = {
                [Screen.TITLE]: this.el.title,
                [Screen.PLAYING]: this.el.playing,
                [Screen.SUMMARY]: this.el.summary
            };

            for (const key in map) {
                const node = map[key];
                if (!node) continue;
                const active = key === screen;
                node.classList.toggle('is-active', active);
                node.setAttribute('aria-hidden', active ? 'false' : 'true');
            }

            document.body.dataset.screen = screen;
        }

        /**
         * Compose the summary. The headline grade is derived from how the ecosystem
         * actually performed, not just from how long it lasted.
         *
         * @param {object} report
         */
        renderSummary(report) {
            const el = this.el;
            const s = report.stats;

            /* --- Headline ------------------------------------------------- */
            const verdict = this._verdict(report);
            if (el.summaryTitle) el.summaryTitle.textContent = verdict.title;
            if (el.summaryBlurb) el.summaryBlurb.textContent = verdict.blurb;
            if (el.summaryGrade) {
                el.summaryGrade.textContent = verdict.grade;
                el.summaryGrade.className = 'summary__grade summary__grade--' + verdict.tone;
            }

            /* --- The brief, assessed ---------------------------------------- */
            /*
             * Shown before the figures, because this is what the player was told to do.
             * The rows come from the same evaluation that fed the panel during play, so
             * the report cannot say something different from what they were watching.
             */
            if (el.summaryGoals && report.goals) {
                el.summaryGoals.innerHTML = report.goals.items.map((g) =>
                    '<div class="summary__goal' + (g.done ? ' is-done' : '') + '">' +
                    '<span class="summary__goal-tick"></span>' +
                    '<span class="summary__goal-label">' + g.label + '</span>' +
                    '<span class="summary__goal-detail">' + g.detail + '</span>' +
                    '</div>'
                ).join('');
            }

            /* --- Figures --------------------------------------------------- */
            const rows = [
                { label: 'Days survived', value: report.days, hero: true },
                { label: 'Final population', value: report.population, hero: true },
                { label: 'Peak population', value: s.peakPopulation },
                { label: 'Animals born', value: s.born, tone: 'good' },
                { label: 'Predators introduced', value: s.placedCarnivores },
                { label: 'Grazers introduced', value: s.placedHerbivores },
                { label: 'Kills made', value: s.eaten, tone: 'warm' },
                { label: 'Lost to starvation', value: s.starved, tone: 'bad' },
                { label: 'Sedated by the ranger', value: s.tranquilized, tone: 'cool' },
                { label: 'Relocated to other reserves', value: report.relocated || 0,
                    tone: 'cool', hero: !!report.relocated },
                { label: 'Lost to poachers', value: report.poached || 0, tone: 'bad' },
                { label: 'Droughts survived', value: report.droughts || 0 },
                { label: 'Fires on the reserve', value: report.fires || 0, tone: 'warm' },
                { label: 'Meals eaten', value: s.fed }
            ];

            if (el.summaryStats) {
                el.summaryStats.innerHTML = rows.map((r) =>
                    '<div class="summary__row' + (r.hero ? ' summary__row--hero' : '') + '">' +
                    '<span class="summary__label">' + r.label + '</span>' +
                    '<span class="summary__value' + (r.tone ? ' is-' + r.tone : '') + '">' +
                    Safari.Utils.formatNumber(r.value) + '</span>' +
                    '</div>'
                ).join('');
            }

            /* --- Species breakdown ----------------------------------------- */
            if (el.summarySpecies) {
                const counts = report.speciesCounts;
                const present = Object.keys(counts)
                    .filter((k) => counts[k] > 0)
                    .sort((a, b) => counts[b] - counts[a]);

                if (present.length === 0) {
                    el.summarySpecies.innerHTML =
                        '<p class="summary__empty">No animals remained at the end of the run.</p>';
                } else {
                    const max = counts[present[0]];
                    el.summarySpecies.innerHTML = present.map((id) => {
                        const pct = Math.round((counts[id] / max) * 100);
                        return '<div class="species-bar">' +
                            '<span class="species-bar__name">' + Species[id].label + '</span>' +
                            '<span class="species-bar__track">' +
                            '<span class="species-bar__fill species-bar__fill--' +
                            Species[id].stats.diet + '" style="width:' + pct + '%"></span>' +
                            '</span>' +
                            '<span class="species-bar__count">' + counts[id] + '</span>' +
                            '</div>';
                    }).join('');
                }
            }
        }

        /**
         * Judge the run. Balance matters more than raw numbers: an ecosystem that kept
         * predators and prey alive together is a better result than one that simply
         * accumulated rabbits.
         */
        _verdict(report) {
            const s = report.stats;

            if (report.population === 0) {
                return {
                    grade: '—',
                    tone: 'bad',
                    title: 'The reserve fell silent',
                    blurb: report.reason === 'extinct'
                        ? 'Nothing survived. A reserve with no animals left in it ends the tenure early, whatever the calendar says.'
                        : 'Nothing survived to the end of the tenure. Try a gentler balance of predators to grazers.'
                };
            }

            /*
             * The grade is the brief.
             *
             * It used to be a weighted opinion about growth and balance that the player
             * never saw stated anywhere, which meant the letter at the end arrived out
             * of nowhere. Now it is simply how much of the job got done — the same
             * objectives, with the same weights, that were ticking over in the corner
             * all run.
             */
            const goals = report.goals;
            if (!goals) return this._legacyVerdict(report);

            const score = goals.score;
            const met = goals.met;
            const short = goals.items.filter((g) => !g.done);

            const bands = [
                { min: 0.94, grade: 'A', tone: 'good', title: 'A reserve in good hands' },
                { min: 0.80, grade: 'B', tone: 'good', title: 'A tenure worth having' },
                { min: 0.62, grade: 'C', tone: 'warm', title: 'A reserve that held together' },
                { min: 0.40, grade: 'D', tone: 'warm', title: 'A difficult tenure' },
                { min: -1, grade: 'E', tone: 'bad', title: 'A hard season' }
            ];
            const band = bands.find((b) => score > b.min);

            // Advice comes from whichever term of the brief went worst, not from the
            // letter — telling a warden to watch for poachers when none came is noise.
            const worst = short.slice().sort((a, b) => a.ratio - b.ratio)[0];
            /*
             * Written as functions of the run, because the same shortfall has different
             * causes. A warden who never brought a predator in has not watched them
             * starve, and telling them they did is both wrong and useless — it was the
             * first thing the report got caught saying.
             */
            const brought = report.stats || {};
            const advice = {
                tenure: () => 'The tenure was cut short. Everything else follows from keeping the reserve going, so start with forage and water and let the herds settle before adding predators.',
                starvation: () => 'Too many animals starved. That is the reserve telling you it was carrying more than the pasture could feed — scatter forage where the herds actually are, and move the surplus on before the grass is stripped rather than after.',
                predators: () => !brought.placedCarnivores
                    ? 'No predators were ever brought in. The predator allowance is separate from the grazer one — spending every grazer slot never costs you a lion.'
                    : 'The predators did not survive. They need grazers within reach — a reserve of empty plain starves them however much grass there is.',
                species: () => 'Too little variety left. A reserve that is all one animal is fragile; keep a spread and relocate from the species that are crowding.',
                relocate: () => 'Nothing much was moved on. Arm the ranger, dart the surplus, and let the loader and lorry take them out through the gate — that is the part of the job only you can do.',
                poaching: () => 'Poachers got away with too much. Drive at their truck the moment one is sighted; they lose their nerve and run once you are close.'
            };

            return {
                grade: band.grade,
                tone: band.tone,
                title: met === goals.total
                    ? 'Every term of the brief met'
                    : band.title,
                blurb: worst
                    ? (advice[worst.id] ? advice[worst.id]()
                        : 'A near miss on ' + worst.label.toLowerCase() + '.')
                    : 'The reserve was left in better shape than it was found. Nothing to add.',
                score,
                met
            };
        }

        /** The old opinion-based grade, kept for callers without a brief. */
        _legacyVerdict(report) {
            const s = report.stats;
            const placed = s.placedCarnivores + s.placedHerbivores;

            /* --- Score components, each 0..1 ---------------------------- */
            const growth = placed > 0 ? report.population / placed : report.population;
            const ratio = report.predators > 0
                ? report.grazers / report.predators
                : (report.grazers > 0 ? 8 : 0);

            const components = {
                /*
                 * Stewardship: relocating surplus animals to other reserves, and not
                 * losing them to poachers. This is the part of the grade the player has
                 * the most direct hand in — the rest is management at one remove.
                 */
                stewardship: MathUtils.clamp01(
                    ((report.relocated || 0) * 1.4 - (report.poached || 0) * 2 + 2) / 8),
                // How long the reserve was kept running.
                longevity: MathUtils.clamp01(report.days / 12),
                // Whether the population grew beyond what was introduced.
                growth: MathUtils.clamp01(growth / 2.2),
                // Distance from a healthy ~4:1 grazer-to-predator ratio, in log space.
                balance: 1 - MathUtils.clamp01(
                    Math.abs(Math.log(Math.max(0.2, ratio) / 4)) / 2.2),
                // Absence of starvation.
                nutrition: 1 - MathUtils.clamp01(s.starved / Math.max(4, placed * 1.5))
            };

            const weights = {
                longevity: 0.24, growth: 0.20, balance: 0.22,
                nutrition: 0.14, stewardship: 0.20
            };
            let score = 0;
            for (const key in weights) score += components[key] * weights[key];
            score = MathUtils.clamp01(score);

            const grades = [
                { min: 0.80, grade: 'A', tone: 'good', title: 'A thriving reserve' },
                { min: 0.62, grade: 'B', tone: 'good', title: 'A steady ecosystem' },
                { min: 0.42, grade: 'C', tone: 'warm', title: 'A fragile balance' },
                { min: 0.22, grade: 'D', tone: 'warm', title: 'A struggling reserve' },
                { min: -1, grade: 'E', tone: 'bad', title: 'A hard season' }
            ];
            const band = grades.find((g) => score > g.min);

            /*
             * Advice is drawn from whichever component actually scored worst, rather
             * than from the grade. Telling a player their animals went hungry when none
             * starved is worse than saying nothing.
             */
            let weakest = 'longevity';
            for (const key in components) {
                if (components[key] < components[weakest]) weakest = key;
            }

            const advice = {
                longevity: 'The reserve was only getting started — give a run longer to let herds establish and breed.',
                growth: 'The population never really took hold. Scatter more forage early, and let the grazers multiply before adding predators.',
                balance: report.predators === 0
                    ? 'With no predators, the grazers had nothing to check them. A lion or two keeps a reserve honest.'
                    : (ratio < 4
                        ? 'Too many predators for the number of grazers. Thin the hunters, or bring in more herds to feed them.'
                        : 'The grazers heavily outnumbered the predators. The reserve was safe, but the balance was slack.'),
                nutrition: 'Too many animals went hungry. More forage, and fewer predators early on, would give the herds room to establish.',
                stewardship: (report.poached || 0) > 0
                    ? 'Poachers got away with animals. Send the ranger at their truck the moment one is sighted — they run once you get close.'
                    : 'Nothing was moved on. When the reserve gets crowded, dart the surplus and let the lorry take them to another reserve.'
            };

            return {
                grade: band.grade,
                tone: band.tone,
                title: band.title,
                blurb: advice[weakest],
                score,
                components
            };
        }
    }

    Screens.Screen = Screen;
    Safari.Screens = Screens;

})(window.Safari);
