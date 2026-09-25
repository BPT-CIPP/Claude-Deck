'use strict';
// Ticks every half second for the window icon's "working" animation (app.js setAppIcon). Timers in
// a worker keep their pace while the window is minimized or covered; the page's own timers don't.

setInterval(() => postMessage(0), 500);
