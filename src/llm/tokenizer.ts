/**
 * Fast token estimator.
 *
 * Deliberately an estimate, not a tokenizer. Real BPE tokenization requires the
 * provider's own vocabulary, and every provider differs - so a "correct" count
 * here would be correct for exactly one model. What the budget actually needs is
 * a *stable, conservative upper bound* that can be computed thousands of times
 * per second without a network call, which this provides.
 *
 * Devanagari and other Indic scripts tokenize far less efficiently than Latin
 * text - often close to one token per character - so script is accounted for
 * rather than assuming a flat 4 chars/token. Getting this wrong in the other
 * direction would silently blow the context budget for exactly the Hindi and
 * Marathi users this product is built for.
 *
 * For exact accounting, providers expose token-counting endpoints; see
 * `estimateTokens` callers in the prompt builder for where that would slot in.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let ascii = 0;
  let indic = 0;
  let otherNonAscii = 0;

  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 128) ascii += 1;
    // Devanagari, Tamil, Telugu, Gurmukhi, Bengali, Kannada, Malayalam, Gujarati
    else if (code >= 0x0900 && code <= 0x0d7f) indic += 1;
    else otherNonAscii += 1;
  }

  const asciiTokens = ascii / 3.8;
  const indicTokens = indic / 1.2;
  const otherTokens = otherNonAscii / 2.2;

  return Math.ceil(asciiTokens + indicTokens + otherTokens);
}

/** Token cost of a JSON-serialisable value, as it would appear in a prompt. */
export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value));
}
