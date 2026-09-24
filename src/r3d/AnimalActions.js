/**
 * Safari Simulator 3D — Animal action card.
 *
 * Click an animal and a small card opens above it, pinned to it as it moves, with what
 * you can do to it: **Dart** it, or **Follow** it. The ranger drives out and takes the
 * shot; the card reports how that is going — closing in, taking the shot, sedated, the
 * loader on its way — until it is done.
 *
 * It replaces the only way darting used to work: arm the ranger from the dock, then
 * click an animal. That is a mode, and nothing on screen said the mode existed — players
 * forgot it between sessions and new players never found it. Acting on the thing you
 * are looking at is the convention every game teaches, so that is what this does. The
 * dock route still works for anyone who learned it.
 *
 * Presentation only. Orders go out through the callbacks the shell supplies; the card
 * reads simulation state to describe it and never writes to it.
 */
(function (Safari) {
    'use strict';

    const { MathUtils, IsoSpecies, IsoAnimal } = Safari;

    /** How many times the hover hint is offered before the player is assumed to know. */
    const HINT_LIMIT = 3;
    const HINT_KEY = 'ss3d.animalCardUses';

    /** Read the use count, tolerating storage that is blocked or absent. */
    function readUses() {
        try {
            return parseInt(window.localStorage.getItem(HINT_KEY) || '0', 10) || 0;
        } catch (e) {
            return 0;
        }
    }

    function writeUses(n) {
        try {
            window.localStorage.setItem(HINT_KEY, String(n));
        } catch (e) {
            // Private browsing: the hint simply keeps showing, which is harmless.
        }
    }

    class AnimalActions {
        /**
         * @param {object} opts
         * @param {HTMLElement} opts.root Where the card and hint are attached.
         * @param {function(object):void} opts.onDart   Send the ranger after an animal.
         * @param {function():void} opts.onCancel       Call the ranger off.
         * @param {function(object):void} opts.onFollow Put the camera on an animal.
         */
        constructor(opts) {
            this.opts = opts;
            this.animal = null;
            this._pinned = false;
            this._x = 0;
            this._y = 0;
            this._uses = readUses();
            this._build(opts.root);
        }

        /* -------------------------------------------------------------- *
         * DOM
         * -------------------------------------------------------------- */

        _build(root) {
            const icons = (Safari.HUD && Safari.HUD.ICONS) || {};

            const card = document.createElement('div');
            card.className = 'animal-card';
            card.setAttribute('role', 'dialog');
            card.setAttribute('aria-label', 'Animal actions');
            card.innerHTML = [
                '<div class="animal-card__head">',
                '  <span class="animal-card__name"></span>',
                '  <button type="button" class="animal-card__close" aria-label="Close">&times;</button>',
                '</div>',
                '<div class="animal-card__status"></div>',
                '<div class="animal-card__actions">',
                '  <button type="button" class="animal-card__btn animal-card__btn--dart">',
                '    <span class="animal-card__icon">' + (icons.tranq || '') + '</span>',
                '    <span class="animal-card__label">Dart</span><kbd>T</kbd>',
                '  </button>',
                '  <button type="button" class="animal-card__btn animal-card__btn--follow">',
                '    <span class="animal-card__label">Follow</span><kbd>F</kbd>',
                '  </button>',
                '</div>'
            ].join('');
            root.appendChild(card);

            const hint = document.createElement('div');
            hint.className = 'animal-hint';
            hint.textContent = 'Click to dart or follow';
            root.appendChild(hint);

            this.el = {
                card,
                hint,
                name: card.querySelector('.animal-card__name'),
                status: card.querySelector('.animal-card__status'),
                dart: card.querySelector('.animal-card__btn--dart'),
                dartLabel: card.querySelector('.animal-card__btn--dart .animal-card__label'),
                follow: card.querySelector('.animal-card__btn--follow'),
                close: card.querySelector('.animal-card__close')
            };

            this.el.dart.addEventListener('click', () => this.dart());
            this.el.follow.addEventListener('click', () => this.follow());
            this.el.close.addEventListener('click', () => this.close());

            // Hold the card still while the pointer is on it, so a button on a running
            // animal's card does not slide out from under the cursor.
            card.addEventListener('pointerenter', () => { this._pinned = true; });
            card.addEventListener('pointerleave', () => { this._pinned = false; });
            // Nothing that happens on the card is a click on the reserve beneath it.
            card.addEventListener('pointerdown', (e) => e.stopPropagation());
            card.addEventListener('wheel', (e) => e.stopPropagation());
        }

        /* -------------------------------------------------------------- *
         * Commands
         * -------------------------------------------------------------- */

        get isOpen() {
            return !!this.animal;
        }

        /** Open the card on an animal. */
        open(animal) {
            if (!animal) return;
            const first = this.animal !== animal;
            this.animal = animal;
            this._pinned = false;
            this.el.card.classList.add('is-open');
            if (first) {
                this.el.name.textContent = IsoSpecies[animal.species].label;
                this._snap = true;
                this._uses++;
                writeUses(this._uses);
            }
        }

        close() {
            this.animal = null;
            this._pinned = false;
            this.el.card.classList.remove('is-open');
        }

        /** Dart the animal on the card, or call the ranger off if it is already after it. */
        dart() {
            const a = this.animal;
            if (!a) return;
            const ranger = this._scene && this._scene.ranger;
            if (ranger && ranger.quarry === a) {
                this.opts.onCancel();
                return;
            }
            this.opts.onDart(a);
        }

        follow() {
            if (this.animal) this.opts.onFollow(this.animal);
        }

        /* -------------------------------------------------------------- *
         * Frame
         * -------------------------------------------------------------- */

        /**
         * Keep the card on its animal, and tell the player what is happening to it.
         *
         * @param {object} ctx
         * @param {Safari.Scene3D} ctx.scene
         * @param {object|null} ctx.hovered Animal under the pointer, for the hint.
         * @param {{x:number,y:number}} ctx.pointer Pointer in screen pixels.
         * @param {boolean} ctx.active The reserve is in play and nothing is armed.
         */
        update(ctx) {
            this._scene = ctx.scene;
            this._updateHint(ctx);

            const a = this.animal;
            if (!a) return;
            if (!a.alive || ctx.scene.ecology.animals.indexOf(a) < 0) {
                this.close();
                return;
            }

            const scene = ctx.scene;
            const R3D = Safari.R3D;
            const top = R3D.surfaceY(scene.world, a.x, a.y) +
                Safari.Creature3D.topOf(a.spec) * (a.renderState.baby ? 0.7 : 1) + 0.25;
            const p = scene.camera.worldToScreen(a.x, top, a.y, this._screen || (this._screen = {}));
            const card = this.el.card;
            card.classList.toggle('is-offscreen', !p.visible);

            if (!this._pinned) {
                if (this._snap) {
                    this._x = p.x;
                    this._y = p.y;
                    this._snap = false;
                } else {
                    // Eased, so the card floats with the animal instead of jittering.
                    this._x = MathUtils.lerp(this._x, p.x, 0.35);
                    this._y = MathUtils.lerp(this._y, p.y, 0.35);
                }
            }
            const w = card.offsetWidth, h = card.offsetHeight;
            const vw = window.innerWidth, vh = window.innerHeight;
            const x = MathUtils.clamp(this._x - w / 2, 8, vw - w - 8);
            const y = MathUtils.clamp(this._y - h - 14, 70, vh - h - 110);
            card.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';

            this._describe(scene);
        }

        /** The status line and the state of the Dart button. */
        _describe(scene) {
            const a = this.animal;
            const ranger = scene.ranger;
            const el = this.el;
            let status = '';
            let tone = '';
            let label = 'Dart';
            let enabled = true;

            if (a.state === IsoAnimal.State.TRANQUILIZED) {
                const loading = scene.relocation.queue.indexOf(a) >= 0 ||
                    scene.relocation.loader.quarry === a;
                status = loading ? 'Sedated — the loader is on its way' : 'Sedated';
                tone = 'good';
                label = 'Sedated';
                enabled = false;
            } else if (ranger.quarry === a) {
                const d = Math.hypot(a.x - ranger.x, a.y - ranger.y);
                status = d <= ranger.dartRange * 0.72
                    ? 'Taking the shot…'
                    : 'Ranger closing in · ' + Math.round(d) + ' tiles';
                tone = 'cool';
                label = 'Call off';
            } else if (a.isDown) {
                status = 'Down';
                enabled = false;
            } else if (ranger.quarry) {
                status = 'The ranger is after another animal';
                label = 'Dart this one';
            } else {
                status = 'Dart it to relocate it to another reserve';
            }

            if (el.status.textContent !== status) el.status.textContent = status;
            el.status.dataset.tone = tone;
            if (el.dartLabel.textContent !== label) el.dartLabel.textContent = label;
            el.dart.disabled = !enabled;
            el.dart.classList.toggle('is-cancel', ranger.quarry === a);
        }

        /**
         * The first few times a player hovers an animal with nothing else going on,
         * say that it can be clicked. Once they have opened the card a few times, stop.
         */
        _updateHint(ctx) {
            const hint = this.el.hint;
            const show = ctx.active && !!ctx.hovered && !this.animal && this._uses < HINT_LIMIT;
            hint.classList.toggle('is-visible', show);
            if (show) {
                hint.style.transform = 'translate(' + Math.round(ctx.pointer.x + 16) + 'px,' +
                    Math.round(ctx.pointer.y + 18) + 'px)';
            }
        }
    }

    Safari.AnimalActions = AnimalActions;

})(window.Safari);
