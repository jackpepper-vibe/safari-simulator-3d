/**
 * Safari Simulator 3D — Interface icon set.
 *
 * The inline SVGs the HUD stamps into the clock, the event feed and the sound button.
 *
 * In the 2D build these lived at the top of the side-on `HUD.js`, and the isometric
 * build loaded that whole file just to reach them. There is no side-on HUD in this
 * fork, so the set is lifted out on its own and published under the name the interface
 * already asks for — `Safari.HUD.ICONS` — which keeps `IsoHud` identical to the 2D
 * build's copy.
 */
(function (Safari) {
    'use strict';

    const ICONS = {
        sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.6"/><g stroke-width="2" stroke-linecap="round"><path d="M12 2.4v2.6M12 19v2.6M2.4 12h2.6M19 12h2.6M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9"/></g></svg>',
        moon: '<svg viewBox="0 0 24 24"><path d="M20 14.6A8.6 8.6 0 0 1 9.4 4 8.6 8.6 0 1 0 20 14.6z"/></svg>',
        dawn: '<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="4"/><g stroke-width="2" stroke-linecap="round"><path d="M3 20h18M6 14H3.5M20.5 14H18M12 6.5V4M6.6 8.6L5 7M17.4 8.6L19 7"/></g></svg>',
        dusk: '<svg viewBox="0 0 24 24"><circle cx="12" cy="15" r="4"/><g stroke-width="2" stroke-linecap="round"><path d="M3 20h18M3.5 15H6M18 15h2.5M12 7.5V5"/></g></svg>',
        cloud: '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.5 1.3A3.4 3.4 0 0 0 7 18z"/></svg>',
        rain: '<svg viewBox="0 0 24 24"><path d="M7 14h10a3.6 3.6 0 0 0 .4-7.2A5 5 0 0 0 7.2 8 3.1 3.1 0 0 0 7 14z"/><g stroke-width="2" stroke-linecap="round"><path d="M8.5 17l-1 3M12.5 17l-1 3M16.5 17l-1 3"/></g></svg>',
        wind: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M3 9h10a3 3 0 1 0-3-3M3 14h13a3 3 0 1 1-3 3"/></svg>',
        predator: '<svg viewBox="0 0 24 24"><path d="M12 3l2.4 4.2 4.6.9-3.2 3.4.6 4.7L12 14.4 7.6 16.2l.6-4.7L5 8.1l4.6-.9z"/></svg>',
        prey: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.6-7-9.6A4.4 4.4 0 0 1 12 8a4.4 4.4 0 0 1 7 3.4C19 16.4 12 21 12 21z"/></svg>',
        born: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.2" fill="none" stroke-width="2"/><path d="M12 7.4v9.2M7.4 12h9.2" stroke-width="2" stroke-linecap="round"/></svg>',
        eaten: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M6 3v8a2.6 2.6 0 0 0 5.2 0V3M8.6 3v18M17.4 3c-1.7 1.4-2.4 3.4-2.4 5.6 0 1.8.8 2.8 2.4 3.2V21"/></svg>',
        starved: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M4 20L20 4M4 4l16 16"/></svg>',
        tranq: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M14 3l7 7M18.5 6.5L9 16l-4 1 1-4 9.5-9.5M6 14l4 4"/></svg>',
        sound: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.4L12 18.6V5.4L7.4 9.5z"/><path d="M15.4 8.6a4.8 4.8 0 0 1 0 6.8M18 6a8.4 8.4 0 0 1 0 12" fill="none" stroke-width="2" stroke-linecap="round"/></svg>',
        mute: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.4L12 18.6V5.4L7.4 9.5z"/><path d="M16 9.6l5 5M21 9.6l-5 5" fill="none" stroke-width="2" stroke-linecap="round"/></svg>'
    };

    Safari.HUD = Safari.HUD || {};
    Safari.HUD.ICONS = ICONS;

})(window.Safari);
