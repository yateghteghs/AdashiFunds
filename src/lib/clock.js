'use strict';
// Overridable clock so due dates and the scheduler can be tested deterministically.
let offsetMs = 0;

const clock = {
  now: () => new Date(Date.now() + offsetMs),
  iso: () => clock.now().toISOString(),
  advance(ms) { offsetMs += ms; },
  reset() { offsetMs = 0; },
};

module.exports = clock;
