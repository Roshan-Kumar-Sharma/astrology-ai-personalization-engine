import { Injectable } from '@nestjs/common';
import { RISK_POLICIES, RiskPolicy, UNIVERSAL_CONSTRAINTS } from './policies.config';

export interface GuardrailDecision {
  /** True when the question must not reach the LLM at all. */
  blocked: boolean;
  /** Policy ids that matched, highest priority first. */
  matchedPolicies: string[];
  /** Human-readable reasons, surfaced by the debug endpoint. */
  rationale: string[];
  /** Prompt directives to inject when not blocked. */
  constraints: string[];
  /** Canned response to return when blocked. */
  blockResponse?: string;
  /** Whether to offer a handover to a human astrologer. */
  escalateToHuman: boolean;
}

export interface OutputReview {
  /** The answer after safe rewrites. */
  answer: string;
  /** Rules that fired on the model output. */
  violations: string[];
  /** True when the answer was replaced wholesale rather than softened. */
  replaced: boolean;
}

/**
 * Two-sided guardrail: one gate before the LLM, one after.
 *
 * The input gate is the important one - it is deterministic, costs nothing, and
 * stops a dangerous question from ever becoming a generated answer. The output
 * gate is a backstop for the cases the model reaches on its own: absolute
 * predictions, invented medical claims, and guarantees.
 */
@Injectable()
export class GuardrailsService {
  private policies: RiskPolicy[] = sortByPriority(RISK_POLICIES);

  /**
   * Test seam. Nest resolves constructor parameters by type, so the policy list
   * cannot be a constructor argument with a default - it would be treated as an
   * injectable dependency and fail to resolve.
   */
  static withPolicies(policies: RiskPolicy[]): GuardrailsService {
    const svc = new GuardrailsService();
    svc.policies = sortByPriority(policies);
    return svc;
  }

  /** Classify the incoming question. Runs before any upstream call. */
  screenQuestion(question: string): GuardrailDecision {
    const normalized = normalize(question);
    const matched = this.policies.filter((p) => matchesPolicy(p, normalized));

    const blocking = matched.find((p) => p.action === 'block');
    if (blocking) {
      return {
        blocked: true,
        matchedPolicies: [blocking.id],
        rationale: [blocking.rationale],
        constraints: [],
        blockResponse: blocking.blockResponse,
        escalateToHuman: blocking.escalateToHuman ?? false,
      };
    }

    const constraining = matched.filter((p) => p.action === 'constrain');
    return {
      blocked: false,
      matchedPolicies: constraining.map((p) => p.id),
      rationale: constraining.map((p) => p.rationale),
      constraints: [...UNIVERSAL_CONSTRAINTS, ...constraining.flatMap((p) => p.constraints ?? [])],
      escalateToHuman: constraining.some((p) => p.escalateToHuman),
    };
  }

  /** Backstop review of generated text. */
  reviewAnswer(answer: string): OutputReview {
    const violations: string[] = [];

    for (const rule of HARD_OUTPUT_RULES) {
      if (rule.pattern.test(answer)) violations.push(rule.id);
    }
    if (violations.length) {
      return {
        answer:
          "I'm not able to give a reliable answer to this one. Astrology can describe the climate of a period, but not medical outcomes, lifespan or guaranteed results.\n\nIf you'd like, ask me about what this period supports for you and I'll work from your chart.",
        violations,
        replaced: true,
      };
    }

    // Softening rewrites: the claim is fine, the certainty is not.
    let softened = answer;
    const soft: string[] = [];
    for (const rule of SOFTENING_RULES) {
      if (rule.pattern.test(softened)) {
        softened = softened.replace(rule.pattern, rule.replacement);
        soft.push(rule.id);
      }
    }

    return { answer: softened, violations: soft, replaced: false };
  }
}

/** Output that cannot be salvaged by rewording. */
const HARD_OUTPUT_RULES: { id: string; pattern: RegExp }[] = [
  { id: 'output.death_prediction', pattern: /\byou\s+will\s+die\b|\byour\s+death\s+(will|is)\b/i },
  {
    id: 'output.medical_claim',
    pattern: /\byou\s+(have|will\s+(get|develop))\s+(cancer|a\s+tumou?r|diabetes|hiv)\b/i,
  },
  {
    id: 'output.stop_treatment',
    pattern:
      /\b(stop|discontinue|avoid)\s+(taking\s+)?(your\s+)?(medication|medicine|treatment|chemo\w*)\b/i,
  },
  {
    id: 'output.guarantee',
    pattern: /\b(i\s+)?guarantee\b|\bit\s+is\s+certain\s+that\s+you\s+will\b/i,
  },
];

/**
 * Deterministic de-fatalising rewrites.
 *
 * Cheaper and far more reliable than asking the model a second time, and it
 * makes the fatalism rule enforced rather than merely requested in the prompt.
 */
const SOFTENING_RULES: { id: string; pattern: RegExp; replacement: string }[] = [
  { id: 'soft.will_definitely', pattern: /\bwill\s+definitely\b/gi, replacement: 'is likely to' },
  {
    id: 'soft.you_will_lose',
    pattern: /\byou\s+will\s+lose\b/gi,
    replacement: 'there is a risk of losing',
  },
  {
    id: 'soft.you_will_fail',
    pattern: /\byou\s+will\s+fail\b/gi,
    replacement: 'you may find it hard',
  },
  { id: 'soft.never', pattern: /\byou\s+will\s+never\b/gi, replacement: 'it may be difficult to' },
  {
    id: 'soft.certainly',
    pattern: /\bit\s+is\s+certain\b/gi,
    replacement: 'the indication is strong',
  },
];

/**
 * A policy fires when any `patterns` entry matches, or when every `allOf` group
 * produces at least one match.
 */
function matchesPolicy(policy: RiskPolicy, question: string): boolean {
  if (policy.patterns.some((re) => re.test(question))) return true;
  if (!policy.allOf?.length) return false;
  return policy.allOf.every((group) => group.some((re) => re.test(question)));
}

function sortByPriority(policies: RiskPolicy[]): RiskPolicy[] {
  return [...policies].sort((a, b) => b.priority - a.priority);
}

function normalize(q: string): string {
  return q.normalize('NFKC').replace(/\s+/g, ' ').trim();
}
