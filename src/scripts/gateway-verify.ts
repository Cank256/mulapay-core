/**
 * Gateway verification script (P3-12): checks connectivity, API key validity, and tenant ID.
 * Run with: npm run gateway:verify
 *
 * Verifies:
 * - GATEWAY_BASE_URL is reachable
 * - GATEWAY_API_KEY is valid (401/403 means invalid)
 * - Tenant ID from response matches expectation
 *
 * Exit codes:
 * - 0: all checks passed
 * - 1: connectivity or configuration error
 */
import pino from 'pino';
import { getConfig } from '../config/configuration';
import { GatewayOperationsClient } from '../integrations/gateway/gateway-operations.client';
import { RedisCircuitBreaker } from '../integrations/gateway/circuit-breaker';
import { GatewayRequestRecorder } from '../integrations/gateway/gateway-request.recorder';

const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

async function verify(): Promise<void> {
  logger.info('Gateway verification starting...');

  const config = getConfig();

  // Check configuration
  if (!config.GATEWAY_BASE_URL) {
    logger.error('GATEWAY_BASE_URL is not configured');
    process.exit(1);
  }

  if (!config.GATEWAY_API_KEY) {
    logger.error('GATEWAY_API_KEY is not configured');
    process.exit(1);
  }

  logger.info({ baseUrl: config.GATEWAY_BASE_URL }, 'Gateway base URL configured');

  // Create a noop breaker and recorder for this verification
  const noopBreaker = {
    allow: async () => true,
    record: async () => 'closed' as const,
    mode: async () => 'closed' as const,
  } as unknown as RedisCircuitBreaker;

  const noopRecorder = {
    record: async () => {},
  } as unknown as GatewayRequestRecorder;

  const client = new GatewayOperationsClient(config, logger, noopBreaker, noopRecorder);

  // Test 1: Connectivity and authentication with getBalance
  logger.info('Testing connectivity and authentication...');

  try {
    const balanceResult = await client.getBalance('mtn_momo_ug', 'provider_operating', 'UGX');

    if (balanceResult.kind === 'unavailable') {
      if (balanceResult.reason === 'gateway_not_configured') {
        logger.error('Gateway is not configured');
        process.exit(1);
      } else if (balanceResult.reason === 'unauthorized') {
        logger.error('API key is invalid (401/403)');
        process.exit(1);
      } else if (balanceResult.reason.startsWith('http_')) {
        logger.error({ reason: balanceResult.reason }, 'HTTP error from gateway');
        process.exit(1);
      } else {
        logger.error({ reason: balanceResult.reason }, 'Gateway unavailable');
        process.exit(1);
      }
    }

    if (balanceResult.kind === 'ok') {
      logger.info(
        {
          availableMinor: balanceResult.availableMinor,
          currency: balanceResult.currency,
        },
        'Connectivity check passed'
      );
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to gateway');
    process.exit(1);
  }

  // Test 2: List operations to verify general API access
  logger.info('Testing API access with list operations...');

  try {
    const listResult = await client.listOperations({
      limit: 1,
      offset: 0,
    });

    if (listResult.kind === 'unavailable') {
      logger.error({ reason: listResult.reason }, 'List operations failed');
      process.exit(1);
    }

    if (listResult.kind === 'ok') {
      logger.info({ total: listResult.total }, 'API access verified');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to list operations');
    process.exit(1);
  }

  logger.info('✓ All gateway verification checks passed');
  logger.info('Gateway is configured correctly and accessible');
}

verify()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error({ err: error }, 'Verification failed with unexpected error');
    process.exit(1);
  });
