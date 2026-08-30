import { Kundli, UserProfile } from '../upstream/types';
import { lordOfHouse, signIndex } from './zodiac';
import { BirthTimeReliability, ChartReliability } from './types';

/**
 * Validates the upstream chart against classical rules and assesses how much of
 * it is safe to reason from.
 *
 * Upstream services can and do drift - a bad ephemeris config or a swapped house
 * mapping produces a payload that is syntactically perfect and astrologically
 * impossible. Because house lords are fully determined by the lagna, we can
 * check that property for free on every request, which turns a silent data bug
 * into a logged inconsistency and a lowered confidence score.
 */
export function assessChart(
  kundli: Kundli | undefined,
  user: UserProfile | undefined,
): ChartReliability {
  const birthTime = assessBirthTime(user);
  const inconsistencies: string[] = [];
  const notes: string[] = [];

  if (kundli) {
    if (signIndex(kundli.lagna) < 0) {
      inconsistencies.push(`Unrecognised lagna "${kundli.lagna}".`);
    }
    if (signIndex(kundli.moonSign) < 0) {
      inconsistencies.push(`Unrecognised moon sign "${kundli.moonSign}".`);
    }

    // House lords are a pure function of the lagna. Any mismatch is a data bug.
    for (const [houseNo, info] of Object.entries(kundli.houses ?? {})) {
      const house = Number(houseNo);
      const expected = lordOfHouse(kundli.lagna, house);
      if (!expected) continue;
      if (expected !== info.lord) {
        inconsistencies.push(
          `House ${house} lord is "${info.lord}" but a ${kundli.lagna} lagna makes it ${expected}.`,
        );
      }
    }
  }

  const housesUsable = birthTime !== 'unknown' && inconsistencies.length === 0;

  if (birthTime === 'unknown') {
    notes.push(
      'Birth time unknown: the ascendant and all house placements are unreliable, so reasoning falls back to the Moon sign.',
    );
  } else if (birthTime === 'approximate') {
    notes.push(
      'Birth time is approximate: house placements near a sign boundary may shift, so house-based claims are stated with less certainty.',
    );
  }

  return { birthTime, housesUsable, inconsistencies, notes };
}

export function assessBirthTime(user: UserProfile | undefined): BirthTimeReliability {
  const details = user?.birthDetails;
  if (!details?.time) return 'unknown';
  if (details.timeAccuracy) return details.timeAccuracy;

  // Heuristic when the upstream does not tell us: a time landing exactly on the
  // hour or half hour is far more likely to be a remembered approximation than
  // a recorded fact.
  const [, minutes] = details.time.split(':').map(Number);
  if (Number.isNaN(minutes)) return 'unknown';
  return minutes % 30 === 0 ? 'approximate' : 'exact';
}
