import { prisma } from "../../lib/prisma/prisma";

const fix = process.argv.includes("--fix");

type Finding = { kind: string; id: string; detail: string; fixable: boolean };

const run = async () => {
  const findings: Finding[] = [];

  const services = await prisma.serviceCatalog.findMany({
    select: { id: true, adminId: true, serviceName: true, slug: true },
    orderBy: [{ adminId: "asc" }, { createdAt: "asc" }],
  });
  const seenSlugs = new Set<string>();
  for (const service of services) {
    const key = `${service.adminId}:${service.slug}`;
    if (!service.slug?.trim()) findings.push({ kind: "SERVICE_SLUG_MISSING", id: service.id, detail: service.serviceName, fixable: false });
    if (seenSlugs.has(key)) findings.push({ kind: "SERVICE_SLUG_DUPLICATE", id: service.id, detail: service.slug, fixable: false });
    seenSlugs.add(key);
  }

  const reviews = await prisma.review.findMany({
    select: {
      id: true, adminId: true, scope: true, source: true, status: true, isPublished: true,
      reviewTokenId: true, jobId: true, serviceCatalogId: true, serviceNameSnapshot: true,
      websiteId: true, websiteContact: { select: { id: true } },
      serviceCatalog: { select: { serviceName: true } },
    },
  });

  for (const review of reviews) {
    const shouldPublish = review.status === "published";
    if (review.isPublished !== shouldPublish) {
      findings.push({ kind: "REVIEW_PUBLICATION_MISMATCH", id: review.id, detail: `${review.status}/${review.isPublished}`, fixable: true });
      if (fix) await prisma.review.update({ where: { id: review.id }, data: { isPublished: shouldPublish } });
    }

    if (review.source === "WEBSITE") {
      if (!review.websiteId) findings.push({ kind: "WEBSITE_REVIEW_WITHOUT_WEBSITE", id: review.id, detail: review.scope, fixable: false });
      if (!review.websiteContact) findings.push({ kind: "WEBSITE_REVIEW_WITHOUT_PRIVATE_CONTACT", id: review.id, detail: review.scope, fixable: false });
      if (review.reviewTokenId || review.jobId) findings.push({ kind: "WEBSITE_REVIEW_HAS_LEGACY_LINK", id: review.id, detail: "token/job should be null", fixable: false });
    } else if (!review.reviewTokenId || !review.jobId) {
      findings.push({ kind: "JOB_REVIEW_WITHOUT_JOB_TOKEN", id: review.id, detail: review.scope, fixable: false });
    }

    if (review.scope === "SERVICE" && !review.serviceCatalogId) {
      findings.push({ kind: "SERVICE_REVIEW_WITHOUT_SERVICE", id: review.id, detail: review.serviceNameSnapshot ?? "", fixable: false });
    }
    if (review.serviceCatalogId && !review.serviceNameSnapshot && review.serviceCatalog?.serviceName) {
      findings.push({ kind: "REVIEW_SERVICE_SNAPSHOT_MISSING", id: review.id, detail: review.serviceCatalog.serviceName, fixable: true });
      if (fix) await prisma.review.update({ where: { id: review.id }, data: { serviceNameSnapshot: review.serviceCatalog.serviceName } });
    }
  }

  const counts = findings.reduce<Record<string, number>>((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ mode: fix ? "fix" : "report", scanned: { services: services.length, reviews: reviews.length }, findings: counts, sample: findings.slice(0, 50) }, null, 2));

  const nonFixable = findings.filter((item) => !item.fixable);
  if (!fix && nonFixable.length > 0) process.exitCode = 2;
};

run()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
