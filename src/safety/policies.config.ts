/**
 * Safety policy table.
 *
 * Astrology is a consumer product that receives questions no astrologer should
 * answer: medical prognoses, death timing, whether to leave a marriage, and
 * sometimes genuine crisis. An LLM asked "will my mother's cancer be cured?"
 * will produce a fluent, confident, and completely unacceptable answer unless
 * something upstream of it says no.
 *
 * The table below is config, not code, for the same reason the personalization
 * rules are: policy in this domain changes with legal advice and app-store
 * review, and that should never require touching the pipeline.
 */

export type RiskAction =
  /** Never reaches the LLM. A fixed, reviewed response is returned instead. */
  | 'block'
  /** The LLM runs, but with mandatory constraints injected into the prompt. */
  | 'constrain';

export interface RiskPolicy {
  id: string;
  action: RiskAction;
  /**
   * Any-of matching: one hit is enough.
   *
   * Good for distinctive phrasings ("when will I die"), brittle for questions
   * whose danger comes from a *combination* of ideas - use `allOf` for those.
   */
  patterns: RegExp[];
  /**
   * All-of matching: every group must produce a hit, and within a group any
   * pattern will do. Written as `[[subjects], [verbs]]`.
   *
   * This exists because trying to express "a disease AND a prognosis verb" as
   * one regex means encoding every word order, possessive and filler word
   * between them, and it silently fails on the first phrasing you did not
   * anticipate - "will my mother's cancer be cured" slips past a pattern that
   * matches "will cancer be cured". Splitting the concepts is both more robust
   * and far easier to review.
   */
  allOf?: RegExp[][];
  /** Why this policy exists - surfaced in the debug endpoint. */
  rationale: string;
  /** For `block`: the response returned to the user. */
  blockResponse?: string;
  /** For `constrain`: directives appended to the system prompt. */
  constraints?: string[];
  /** Offer a handover to a human astrologer on the MyNaksh platform. */
  escalateToHuman?: boolean;
  /** Highest-priority policies are evaluated first. */
  priority: number;
}

/**
 * Crisis response.
 *
 * Deliberately does not moralise, does not predict, and does not use the chart.
 * Indian helplines are listed first because that is the primary market; the
 * closing line covers users outside India.
 */
const CRISIS_RESPONSE = [
  "I'm really glad you reached out, and I want to respond to what you've said rather than to your chart.",
  '',
  "What you're carrying sounds genuinely heavy, and it deserves support from someone who can be present with you right now — not a horoscope. Please consider talking to someone today:",
  '',
  '• **Tele-MANAS** (Government of India, 24x7, multiple languages): **14416** or 1-800-891-4416',
  '• **KIRAN** mental health helpline (24x7): **1800-599-0019**',
  '• **AASRA** (24x7): **+91 98204 66726**',
  '',
  'If you are outside India, your local emergency number or a national crisis line can connect you to someone immediately. If you feel you may act on these thoughts, please treat this as an emergency and reach out now.',
  '',
  "You're welcome to come back and ask me anything about your chart whenever you'd like. Right now, talking to a person matters more.",
].join('\n');

export const RISK_POLICIES: RiskPolicy[] = [
  {
    id: 'crisis_self_harm',
    action: 'block',
    priority: 100,
    rationale:
      'Self-harm indicators must never be routed through an astrological answer. The chart is irrelevant and any prediction risks real harm.',
    patterns: [
      /\b(kill|killing)\s+(myself|my\s?self)\b/i,
      /\bsuicid(e|al)\b/i,
      /\bend\s+(my|this)\s+life\b/i,
      /\bdon'?t\s+want\s+to\s+(live|be\s+alive)\b/i,
      /\bno\s+(point|reason)\s+(in\s+)?living\b/i,
      /\b(harm|hurt|cut)\s+myself\b/i,
      /\bkhudkushi\b/i,
      /\baatmahatya\b/i,
      /\bjeena\s+nahi\s+chahta\b/i,
      /आत्महत्या|खुदकुशी/,
    ],
    blockResponse: CRISIS_RESPONSE,
  },
  {
    id: 'prenatal_sex_determination',
    action: 'block',
    priority: 95,
    rationale:
      'Prenatal sex determination is a criminal offence in India under the PCPNDT Act, 1994. Astrological framing does not exempt it, and a consumer astrology app is a realistic place for the question to be asked.',
    patterns: [
      /\b(boy|girl|male|female|beta|beti|ladka|ladki)\b[^?]{0,40}\b(baby|child|pregnan\w+|garbh\w*|womb)\b/i,
      /\b(baby|child|pregnan\w+|garbh\w*)\b[^?]{0,40}\b(boy|girl|male|female|gender|sex|beta|beti|ladka|ladki)\b/i,
      /\bgender\s+of\s+(my|the)\s+(baby|child|unborn)\b/i,
    ],
    blockResponse:
      "I can't help with predicting the sex of an unborn child. In India, prenatal sex determination is prohibited by law under the PCPNDT Act, and that applies to astrological predictions too.\n\nI'd genuinely love to help with what's underneath the question though — I can look at what your chart says about this period of family life, the timing indicated by your current dasha, or supportive practices for a healthy pregnancy. Just ask.",
    escalateToHuman: false,
  },
  {
    id: 'death_timing',
    action: 'block',
    priority: 90,
    rationale:
      'Longevity prediction (marana / ayurdaya) is refused by responsible astrologers and is actively harmful in a self-service product with no human present.',
    patterns: [
      /\bwhen\s+(will|would|am)\s+(i|he|she|they|my\s+\w+)\s+(die|pass\s+away)\b/i,
      /\b(how\s+long|how\s+many\s+years)\s+(will|do)\s+(i|he|she|they|my\s+\w+)\s+(live|have\s+left)\b/i,
      /\b(date|time|year)\s+of\s+(my|his|her|their)\s+death\b/i,
      /\bwill\s+(i|he|she|they|my\s+\w+)\s+die\b/i,
      /\bmrityu\s+(kab|yog)\b/i,
      /\bkab\s+maru?nga\b/i,
    ],
    blockResponse:
      "I don't make predictions about death or lifespan — no responsible astrologer does, and a confident-sounding answer here could cause real harm.\n\nIf you're worried about someone's health, a doctor is the right person to talk to. If something in your chart is weighing on you, I'm happy to look at what this period asks of you, or at practices traditionally used for wellbeing and peace of mind.",
    escalateToHuman: true,
  },
  {
    id: 'medical_prognosis',
    action: 'block',
    priority: 85,
    rationale:
      'Diagnosis and cure prediction can delay real treatment. This is the highest-frequency dangerous question in astrology apps, and it arrives in endless phrasings, so it is matched as (medical subject + prognosis language) rather than as a fixed form.',
    patterns: [
      /\b(do|does)\s+(i|he|she|they)\s+have\s+(cancer|a\s+tumou?r|diabetes|a\s+disease|an?\s+illness)\b/i,
      /\bshould\s+i\s+(stop|skip|avoid|delay)\s+(taking\s+)?(my\s+)?(medicine|medication|treatment|chemo\w*|surgery)\b/i,
      /\b(diagnose|diagnosis\s+of)\s+(my|me|his|her)\b/i,
      /\bwhat\s+(disease|illness|condition)\s+do\s+i\s+have\b/i,
    ],
    allOf: [
      [
        /\b(cancer|tumou?r|diabet\w*|hiv|aids|stroke|paralysis|thyroid|asthma|epilep\w*|kidney|liver|cardiac|heart\s+(attack|disease|problem)|infection|disease|illness|surgery|operation|chemo\w*|dialysis|transplant|coma|coronary)\b/i,
      ],
      [
        /\b(cure[ds]?|curable|heal(ed|ing)?|recover(y|ed|ing)?|surviv\w+|get\s+better|be\s+(ok|okay|alright|fine)|go\s+away|pull\s+through|make\s+it|succeed|successful|work\s+out|outcome|prognosis)\b/i,
      ],
    ],
    blockResponse:
      "I can't predict medical outcomes or diagnose anything — astrology isn't a substitute for a doctor, and treating it as one can delay care that actually helps.\n\nPlease speak to a qualified physician about this. What I *can* do is look at what your chart suggests about energy, routine and recovery-friendly periods, or the supportive practices traditionally recommended during a difficult health phase.",
    escalateToHuman: true,
  },
  {
    id: 'harm_to_others',
    action: 'block',
    priority: 80,
    rationale:
      'Requests to control, bind or harm a named person (vashikaran, black magic) are abuse vectors and are refused outright.',
    patterns: [
      /\b(vashikaran|black\s+magic|jadoo?\s?tona|kala\s+jadu|tantrik?\s+(remedy|solution))\b/i,
      /\bhow\s+(do|can)\s+i\s+(control|bind|force)\s+(him|her|them|my\s+\w+)\b/i,
      /\b(spell|ritual|mantra)\s+to\s+(make|force)\s+(him|her|them)\s+\w+/i,
      /\b(curse|harm|destroy|ruin)\s+(him|her|them|my\s+enemy)\b/i,
    ],
    blockResponse:
      "I won't help with anything meant to control, bind or harm another person — that's outside what I'll do, regardless of how it's framed.\n\nIf there's a difficult relationship behind this, I'm glad to look at what your chart says about your own situation and what this period supports for you.",
  },
  {
    id: 'specific_financial_advice',
    action: 'constrain',
    priority: 60,
    rationale:
      'Naming specific instruments would constitute investment advice. The answer stays astrological and general, and never endorses a trade.',
    patterns: [
      /\b(should|shall)\s+i\s+(buy|sell|invest\s+in|put\s+money\s+in)\b/i,
      /\b(stock|share|crypto|bitcoin|mutual\s+fund|sip|ipo|f&o|options?\s+trading)\b/i,
      /\bhow\s+much\s+should\s+i\s+invest\b/i,
    ],
    constraints: [
      'Do NOT recommend, endorse or discourage any specific financial instrument, stock, fund or transaction.',
      'Speak only about the general financial climate the chart indicates (timing, caution, patience, consolidation).',
      'State plainly, once, that this is not financial advice and that a licensed advisor should be consulted for decisions involving money.',
    ],
  },
  {
    id: 'legal_outcome',
    action: 'constrain',
    priority: 55,
    rationale:
      'Predicting a case outcome could influence a real legal decision. The answer describes the period, not the verdict.',
    patterns: [
      /\b(will|do)\s+i\s+win\s+(the|my|this)\s+(case|lawsuit|litigation|dispute)\b/i,
      /\b(court|lawsuit|litigation|legal\s+case|divorce\s+case|fir|bail)\b/i,
    ],
    constraints: [
      'Do NOT predict the outcome of any legal proceeding.',
      'Describe only what the period favours in terms of patience, documentation, negotiation or timing.',
      'Recommend consulting a qualified lawyer for the decision itself.',
    ],
  },
  {
    id: 'third_party_private',
    action: 'constrain',
    priority: 50,
    rationale:
      "We hold the user's chart, not anyone else's. Confident claims about a named third party's feelings or conduct invite harm and are not derivable from the data we have.",
    patterns: [
      /\bis\s+(he|she|they|my\s+(husband|wife|partner|boyfriend|girlfriend|ex))\s+(cheating|lying|seeing\s+someone|faithful)\b/i,
      /\bdoes\s+(he|she|they)\s+(love|like|still\s+care\s+about)\s+me\b/i,
      /\bwhat\s+is\s+(he|she|they)\s+(thinking|feeling|planning)\b/i,
    ],
    constraints: [
      "Do NOT make factual claims about another person's behaviour, feelings or intentions - their chart is not available and the user's chart cannot reveal them.",
      "Reframe toward the user's own situation: what this period asks of them, and how they might approach the conversation.",
      'Never confirm or deny an accusation about a named person.',
    ],
    escalateToHuman: true,
  },
];

/**
 * Applied to every request regardless of risk.
 *
 * The fatalism rule is a product decision as much as a safety one. "You will
 * lose your job in October" is the kind of sentence that gets an astrology app
 * uninstalled, screenshotted, and occasionally sued - and it is also bad
 * astrology, since a dasha describes a climate rather than a verdict.
 */
export const UNIVERSAL_CONSTRAINTS: string[] = [
  'Never state a negative life event as certain. Describe tendencies, timing and climate, never verdicts.',
  "Preserve the user's agency: the chart describes conditions, the user makes the decision.",
  'Do not diagnose medical conditions, predict death, or guarantee financial or legal outcomes.',
  'Only use the astrological context supplied below. If the context does not support a claim, do not make it.',
];
