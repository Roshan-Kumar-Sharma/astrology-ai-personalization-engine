/**
 * Parsing helpers for model output.
 *
 * Lives under `llm/` because every consumer of a model response needs the same
 * defences, and both `answer/` and `personalization/` are downstream of one.
 */

/**
 * Removes visible chain-of-thought.
 *
 * A large share of the models on free tiers are reasoning models, and several
 * emit their thinking as ordinary content rather than in a separate field. Left
 * in, it reaches the user as the answer - or, for a classifier, it buries the
 * one word we asked for under a paragraph of deliberation.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '');
}

/** Finds the outermost JSON object, tolerating markdown fences and preamble. */
export function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}
