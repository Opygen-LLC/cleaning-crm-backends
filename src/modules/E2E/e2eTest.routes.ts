import { Router, type NextFunction, type Request, type Response } from "express";
import status from "http-status";
import { prisma } from "../../lib/prisma/prisma";
import { ServiceStatus, SubscriptionStatus, UserRole } from "../../generated/prisma/enums";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { PublicWebsiteService } from "../Website/publicWebsite.service";
import { WebsiteAcquisitionService } from "../Website/websiteAcquisition.service";
import { WebsiteService } from "../Website/website.service";

const router = Router();
const token = process.env.E2E_TEST_TOKEN?.trim() || "";
const domain = (process.env.E2E_TEST_EMAIL_DOMAIN || "e2e.invalid").trim().toLowerCase();

const assertEmail = (email: unknown): string => {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized.endsWith(`@${domain}`)) throw Object.assign(new Error("Synthetic E2E email required"), { statusCode: 400 });
  return normalized;
};

router.use((req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === "production" || process.env.E2E_TEST_HOOKS_ENABLED !== "true") return res.status(404).end();
  if (token.length < 32 || req.get("x-e2e-token") !== token) return res.status(status.NOT_FOUND).end();
  next();
});

const contextFor = async (email: string) => {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, status: true, emailVerified: true, admin: { select: { id: true, onboardingCompletedSteps: true, onboardingCompletedAt: true, businessWebsite: { select: { id: true, subdomain: true, status: true, primaryBookingFormId: true, primaryEstimateFormId: true } } } } },
  });
  if (!user?.admin) throw Object.assign(new Error("Synthetic account not found"), { statusCode: 404 });
  return { user, admin: user.admin, website: user.admin.businessWebsite };
};

router.get("/verification-code", async (req, res, next) => {
  try {
    const email = assertEmail(req.query.email);
    const rows = await prisma.verification.findMany({ where: { expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 100 });
    const row = rows.find((candidate) => candidate.identifier.toLowerCase().includes(email));
    if (!row || !/^\d{6}$/.test(row.value)) return res.status(409).json({ success: false, message: "OTP not available yet" });
    res.json({ success: true, data: { otp: row.value } });
  } catch (error) { next(error); }
});

router.get("/snapshot", async (req, res, next) => {
  try {
    const email = assertEmail(req.query.email);
    const { user, admin, website } = await contextFor(email);
    const [clients, bookings, jobs, services, submissions, estimates, subscriptions] = await Promise.all([
      prisma.client.count({ where: { adminId: admin.id } }),
      prisma.booking.count({ where: { adminId: admin.id } }),
      prisma.job.count({ where: { adminId: admin.id } }),
      prisma.serviceCatalog.count({ where: { adminId: admin.id } }),
      website ? prisma.bookingFormSubmission.count({ where: { sourceWebsiteId: website.id } }) : 0,
      website ? prisma.estimateFormSubmission.count({ where: { sourceWebsiteId: website.id } }) : 0,
      prisma.subscription.count({ where: { adminId: admin.id } }),
    ]);
    const dataFingerprint = JSON.stringify({ clients, bookings, jobs, services, subscriptions, websiteId: website?.id || null });
    res.json({ success: true, data: { user: { status: user.status, emailVerified: user.emailVerified }, onboarding: { completedSteps: admin.onboardingCompletedSteps, completedAt: admin.onboardingCompletedAt }, website, counts: { clients, bookings, jobs, services, bookingSubmissions: submissions, estimateSubmissions: estimates, subscriptions }, dataFingerprint } });
  } catch (error) { next(error); }
});

router.post("/complete-onboarding", async (req, res, next) => {
  try {
    const email = assertEmail(req.body.email);
    const { admin, website } = await contextFor(email);
    if (!website) return res.status(409).json({ success: false, message: "Website missing" });
    let service = await prisma.serviceCatalog.findFirst({ where: { adminId: admin.id }, orderBy: { createdAt: "asc" } });
    if (!service) {
      service = await prisma.serviceCatalog.create({ data: {
        adminId: admin.id, serviceName: "E2E Standard Cleaning", description: "Synthetic staging qualification service",
        basePrice: 100, duration: "2h", category: "STANDARD", status: ServiceStatus.ACTIVE, onlineBookingEnabled: true,
      } });
    }
    let bookingForm = website.primaryBookingFormId ? await prisma.bookingForm.findUnique({ where: { id: website.primaryBookingFormId } }) : null;
    if (!bookingForm) {
      bookingForm = await prisma.bookingForm.create({ data: {
        adminId: admin.id, slug: `phase7-booking-${admin.id.slice(0,8)}`, websiteManaged: true, published: true,
        headline: "Phase 7 Booking", availableDays: ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],
        blockedDates: [], timeSlots: ["10:00"], maxBookingsPerSlot: 5,
        services: { create: { serviceCatalogId: service.id, enabled: true, duration: "2h" } },
      } });
    } else if (!bookingForm.published) {
      bookingForm = await prisma.bookingForm.update({ where: { id: bookingForm.id }, data: { published: true } });
    }
    let estimateForm = website.primaryEstimateFormId ? await prisma.estimateForm.findUnique({ where: { id: website.primaryEstimateFormId } }) : null;
    if (!estimateForm) {
      estimateForm = await prisma.estimateForm.create({ data: {
        adminId: admin.id, slug: `phase7-estimate-${admin.id.slice(0,8)}`, published: true, headline: "Phase 7 Estimate",
        coveredPostcodes: [], coveredCities: [], showLiveEstimate: true,
        services: { create: { serviceCatalogId: service.id, enabled: true, basePrice: 100 } },
      } });
    } else if (!estimateForm.published) {
      estimateForm = await prisma.estimateForm.update({ where: { id: estimateForm.id }, data: { published: true } });
    }
    await prisma.adminProfile.update({ where: { id: admin.id }, data: { onboardingCompletedSteps: ["business_profile", "branding", "services", "website_address", "template"] } });
    await prisma.businessWebsite.update({ where: { id: website.id }, data: {
      primaryBookingFormId: bookingForm.id, primaryEstimateFormId: estimateForm.id, bookingEnabled: true, estimateEnabled: true,
    } });
    const account = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true, email: true } });
    await WebsiteService.publishWebsite({}, { id: account.id, email: account.email, role: UserRole.ADMIN, adminId: admin.id });
    await prisma.adminProfile.update({ where: { id: admin.id }, data: { onboardingCompletedAt: new Date() } });
    await WebsiteProjectionCacheService.invalidateWebsite(website.id).catch(() => undefined);
    res.json({ success: true, data: { completed: true, serviceCatalogId: service.id } });
  } catch (error) { next(error); }
});

router.post("/expire-trial", async (req, res, next) => {
  try {
    const email = assertEmail(req.body.email);
    const { admin } = await contextFor(email);
    await prisma.subscription.updateMany({ where: { adminId: admin.id, isTrial: true }, data: { status: SubscriptionStatus.EXPIRED, trialEndsAt: new Date(Date.now() - 60_000) } });
    const { invalidateSubscriptionAccessCache } = await import("../../middlewares/checkSubscription");
    await invalidateSubscriptionAccessCache((await prisma.adminProfile.findUnique({ where: { id: admin.id }, select: { userId: true } }))!.userId);
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.post("/qualify-public-acquisition", async (req, res, next) => {
  try {
    const email = assertEmail(req.body.email);
    const key = String(req.body.idempotencyKey || "").slice(0, 120);
    const { website } = await contextFor(email);
    if (!website) return res.status(409).json({ success: false, message: "Website missing" });
    const beforeB = await prisma.bookingFormSubmission.count({ where: { sourceWebsiteId: website.id } });
    const beforeBookings = await prisma.booking.count({ where: { adminId: (await contextFor(email)).admin.id } });
    const beforeE = await prisma.estimateFormSubmission.count({ where: { sourceWebsiteId: website.id } });
    // Only run if real public integrations are present. The hook intentionally
    // delegates to production acquisition services; it never inserts submissions itself.
    const pub = await PublicWebsiteService.getPublicWebsite(website.subdomain);
    if (!pub) return res.status(409).json({ success: false, message: "Public website unavailable" });
    const service = await prisma.serviceCatalog.findFirst({ where: { adminId: (await contextFor(email)).admin.id }, orderBy: { createdAt: "asc" } });
    if (!service || !website.primaryBookingFormId || !website.primaryEstimateFormId) return res.status(409).json({ success: false, message: "Qualification integrations missing" });
    const date = new Date(Date.now()+86400000).toISOString().slice(0,10);
    const bookingPayload = { serviceCatalogId: service.id, date, timeSlot: "10:00", name: "Phase Seven", email, phone: "+15555550123", address: "1 Test Street", notes: "phase7" } as never;
    await WebsiteAcquisitionService.submitBooking(website.subdomain, bookingPayload, key);
    await WebsiteAcquisitionService.submitBooking(website.subdomain, bookingPayload, key);
    const estimatePayload = { serviceCatalogId: service.id, bedrooms: 2, bathrooms: 1, addOnIds: [], postcode: "10001", city: "Test City", name: "Phase Seven", email, phone: "+15555550123", notes: "phase7" } as never;
    await WebsiteAcquisitionService.submitEstimate(website.subdomain, estimatePayload, `${key}-estimate`);
    await WebsiteAcquisitionService.submitEstimate(website.subdomain, estimatePayload, `${key}-estimate`);
    const afterB = await prisma.bookingFormSubmission.count({ where: { sourceWebsiteId: website.id } });
    const afterBookings = await prisma.booking.count({ where: { adminId: (await contextFor(email)).admin.id } });
    const afterE = await prisma.estimateFormSubmission.count({ where: { sourceWebsiteId: website.id } });
    res.json({ success: true, data: { bookingSubmissionDelta: afterB-beforeB, crmBookingDelta: afterBookings-beforeBookings, estimateSubmissionDelta: afterE-beforeE } });
  } catch (error) { next(error); }
});

router.post("/reset-cache", async (req, res, next) => {
  try { const email = assertEmail(req.body.email); const { website } = await contextFor(email); if (website) await WebsiteProjectionCacheService.invalidateWebsite(website.id); res.json({ success: true }); } catch (error) { next(error); }
});

router.post("/cleanup", async (req, res, next) => {
  try { const email = assertEmail(req.body.email); await prisma.user.deleteMany({ where: { email } }); res.json({ success: true }); } catch (error) { next(error); }
});

export const e2eTestRoutes = router;
