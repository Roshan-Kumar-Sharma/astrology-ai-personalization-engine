import {
  jupiterFromMoon,
  MONTHS_PER_SIGN,
  nodesFromMoon,
  saturnFromMoon,
  signProgress,
  signsFrom,
} from './gochar';

describe('Gochar (transits)', () => {
  describe('signsFrom', () => {
    it('counts inclusively, so a planet in the Moon sign itself is the 1st', () => {
      expect(signsFrom('Aries', 'Aries')).toBe(1);
      expect(signsFrom('Aries', 'Taurus')).toBe(2);
      expect(signsFrom('Aries', 'Pisces')).toBe(12);
    });

    it('wraps around the zodiac', () => {
      // Aquarius -> Pisces is one step forward.
      expect(signsFrom('Aquarius', 'Pisces')).toBe(2);
      // Pisces -> Aquarius is eleven steps forward.
      expect(signsFrom('Pisces', 'Aquarius')).toBe(12);
    });

    it('accepts rashi names', () => {
      expect(signsFrom('Kumbha', 'Meena')).toBe(2);
    });

    it('is undefined for an unknown sign rather than guessing', () => {
      expect(signsFrom('Aries', 'Ophiuchus')).toBeUndefined();
    });
  });

  describe('signProgress', () => {
    it('reads direct planets forward through the sign', () => {
      // Saturn at 7 degrees: 23.3% through, (1 - 0.233) * 29.5 = 22.6 months left.
      expect(signProgress('Saturn', 7)).toEqual({ pct: 23.3, monthsRemaining: 22.6 });
    });

    it('reads the nodes backwards - Rahu enters a sign at 30 and leaves at 0', () => {
      // Rahu at 4 degrees is nearly OUT of the sign, not nearly in.
      const r = signProgress('Rahu', 4);
      expect(r.pct).toBe(86.7);
      expect(r.monthsRemaining).toBe(2.5);
      // Whereas a direct planet at 4 degrees has just arrived.
      expect(signProgress('Jupiter', 4).pct).toBe(13.3);
    });

    it('clamps out-of-range degrees instead of producing negative months', () => {
      expect(signProgress('Saturn', 45).monthsRemaining).toBe(0);
      expect(signProgress('Saturn', -3).pct).toBe(0);
    });

    it('derives months-per-sign from the orbital periods', () => {
      // 29.457 years / 12 signs = 2.455 years = 29.5 months.
      expect(MONTHS_PER_SIGN.Saturn).toBeCloseTo((29.457 * 12) / 12, 0);
      expect(MONTHS_PER_SIGN.Jupiter).toBeCloseTo((11.862 * 12) / 12, 0);
    });
  });

  describe('Saturn from the Moon', () => {
    const saturnInPisces = { sign: 'Pisces', degree: 7 };

    it('finds the three Sade Sati phases at the 12th, 1st and 2nd from the Moon', () => {
      expect(saturnFromMoon('Aries', saturnInPisces)).toMatchObject({
        fromMoon: 12,
        kind: 'sade_sati',
        phase: 'rising',
      });
      expect(saturnFromMoon('Pisces', saturnInPisces)).toMatchObject({
        fromMoon: 1,
        kind: 'sade_sati',
        phase: 'peak',
      });
      expect(saturnFromMoon('Aquarius', saturnInPisces)).toMatchObject({
        fromMoon: 2,
        kind: 'sade_sati',
        phase: 'setting',
      });
    });

    it('measures the whole seven-and-a-half-year cycle, not just the current sign', () => {
      // Setting phase, 7 degrees in: 60 + 7 = 67 of 90 degrees = 74.4% through.
      // Remaining: (1 - 0.744) * 3 signs * 29.5 months = 22.6 months.
      const t = saturnFromMoon('Aquarius', saturnInPisces)!;
      expect(t.cycle).toEqual({ pct: 74.4, monthsRemaining: 22.6 });
      // Rising phase at the same degree has two more signs to go.
      const rising = saturnFromMoon('Aries', saturnInPisces)!;
      expect(rising.cycle!.pct).toBe(7.8);
      expect(rising.cycle!.monthsRemaining).toBe(81.6);
    });

    it('names the two small panotis at the 4th and 8th', () => {
      expect(saturnFromMoon('Sagittarius', saturnInPisces)).toMatchObject({
        fromMoon: 4,
        kind: 'dhaiya',
        dhaiyaName: 'Kantaka Shani',
      });
      expect(saturnFromMoon('Leo', saturnInPisces)).toMatchObject({
        fromMoon: 8,
        kind: 'dhaiya',
        dhaiyaName: 'Ashtama Shani',
      });
    });

    it('marks the 3rd, 6th and 11th as favourable and everything else as plain', () => {
      // Taurus Moon: Pisces is the 11th.
      expect(saturnFromMoon('Taurus', saturnInPisces)).toMatchObject({
        fromMoon: 11,
        kind: 'plain',
        favourable: true,
      });
      // Scorpio Moon: Pisces is the 5th.
      expect(saturnFromMoon('Scorpio', saturnInPisces)).toMatchObject({
        fromMoon: 5,
        kind: 'plain',
        favourable: false,
      });
    });

    it('never reports a cycle for a transit that is not Sade Sati', () => {
      expect(saturnFromMoon('Taurus', saturnInPisces)!.cycle).toBeUndefined();
      expect(saturnFromMoon('Leo', saturnInPisces)!.cycle).toBeUndefined();
    });
  });

  describe('Jupiter from the Moon', () => {
    it('applies the classical favourable positions and reports dignity', () => {
      // Scorpio Moon, Jupiter in Cancer: 9th from the Moon, and exalted.
      expect(jupiterFromMoon('Scorpio', { sign: 'Cancer', degree: 10 })).toEqual({
        fromMoon: 9,
        favourable: true,
        dignity: 'exalted',
        progress: { pct: 33.3, monthsRemaining: 7.9 },
      });
      // Taurus Moon, Jupiter in Cancer: 3rd, not favourable.
      expect(jupiterFromMoon('Taurus', { sign: 'Cancer', degree: 10 })).toMatchObject({
        fromMoon: 3,
        favourable: false,
      });
      // Debilitated in Capricorn.
      expect(jupiterFromMoon('Aries', { sign: 'Capricorn', degree: 1 })!.dignity).toBe(
        'debilitated',
      );
    });
  });

  describe('Rahu / Ketu from the Moon', () => {
    it('places Ketu exactly opposite Rahu', () => {
      // Taurus Moon, Rahu in Aquarius: 10th from the Moon, so Ketu is 4th.
      const n = nodesFromMoon('Taurus', { sign: 'Aquarius', degree: 4 })!;
      expect(n.rahuFromMoon).toBe(10);
      expect(n.ketuFromMoon).toBe(4);
      // And the opposite always differs by six.
      for (const moon of ['Aries', 'Cancer', 'Libra', 'Capricorn']) {
        const m = nodesFromMoon(moon, { sign: 'Aquarius', degree: 4 })!;
        expect((m.ketuFromMoon - m.rahuFromMoon + 12) % 12).toBe(6);
      }
    });

    it("uses the node's backward progress", () => {
      const n = nodesFromMoon('Taurus', { sign: 'Aquarius', degree: 4 })!;
      expect(n.progress.monthsRemaining).toBe(2.5);
    });
  });
});
