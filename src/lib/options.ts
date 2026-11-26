export interface ReplyOption {
  label: string;
  effect: string;
  reason?: string;
}

export function parseOptions(question: string): { question: string; options: ReplyOption[] } {
  const fallback = { question, options: [] };
  const block = /\r?\n[ \t]*\r?\nOptions:\r?\n/.exec(question);
  if (!block) return fallback;

  const prompt = question.slice(0, block.index).trimEnd();
  const lines = question.slice(block.index + block[0].length).trimEnd().split(/\r?\n/);
  if (!prompt.trim() || lines.length < 2 || lines.length > 4) return fallback;

  const options: ReplyOption[] = [];
  for (const line of lines) {
    const entry = /^- ([^:]+): (.+)$/.exec(line);
    if (!entry) return fallback;
    const label = entry[1].trim();
    const [effect, recommendation, extra] = entry[2].trim().split(" (Recommended:");
    const reason = recommendation && /^ (.+)\)$/.exec(recommendation)?.[1].trim();
    if (!label || !effect.trim() || extra !== undefined || (recommendation !== undefined && !reason)
      || options.some((option) => option.label === label)) return fallback;
    options.push({ label, effect: effect.trimEnd(), ...(reason && { reason }) });
  }

  const recommended = options.filter((option) => option.reason);
  if (recommended.length !== 1) return fallback;
  return { question: prompt, options: [...recommended, ...options.filter((option) => !option.reason)] };
}
