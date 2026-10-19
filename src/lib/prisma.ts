// SPDX-License-Identifier: MIT

import { PrismaClient, Prisma } from "@prisma/client";
import { logger } from "@/lib/logger";

export { Prisma, PrismaClient };

/**
 * Connection acquisition or query wait duration threshold in milliseconds.
 * Durations exceeding this trigger a structured warning log (#1371).
 */
export const DB_POOL_WAIT_THRESHOLD_MS = 500;

export interface PrismaPoolMetrics {
  busy: number;
  idle: number;
  open: number;
  waitDurationMsSum: number;
  waitDurationMsCount: number;
}

/**
 * Check if a connection acquisition or query wait duration exceeded the warning threshold.
 * Emits a structured warning log when exceeded.
 */
export function checkConnectionAcquisitionWait(
  durationMs: number,
  operation?: string,
  model?: string
): boolean {
  if (durationMs > DB_POOL_WAIT_THRESHOLD_MS) {
    logger.warn("Database connection acquisition or query wait exceeded threshold", {
      durationMs: Math.round(durationMs),
      thresholdMs: DB_POOL_WAIT_THRESHOLD_MS,
      ...(operation ? { operation } : {}),
      ...(model ? { model } : {}),
    });
    return true;
  }
  return false;
}

const prismaClientSingleton = () => {
  const baseClient = new PrismaClient();

  return baseClient.$extends({
    query: {
      $allModels: {
        async $allOperations({ operation, model, args, query }) {
          const start = performance.now();
          try {
            return await query(args);
          } finally {
            const duration = performance.now() - start;
            checkConnectionAcquisitionWait(duration, operation, model);
          }
        },
      },
    },
  });
};

type ExtendedPrismaClient = ReturnType<typeof prismaClientSingleton>;

const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedPrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

interface PrismaMetricGauge {
  key: string;
  value: number;
  labels?: Record<string, string>;
}

interface PrismaMetricHistogram {
  key: string;
  value: {
    buckets: [number, number][];
    count: number;
    sum: number;
  };
  labels?: Record<string, string>;
}

interface PrismaMetricsPayload {
  gauges?: PrismaMetricGauge[];
  histograms?: PrismaMetricHistogram[];
}

interface PrismaWithMetrics {
  $metrics?: {
    json(): Promise<PrismaMetricsPayload>;
    prometheus(): Promise<string>;
  };
}

/**
 * Collect database connection pool telemetry from Prisma client metrics.
 * Gracefully falls back when metrics are disabled, database is disconnected, or in unit tests.
 */
export async function getPrismaPoolMetrics(): Promise<PrismaPoolMetrics> {
  const fallback: PrismaPoolMetrics = {
    busy: 0,
    idle: 0,
    open: 0,
    waitDurationMsSum: 0,
    waitDurationMsCount: 0,
  };

  try {
    const clientWithMetrics = prisma as unknown as PrismaWithMetrics;
    const rawMetrics = clientWithMetrics.$metrics;
    if (typeof rawMetrics?.json === "function") {
      const json = await rawMetrics.json();
      const gauges = json?.gauges || [];
      const histograms = json?.histograms || [];

      const busyGauge = gauges.find((g: PrismaMetricGauge) => g.key === "prisma_pool_connections_busy");
      const idleGauge = gauges.find((g: PrismaMetricGauge) => g.key === "prisma_pool_connections_idle");
      const openGauge = gauges.find((g: PrismaMetricGauge) => g.key === "prisma_pool_connections_open");
      const waitHist = histograms.find((h: PrismaMetricHistogram) => h.key === "prisma_pool_wait_duration_ms");

      const waitSum = typeof waitHist?.value?.sum === "number" ? waitHist.value.sum : 0;
      const waitCount = typeof waitHist?.value?.count === "number" ? waitHist.value.count : 0;

      if (waitCount > 0) {
        const avgWait = waitSum / waitCount;
        if (avgWait > DB_POOL_WAIT_THRESHOLD_MS) {
          logger.warn("Prisma connection pool average wait time exceeded threshold", {
            avgWaitMs: Math.round(avgWait),
            thresholdMs: DB_POOL_WAIT_THRESHOLD_MS,
            totalWaitCount: waitCount,
          });
        }
      }

      return {
        busy: typeof busyGauge?.value === "number" ? busyGauge.value : 0,
        idle: typeof idleGauge?.value === "number" ? idleGauge.value : 0,
        open: typeof openGauge?.value === "number" ? openGauge.value : 0,
        waitDurationMsSum: waitSum,
        waitDurationMsCount: waitCount,
      };
    }
  } catch {
    // Offline or test environment fallback
  }

  return fallback;
}

/**
 * Format Prisma connection pool metrics in Prometheus exposition format.
 * Returns native $metrics.prometheus() string if available, or formatted fallback.
 */
export async function getPrismaPrometheusMetrics(): Promise<string> {
  try {
    const clientWithMetrics = prisma as unknown as PrismaWithMetrics;
    const rawMetrics = clientWithMetrics.$metrics;
    if (typeof rawMetrics?.prometheus === "function") {
      const output = await rawMetrics.prometheus();
      if (typeof output === "string" && output.trim().length > 0) {
        return output.trim();
      }
    }
  } catch {
    // Fallback when Prometheus exposition fails or DB is offline
  }

  const pool = await getPrismaPoolMetrics();
  return [
    "# HELP prisma_pool_connections_busy Number of currently used database connections in the pool",
    "# TYPE prisma_pool_connections_busy gauge",
    `prisma_pool_connections_busy ${pool.busy}`,
    "",
    "# HELP prisma_pool_connections_idle Number of currently unused database connections in the pool",
    "# TYPE prisma_pool_connections_idle gauge",
    `prisma_pool_connections_idle ${pool.idle}`,
    "",
    "# HELP prisma_pool_connections_open Number of currently open database connections in the pool",
    "# TYPE prisma_pool_connections_open gauge",
    `prisma_pool_connections_open ${pool.open}`,
    "",
    "# HELP prisma_pool_wait_duration_ms Time taken to acquire a connection in milliseconds",
    "# TYPE prisma_pool_wait_duration_ms histogram",
    `prisma_pool_wait_duration_ms_bucket{le="0"} 0`,
    `prisma_pool_wait_duration_ms_bucket{le="+Inf"} ${pool.waitDurationMsCount}`,
    `prisma_pool_wait_duration_ms_sum ${pool.waitDurationMsSum}`,
    `prisma_pool_wait_duration_ms_count ${pool.waitDurationMsCount}`,
  ].join("\n");
}

export interface KeysetCursorOptions {
  cursor?: string | null;
  limit?: number;
  order?: "asc" | "desc";
}

/**
 * Build Prisma findMany arguments for indexed keyset cursor pagination.
 * Takes limit + 1 to detect whether subsequent pages exist without an extra COUNT.
 */
export function buildPrismaCursorArgs(options: KeysetCursorOptions = {}) {
  const limit = options.limit ?? 20;
  const order = options.order === "asc" ? "asc" : "desc";
  return {
    take: limit + 1,
    orderBy: [
      { createdAt: order },
      { id: order },
    ] as [{ createdAt: typeof order }, { id: typeof order }],
    ...(options.cursor
      ? {
          cursor: { id: options.cursor },
          skip: 1,
        }
      : {}),
  };
}

