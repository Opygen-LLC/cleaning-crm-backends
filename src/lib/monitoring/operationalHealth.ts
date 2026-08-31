import { prisma } from "../prisma/prisma";
import { getOperationalMetricsSnapshot } from "./operationalMetrics";

const pendingStatuses = ["PENDING", "RETRY", "PROCESSING"] as const;

export const getOperationalHealthSnapshot = async () => {
  const [
    pendingOutbox,
    deadOutbox,
    oldestPending,
    deliveryRows,
  ] = await Promise.all([
    prisma.outboxEvent.groupBy({
      by: ["topic", "status"],
      where: { processedAt: null, status: { in: [...pendingStatuses] } },
      _count: { _all: true },
    }),
    prisma.outboxEvent.groupBy({
      by: ["topic"],
      where: { status: "DEAD" },
      _count: { _all: true },
    }),
    prisma.outboxEvent.findFirst({
      where: { processedAt: null, status: { in: [...pendingStatuses] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, topic: true },
    }),
    prisma.notificationDelivery.groupBy({
      by: ["status", "templateKey"],
      _count: { _all: true },
    }),
  ]);

  const deadLetterCount = deadOutbox.reduce((sum, row) => sum + row._count._all, 0);
  const failedNotificationCount = deliveryRows
    .filter((row) => row.status === "FAILED")
    .reduce((sum, row) => sum + row._count._all, 0);

  return {
    healthy: deadLetterCount === 0 && failedNotificationCount === 0,
    metrics: getOperationalMetricsSnapshot(),
    queues: {
      pending: pendingOutbox.map((row) => ({ topic: row.topic, status: row.status, count: row._count._all })),
      deadLetters: deadOutbox.map((row) => ({ topic: row.topic, count: row._count._all })),
      oldestPendingAt: oldestPending?.createdAt.toISOString() ?? null,
      oldestPendingTopic: oldestPending?.topic ?? null,
      oldestPendingAgeMs: oldestPending ? Math.max(0, Date.now() - oldestPending.createdAt.getTime()) : null,
    },
    notificationDeliveries: deliveryRows.map((row) => ({
      status: row.status,
      templateKey: row.templateKey,
      count: row._count._all,
    })),
  };
};
