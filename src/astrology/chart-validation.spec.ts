import { Kundli, UserProfile } from '../upstream/types';
import { assessBirthTime, assessChart } from './chart-validation';

const libraChart: Kundli = {
  lagna: 'Libra',
  moonSign: 'Scorpio',
  currentDasha: { mahadasha: 'Rahu', antardasha: 'Mars' },
  houses: {
    '6': { lord: 'Jupiter', strength: 'Average' },
    '7': { lord: 'Mars', strength: 'Weak' },
    '10': { lord: 'Moon', strength: 'Strong' },
  },
};

const user = (overrides: Partial<UserProfile['birthDetails']> = {}): UserProfile => ({
  id: 'u',
  name: 'Test',
  language: 'en',
  subscription: 'premium',
  tonePreference: 'neutral',
  birthDetails: { date: '1997-08-15', time: '09:35', place: 'Delhi', ...overrides },
});

describe('chart validation', () => {
  it("accepts the brief's sample chart as internally consistent", () => {
    // A Libra lagna puts Pisces on the 6th (Jupiter), Aries on the 7th (Mars)
    // and Cancer on the 10th (Moon) - exactly what the payload claims.
    const result = assessChart(libraChart, user());
    expect(result.inconsistencies).toEqual([]);
    expect(result.housesUsable).toBe(true);
  });

  it('detects a house lord that the stated lagna cannot produce', () => {
    const broken: Kundli = {
      ...libraChart,
      houses: { ...libraChart.houses, '10': { lord: 'Saturn', strength: 'Strong' } },
    };
    const result = assessChart(broken, user());
    expect(result.inconsistencies).toHaveLength(1);
    expect(result.inconsistencies[0]).toContain('House 10');
    expect(result.inconsistencies[0]).toContain('Moon');
    expect(result.housesUsable).toBe(false);
  });

  it('flags an unrecognised lagna', () => {
    const result = assessChart({ ...libraChart, lagna: 'Ophiuchus' }, user());
    expect(result.inconsistencies.some((i) => i.includes('lagna'))).toBe(true);
  });

  describe('birth time reliability', () => {
    it('trusts an explicit accuracy flag over the heuristic', () => {
      expect(assessBirthTime(user({ time: '09:00', timeAccuracy: 'exact' }))).toBe('exact');
      expect(assessBirthTime(user({ time: '09:35', timeAccuracy: 'unknown' }))).toBe('unknown');
    });

    it('treats an off-the-clock time as precise', () => {
      expect(assessBirthTime(user({ timeAccuracy: undefined }))).toBe('exact');
    });

    it('treats a time on the hour or half hour as remembered, not recorded', () => {
      expect(assessBirthTime(user({ time: '09:00', timeAccuracy: undefined }))).toBe('approximate');
      expect(assessBirthTime(user({ time: '18:30', timeAccuracy: undefined }))).toBe('approximate');
    });

    it('reports unknown when there is no time at all', () => {
      expect(assessBirthTime(user({ time: undefined, timeAccuracy: undefined }))).toBe('unknown');
      expect(assessBirthTime(undefined)).toBe('unknown');
    });
  });

  it('suppresses house analysis when the birth time is unknown', () => {
    const result = assessChart(libraChart, user({ time: undefined, timeAccuracy: 'unknown' }));
    expect(result.housesUsable).toBe(false);
    expect(result.notes.join(' ')).toContain('Moon sign');
  });
});
