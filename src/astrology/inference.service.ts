import { Injectable } from '@nestjs/common';
import { Kundli, Panchang, UserProfile } from '../upstream/types';
import { assessChart } from './chart-validation';
import { locateDasha, nakshatraLord, normalizePlanet } from './vimshottari';
import {
  dignityOf,
  houseOfSign,
  HOUSE_MEANING,
  lordOfHouse,
  PLANET_THEME,
  Planet,
  signOfHouse,
  Sign,
} from './zodiac';
import { ChartReliability, DerivedFact, DomainCategory } from './types';

/** Which houses actually answer which kind of question. */
export const HOUSES_FOR_CATEGORY: Record<DomainCategory, number[]> = {
  career: [10, 6, 11],
  relationship: [7, 5, 2],
  health: [1, 6, 8],
  finance: [2, 11, 5],
  self: [1, 9],
  timing: [],
  general: [1, 10, 7],
};

/**
 * Turns raw chart JSON into astrological *conclusions*.
 *
 * This is the layer that separates this engine from "pipe four JSON blobs into a
 * prompt". An LLM handed `{"mahadasha":"Rahu","antardasha":"Mars"}` has to guess
 * what that means and will happily invent the arithmetic. Handing it "Mars is
 * the ninth and final sub-period of an eighteen-year Rahu chapter, roughly 12.6
 * months long" removes the guesswork, costs no tokens to compute, and is
 * verifiable against the classical rules in `vimshottari.ts`.
 *
 * Everything here is deterministic. No inference in this file depends on the LLM.
 */
@Injectable()
export class AstrologyInferenceEngine {
  derive(input: {
    user?: UserProfile;
    kundli?: Kundli;
    panchang?: Panchang;
    categories: DomainCategory[];
  }): { facts: DerivedFact[]; reliability: ChartReliability } {
    const { user, kundli, panchang, categories } = input;
    const reliability = assessChart(kundli, user);
    const facts: DerivedFact[] = [];

    if (!kundli) return { facts, reliability };

    const dasha = this.dashaFacts(kundli, categories, reliability);
    facts.push(...dasha);

    if (reliability.housesUsable) {
      facts.push(...this.houseFacts(kundli, categories));
      facts.push(...this.moonPlacementFacts(kundli));
    } else {
      facts.push(...this.moonSignFallbackFacts(kundli, reliability));
    }

    if (panchang) facts.push(...this.panchangResonanceFacts(kundli, panchang));

    return { facts, reliability };
  }

  // --- Dasha ---------------------------------------------------------------

  private dashaFacts(
    kundli: Kundli,
    categories: DomainCategory[],
    reliability: ChartReliability,
  ): DerivedFact[] {
    const pos = locateDasha(
      kundli.currentDasha?.mahadasha ?? '',
      kundli.currentDasha?.antardasha ?? '',
    );
    if (!pos) return [];

    const out: DerivedFact[] = [];
    const basis = ['kundli.currentDasha'];

    const positionLine =
      `${pos.mahadasha} mahadasha (${pos.mahadashaYears} years), currently the ` +
      `${ordinal(pos.antardashaIndex)} of nine sub-periods: ${pos.antardasha} antardasha, ` +
      `about ${pos.antardashaMonths} months long. This places the user roughly ` +
      `${pos.chapterProgress.fromPct}-${pos.chapterProgress.toPct}% through the ${pos.mahadasha} chapter ` +
      `(${pos.phase} phase).`;

    out.push({
      id: 'derived.dasha.position',
      label: 'Current Dasha',
      categories: ['career', 'relationship', 'health', 'finance', 'self', 'timing', 'general'],
      statement: positionLine,
      confidence: 'high',
      basis,
    });

    // The single highest-signal fact for any "should I make a change?" question.
    if (pos.isFinalAntardasha) {
      out.push({
        id: 'derived.dasha.transition',
        label: 'Dasha Transition',
        categories: ['career', 'relationship', 'finance', 'self', 'timing', 'general'],
        statement:
          `This is the closing sub-period of the ${pos.mahadasha} mahadasha. A ${pos.nextMahadasha} ` +
          `mahadasha (${PLANET_THEME[pos.nextMahadasha]}) begins next, so this is a genuine ` +
          `chapter boundary rather than a mid-cycle moment - a period when endings and ` +
          `re-orientation are structurally expected.`,
        confidence: 'high',
        basis,
      });
    } else if (pos.isOpeningAntardasha) {
      out.push({
        id: 'derived.dasha.transition',
        label: 'Dasha Transition',
        categories: ['career', 'relationship', 'finance', 'self', 'timing', 'general'],
        statement:
          `This is the opening sub-period of a new ${pos.mahadasha} mahadasha - the start of a ` +
          `${pos.mahadashaYears}-year chapter, where themes are being set rather than concluded.`,
        confidence: 'high',
        basis,
      });
    }

    out.push({
      id: 'derived.dasha.themes',
      label: 'Dasha Themes',
      categories: ['career', 'relationship', 'health', 'finance', 'self', 'general'],
      statement:
        `${pos.mahadasha} brings ${PLANET_THEME[pos.mahadasha]}; the ${pos.antardasha} sub-period ` +
        `overlays ${PLANET_THEME[pos.antardasha]}.`,
      confidence: 'high',
      basis,
    });

    // Which of the user's houses does the sub-period lord actually govern?
    // This is what converts a generic "Mars period" into a personal statement.
    if (reliability.housesUsable) {
      const ruled = this.housesRuledBy(kundli.lagna, pos.antardasha);
      const relevant = ruled.filter((h) =>
        categories.some((c) => HOUSES_FOR_CATEGORY[c].includes(h)),
      );
      const houseList = relevant.length ? relevant : ruled;
      if (houseList.length) {
        out.push({
          id: 'derived.dasha.house_rulership',
          label: 'Dasha Lord Rulership',
          categories: ['career', 'relationship', 'health', 'finance', 'self', 'general'],
          statement:
            `In this chart the sub-period lord ${pos.antardasha} rules ` +
            houseList.map((h) => `house ${h} (${HOUSE_MEANING[h]})`).join(' and ') +
            `, so those areas are the ones this sub-period actually activates.`,
          confidence: 'high',
          basis: [...basis, 'kundli.lagna'],
        });
      }
    }

    return out;
  }

  /** Houses a planet rules for a given lagna. Nodes rule no signs classically. */
  private housesRuledBy(lagna: string, planet: Planet): number[] {
    if (planet === 'Rahu' || planet === 'Ketu') return [];
    const houses: number[] = [];
    for (let h = 1; h <= 12; h++) {
      if (lordOfHouse(lagna, h) === planet) houses.push(h);
    }
    return houses;
  }

  // --- Houses --------------------------------------------------------------

  private houseFacts(kundli: Kundli, categories: DomainCategory[]): DerivedFact[] {
    const wanted = new Set<number>();
    for (const c of categories) for (const h of HOUSES_FOR_CATEGORY[c]) wanted.add(h);

    const out: DerivedFact[] = [];
    for (const house of [...wanted].sort((a, b) => a - b)) {
      const upstream = kundli.houses?.[String(house)];
      const derivedLord = lordOfHouse(kundli.lagna, house);
      const sign = signOfHouse(kundli.lagna, house);
      if (!derivedLord || !sign) continue;

      const lord = upstream?.lord ?? derivedLord;
      const strength = upstream?.strength;
      const strengthClause = strength ? `, reported as ${strength.toLowerCase()}` : '';

      out.push({
        id: `derived.house.${house}`,
        label: `${ordinal(house)} House`,
        categories: categoriesForHouse(house),
        statement: `House ${house} (${HOUSE_MEANING[house]}) falls in ${sign}, ruled by ${lord}${strengthClause}.`,
        confidence: upstream ? 'high' : 'medium',
        basis: upstream ? [`kundli.houses.${house}`, 'kundli.lagna'] : ['kundli.lagna'],
      });
    }
    return out;
  }

  private moonPlacementFacts(kundli: Kundli): DerivedFact[] {
    const house = houseOfSign(kundli.lagna, kundli.moonSign);
    if (!house) return [];
    const dignity = dignityOf('Moon', kundli.moonSign as Sign);
    const dignityClause =
      dignity === 'neutral' ? '' : ` The Moon is ${dignity} in ${kundli.moonSign}.`;
    return [
      {
        id: 'derived.moon.placement',
        label: 'Moon Placement',
        categories: ['health', 'relationship', 'self', 'general'],
        statement:
          `The Moon sits in ${kundli.moonSign}, house ${house} from the ascendant ` +
          `(${HOUSE_MEANING[house]}), so emotional focus tends to settle there.${dignityClause}`,
        confidence: 'high',
        basis: ['kundli.moonSign', 'kundli.lagna'],
      },
    ];
  }

  /**
   * When the birth time is unusable the whole house framework collapses, but the
   * Moon sign survives - it changes roughly every 2.25 days, so even a birth
   * time wrong by several hours usually leaves it intact.
   */
  private moonSignFallbackFacts(kundli: Kundli, reliability: ChartReliability): DerivedFact[] {
    if (!kundli.moonSign) return [];
    const dignity = dignityOf('Moon', kundli.moonSign as Sign);
    return [
      {
        id: 'derived.moon.fallback',
        label: 'Moon Sign',
        categories: ['career', 'relationship', 'health', 'finance', 'self', 'general'],
        statement:
          `Reasoning is anchored to the Moon sign (${kundli.moonSign}${
            dignity === 'neutral' ? '' : `, ${dignity}`
          }) rather than the ascendant, because ${reliability.birthTime === 'unknown' ? 'the birth time is unknown' : 'the chart failed validation'}. ` +
          `Do not make claims about specific houses.`,
        confidence: 'medium',
        basis: ['kundli.moonSign'],
      },
    ];
  }

  // --- Panchang x chart ----------------------------------------------------

  /**
   * Connects the global daily almanac to this specific user.
   *
   * The panchang is identical for every user in a location, which makes it the
   * least personal thing we hold. But the 27 nakshatras cycle through the same
   * nine dasha lords, so when the Moon transits a nakshatra ruled by the user's
   * own running dasha lord, a generic day becomes a personally charged one. That
   * link is cheap to compute and is the difference between "today is Rohini" and
   * "today's Rohini is ruled by the Moon, which runs your career house".
   */
  private panchangResonanceFacts(kundli: Kundli, panchang: Panchang): DerivedFact[] {
    const lord = nakshatraLord(panchang.nakshatra ?? '');
    if (!lord) return [];

    const md = normalizePlanet(kundli.currentDasha?.mahadasha ?? '');
    const ad = normalizePlanet(kundli.currentDasha?.antardasha ?? '');
    const matches = [md === lord ? 'mahadasha' : null, ad === lord ? 'antardasha' : null].filter(
      Boolean,
    );

    if (!matches.length) {
      return [
        {
          id: 'derived.panchang.lord',
          label: "Today's Nakshatra Lord",
          categories: ['timing', 'general'],
          statement: `Today's nakshatra ${panchang.nakshatra} is ruled by ${lord} (${PLANET_THEME[lord]}).`,
          confidence: 'high',
          basis: ['panchang.nakshatra'],
        },
      ];
    }

    return [
      {
        id: 'derived.panchang.resonance',
        label: 'Daily Resonance',
        categories: ['timing', 'career', 'relationship', 'health', 'finance', 'general'],
        statement:
          `Today's nakshatra ${panchang.nakshatra} is ruled by ${lord}, which is also the user's ` +
          `running ${matches.join(' and ')} lord. Days like this tend to bring the themes of the ` +
          `current period to the surface, so today is unusually relevant to the question.`,
        confidence: 'high',
        basis: ['panchang.nakshatra', 'kundli.currentDasha'],
      },
    ];
  }
}

function categoriesForHouse(house: number): DomainCategory[] {
  const out: DomainCategory[] = [];
  for (const [cat, houses] of Object.entries(HOUSES_FOR_CATEGORY) as [DomainCategory, number[]][]) {
    if (houses.includes(house)) out.push(cat);
  }
  return out.length ? out : ['general'];
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
