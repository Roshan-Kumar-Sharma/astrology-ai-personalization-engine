import {
  antardashaSequence,
  antardashaYears,
  DASHA_SEQUENCE,
  DASHA_YEARS,
  locateDasha,
  nakshatraLord,
  TOTAL_CYCLE_YEARS,
} from './vimshottari';

describe('Vimshottari dasha', () => {
  it('has the canonical 120-year cycle', () => {
    expect(DASHA_SEQUENCE).toHaveLength(9);
    const total = DASHA_SEQUENCE.reduce((s, p) => s + DASHA_YEARS[p], 0);
    expect(total).toBe(TOTAL_CYCLE_YEARS);
  });

  it('starts each antardasha sequence with the mahadasha lord itself', () => {
    expect(antardashaSequence('Rahu')).toEqual([
      'Rahu',
      'Jupiter',
      'Saturn',
      'Mercury',
      'Ketu',
      'Venus',
      'Sun',
      'Moon',
      'Mars',
    ]);
    expect(antardashaSequence('Jupiter')[0]).toBe('Jupiter');
  });

  it('computes antardasha length as md x ad / 120 years', () => {
    // Rahu 18y, Mars 7y -> 18 * 7 / 120 = 1.05 years = 12.6 months
    expect(antardashaYears('Rahu', 'Mars')).toBeCloseTo(1.05, 5);
  });

  it('sub-periods of a mahadasha sum to its full length', () => {
    for (const md of DASHA_SEQUENCE) {
      const sum = antardashaSequence(md).reduce((s, ad) => s + antardashaYears(md, ad), 0);
      expect(sum).toBeCloseTo(DASHA_YEARS[md], 6);
    }
  });

  /**
   * The assignment's own sample payload. Rahu-Mars looks like an arbitrary
   * mid-period pointer, but Mars is the ninth and final sub-period of Rahu -
   * the user is at the end of an 18-year chapter. That is the single most
   * relevant fact for "should I change my job", and it is invisible in the raw
   * JSON.
   */
  it('identifies Rahu-Mars as the closing sub-period of the Rahu mahadasha', () => {
    const pos = locateDasha('Rahu', 'Mars')!;
    expect(pos.antardashaIndex).toBe(9);
    expect(pos.isFinalAntardasha).toBe(true);
    expect(pos.phase).toBe('closing');
    expect(pos.antardashaMonths).toBeCloseTo(12.6, 1);
    expect(pos.nextMahadasha).toBe('Jupiter');
    expect(pos.chapterProgress.toPct).toBe(100);
  });

  it('identifies an opening sub-period', () => {
    const pos = locateDasha('Jupiter', 'Jupiter')!;
    expect(pos.isOpeningAntardasha).toBe(true);
    expect(pos.phase).toBe('opening');
    expect(pos.chapterProgress.fromPct).toBe(0);
  });

  it('places Jupiter-Saturn early in the Jupiter mahadasha', () => {
    const pos = locateDasha('Jupiter', 'Saturn')!;
    expect(pos.antardashaIndex).toBe(2);
    expect(pos.isFinalAntardasha).toBe(false);
    expect(pos.phase).toBe('early');
  });

  it('is case-insensitive and rejects non-dasha lords', () => {
    expect(locateDasha('rahu', 'mars')?.antardashaIndex).toBe(9);
    expect(locateDasha('Pluto', 'Mars')).toBeUndefined();
    expect(locateDasha('Rahu', '')).toBeUndefined();
  });

  it('maps nakshatras to their dasha lords on a repeating nine-cycle', () => {
    expect(nakshatraLord('Ashwini')).toBe('Ketu');
    expect(nakshatraLord('Rohini')).toBe('Moon');
    expect(nakshatraLord('Magha')).toBe('Ketu'); // 10th, wraps to the start
    expect(nakshatraLord('Revati')).toBe('Mercury'); // 27th
    expect(nakshatraLord('NotANakshatra')).toBeUndefined();
  });
});
