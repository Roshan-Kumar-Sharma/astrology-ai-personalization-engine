import { Horoscope, Kundli, UserProfile } from '../types';

/**
 * Fixtures for the bundled mock upstream.
 *
 * Every chart below is *astrologically self-consistent*: the house lords match
 * what the stated lagna actually produces under the fixed zodiac-sign rulership
 * (e.g. Libra lagna -> 10th house is Cancer -> lord is Moon). The sample payload
 * in the assignment is consistent in exactly this way, and our chart validator
 * checks the property at runtime.
 *
 * The three users are chosen to exercise different engine paths:
 *   user_101 - premium, English, exact birth time  -> full-confidence path
 *   user_102 - free, Hindi, approximate birth time -> reduced budget + confidence
 *   user_103 - free, Hinglish, unknown birth time  -> houses suppressed entirely,
 *                                                     Moon-sign fallback reasoning
 */

export const USERS: Record<string, UserProfile> = {
  user_101: {
    id: 'user_101',
    name: 'Aarav Sharma',
    language: 'en',
    subscription: 'premium',
    tonePreference: 'motivational',
    birthDetails: { date: '1997-08-15', time: '09:35', place: 'Delhi', timeAccuracy: 'exact' },
  },
  user_102: {
    id: 'user_102',
    name: 'Priya Deshmukh',
    language: 'hi',
    subscription: 'free',
    tonePreference: 'gentle',
    birthDetails: { date: '1992-03-04', time: '18:30', place: 'Pune', timeAccuracy: 'approximate' },
  },
  user_103: {
    id: 'user_103',
    name: 'Rohan Iyer',
    language: 'hinglish',
    subscription: 'free',
    tonePreference: 'analytical',
    birthDetails: { date: '2000-11-22', place: 'Chennai', timeAccuracy: 'unknown' },
  },
  /**
   * Added as a worked example of extending the fixtures. Exercises a fourth
   * language (Marathi) and an early-phase dasha, contrasting with user_101's
   * closing-phase chart.
   */
  user_104: {
    id: 'user_104',
    name: 'Sneha Kulkarni',
    language: 'mr',
    subscription: 'premium',
    tonePreference: 'direct',
    birthDetails: { date: '1989-06-11', time: '04:22', place: 'Nagpur', timeAccuracy: 'exact' },
  },
};

export const KUNDLIS: Record<string, Kundli> = {
  // Libra lagna: 6th=Pisces(Jupiter), 7th=Aries(Mars), 10th=Cancer(Moon).
  // Rahu-Mars is the FINAL antardasha of an 18-year Rahu mahadasha.
  user_101: {
    lagna: 'Libra',
    moonSign: 'Scorpio',
    currentDasha: { mahadasha: 'Rahu', antardasha: 'Mars' },
    houses: {
      '1': { lord: 'Venus', strength: 'Average' },
      '2': { lord: 'Mars', strength: 'Average' },
      '6': { lord: 'Jupiter', strength: 'Average' },
      '7': { lord: 'Mars', strength: 'Weak' },
      '10': { lord: 'Moon', strength: 'Strong' },
      '11': { lord: 'Sun', strength: 'Average' },
    },
  },
  // Aries lagna: 6th=Virgo(Mercury), 7th=Libra(Venus), 10th=Capricorn(Saturn).
  // Jupiter-Saturn is the 2nd antardasha -> early in a 16-year mahadasha.
  user_102: {
    lagna: 'Aries',
    moonSign: 'Taurus',
    currentDasha: { mahadasha: 'Jupiter', antardasha: 'Saturn' },
    houses: {
      '1': { lord: 'Mars', strength: 'Strong' },
      '2': { lord: 'Venus', strength: 'Strong' },
      '6': { lord: 'Mercury', strength: 'Average' },
      '7': { lord: 'Venus', strength: 'Strong' },
      '10': { lord: 'Saturn', strength: 'Average' },
      '11': { lord: 'Saturn', strength: 'Average' },
    },
  },
  // Cancer lagna: 6th=Sagittarius(Jupiter), 7th=Capricorn(Saturn), 10th=Aries(Mars).
  // Birth time unknown -> the lagna and every house below are unreliable and the
  // engine must fall back to Moon-sign reasoning. The service still returns them;
  // deciding not to trust them is the engine's job, not the service's.
  user_103: {
    lagna: 'Cancer',
    moonSign: 'Aquarius',
    currentDasha: { mahadasha: 'Saturn', antardasha: 'Venus' },
    houses: {
      '1': { lord: 'Moon', strength: 'Average' },
      '6': { lord: 'Jupiter', strength: 'Strong' },
      '7': { lord: 'Saturn', strength: 'Average' },
      '10': { lord: 'Mars', strength: 'Weak' },
      '11': { lord: 'Venus', strength: 'Strong' },
    },
  },
  // Capricorn lagna: 1st=Capricorn(Saturn), 2nd=Aquarius(Saturn), 5th=Taurus(Venus),
  // 6th=Gemini(Mercury), 7th=Cancer(Moon), 10th=Libra(Venus), 11th=Scorpio(Mars).
  // Mercury-Ketu is the 2nd of nine antardashas -> early in a 17-year mahadasha.
  user_104: {
    lagna: 'Capricorn',
    moonSign: 'Virgo',
    currentDasha: { mahadasha: 'Mercury', antardasha: 'Ketu' },
    houses: {
      '1': { lord: 'Saturn', strength: 'Strong' },
      '2': { lord: 'Saturn', strength: 'Average' },
      '5': { lord: 'Venus', strength: 'Strong' },
      '6': { lord: 'Mercury', strength: 'Strong' },
      '7': { lord: 'Moon', strength: 'Average' },
      '10': { lord: 'Venus', strength: 'Strong' },
      '11': { lord: 'Mars', strength: 'Average' },
    },
  },
};

export const HOROSCOPES: Record<string, Horoscope> = {
  user_101: {
    career: 'Networking may bring new opportunities.',
    finance: 'Avoid risky investments.',
    health: 'Prioritize proper sleep.',
    relationship: 'Communication with your partner improves.',
  },
  user_102: {
    career: 'A senior colleague may offer useful guidance.',
    finance: 'A pending payment is likely to clear.',
    health: 'Light movement will lift your energy.',
    relationship: 'Family conversations feel warmer today.',
  },
  user_103: {
    career: 'Focus favours steady work over new commitments.',
    finance: 'Review subscriptions and recurring costs.',
    health: 'Hydration and screen breaks matter today.',
    relationship: 'An old friend may reconnect.',
  },
  user_104: {
    career: 'A long-running project moves closer to completion.',
    finance: 'A good week to renegotiate a recurring cost.',
    health: 'Your stamina responds well to an earlier bedtime.',
    relationship: 'Someone close appreciates being asked, not assumed.',
  },
};

// --- Panchang -------------------------------------------------------------
// NOTE: this is a deterministic stand-in, NOT a real ephemeris calculation.
// A production Panchang service computes these from planetary longitudes and
// local sunrise. We cycle the canonical lists so the mock always returns a
// plausible, current-looking panchang for any date.

const TITHI_NAMES = [
  'Pratipada',
  'Dwitiya',
  'Tritiya',
  'Chaturthi',
  'Panchami',
  'Shashthi',
  'Saptami',
  'Ashtami',
  'Navami',
  'Dashami',
  'Ekadashi',
  'Dwadashi',
  'Trayodashi',
  'Chaturdashi',
];

const NAKSHATRAS = [
  'Ashwini',
  'Bharani',
  'Krittika',
  'Rohini',
  'Mrigashira',
  'Ardra',
  'Punarvasu',
  'Pushya',
  'Ashlesha',
  'Magha',
  'Purva Phalguni',
  'Uttara Phalguni',
  'Hasta',
  'Chitra',
  'Swati',
  'Vishakha',
  'Anuradha',
  'Jyeshtha',
  'Mula',
  'Purva Ashadha',
  'Uttara Ashadha',
  'Shravana',
  'Dhanishta',
  'Shatabhisha',
  'Purva Bhadrapada',
  'Uttara Bhadrapada',
  'Revati',
];

const YOGAS = [
  'Vishkambha',
  'Priti',
  'Ayushman',
  'Saubhagya',
  'Shobhana',
  'Atiganda',
  'Sukarma',
  'Dhriti',
  'Shula',
  'Ganda',
  'Vriddhi',
  'Dhruva',
  'Vyaghata',
  'Harshana',
  'Vajra',
  'Siddhi',
  'Vyatipata',
  'Variyana',
  'Parigha',
  'Shiva',
  'Siddha',
  'Sadhya',
  'Shubha',
  'Shukla',
  'Brahma',
  'Indra',
  'Vaidhriti',
];

const KARANAS = ['Bava', 'Balava', 'Kaulava', 'Taitila', 'Gara', 'Vanija', 'Vishti'];

export function panchangFor(dateIso: string) {
  const dayIndex = Math.floor(Date.parse(`${dateIso}T00:00:00Z`) / 86_400_000);
  const tithiIndex = mod(dayIndex, 30);
  const paksha = tithiIndex < 15 ? 'Shukla' : 'Krishna';
  const withinPaksha = mod(tithiIndex, 15);
  const tithi =
    withinPaksha === 14
      ? paksha === 'Shukla'
        ? 'Purnima'
        : 'Amavasya'
      : `${paksha} ${TITHI_NAMES[withinPaksha]}`;
  return {
    date: dateIso,
    tithi,
    nakshatra: NAKSHATRAS[mod(dayIndex, 27)],
    yoga: YOGAS[mod(dayIndex, 27)],
    karana: KARANAS[mod(dayIndex, 7)],
  };
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}
