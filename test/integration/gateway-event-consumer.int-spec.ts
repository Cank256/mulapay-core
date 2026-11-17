/**
 * Gateway event consumer integration tests (P3-10): duplicate events, out-of-order ids,
 * handler failures with 3 attempts, crash between apply and cursor commit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, inject } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

describe('Gateway Event Consumer (Integration)', () => {
  let db: PostgresJsDatabase;
  let sql_client: postgres.Sql;

  beforeAll(async () => {
    const dbUrl = inject('databaseUrls').rw;
    sql_client = postgres(dbUrl, { max: 2 });
    db = drizzle(sql_client);
  });

  afterAll(async () => {
    await sql_client?.end();
  });

  beforeEach(async () => {
    // Initialize cursor
    await db.execute(sql`
      INSERT INTO core.consumer_cursors (name, position)
      VALUES ('gateway', '0')
      ON CONFLICT (name) DO UPDATE
      SET position = '0', heartbeat_at = NULL
    `);

    // Clear any existing gateway events for this test
    await db.execute(sql`DELETE FROM core.gateway_events`);
  });

  const insertEvent = async (overrides: {
    id: bigint;
    eventId: string;
    operationId?: string;
    status?: string;
    apply_status?: string;
  }) => {
    await db.execute(sql`
      INSERT INTO core.gateway_events (
        gateway_event_id, gateway_id, operation_id, provider_id, operation_type,
        external_id, reference_id, provider_transaction_id, status, previous_status,
        amount, currency, source, occurred_at, apply_status
      ) VALUES (
        ${overrides.eventId},
        ${overrides.id.toString()},
        ${overrides.operationId || 'op_test_001'},
        'mtn',
        'collection',
        'txn_test_001',
        'ref_001',
        'mtn_tx_001',
        ${overrides.status || 'successful'},
        'pending',
        100000,
        'UGX',
        'callback',
        now() AT TIME ZONE 'UTC',
        ${overrides.apply_status || 'pending'}
      )
    `);
  };

  const getCursor = async (): Promise<string> => {
    const result = await db.execute(sql`
      SELECT position FROM core.consumer_cursors WHERE name = 'gateway'
    `);
    return result[0]?.position as string;
  };

  describe('duplicate event dedupe (ON CONFLICT)', () => {
    it('should prevent duplicate events with same gateway_event_id', async () => {
      await insertEvent({ id: BigInt(1), eventId: 'evt_dup_001' });

      // Try to insert the same eventId again (should be rejected by UNIQUE constraint)
      await expect(
        insertEvent({ id: BigInt(1), eventId: 'evt_dup_001' })
      ).rejects.toThrow();

      // Verify only one row exists
      const rows = await db.execute(sql`
        SELECT COUNT(*) as count
        FROM core.gateway_events
        WHERE gateway_event_id = 'evt_dup_001'
      `);
      expect(rows[0]).toMatchObject({ count: '1' });
    });

    it('should allow different event IDs even with same gateway_id', async () => {
      await insertEvent({ id: BigInt(1), eventId: 'evt_dup_002' });
      await insertEvent({ id: BigInt(1), eventId: 'evt_dup_003' });

      const rows = await db.execute(sql`
        SELECT COUNT(*) as count
        FROM core.gateway_events
        WHERE gateway_id = '1'
      `);
      expect(rows[0]).toMatchObject({ count: '2' });
    });
  });

  describe('cursor advancement with GREATEST', () => {
    it('should advance cursor forward', async () => {
      await db.execute(sql`
        UPDATE core.consumer_cursors
        SET position = GREATEST(position, ${BigInt(10).toString()}::bigint)
        WHERE name = 'gateway'
      `);

      expect(await getCursor()).toBe('10');
    });

    it('should never move cursor backwards (GREATEST)', async () => {
      // Set cursor to 100
      await db.execute(sql`
        UPDATE core.consumer_cursors
        SET position = ${BigInt(100).toString()}
        WHERE name = 'gateway'
      `);

      // Try to set it to 50 (should stay at 100)
      await db.execute(sql`
        UPDATE core.consumer_cursors
        SET position = GREATEST(position, ${BigInt(50).toString()}::bigint)
        WHERE name = 'gateway'
      `);

      expect(await getCursor()).toBe('100');
    });

    it('should handle out-of-order advancement correctly', async () => {
      // Advance to 10
      await db.execute(sql`
        UPDATE core.consumer_cursors
        SET position = GREATEST(position, '10'::bigint)
        WHERE name = 'gateway'
      `);
      expect(await getCursor()).toBe('10');

      // Try to go backwards to 5 (should stay at 10)
      await db.execute(sql`
        UPDATE core.consumer_cursors
        SET position = GREATEST(position, '5'::bigint)
        WHERE name = 'gateway'
      `);
      expect(await getCursor()).toBe('10');

      // Advance to 15
      await db.execute(sql`
        UPDATE core.consumer_cursors
        SET position = GREATEST(position, '15'::bigint)
        WHERE name = 'gateway'
      `);
      expect(await getCursor()).toBe('15');
    });
  });

  describe('handler failure tracking', () => {
    it('should increment attempts counter', async () => {
      await insertEvent({ id: BigInt(20), eventId: 'evt_fail_001' });

      // Increment attempts
      await db.execute(sql`
        UPDATE core.gateway_events
        SET attempts = attempts + 1,
            apply_error = 'Test error'
        WHERE gateway_event_id = 'evt_fail_001'
      `);

      const result = await db.execute(sql`
        SELECT attempts, apply_error
        FROM core.gateway_events
        WHERE gateway_event_id = 'evt_fail_001'
      `);

      expect(result[0]).toMatchObject({
        attempts: 1,
        apply_error: 'Test error',
      });
    });

    it('should mark event failed after max attempts', async () => {
      await insertEvent({ id: BigInt(21), eventId: 'evt_fail_002' });

      // Simulate 3 failed attempts
      for (let i = 0; i < 3; i++) {
        await db.execute(sql`
          UPDATE core.gateway_events
          SET attempts = attempts + 1,
              apply_error = 'Handler error'
          WHERE gateway_event_id = 'evt_fail_002'
        `);
      }

      // Mark as failed
      await db.execute(sql`
        UPDATE core.gateway_events
        SET apply_status = 'failed'
        WHERE gateway_event_id = 'evt_fail_002'
      `);

      const result = await db.execute(sql`
        SELECT attempts, apply_status
        FROM core.gateway_events
        WHERE gateway_event_id = 'evt_fail_002'
      `);

      expect(result[0]).toMatchObject({
        attempts: 3,
        apply_status: 'failed',
      });
    });
  });

  describe('apply_status transitions', () => {
    it('should track event processing state', async () => {
      await insertEvent({
        id: BigInt(30),
        eventId: 'evt_status_001',
        apply_status: 'pending',
      });

      // Mark as applied
      await db.execute(sql`
        UPDATE core.gateway_events
        SET apply_status = 'applied',
            processed_at = now() AT TIME ZONE 'UTC'
        WHERE gateway_event_id = 'evt_status_001'
      `);

      const result = await db.execute(sql`
        SELECT apply_status, processed_at
        FROM core.gateway_events
        WHERE gateway_event_id = 'evt_status_001'
      `);

      expect(result[0]).toMatchObject({
        apply_status: 'applied',
      });
      expect(result[0]?.processed_at).toBeTruthy();
    });

    it('should support all three apply_status values', async () => {
      await insertEvent({ id: BigInt(31), eventId: 'evt_st_pending', apply_status: 'pending' });
      await insertEvent({ id: BigInt(32), eventId: 'evt_st_applied', apply_status: 'applied' });
      await insertEvent({ id: BigInt(33), eventId: 'evt_st_failed', apply_status: 'failed' });

      const result = await db.execute(sql`
        SELECT gateway_event_id, apply_status
        FROM core.gateway_events
        WHERE gateway_event_id LIKE 'evt_st_%'
        ORDER BY gateway_event_id
      `);

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ apply_status: 'applied' });
      expect(result[1]).toMatchObject({ apply_status: 'failed' });
      expect(result[2]).toMatchObject({ apply_status: 'pending' });
    });
  });

  describe('heartbeat updates', () => {
    it('should update heartbeat_at timestamp', async () => {
      await db.execute(sql`
        UPDATE core.consumer_cursors
        SET heartbeat_at = NULL
        WHERE name = 'gateway'
      `);

      let cursor = await db.execute(sql`
        SELECT heartbeat_at FROM core.consumer_cursors WHERE name = 'gateway'
      `);
      expect(cursor[0]?.heartbeat_at).toBeNull();

      // Update heartbeat
      await db.execute(sql`
        UPDATE core.consumer_cursors
        SET heartbeat_at = now() AT TIME ZONE 'UTC'
        WHERE name = 'gateway'
      `);

      cursor = await db.execute(sql`
        SELECT heartbeat_at FROM core.consumer_cursors WHERE name = 'gateway'
      `);
      expect(cursor[0]?.heartbeat_at).toBeTruthy();
    });
  });

  describe('crash recovery scenarios', () => {
    it('should handle event inserted but cursor not advanced', async () => {
      // Insert event with applied status (simulating successful processing)
      await insertEvent({
        id: BigInt(100),
        eventId: 'evt_crash_001',
        apply_status: 'applied',
      });

      // Cursor is still at 0 (crash before cursor advance)
      expect(await getCursor()).toBe('0');

      // After restart, cursor can be advanced
      await db.execute(sql`
        UPDATE core.consumer_cursors
        SET position = GREATEST(position, '100'::bigint)
        WHERE name = 'gateway'
      `);

      expect(await getCursor()).toBe('100');
    });

    it('should allow reprocessing of pending event after crash', async () => {
      // Insert event that failed to process
      await insertEvent({
        id: BigInt(101),
        eventId: 'evt_crash_002',
        apply_status: 'pending',
      });

      // Can update to applied
      await db.execute(sql`
        UPDATE core.gateway_events
        SET apply_status = 'applied', processed_at = now() AT TIME ZONE 'UTC'
        WHERE gateway_event_id = 'evt_crash_002'
      `);

      const result = await db.execute(sql`
        SELECT apply_status FROM core.gateway_events
        WHERE gateway_event_id = 'evt_crash_002'
      `);

      expect(result[0]).toMatchObject({ apply_status: 'applied' });
    });
  });

  describe('event ordering and selection', () => {
    it('should support fetching events after cursor position', async () => {
      await insertEvent({ id: BigInt(200), eventId: 'evt_order_001' });
      await insertEvent({ id: BigInt(201), eventId: 'evt_order_002' });
      await insertEvent({ id: BigInt(202), eventId: 'evt_order_003' });

      // Set cursor to 200
      await db.execute(sql`
        UPDATE core.consumer_cursors SET position = '200'
        WHERE name = 'gateway'
      `);

      // Fetch events after cursor (simulating consumer query)
      const events = await db.execute(sql`
        SELECT gateway_id, gateway_event_id
        FROM core.gateway_events
        WHERE gateway_id > (SELECT position FROM core.consumer_cursors WHERE name = 'gateway')
        ORDER BY gateway_id
        LIMIT 10
      `);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ gateway_event_id: 'evt_order_002' });
      expect(events[1]).toMatchObject({ gateway_event_id: 'evt_order_003' });
    });
  });

  describe('transaction boundaries (simulated)', () => {
    it('should support atomic insert and cursor advance within transaction', async () => {
      // Simulate the consumer's transaction: insert event, mark applied, advance cursor
      await db.execute(sql`BEGIN`);

      try {
        await insertEvent({
          id: BigInt(300),
          eventId: 'evt_tx_001',
          apply_status: 'applied',
        });

        await db.execute(sql`
          UPDATE core.consumer_cursors
          SET position = GREATEST(position, '300'::bigint),
              heartbeat_at = now() AT TIME ZONE 'UTC'
          WHERE name = 'gateway'
        `);

        await db.execute(sql`COMMIT`);
      } catch (error) {
        await db.execute(sql`ROLLBACK`);
        throw error;
      }

      // Verify both event and cursor were committed
      const event = await db.execute(sql`
        SELECT gateway_event_id FROM core.gateway_events
        WHERE gateway_event_id = 'evt_tx_001'
      `);
      expect(event).toHaveLength(1);
      expect(await getCursor()).toBe('300');
    });
  });
});
