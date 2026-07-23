/* Self-check for the alpha matte math in app.js (separate()).
   Run: node test.js  — mirrors the per-pixel formula, asserts key behavior. */
const assert = require("assert");

function alpha(mode, r, g, b, threshold, feather) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const clamp = (v) => Math.max(0, Math.min(255, v));
  if (mode === "hard") return lum >= threshold ? 0 : 255;
  if (mode === "soft") return clamp((threshold - lum) / Math.max(1, feather) * 255);
  return 255 - lum; // matte
}

// white -> transparent, black -> opaque, in every mode
assert.strictEqual(alpha("matte", 255, 255, 255), 0, "matte: white transparent");
assert.strictEqual(alpha("matte", 0, 0, 0), 255, "matte: black opaque");
assert.strictEqual(alpha("hard", 255, 255, 255, 235), 0, "hard: white transparent");
assert.strictEqual(alpha("hard", 10, 10, 10, 235), 255, "hard: dark opaque");
assert.strictEqual(alpha("soft", 255, 255, 255, 235, 40), 0, "soft: white transparent");
assert.strictEqual(alpha("soft", 0, 0, 0, 235, 40), 255, "soft: black opaque");
// mid-gray in soft mode is partially opaque (anti-aliased edge)
const mid = alpha("soft", 200, 200, 200, 235, 40);
assert.ok(mid > 0 && mid < 255, "soft: gray edge is semi-transparent");

console.log("ok");
