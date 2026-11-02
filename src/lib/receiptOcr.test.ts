import { describe, expect, it } from 'vitest';
import { ctcDecode, dbBoxes, textAngle } from './receiptOcr';

describe('PaddleOCR post-processing', () => {
  it('finds one box per blob of text pixels, grown by the unclip distance', () => {
    // 10×6 map with two separate 3×2 blobs.
    const w = 10, h = 6;
    const prob = new Float32Array(w * h);
    for (const [x, y] of [[1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [6, 3], [7, 3], [8, 3], [6, 4], [7, 4], [8, 4]]) prob[y * w + x] = 0.9;
    const boxes = dbBoxes(prob, w, h, { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, minSize: 2 });
    expect(boxes).toHaveLength(2);
    // 3×2 box: d = 6 × 1.5 / 10 = 0.9
    const [b] = boxes;
    for (const [got, want] of [[b.x0, 0.1], [b.y0, 0.1], [b.x1, 4.9], [b.y1, 3.9]]) expect(got).toBeCloseTo(want);
  });

  it('drops faint regions and slivers', () => {
    const w = 6, h = 4;
    const prob = new Float32Array(w * h);
    for (const x of [1, 2, 3]) { prob[w + x] = 0.4; prob[2 * w + x] = 0.4; } // faint: mean 0.4 < 0.6
    prob[5] = 0.9; // 1×1 sliver
    expect(dbBoxes(prob, w, h, { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, minSize: 2 })).toEqual([]);
  });

  it('decodes CTC output: collapses repeats, drops blanks, maps the extra class to a space', () => {
    const dict = ['A', 'B'];
    // classes: 0 blank, 1 'A', 2 'B', 3 space
    const steps = [1, 1, 0, 1, 3, 2];
    const scores = new Float32Array(steps.length * 4);
    steps.forEach((c, t) => { scores[t * 4 + c] = 0.9; });
    expect(ctcDecode(scores, steps.length, 4, dict).text).toBe('AA B');
  });
});

describe('how the text slants', () => {
  const line = (angle: number, pixels = 400) => ({ angle, elongation: 0.95, pixels });

  it('reads a region’s slant from its shape', () => {
    // A thin line of pixels running down to the right at 1 in 10 (5.7°).
    const w = 60, h = 12;
    const prob = new Float32Array(w * h);
    for (let x = 0; x < 50; x++) for (const dy of [0, 1]) prob[(2 + Math.floor(x / 10) + dy) * w + x] = 0.9;
    const [r] = dbBoxes(prob, w, h, { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, minSize: 2 });
    expect(r.angle).toBeGreaterThan(4);
    expect(r.angle).toBeLessThan(8);
    expect(r.elongation).toBeGreaterThan(0.9);
  });

  it('takes the weighted average of the line-like regions', () => {
    expect(textAngle([line(5), line(6), line(4)])).toBeCloseTo(5, 5);
    // Round blobs (single characters, logos) don't count.
    expect(textAngle([line(-3), { angle: 40, elongation: 0.2, pixels: 5000 }])).toBeCloseTo(-3, 5);
  });

  it('treats nearly-vertical lines either side of 90° as one direction', () => {
    // A sideways photo: 89° and -89° are both "almost vertical", not opposites.
    expect(Math.abs(textAngle([line(89), line(-89)]))).toBeCloseTo(90, 5);
  });

  it('is level when there is nothing to go by', () => {
    expect(textAngle([])).toBe(0);
  });
});
