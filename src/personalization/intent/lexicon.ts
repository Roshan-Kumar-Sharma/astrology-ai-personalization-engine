import { Intent } from '../types';

/**
 * Weighted term lexicon for intent detection.
 *
 * Covers English, Devanagari Hindi and romanised Hinglish, because that is what
 * Indian consumer apps actually receive - "job change karu kya?" is a normal
 * question, not an edge case, and an English-only classifier silently routes it
 * to `general` and loses all personalization.
 *
 * Weights let genuinely ambiguous terms contribute to more than one intent
 * ("salary" is both career and finance) instead of forcing a false choice.
 */
export interface LexEntry {
  /** Matched case-insensitively with word boundaries where meaningful. */
  term: string;
  weights: Partial<Record<Intent, number>>;
}

export const LEXICON: LexEntry[] = [
  // --- career -------------------------------------------------------------
  { term: 'job', weights: { career: 1 } },
  { term: 'career', weights: { career: 1 } },
  { term: 'work', weights: { career: 0.6 } },
  { term: 'office', weights: { career: 0.8 } },
  { term: 'promotion', weights: { career: 1 } },
  { term: 'appraisal', weights: { career: 1 } },
  { term: 'resign', weights: { career: 1 } },
  { term: 'quit', weights: { career: 0.8 } },
  { term: 'interview', weights: { career: 1 } },
  { term: 'boss', weights: { career: 0.9 } },
  { term: 'manager', weights: { career: 0.7 } },
  { term: 'colleague', weights: { career: 0.7 } },
  { term: 'company', weights: { career: 0.6 } },
  { term: 'employer', weights: { career: 0.9 } },
  { term: 'business', weights: { career: 0.7, finance: 0.4 } },
  { term: 'startup', weights: { career: 0.8 } },
  { term: 'freelance', weights: { career: 0.8 } },
  { term: 'profession', weights: { career: 1 } },
  { term: 'naukri', weights: { career: 1 } },
  { term: 'kaam', weights: { career: 0.7 } },
  { term: 'नौकरी', weights: { career: 1 } },
  { term: 'करियर', weights: { career: 1 } },

  // --- relationship -------------------------------------------------------
  { term: 'relationship', weights: { relationship: 1 } },
  { term: 'marriage', weights: { relationship: 1 } },
  { term: 'marry', weights: { relationship: 1 } },
  { term: 'partner', weights: { relationship: 0.9 } },
  { term: 'husband', weights: { relationship: 1 } },
  { term: 'wife', weights: { relationship: 1 } },
  { term: 'spouse', weights: { relationship: 1 } },
  { term: 'girlfriend', weights: { relationship: 1 } },
  { term: 'boyfriend', weights: { relationship: 1 } },
  { term: 'love', weights: { relationship: 0.8 } },
  { term: 'romance', weights: { relationship: 1 } },
  { term: 'dating', weights: { relationship: 1 } },
  { term: 'breakup', weights: { relationship: 1 } },
  { term: 'divorce', weights: { relationship: 1 } },
  { term: 'compatibility', weights: { relationship: 1 } },
  { term: 'shaadi', weights: { relationship: 1 } },
  { term: 'rishta', weights: { relationship: 1 } },
  { term: 'pyaar', weights: { relationship: 0.9 } },
  { term: 'शादी', weights: { relationship: 1 } },
  { term: 'रिश्ता', weights: { relationship: 1 } },

  // --- health -------------------------------------------------------------
  { term: 'health', weights: { health: 1 } },
  { term: 'illness', weights: { health: 1 } },
  { term: 'sick', weights: { health: 0.9 } },
  { term: 'energy', weights: { health: 0.6 } },
  { term: 'sleep', weights: { health: 0.8 } },
  { term: 'fitness', weights: { health: 1 } },
  { term: 'diet', weights: { health: 0.9 } },
  { term: 'stress', weights: { health: 0.8 } },
  { term: 'anxiety', weights: { health: 0.9 } },
  { term: 'mental', weights: { health: 0.8 } },
  { term: 'wellbeing', weights: { health: 0.9 } },
  { term: 'wellness', weights: { health: 0.9 } },
  { term: 'exercise', weights: { health: 0.8 } },
  { term: 'fatigue', weights: { health: 0.9 } },
  { term: 'tired', weights: { health: 0.7 } },
  { term: 'body', weights: { health: 0.5 } },
  { term: 'sehat', weights: { health: 1 } },
  { term: 'tabiyat', weights: { health: 1 } },
  { term: 'स्वास्थ्य', weights: { health: 1 } },
  { term: 'सेहत', weights: { health: 1 } },

  // --- finance ------------------------------------------------------------
  { term: 'money', weights: { finance: 1 } },
  { term: 'finance', weights: { finance: 1 } },
  { term: 'financial', weights: { finance: 1 } },
  { term: 'savings', weights: { finance: 1 } },
  { term: 'invest', weights: { finance: 1 } },
  { term: 'investment', weights: { finance: 1 } },
  { term: 'loan', weights: { finance: 1 } },
  { term: 'debt', weights: { finance: 1 } },
  { term: 'income', weights: { finance: 0.9, career: 0.3 } },
  { term: 'salary', weights: { finance: 0.7, career: 0.6 } },
  { term: 'wealth', weights: { finance: 1 } },
  { term: 'expense', weights: { finance: 0.9 } },
  { term: 'budget', weights: { finance: 0.8 } },
  { term: 'emi', weights: { finance: 1 } },
  { term: 'property', weights: { finance: 0.6 } },
  { term: 'paisa', weights: { finance: 1 } },
  { term: 'paise', weights: { finance: 1 } },
  { term: 'dhan', weights: { finance: 0.9 } },
  { term: 'पैसा', weights: { finance: 1 } },
  { term: 'धन', weights: { finance: 0.9 } },

  // --- daily --------------------------------------------------------------
  { term: 'today', weights: { daily: 1 } },
  { term: "today's", weights: { daily: 1 } },
  { term: 'tomorrow', weights: { daily: 0.8 } },
  { term: 'prioritize', weights: { daily: 0.7 } },
  { term: 'prioritise', weights: { daily: 0.7 } },
  { term: 'priority', weights: { daily: 0.6 } },
  { term: 'guidance', weights: { daily: 0.6 } },
  { term: 'summarize', weights: { daily: 0.5 } },
  { term: 'summarise', weights: { daily: 0.5 } },
  { term: 'aaj', weights: { daily: 1 } },
  { term: 'आज', weights: { daily: 1 } },

  // --- spiritual ----------------------------------------------------------
  { term: 'remedy', weights: { spiritual: 1 } },
  { term: 'remedies', weights: { spiritual: 1 } },
  { term: 'mantra', weights: { spiritual: 1 } },
  { term: 'puja', weights: { spiritual: 1 } },
  { term: 'pooja', weights: { spiritual: 1 } },
  { term: 'vrat', weights: { spiritual: 1 } },
  { term: 'fast', weights: { spiritual: 0.5 } },
  { term: 'temple', weights: { spiritual: 0.9 } },
  { term: 'mandir', weights: { spiritual: 0.9 } },
  { term: 'gemstone', weights: { spiritual: 1 } },
  { term: 'rudraksha', weights: { spiritual: 1 } },
  { term: 'meditation', weights: { spiritual: 0.8, health: 0.3 } },
  { term: 'spiritual', weights: { spiritual: 1 } },
  { term: 'upay', weights: { spiritual: 1 } },
  { term: 'उपाय', weights: { spiritual: 1 } },
  { term: 'मंत्र', weights: { spiritual: 1 } },
];

/** Multi-word phrases carry more signal than their parts and are matched first. */
export const PHRASES: LexEntry[] = [
  { term: 'change my job', weights: { career: 2 } },
  { term: 'changing my job', weights: { career: 2 } },
  { term: 'job change', weights: { career: 2 } },
  { term: 'switch jobs', weights: { career: 2 } },
  { term: 'new job', weights: { career: 1.6 } },
  { term: 'start a business', weights: { career: 1.8 } },
  { term: 'my partner', weights: { relationship: 1.6 } },
  { term: 'get married', weights: { relationship: 2 } },
  { term: 'life partner', weights: { relationship: 2 } },
  { term: 'take care of', weights: { health: 0.4 } },
  { term: 'focus on for my health', weights: { health: 2 } },
  { term: 'mutual fund', weights: { finance: 2 } },
  { term: 'buy a house', weights: { finance: 1.4 } },
  { term: 'this week', weights: { daily: 0.9 } },
  { term: 'right now', weights: { daily: 0.7 } },
];
