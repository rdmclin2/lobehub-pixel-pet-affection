'use strict';

// The chat box opens under her feet (T-6162), so it never covers her: her window grows downward by the box's
// height. Next to the bottom of the screen there is no room for that, so the window goes up by what is missing
// (`lift`), and comes down again as the box shrinks or closes. Her top-left stays where it was otherwise.
//   bounds    the window now, `prevExtra` of its height being the room for the box
//   extra     the room the box wants now (0: closed)
//   lift      how far up the window was moved for the box so far
// -> { x, y, width, height, lift }
function composerBounds({ bounds, prevExtra = 0, extra = 0, lift = 0, area }) {
  const restY = bounds.y + lift;
  const height = bounds.height - prevExtra + extra;
  const y = Math.max(area.y, Math.min(restY, area.y + area.height - height));
  return { x: bounds.x, y, width: bounds.width, height, lift: restY - y };
}

module.exports = { composerBounds };
