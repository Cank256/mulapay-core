import { describe, expect, it } from 'vitest';
import { EVENT_TRIGGERS, triggersMatchNotifiableEvents } from './event-triggers';
import {
  DEDUPE_WINDOW_MS,
  MissingTemplateVariableError,
  channelEnabled,
  placeholdersOf,
  render,
  retryDelaySeconds,
  selectChannels,
  templateProblems,
  withinDedupeWindow,
  type Channel,
} from './notification-rules';

describe('template rendering', () => {
  it('substitutes every placeholder, with or without spaces', () => {
    expect(render('Hi {{name}}, {{ thing }} is ready', { name: 'Ada', thing: 'report' })).toBe(
      'Hi Ada, report is ready'
    );
  });

  it('refuses to send a placeholder it could not fill', () => {
    expect(() => render('Hi {{name}}', {})).toThrow(MissingTemplateVariableError);
    expect(() => render('Hi {{name}}', {})).toThrow(/name/);
  });

  it('does not treat a value as a template, so a value cannot inject another placeholder', () => {
    expect(render('{{a}}', { a: '{{b}}', b: 'x' })).toBe('{{b}}');
  });

  it('finds the variables a template uses, and what it forgets to declare or never uses', () => {
    expect(placeholdersOf('{{a}} {{b}}', '{{a}}', null)).toEqual(['a', 'b']);
    expect(templateProblems(['a'], 'S {{a}}', 'B {{b}}')).toEqual({
      undeclared: ['b'],
      unused: [],
    });
    expect(templateProblems(['a', 'c'], null, '{{a}}')).toEqual({ undeclared: [], unused: ['c'] });
  });
});

describe('channel selection', () => {
  const templates = (...channels: Channel[]) =>
    channels.map((channel) => ({ channel, mandatory: false }));
  const base = {
    templateCode: 'x.y',
    destinations: new Set<Channel>(),
    preferences: [],
  };

  it('uses every channel the template has, except SMS and push without a destination', () => {
    expect(
      selectChannels({ ...base, templates: templates('email', 'in_app', 'sms', 'push') })
    ).toEqual(['in_app', 'email']);
    expect(
      selectChannels({
        ...base,
        templates: templates('email', 'in_app', 'sms', 'push'),
        destinations: new Set<Channel>(['sms', 'push']),
      })
    ).toEqual(['in_app', 'email', 'sms', 'push']);
  });

  it('lets a specific preference beat a channel-wide one, which beats the default', () => {
    expect(channelEnabled([], 'x.y', 'email')).toBe(true);
    const wide = [{ templateCode: '*', channel: 'email' as const, enabled: false }];
    expect(channelEnabled(wide, 'x.y', 'email')).toBe(false);
    expect(channelEnabled(wide, 'x.y', 'in_app')).toBe(true);
    const both = [...wide, { templateCode: 'x.y', channel: 'email' as const, enabled: true }];
    expect(channelEnabled(both, 'x.y', 'email')).toBe(true);
    expect(channelEnabled(both, 'other', 'email')).toBe(false);
  });

  it('ignores preferences for a mandatory template', () => {
    const off = [{ templateCode: 'x.y', channel: 'email' as const, enabled: false }];
    expect(
      selectChannels({
        ...base,
        preferences: off,
        templates: [
          { channel: 'email', mandatory: true },
          { channel: 'in_app', mandatory: false },
        ],
      })
    ).toEqual(['in_app', 'email']);
  });
});

describe('deduplication window and retries', () => {
  it('is five minutes, exclusive at the end', () => {
    const at = new Date('2025-03-01T10:00:00Z');
    expect(DEDUPE_WINDOW_MS).toBe(300_000);
    expect(withinDedupeWindow(at, new Date(at.getTime() + 299_999))).toBe(true);
    expect(withinDedupeWindow(at, new Date(at.getTime() + 300_000))).toBe(false);
    expect(withinDedupeWindow(at, new Date(at.getTime() - 1))).toBe(false);
  });

  it('doubles the retry delay and stops at an hour', () => {
    expect([1, 2, 3, 4].map((n) => retryDelaySeconds(n, 30))).toEqual([30, 60, 120, 240]);
    expect(retryDelaySeconds(20, 30)).toBe(3600);
  });
});

describe('event triggers', () => {
  it('cover exactly the events the events module announces', () => {
    expect(triggersMatchNotifiableEvents()).toBe(true);
  });

  it('build the variables their template needs from the event', () => {
    const trigger = EVENT_TRIGGERS['dispute.created'];
    expect(
      trigger?.variables({
        type: 'dispute.created',
        resourceId: 'dsp_1',
        object: { amountMinor: '500', currency: 'UGX', evidenceDueAt: null },
      })
    ).toEqual({
      dispute_ref: 'dsp_1',
      amount_minor: '500',
      currency: 'UGX',
      evidence_due: 'not set',
    });
  });
});
