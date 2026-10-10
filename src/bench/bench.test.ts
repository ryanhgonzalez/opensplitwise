import { describe, expect, it } from 'vitest';
import { boxesToLines, dedupeOverlap, docTagsToLines, extractJson, quadToBox } from './lines';
import { itemsF1, merchantMatches, scoreExtraction, summarize } from './score';

describe('scoring', () => {
  it('matches merchants loosely', () => {
    expect(merchantMatches('PINGO DOCE LISBOA', 'Pingo Doce')).toBe(true);
    expect(merchantMatches('Café Nicola', 'Cafe Nicola')).toBe(true);
    expect(merchantMatches('Starbucks', 'Pingo Doce')).toBe(false);
  });

  it('scores items by amount plus a loose description match', () => {
    const truth = [
      { description: 'Grilled tiger prawns', amount: 64 },
      { description: 'Beers', amount: 35.5 },
    ];
    expect(itemsF1(truth, truth)).toBe(1);
    // Right amount, unrelated description: not a hit.
    expect(itemsF1([{ description: 'Tax', amount: 64 }], truth)).toBe(0);
    // One of two found, one extra: precision 1/2, recall 1/2.
    expect(itemsF1([{ description: 'TIGER PRAWNS', amount: 64 }, { description: 'Bread', amount: 2 }], truth)).toBeCloseTo(0.5);
  });

  it('skips fields the label leaves out', () => {
    const s = scoreExtraction({ total: 12.5, date: '2026-09-14' }, { total: 12.5 });
    expect(s).toEqual({ total: true, date: null, merchant: null, itemsF1: null });
  });

  it('summarizes only scored fields and counts failures', () => {
    const sum = summarize([
      { scores: { total: true, date: false, merchant: null, itemsF1: 1 }, ms: 100 },
      { scores: { total: false, date: true, merchant: null, itemsF1: null }, ms: 300 },
      { scores: null, ms: null },
    ]);
    expect(sum.total).toBe(0.5);
    expect(sum.merchant).toBeNull();
    expect(sum.itemsF1).toBe(1);
    expect(sum.medianMs).toBe(200);
    expect(sum.failures).toBe(1);
  });
});

describe('line reconstruction', () => {
  it('joins boxes on the same row, left to right', () => {
    const lines = boxesToLines([
      quadToBox('3.50', [200, 10, 240, 10, 240, 30, 200, 30]),
      quadToBox('Coffee', [10, 12, 80, 12, 80, 31, 10, 31]),
      quadToBox('TOTAL 3.50', [10, 60, 240, 60, 240, 80, 10, 80]),
    ]);
    expect(lines).toEqual(['Coffee  3.50', 'TOTAL 3.50']);
  });

  it('drops a line repeated across overlapping tiles', () => {
    const a = quadToBox('Coffee 3.50', [10, 500, 200, 500, 200, 520, 10, 520]);
    const b = quadToBox('Coffee 3.50', [12, 504, 201, 504, 201, 524, 12, 524]);
    expect(dedupeOverlap([a, b], 20)).toHaveLength(1);
  });

  it('flattens DocTags tables into rows', () => {
    const doctags =
      '<doctag><text><loc_10><loc_10><loc_90><loc_20>PINGO DOCE</text>' +
      '<otsl><fcel>Milk<fcel>1.29<nl><fcel>Bread<fcel>0.89<nl></otsl></doctag>';
    expect(docTagsToLines(doctags)).toEqual(['PINGO DOCE', 'Milk  1.29', 'Bread  0.89']);
  });

  it('finds JSON wrapped in prose or a code fence', () => {
    expect(extractJson('Sure!\n```json\n{"total": 4.2}\n```')).toEqual({ total: 4.2 });
    expect(extractJson('no json here')).toBeNull();
  });
});
