import { describe, expect, it } from 'vitest';
import {
  evaluateRequirements,
  missingForSubmission,
  resolveRequirements,
  unmetForApproval,
  type Evidence,
  type RequirementRow,
} from './requirements';

const NOW = new Date('2025-06-01T00:00:00Z');
function row(over: Partial<RequirementRow> & { requirementCode: string }): RequirementRow {
  return {
    level: 1,
    country: '*',
    businessType: '*',
    kind: 'document',
    evidenceKey: over.requirementCode,
    label: over.requirementCode,
    description: '',
    mandatory: true,
    active: true,
    sortOrder: 100,
    ...over,
  };
}
const NO_EVIDENCE: Evidence = {
  profileFields: new Set(),
  documents: [],
  parties: { director: 0, ubo: 0 },
  passedChecks: new Set(),
};
const codes = (rows: readonly { requirementCode: string }[]) => rows.map((r) => r.requirementCode);

describe('resolveRequirements', () => {
  const rows = [
    row({ requirementCode: 'id', level: 1, sortOrder: 1 }),
    row({ requirementCode: 'cert', level: 2, sortOrder: 2 }),
    row({
      requirementCode: 'cert',
      level: 2,
      businessType: 'sole_proprietor',
      mandatory: false,
      sortOrder: 2,
    }),
    row({ requirementCode: 'tin_cert', level: 2, country: 'UG', sortOrder: 3 }),
    row({
      requirementCode: 'directors',
      level: 3,
      kind: 'party',
      evidenceKey: 'director',
      sortOrder: 4,
    }),
    row({ requirementCode: 'old', level: 1, active: false }),
  ];

  it('applies only rows at or below the level applied for', () => {
    expect(
      codes(
        resolveRequirements(rows, {
          country: 'KE',
          businessType: 'limited_company',
          targetLevel: 1,
        })
      )
    ).toEqual(['id']);
    expect(
      codes(
        resolveRequirements(rows, {
          country: 'KE',
          businessType: 'limited_company',
          targetLevel: 3,
        })
      )
    ).toEqual(['id', 'cert', 'directors']);
  });

  it('adds country-specific rows only for that country, with no country named in code', () => {
    const ug = resolveRequirements(rows, {
      country: 'UG',
      businessType: 'limited_company',
      targetLevel: 2,
    });
    const ke = resolveRequirements(rows, {
      country: 'KE',
      businessType: 'limited_company',
      targetLevel: 2,
    });
    expect(codes(ug)).toContain('tin_cert');
    expect(codes(ke)).not.toContain('tin_cert');
  });

  it('lets a business type relax a requirement for itself only', () => {
    const solo = resolveRequirements(rows, {
      country: 'KE',
      businessType: 'sole_proprietor',
      targetLevel: 2,
    });
    const company = resolveRequirements(rows, {
      country: 'KE',
      businessType: 'limited_company',
      targetLevel: 2,
    });
    expect(solo.find((r) => r.requirementCode === 'cert')?.mandatory).toBe(false);
    expect(company.find((r) => r.requirementCode === 'cert')?.mandatory).toBe(true);
  });

  it('ignores a type-specific row until the business type is known', () => {
    const unknown = resolveRequirements(rows, {
      country: 'KE',
      businessType: null,
      targetLevel: 2,
    });
    expect(unknown.find((r) => r.requirementCode === 'cert')?.mandatory).toBe(true);
  });

  it('prefers the country match over the business type match', () => {
    const more = [
      row({ requirementCode: 'x', mandatory: true }),
      row({ requirementCode: 'x', businessType: 'ngo', mandatory: false }),
      row({ requirementCode: 'x', country: 'UG', mandatory: true }),
    ];
    const picked = resolveRequirements(more, {
      country: 'UG',
      businessType: 'ngo',
      targetLevel: 1,
    });
    expect(picked).toHaveLength(1);
    expect(picked[0]?.country).toBe('UG');
    expect(picked[0]?.mandatory).toBe(true);
  });

  it('never returns an inactive row', () => {
    expect(
      codes(resolveRequirements(rows, { country: 'UG', businessType: null, targetLevel: 3 }))
    ).not.toContain('old');
  });
});

describe('evaluating evidence', () => {
  const required = [
    row({ requirementCode: 'owner_id', evidenceKey: 'national_id' }),
    row({ requirementCode: 'tin', kind: 'profile_field', evidenceKey: 'tin' }),
    row({ requirementCode: 'directors', kind: 'party', evidenceKey: 'director' }),
    row({ requirementCode: 'bank', kind: 'verification', evidenceKey: 'bank_account' }),
    row({ requirementCode: 'optional_doc', mandatory: false }),
  ];

  it('asks the merchant for everything except staff-side verifications', () => {
    const statuses = evaluateRequirements(required, NO_EVIDENCE, NOW);
    expect(missingForSubmission(statuses)).toEqual(['owner_id', 'tin', 'directors']);
    expect(unmetForApproval(statuses)).toEqual(['owner_id', 'tin', 'directors', 'bank']);
  });

  it('counts an uploaded document as provided and a verified one as verified', () => {
    const uploaded = evaluateRequirements(
      [required[0] as RequirementRow],
      { ...NO_EVIDENCE, documents: [{ type: 'national_id', status: 'uploaded', expiresAt: null }] },
      NOW
    );
    expect(uploaded[0]?.state).toBe('provided');
    expect(unmetForApproval(uploaded)).toEqual(['owner_id']);
    const verified = evaluateRequirements(
      [required[0] as RequirementRow],
      { ...NO_EVIDENCE, documents: [{ type: 'national_id', status: 'verified', expiresAt: null }] },
      NOW
    );
    expect(verified[0]?.state).toBe('verified');
  });

  it('does not count a rejected or expired document', () => {
    const state = (docs: Evidence['documents']) =>
      evaluateRequirements(
        [required[0] as RequirementRow],
        { ...NO_EVIDENCE, documents: docs },
        NOW
      )[0]?.state;
    expect(state([{ type: 'national_id', status: 'rejected', expiresAt: null }])).toBe('missing');
    expect(
      state([
        { type: 'national_id', status: 'verified', expiresAt: new Date('2025-05-31T00:00:00Z') },
      ])
    ).toBe('missing');
    expect(state([{ type: 'passport', status: 'verified', expiresAt: null }])).toBe('missing');
  });

  it('meets fields, parties and verifications from their own evidence', () => {
    const statuses = evaluateRequirements(
      required,
      {
        profileFields: new Set(['tin']),
        documents: [{ type: 'national_id', status: 'verified', expiresAt: null }],
        parties: { director: 2, ubo: 0 },
        passedChecks: new Set(['bank_account']),
      },
      NOW
    );
    expect(unmetForApproval(statuses)).toEqual([]);
  });
});
