// The band cut-lines are V03's reading of the Ada'a card (not in the
// repository, D-11); these tests pin the ported behaviour, not the source.
import { describe, expect, it } from 'vitest';
import { computeKpiA, computeKpiB, scoreArea } from './kpi.js';

describe('nurse-to-bed KPI', () => {
  it.each([
    ['ICU', 10, 10, 1], ['ICU', 5, 10, 2], ['ICU', 4, 12, 3], ['ICU', 2, 10, 4],
    ['ER', 5, 10, 1], ['ER', 3, 10, 2], ['ER', 1, 10, 4],
    ['OR', 20, 10, 1], ['OR', 10, 10, 2], ['OR', 5, 10, 3], ['OR', 2, 10, 4],
  ] as const)('%s with %i nurses and %i beds codes %i', (area, nurses, beds, code) => {
    expect(scoreArea(area, nurses, beds).code).toBe(code);
  });

  it('no nurses is the worst code, never a division error', () => {
    expect(scoreArea('ICU', 0, 10)).toMatchObject({ code: 4, band: 'Failed', ratioLabel: '—' });
  });

  it('KPI A averages the three codes', () => {
    const a = computeKpiA({ ICU: { nurses: 10, beds: 10 }, ER: { nurses: 3, beds: 10 }, OR: { nurses: 2, beds: 10 } });
    expect(a.averageCode).toBe(2.3);
    expect(a.band).toBe('Distress');
  });

  it.each([[100, 500, 'Standard'], [100, 650, 'Distress'], [100, 900, 'Failing'], [100, 901, 'Failed'], [0, 10, 'Failed']] as const)(
    'KPI B: %i nurses for %i beds is %s', (nurses, beds, band) => { expect(computeKpiB(nurses, beds).band).toBe(band); },
  );
});
