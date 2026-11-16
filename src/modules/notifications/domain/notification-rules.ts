/**
 * Pure rules of the notification service (spec 6.12), unit-tested without a database.
 *
 *  - Templates use `{{name}}` placeholders. A template may only use the variables it lists, and
 *    rendering fails when one is missing, so a typo never reaches a recipient as `{{name}}`.
 *  - Channel selection respects preferences: a specific (template, channel) preference beats the
 *    channel-wide `*` one, which beats the default. A mandatory template ignores preferences.
 *    SMS and push need a destination; without one the channel is skipped.
 *  - The deduplication window is five minutes (spec 6.12).
 *  - A failed delivery retries with exponential backoff and a cap.
 */
export const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
export type Channel = 'email' | 'sms' | 'push' | 'in_app';
export const CHANNELS: readonly Channel[] = ['in_app', 'email', 'sms', 'push'];
/** Templates are written in English; a recipient locale is not stored yet. */
export const DEFAULT_LOCALE = 'en';

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** The variable names a template text uses, in first-use order. */
export function placeholdersOf(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

/** Names used in the text that the template does not declare, and declared names never used. */
export function templateProblems(
  declared: readonly string[],
  subject: string | null,
  body: string
): { undeclared: string[]; unused: string[] } {
  const used = placeholdersOf(subject, body);
  return {
    undeclared: used.filter((n) => !declared.includes(n)),
    unused: declared.filter((n) => !used.includes(n)),
  };
}

export class MissingTemplateVariableError extends Error {
  constructor(readonly variable: string) {
    super(`template variable "${variable}" was not supplied`);
    this.name = 'MissingTemplateVariableError';
  }
}

/** Substitutes every placeholder; throws `MissingTemplateVariableError` for one not supplied. */
export function render(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new MissingTemplateVariableError(name);
    return value;
  });
}

export interface PreferenceRow {
  readonly templateCode: string;
  readonly channel: Channel;
  readonly enabled: boolean;
}

/** Whether a user wants a channel for a template. A specific preference wins over `*`. */
export function channelEnabled(
  preferences: readonly PreferenceRow[],
  templateCode: string,
  channel: Channel
): boolean {
  const specific = preferences.find(
    (p) => p.templateCode === templateCode && p.channel === channel
  );
  if (specific) return specific.enabled;
  const wide = preferences.find((p) => p.templateCode === '*' && p.channel === channel);
  return wide ? wide.enabled : true;
}

export interface ChannelTemplate {
  readonly channel: Channel;
  readonly mandatory: boolean;
}

/**
 * The channels to use for one recipient: those the template exists for, the recipient wants (or
 * the template overrides), and, for SMS and push, that have a destination. In-app is always
 * possible and is never refused for a mandatory template.
 */
export function selectChannels(input: {
  readonly templates: readonly ChannelTemplate[];
  readonly templateCode: string;
  readonly preferences: readonly PreferenceRow[];
  readonly destinations: ReadonlySet<Channel>;
}): Channel[] {
  const selected: Channel[] = [];
  for (const channel of CHANNELS) {
    const template = input.templates.find((t) => t.channel === channel);
    if (!template) continue;
    if ((channel === 'sms' || channel === 'push') && !input.destinations.has(channel)) {
      continue;
    }
    if (!template.mandatory && !channelEnabled(input.preferences, input.templateCode, channel)) {
      continue;
    }
    selected.push(channel);
  }
  return selected;
}

/** Whether a notification at `createdAt` is inside the dedupe window ending at `now`. */
export function withinDedupeWindow(createdAt: Date, now: Date): boolean {
  return (
    now.getTime() - createdAt.getTime() < DEDUPE_WINDOW_MS && createdAt.getTime() <= now.getTime()
  );
}

/** Seconds to wait after the `attempt`th failed try (1-based): base, 2x, 4x, ... capped at 1 hour. */
export function retryDelaySeconds(attempt: number, baseSeconds: number): number {
  const delay = baseSeconds * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, 3600);
}
