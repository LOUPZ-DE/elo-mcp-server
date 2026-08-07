// Polyfill for `Math.sumPrecise`, which pdf.js calls but Node 24 does not ship.
//
// unpdf 1.8.0 bundles a pdf.js that uses `Math.sumPrecise` in seven places,
// including `_getTextWidth` — squarely in the text path we depend on. The
// function is a recent TC39 proposal; V8 in Node 24 does not provide it yet, so
// affected PDFs fail with "Math.sumPrecise is not a function". Not every
// document reaches those code paths, which is why extraction works for some
// files and not others.
//
// Downgrading unpdf loses fixes and 1.8.0 is the current release; moving to a
// Node that has the function would mean running Current instead of LTS in
// production. Supplying the function is the smaller change, and it disappears
// on its own once Node ships it — the install is a no-op when it already exists.

/**
 * Exact-as-practical sum of an iterable of numbers.
 *
 * Uses Neumaier compensated summation. The TC39 proposal guarantees a
 * *correctly rounded* result for any input; this is a close approximation of
 * that, not a formal implementation of it. The distinction does not matter for
 * the callers here — pdf.js sums glyph widths, column widths, byte lengths and
 * array sizes, which are small sets of small (and often integral) values where
 * compensated summation is already exact.
 *
 * Edge cases follow the proposal: NaN anywhere wins, opposing infinities give
 * NaN, and an empty iterable gives -0.
 */
export function sumPrecise(items: Iterable<number>): number {
  if (items === null || items === undefined || typeof (items as any)[Symbol.iterator] !== 'function') {
    throw new TypeError('Math.sumPrecise: argument is not iterable');
  }

  let sum = 0;
  let compensation = 0;
  let count = 0;
  let sawNaN = false;
  let sawPosInf = false;
  let sawNegInf = false;
  let allNegativeZero = true;

  for (const value of items) {
    if (typeof value !== 'number') {
      throw new TypeError('Math.sumPrecise: all values must be numbers');
    }
    count++;

    if (Number.isNaN(value)) {
      sawNaN = true;
      allNegativeZero = false;
      continue;
    }
    if (value === Infinity) {
      sawPosInf = true;
      allNegativeZero = false;
      continue;
    }
    if (value === -Infinity) {
      sawNegInf = true;
      allNegativeZero = false;
      continue;
    }
    if (!(value === 0 && Object.is(value, -0))) {
      allNegativeZero = false;
    }

    // Neumaier: keep the rounding error that `sum + value` discards, choosing
    // the branch by magnitude so the smaller operand's low bits are the ones
    // recovered.
    const t = sum + value;
    compensation +=
      Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum;
    sum = t;
  }

  if (sawNaN) return NaN;
  if (sawPosInf && sawNegInf) return NaN;
  if (sawPosInf) return Infinity;
  if (sawNegInf) return -Infinity;
  if (count === 0) return -0;
  if (allNegativeZero) return -0;

  return sum + compensation;
}

/**
 * Install the polyfill if the runtime lacks it. Idempotent, and deliberately
 * non-enumerable so it behaves like the built-in it stands in for.
 *
 * Must run before pdf.js is evaluated — `extractPdf` calls it ahead of its
 * dynamic `import('unpdf')`.
 */
export function installSumPrecisePolyfill(): void {
  const target = Math as unknown as { sumPrecise?: unknown };
  if (typeof target.sumPrecise === 'function') return;

  Object.defineProperty(Math, 'sumPrecise', {
    value: sumPrecise,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
