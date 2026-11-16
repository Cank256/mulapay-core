/**
 * Turns internal ids into the public refs the admin API shows, and staff refs (`usr_...`) back
 * into ids. Alerts and cases are assigned to staff and point at holds and cases; the API names
 * them by ref and the database by id. Reads only.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { AppError } from '../../common/errors/app-error';
import { amlCases, holds, merchants, users } from '../../db/schema';

@Injectable()
export class AmlStaffDirectory {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** The id of an active staff user. Anyone else is "not found". */
  async idOf(ref: string): Promise<string> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.ref, ref), eq(users.type, 'staff'), eq(users.status, 'active')))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND');
    return row.id;
  }

  async refsOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, ref: users.ref })
      .from(users)
      .where(inArray(users.id, wanted));
    return new Map(rows.map((r) => [r.id, r.ref]));
  }

  async holdRefsOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await this.db
      .select({ id: holds.id, ref: holds.ref })
      .from(holds)
      .where(inArray(holds.id, wanted));
    return new Map(rows.map((r) => [r.id, r.ref]));
  }

  async caseRefsOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await this.db
      .select({ id: amlCases.id, ref: amlCases.ref })
      .from(amlCases)
      .where(inArray(amlCases.id, wanted));
    return new Map(rows.map((r) => [r.id, r.ref]));
  }

  async merchantRefsOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await this.db
      .select({ id: merchants.id, ref: merchants.ref })
      .from(merchants)
      .where(inArray(merchants.id, wanted));
    return new Map(rows.map((r) => [r.id, r.ref]));
  }
}
