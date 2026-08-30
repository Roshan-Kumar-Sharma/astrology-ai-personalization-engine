import { extractHorizon } from './horizon.extractor';
import { IntentClassifier } from './intent.classifier';

describe('IntentClassifier', () => {
  const classifier = new IntentClassifier();

  /** Every sample question from the brief must land on the right intent. */
  it.each([
    ['Should I consider changing my job this year?', 'career'],
    ['Should I consider changing my job in the next few months?', 'career'],
    ['How does this month look for my relationship?', 'relationship'],
    ['What should I focus on for my health?', 'health'],
    ['What should I prioritize this week?', 'daily'],
    ["Can you summarize today's guidance?", 'daily'],
  ])('classifies %j as %s', (question, expected) => {
    expect(classifier.classify(question).intent).toBe(expected);
  });

  it('handles Hinglish and Devanagari, not just English', () => {
    expect(classifier.classify('job change karu kya is saal?').intent).toBe('career');
    expect(classifier.classify('meri shaadi kab hogi?').intent).toBe('relationship');
    expect(classifier.classify('मेरी सेहत कैसी रहेगी?').intent).toBe('health');
    expect(classifier.classify('paise ki dikkat kab khatam hogi?').intent).toBe('finance');
  });

  /**
   * "How does this week look for my relationship?" is a relationship question
   * about a week, not a daily question. The topical intent must win and the
   * temporal word must be left to the horizon extractor.
   */
  it('prefers the topical intent over a temporal one', () => {
    const r = classifier.classify('How does this week look for my relationship?');
    expect(r.intent).toBe('relationship');
    expect(extractHorizon('How does this week look for my relationship?').horizon).toBe('week');
  });

  it('falls back to general with low confidence when nothing matches', () => {
    const r = classifier.classify('What is going on with me?');
    expect(r.intent).toBe('general');
    expect(r.method).toBe('default');
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('reports lower confidence for thin evidence than for strong evidence', () => {
    const strong = classifier.classify('Should I consider changing my job?');
    const thin = classifier.classify('Any thoughts on my sleep?');
    expect(strong.confidence).toBeGreaterThan(thin.confidence);
  });

  it('surfaces a second topic in a compound question', () => {
    const r = classifier.classify('Will my investments and my savings grow, and is my job safe?');
    expect(r.intent).toBe('finance');
    expect(r.secondary).toContain('career');
  });

  it('does not match a term inside an unrelated longer word', () => {
    // "invest" must not fire on "investigation".
    const r = classifier.classify('There is an investigation at my office');
    expect(r.intent).toBe('career');
  });
});

describe('extractHorizon', () => {
  it.each([
    ['Should I change jobs today?', 'today'],
    ['What should I prioritize this week?', 'week'],
    ['How does this month look?', 'month'],
    ['Should I change my job in the next few months?', 'quarter'],
    ['Will I get a promotion this year?', 'year'],
    ['Will I ever find a partner?', 'lifetime'],
    ['Should I change my job?', 'unspecified'],
  ])('reads %j as %s', (question, expected) => {
    expect(extractHorizon(question).horizon).toBe(expected);
  });

  /**
   * "next few months" contains "month". Most-specific-first ordering is what
   * stops the shorter pattern from stealing the match.
   */
  it('prefers the more specific phrase when patterns overlap', () => {
    expect(extractHorizon('in the next few months').horizon).toBe('quarter');
    expect(extractHorizon('this month').horizon).toBe('month');
  });

  it('reads Hinglish time phrases', () => {
    expect(extractHorizon('is saal job change karu?').horizon).toBe('year');
    expect(extractHorizon('aaj ka din kaisa hai?').horizon).toBe('today');
  });
});
