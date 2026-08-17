import { randomBytes } from "crypto";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import status from "http-status";
import { FormFieldType, FormSubmissionStatus, ServiceStatus } from "../../generated/prisma/enums";
import { Prisma } from "../../generated/prisma/client";
import { IRequestUser } from "../../types/requestUser.interface";
import { IBookingFormCreate, IPublicBookingSubmission } from "./bookingForm.interface";
import { projectCanonicalService, projectPublicBusiness } from "../../lib/utils/canonicalProjection";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";

// ─── Slot-generation helpers (mirrors frontend logic exactly) ─────────────────

const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
] as const;

function timeToMinutes(t: string): number {
    const [h, m] = t.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
}

function minutesToTime(mins: number): string {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Given window strings ("Monday|09:00-17:00"), a slot duration, and buffer gap,
 * generate all valid slot start-times that fit fully inside each window.
 *
 * e.g. window 09:00-17:00 + 2-hour slots = ["09:00","11:00","13:00","15:00"]
 */
function generateSlotsFromWindows(
    timeSlotWindows: string[],
    slotDurationMinutes: number,
    bufferTimeMinutes: number,
): string[] {
    const step = slotDurationMinutes + bufferTimeMinutes;
    const slotSet = new Set<string>();

    for (const ts of timeSlotWindows) {
        const [, range] = ts.split("|");
        if (!range) continue;
        const [startStr, endStr] = range.split("-");
        if (!startStr || !endStr) continue;

        const windowStart = timeToMinutes(startStr);
        const windowEnd   = timeToMinutes(endStr);

        let cursor = windowStart;
        while (cursor + slotDurationMinutes <= windowEnd) {
            slotSet.add(minutesToTime(cursor));
            cursor += step;
        }
    }

    return Array.from(slotSet).sort();
}

/**
 * Get the day name ("Monday", "Tuesday", …) for a YYYY-MM-DD date string.
 * Uses noon UTC to avoid any timezone edge-cases around midnight.
 */
function getDayName(dateStr: string): string {
    const d = new Date(`${dateStr}T12:00:00.000Z`);
    return DAY_NAMES[d.getUTCDay()] ?? "Monday";
}

// ─── Other helpers ────────────────────────────────────────────────────────────

const generateSubmissionRef = (): string => {
    const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, "");
    // 64 bits of cryptographic randomness avoids the race/collision risk of
    // reading the latest sequential ref before insert. Existing refs remain
    // valid; only new submissions use this concurrency-safe format.
    return `#BK-${datePart}-${randomBytes(8).toString("hex").toUpperCase()}`;
};

const isBlockedDate = (blockedDates: string[], date: string): boolean =>
    blockedDates.some((entry) => entry.split("|")[0] === date);

const isCoreBookingField = (field: { type: FormFieldType; label: string }): boolean => {
    const label = field.label.trim().toLowerCase();
    if (field.type === FormFieldType.EMAIL && label.includes("email")) return true;
    if (field.type === FormFieldType.PHONE && label.includes("phone")) return true;
    if (field.type === FormFieldType.ADDRESS && label.includes("address")) return true;
    return field.type === FormFieldType.TEXT && /(^|\s)(full\s+name|your\s+name|customer\s+name|name)(\s|$)/.test(label);
};

type PublicAnswerField = {
    id: string;
    type: FormFieldType;
    label: string;
    required: boolean;
    options: string[];
};

type StoredBookingAnswer = {
    fieldId: string;
    label: string;
    type: FormFieldType;
    value: string;
};

const validateAndSnapshotCustomAnswers = (
    fields: PublicAnswerField[],
    answers: Record<string, string> | undefined,
): StoredBookingAnswer[] => {
    const fieldErrors: Record<string, string> = {};
    const stored: StoredBookingAnswer[] = [];

    for (const field of fields) {
        if (isCoreBookingField(field)) continue;

        const value = (answers?.[field.id] ?? "").trim();
        const path = `answers.${field.id}`;

        if (!value) {
            if (field.required) fieldErrors[path] = `${field.label} is required`;
            continue;
        }

        if (field.type === FormFieldType.SELECT && field.options.length > 0 && !field.options.includes(value)) {
            fieldErrors[path] = `Choose a valid option for ${field.label}`;
            continue;
        }
        if (field.type === FormFieldType.EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            fieldErrors[path] = `Enter a valid email address for ${field.label}`;
            continue;
        }
        if (field.type === FormFieldType.PHONE && value.replace(/\D/g, "").length < 6) {
            fieldErrors[path] = `Enter a valid phone number for ${field.label}`;
            continue;
        }
        if (field.type === FormFieldType.NUMBER && !Number.isFinite(Number(value))) {
            fieldErrors[path] = `Enter a valid number for ${field.label}`;
            continue;
        }
        if (field.type === FormFieldType.DATE) {
            const parsed = new Date(`${value}T00:00:00.000Z`);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
                fieldErrors[path] = `Enter a valid date for ${field.label}`;
                continue;
            }
        }

        stored.push({
            fieldId: field.id,
            label: field.label,
            type: field.type,
            value,
        });
    }

    if (Object.keys(fieldErrors).length > 0) {
        throw new AppError(
            status.UNPROCESSABLE_ENTITY,
            "Please check the highlighted fields and try again.",
            { code: "VALIDATION_ERROR", retryable: false, fieldErrors },
        );
    }

    return stored;
};

const generateSlug = (headline: string, adminId: string): string => {
    const base = headline
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
    return `${base}-${adminId.slice(0, 6)}`;
};

// ─── Standard includes ─────────────────────────────────────────────────────────

const formInclude = {
    fields: true,
    services: { include: { serviceCatalog: true } },
    _count: {
        select: { submissions: true },
    },
} as const;

type FormServiceInput = NonNullable<IBookingFormCreate["services"]>[number];

const resolveFormServices = async (adminId: string, services: FormServiceInput[]) => {
    const ids = [...new Set(services.map((s) => s.serviceCatalogId).filter((id): id is string => !!id))];
    const legacyTypes = [...new Set(
        services
            .filter((service) => !service.serviceCatalogId && service.serviceType)
            .map((service) => service.serviceType!),
    )];

    const catalogs = ids.length || legacyTypes.length
        ? await prisma.serviceCatalog.findMany({
            where: {
                adminId,
                status: ServiceStatus.ACTIVE,
                OR: [
                    ...(ids.length ? [{ id: { in: ids } }] : []),
                    ...(legacyTypes.length ? [{ legacyServiceType: { in: legacyTypes } }] : []),
                ],
            },
            select: { id: true, legacyServiceType: true },
        })
        : [];

    const byId = new Map(catalogs.map((catalog) => [catalog.id, catalog]));
    if (ids.some((id) => !byId.has(id))) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "One or more selected services do not belong to this business", {
            code: "SERVICE_TENANT_MISMATCH",
            retryable: false,
            fieldErrors: { services: "Choose active services from your own service catalog." },
        });
    }

    const byLegacy = new Map<string, typeof catalogs>();
    for (const catalog of catalogs) {
        if (!catalog.legacyServiceType) continue;
        const key = String(catalog.legacyServiceType);
        const bucket = byLegacy.get(key) ?? [];
        bucket.push(catalog);
        byLegacy.set(key, bucket);
    }

    const resolved = services.map((entry) => {
        let catalog = entry.serviceCatalogId ? byId.get(entry.serviceCatalogId) : undefined;

        // Old clients still send only ServiceType. When exactly one active
        // catalog service maps to that enum, promote it to the canonical
        // ServiceCatalog relation automatically. Ambiguous mappings require a
        // modern client to send serviceCatalogId rather than guessing.
        if (!catalog && !entry.serviceCatalogId && entry.serviceType) {
            const matches = byLegacy.get(String(entry.serviceType)) ?? [];
            if (matches.length > 1) {
                throw new AppError(status.UNPROCESSABLE_ENTITY, "Choose a specific service from the service catalog", {
                    code: "SERVICE_SELECTION_AMBIGUOUS",
                    retryable: false,
                    fieldErrors: { services: "This legacy service maps to multiple catalog services. Choose a specific service." },
                });
            }
            catalog = matches[0];
        }

        return {
            serviceCatalogId: catalog?.id ?? null,
            // Catalog relation is authoritative; old enum is only a compatibility value.
            serviceType: catalog?.legacyServiceType ?? entry.serviceType ?? null,
            enabled: entry.enabled ?? true,
            priceLabel: entry.priceLabel,
            duration: entry.duration,
        };
    });

    // Canonical IDs define uniqueness for catalog-backed rows. Two distinct
    // catalog services are allowed to share the same legacy ServiceType; that
    // enum is only a compatibility hint. Legacy-only rows still remain unique
    // by ServiceType through the identity key below and the partial DB index.
    const identityKeys = resolved
        .map((service) => service.serviceCatalogId
            ? `catalog:${service.serviceCatalogId}`
            : service.serviceType
                ? `legacy:${service.serviceType}`
                : null)
        .filter((key): key is string => !!key);
    if (new Set(identityKeys).size !== identityKeys.length) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "A service can only be added to a booking form once", {
            code: "DUPLICATE_BOOKING_FORM_SERVICE",
            retryable: false,
            fieldErrors: { services: "Remove the duplicate service before saving." },
        });
    }

    return resolved;
};

// ─── BookingForm CRUD ─────────────────────────────────────────────────────────

const createBookingForm = async (
    payload: IBookingFormCreate,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);
    const resolvedServices = payload.services ? await resolveFormServices(adminId, payload.services) : undefined;
    const slug    = generateSlug(payload.headline, adminId);

    const existing = await prisma.bookingForm.findUnique({ where: { slug } });
    const finalSlug = existing ? `${slug}-${Date.now().toString(36)}` : slug;

    const created = await prisma.bookingForm.create({
        data: {
            slug:                finalSlug,
            adminId,
            headline:            payload.headline,
            subheading:          payload.subheading,
            accentColor:         payload.accentColor ?? "#000000",
            showReviews:         payload.showReviews ?? true,
            ctaLabel:            payload.ctaLabel ?? "Request booking",
            confirmationMessage: payload.confirmationMessage,
            availableDays:       payload.availableDays ?? [],
            blockedDates:        payload.blockedDates ?? [],
            timeSlots:           payload.timeSlots ?? [],
            maxBookingsPerSlot:  payload.maxBookingsPerSlot ?? 1,
            slotDurationMinutes: payload.slotDurationMinutes ?? 120,
            bufferTimeMinutes:   payload.bufferTimeMinutes ?? 0,
            services: payload.services?.length
                ? {
                    createMany: {
                        data: resolvedServices!,
                    },
                }
                : undefined,
            fields: payload.fields?.length
                ? {
                    createMany: {
                        data: payload.fields.map((f, i) => ({
                            type:        f.type,
                            label:       f.label,
                            placeholder: f.placeholder,
                            required:    f.required ?? false,
                            enabled:     f.enabled ?? true,
                            options:     f.options ?? [],
                            sortOrder:   f.sortOrder ?? i,
                        })),
                    },
                }
                : undefined,
        },
        include: formInclude,
    });
    await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
    return created;
};

const getAllBookingForms = async (user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const forms = await prisma.bookingForm.findMany({
        where:   { adminId },
        include: formInclude,
        orderBy: { createdAt: "desc" },
    });

    const formIds = forms.map((f) => f.id);
    const submissionCounts = await prisma.bookingFormSubmission.groupBy({
        by:     ["formId"],
        where:  { formId: { in: formIds } },
        _count: { id: true },
    });
    const newCounts = await prisma.bookingFormSubmission.groupBy({
        by:     ["formId"],
        where:  { formId: { in: formIds }, status: FormSubmissionStatus.NEW },
        _count: { id: true },
    });
    const convertedCounts = await prisma.bookingFormSubmission.groupBy({
        by:     ["formId"],
        where:  { formId: { in: formIds }, status: FormSubmissionStatus.CONVERTED },
        _count: { id: true },
    });

    const countMap     = Object.fromEntries(submissionCounts.map((r) => [r.formId, r._count.id]));
    const newMap       = Object.fromEntries(newCounts.map((r) => [r.formId, r._count.id]));
    const convertedMap = Object.fromEntries(convertedCounts.map((r) => [r.formId, r._count.id]));

    const enriched = forms.map((f) => ({
        ...f,
        totalSubmissions: countMap[f.id] ?? 0,
        newSubmissions:   newMap[f.id]   ?? 0,
        conversions:      convertedMap[f.id] ?? 0,
        link:             `/book/${f.slug}`,
    }));

    const stats = {
        total:            forms.length,
        active:           forms.filter((f) => f.published).length,
        totalSubmissions: enriched.reduce((s, f) => s + f.totalSubmissions, 0),
        totalConversions: enriched.reduce((s, f) => s + f.conversions, 0),
        totalNew:         enriched.reduce((s, f) => s + f.newSubmissions, 0),
    };

    return { forms: enriched, total: forms.length, stats };
};

const getBookingFormById = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const form = await prisma.bookingForm.findFirst({
        where:   { id, adminId },
        include: formInclude,
    });
    if (!form) throw new AppError(status.NOT_FOUND, "Booking form not found");

    return form;
};

const updateBookingForm = async (
    id: string,
    payload: Partial<IBookingFormCreate> & { published?: boolean },
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.bookingForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Booking form not found");
    const resolvedServices = payload.services ? await resolveFormServices(adminId, payload.services) : undefined;

    const updated = await prisma.$transaction(async (tx) => {
        // Replace services when provided
        if (payload.services) {
            await tx.bookingFormService.deleteMany({ where: { formId: id } });
            await tx.bookingFormService.createMany({
                data: resolvedServices!.map((service) => ({ formId: id, ...service })),
            });
        }

        // Replace fields when provided
        if (payload.fields) {
            await tx.bookingFormField.deleteMany({ where: { formId: id } });
            await tx.bookingFormField.createMany({
                data: payload.fields.map((f, i) => ({
                    formId:      id,
                    type:        f.type,
                    label:       f.label,
                    placeholder: f.placeholder,
                    required:    f.required ?? false,
                    enabled:     f.enabled ?? true,
                    options:     f.options ?? [],
                    sortOrder:   f.sortOrder ?? i,
                })),
            });
        }

        return tx.bookingForm.update({
            where: { id },
            data: {
                ...(payload.headline              !== undefined && { headline: payload.headline }),
                ...(payload.subheading            !== undefined && { subheading: payload.subheading }),
                ...(payload.accentColor           !== undefined && { accentColor: payload.accentColor }),
                ...(payload.showReviews           !== undefined && { showReviews: payload.showReviews }),
                ...(payload.ctaLabel              !== undefined && { ctaLabel: payload.ctaLabel }),
                ...(payload.confirmationMessage   !== undefined && { confirmationMessage: payload.confirmationMessage }),
                ...(payload.availableDays         !== undefined && { availableDays: payload.availableDays }),
                ...(payload.blockedDates          !== undefined && { blockedDates: payload.blockedDates }),
                ...(payload.timeSlots             !== undefined && { timeSlots: payload.timeSlots }),
                ...(payload.maxBookingsPerSlot    !== undefined && { maxBookingsPerSlot: payload.maxBookingsPerSlot }),
                ...(payload.slotDurationMinutes   !== undefined && { slotDurationMinutes: payload.slotDurationMinutes }),
                ...(payload.bufferTimeMinutes     !== undefined && { bufferTimeMinutes: payload.bufferTimeMinutes }),
                ...(payload.published             !== undefined && { published: payload.published }),
            },
            include: formInclude,
        });
    });
    await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
    return updated;
};

const deleteBookingForm = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const existing = await prisma.bookingForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Booking form not found");
    await prisma.bookingForm.delete({ where: { id } });
    await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
};

const togglePublished = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const existing = await prisma.bookingForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Booking form not found");

    const updated = await prisma.bookingForm.update({
        where: { id },
        data:  { published: !existing.published },
        include: formInclude,
    });
    await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
    return updated;
};

// ─── Submissions ───────────────────────────────────────────────────────────────

const getSubmissions = async (
    formId: string | undefined,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    if (formId) {
        const form = await prisma.bookingForm.findFirst({ where: { id: formId, adminId } });
        if (!form) throw new AppError(status.NOT_FOUND, "Booking form not found");
    }

    return prisma.bookingFormSubmission.findMany({
        // Scope through the owning form as well as an optional form id. This
        // keeps tenant isolation in the database predicate and avoids relying
        // on a separately fetched list of tenant form ids.
        where: {
            ...(formId ? { formId } : {}),
            form: { adminId },
        },
        include: {
            form: { select: { headline: true, slug: true } },
            serviceCatalog: { select: { id: true, serviceName: true, duration: true, basePriceGbp: true } },
            convertedBooking: { select: { id: true, bookingRef: true } },
        },
        orderBy: { createdAt: "desc" },
    });
};

const updateSubmissionStatus = async (
    submissionId: string,
    newStatus: FormSubmissionStatus,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const submission = await prisma.bookingFormSubmission.findFirst({
        where: {
            id: submissionId,
            form: { adminId },
        },
        include: {
            form: {
                select: { headline: true, maxBookingsPerSlot: true },
            },
            convertedBooking: { select: { id: true, bookingRef: true } },
        },
    });
    if (!submission) throw new AppError(status.NOT_FOUND, "Submission not found");

    // CONVERTED is a derived state backed by convertedBookingId. Prevent a
    // status-only PATCH from manufacturing or undoing a conversion.
    if (newStatus === FormSubmissionStatus.CONVERTED && !submission.convertedBooking) {
        throw new AppError(status.CONFLICT, "Convert this submission using the booking conversion action", {
            code: "BOOKING_CONVERSION_REQUIRED",
            retryable: false,
        });
    }
    if (submission.convertedBooking && newStatus !== FormSubmissionStatus.CONVERTED) {
        throw new AppError(status.CONFLICT, "Converted submissions are linked to a booking and cannot change status", {
            code: "BOOKING_CONVERSION_IMMUTABLE",
            retryable: false,
        });
    }

    // A declined request no longer consumes capacity. If an admin restores it,
    // reserve capacity under the same database lock used by public checkout so
    // reactivation cannot silently overbook a slot.
    if (
        submission.status === FormSubmissionStatus.DECLINED &&
        newStatus !== FormSubmissionStatus.DECLINED
    ) {
        const date = submission.date.toISOString().slice(0, 10);
        const dateStart = new Date(`${date}T00:00:00.000Z`);
        const dateEnd = new Date(`${date}T23:59:59.999Z`);
        const slotLockKey = `booking-slot:${submission.formId}:${date}:${submission.timeSlot}`;

        return prisma.$transaction(async (tx) => {
            await acquireExtendedTextTransactionAdvisoryLock(tx, slotLockKey);
            const occupied = await tx.bookingFormSubmission.count({
                where: {
                    formId: submission.formId,
                    date: { gte: dateStart, lte: dateEnd },
                    timeSlot: submission.timeSlot,
                    status: { not: FormSubmissionStatus.DECLINED },
                },
            });

            if (occupied >= submission.form.maxBookingsPerSlot) {
                throw new AppError(
                    status.CONFLICT,
                    "This time slot is already at capacity. Keep this request declined or move it to another slot.",
                    { code: "BOOKING_SLOT_FULL", retryable: false },
                );
            }

            return tx.bookingFormSubmission.update({
                where: { id: submissionId },
                data: { status: newStatus },
                include: { form: { select: { headline: true } } },
            });
        });
    }

    return prisma.bookingFormSubmission.update({
        where: { id: submissionId },
        data:  { status: newStatus },
        include: { form: { select: { headline: true } } },
    });
};

// ─── Public endpoint (unauthenticated) ───────────────────────────────────────

type PublicBookingFormSelector = {
    slug?: string;
    formId?: string;
    adminId?: string;
    // Internal acquisition attribution. Never populated from public request
    // bodies; Website routes obtain it from the resolved BusinessWebsite.
    sourceWebsiteId?: string;
};

const publicBookingFormWhere = (selector: PublicBookingFormSelector) => {
    if (!selector.slug && !selector.formId) {
        throw new AppError(status.BAD_REQUEST, "A booking form identifier is required");
    }
    return {
        ...(selector.slug ? { slug: selector.slug } : {}),
        ...(selector.formId ? { id: selector.formId } : {}),
        ...(selector.adminId ? { adminId: selector.adminId } : {}),
    };
};

const getPublicBookingFormBySelector = async (selector: PublicBookingFormSelector) => {
    const form = await prisma.bookingForm.findFirst({
        where: publicBookingFormWhere(selector),
        include: {
            fields:   { where: { enabled: true }, orderBy: { sortOrder: "asc" } },
            services: {
                where: { enabled: true },
                include: { serviceCatalog: true },
            },
            admin: {
                select: {
                    businessName: true, businessLogo: true, mobileNumber: true, businessEmail: true,
                    address: true, city: true, zipcode: true, country: true, brandColor: true,
                    user: { select: { name: true, email: true } },
                },
            },
        },
    });

    if (!form || !form.published) {
        throw new AppError(status.NOT_FOUND, "This booking page is not available.", {
            code: "BOOKING_FORM_UNAVAILABLE",
            retryable: false,
        });
    }

    let reviewSummary: { rating: number; count: number } | null = null;
    if (form.showReviews) {
        const aggregate = await prisma.review.aggregate({
            where: {
                adminId: form.adminId,
                staffId: null,
                isPublished: true,
            },
            _avg: { rating: true },
            _count: { rating: true },
        });
        if (aggregate._count.rating > 0 && aggregate._avg.rating != null) {
            reviewSummary = {
                rating: Number(aggregate._avg.rating.toFixed(1)),
                count: aggregate._count.rating,
            };
        }
    }

    // Canonical public projection: internal AdminProfile data is removed from
    // the response. Legacy serviceType stays alongside canonical serviceCatalogId.
    const publicServices = form.services
        .filter((entry) => entry.serviceCatalog
            ? entry.serviceCatalog.adminId === form.adminId && entry.serviceCatalog.status === ServiceStatus.ACTIVE
            : !!entry.serviceType)
        .map((entry) => ({
            id: entry.id,
            enabled: entry.enabled,
            serviceType: entry.serviceType,
            serviceCatalogId: entry.serviceCatalogId,
            priceLabel: entry.priceLabel,
            duration: entry.duration ?? entry.serviceCatalog?.duration ?? null,
            service: entry.serviceCatalog ? projectCanonicalService(entry.serviceCatalog) : null,
            serviceName: entry.serviceCatalog?.serviceName ?? entry.serviceType?.replace(/_/g, " ") ?? "Service",
            basePrice: entry.serviceCatalog?.basePriceGbp ?? null,
            basePriceGbp: entry.serviceCatalog?.basePriceGbp ?? null,
        }));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { adminId, admin, services, ...safeForm } = form;
    return {
        ...safeForm,
        services: publicServices,
        business: projectPublicBusiness(form.admin),
        reviewSummary,
    };
};

/**
 * Returns authoritative slot availability for a specific date. Only the server
 * decides whether a date/time is selectable; the browser preview is advisory.
 */
const getPublicSlotAvailabilityBySelector = async (selector: PublicBookingFormSelector, date: string) => {
    const form = await prisma.bookingForm.findFirst({
        where: publicBookingFormWhere(selector),
        select: {
            id:                   true,
            published:            true,
            timeSlots:            true,
            availableDays:        true,
            blockedDates:         true,
            maxBookingsPerSlot:   true,
            slotDurationMinutes:  true,
            bufferTimeMinutes:    true,
        },
    });

    if (!form || !form.published) {
        throw new AppError(status.NOT_FOUND, "This booking page is not available.", {
            code: "BOOKING_FORM_UNAVAILABLE",
            retryable: false,
        });
    }

    const empty = {
        slotDurationMinutes: form.slotDurationMinutes,
        maxBookingsPerSlot: form.maxBookingsPerSlot,
        slots: [] as { time: string; booked: number; available: boolean }[],
    };

    // Never expose selectable capacity for past/blocked/closed dates.
    if (date < new Date().toISOString().slice(0, 10) || isBlockedDate(form.blockedDates, date)) {
        return empty;
    }

    const dayName = getDayName(date);
    if (!form.availableDays.includes(dayName)) return empty;

    const dayWindows = form.timeSlots.filter((ts) => ts.startsWith(`${dayName}|`));
    const slotTimes = generateSlotsFromWindows(
        dayWindows,
        form.slotDurationMinutes,
        form.bufferTimeMinutes,
    );
    if (slotTimes.length === 0) return empty;

    const dateStart = new Date(`${date}T00:00:00.000Z`);
    const dateEnd   = new Date(`${date}T23:59:59.999Z`);

    const counts = await prisma.bookingFormSubmission.groupBy({
        by:    ["timeSlot"],
        where: {
            formId:  form.id,
            date:    { gte: dateStart, lte: dateEnd },
            status:  { not: FormSubmissionStatus.DECLINED },
        },
        _count: { id: true },
    });

    const countMap = Object.fromEntries(counts.map((row) => [row.timeSlot, row._count.id]));
    return {
        slotDurationMinutes: form.slotDurationMinutes,
        maxBookingsPerSlot: form.maxBookingsPerSlot,
        slots: slotTimes.map((time) => {
            const booked = countMap[time] ?? 0;
            return { time, booked, available: booked < form.maxBookingsPerSlot };
        }),
    };
};

const submitPublicBookingFormBySelector = async (
    selector: PublicBookingFormSelector,
    payload: IPublicBookingSubmission,
    idempotencyKey?: string,
) => {
    if (idempotencyKey && !/^[A-Za-z0-9:_-]{8,128}$/.test(idempotencyKey)) {
        throw new AppError(status.BAD_REQUEST, "Invalid Idempotency-Key header");
    }
    const form = await prisma.bookingForm.findFirst({
        where: publicBookingFormWhere(selector),
        select: {
            id: true,
            adminId: true,
            published: true,
            blockedDates: true,
            timeSlots: true,
            availableDays: true,
            maxBookingsPerSlot: true,
            slotDurationMinutes: true,
            bufferTimeMinutes: true,
            services: {
                where: { enabled: true },
                select: {
                    serviceType: true, serviceCatalogId: true,
                    serviceCatalog: {
                        select: {
                            id: true,
                            adminId: true,
                            serviceName: true,
                            basePriceGbp: true,
                            duration: true,
                            status: true,
                            legacyServiceType: true,
                        },
                    },
                },
            },
            fields: {
                where: { enabled: true },
                orderBy: { sortOrder: "asc" },
                select: {
                    id: true,
                    type: true,
                    label: true,
                    required: true,
                    options: true,
                },
            },
        },
    });

    if (!form || !form.published) {
        throw new AppError(status.NOT_FOUND, "This booking page is not available.", {
            code: "BOOKING_FORM_UNAVAILABLE",
            retryable: false,
        });
    }

    const today = new Date().toISOString().slice(0, 10);
    if (payload.date < today) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "Please choose a future date.", {
            code: "BOOKING_DATE_UNAVAILABLE",
            retryable: false,
            fieldErrors: { date: "Please choose today or a future date." },
        });
    }

    if (isBlockedDate(form.blockedDates, payload.date)) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "That date is no longer available.", {
            code: "BOOKING_DATE_UNAVAILABLE",
            retryable: false,
            fieldErrors: { date: "Please choose another available date." },
        });
    }

    const dayName = getDayName(payload.date);
    if (!form.availableDays.includes(dayName)) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "We are not taking online bookings on that day.", {
            code: "BOOKING_DATE_UNAVAILABLE",
            retryable: false,
            fieldErrors: { date: "Please choose one of the available days." },
        });
    }

    const matchingServices = payload.serviceCatalogId
        ? form.services.filter((entry) => entry.serviceCatalogId === payload.serviceCatalogId)
        : form.services.filter((entry) => {
            if (!payload.serviceType) return false;
            return entry.serviceType === payload.serviceType
                || entry.serviceCatalog?.legacyServiceType === payload.serviceType;
        });

    // Modern website clients submit serviceCatalogId and therefore resolve one
    // exact row. Old clients may still submit only ServiceType; once multiple
    // catalog services share that enum the request is ambiguous and must fail
    // closed instead of silently booking the first service in database order.
    if (!payload.serviceCatalogId && payload.serviceType && matchingServices.length > 1) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "Please choose a specific service.", {
            code: "BOOKING_SERVICE_AMBIGUOUS",
            retryable: false,
            fieldErrors: { serviceCatalogId: "Refresh the booking page and choose a specific service." },
        });
    }

    const selectedService = matchingServices[0];
    const catalog = selectedService?.serviceCatalog;
    if (
        !selectedService
        || (catalog && (catalog.adminId !== form.adminId || catalog.status !== ServiceStatus.ACTIVE))
    ) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "That service is no longer available for online booking.", {
            code: "BOOKING_SERVICE_UNAVAILABLE",
            retryable: false,
            fieldErrors: { serviceCatalogId: "Please choose another service." },
        });
    }
    const canonicalService = {
        serviceCatalogId: catalog?.id ?? selectedService.serviceCatalogId ?? null,
        serviceType: catalog?.legacyServiceType ?? selectedService.serviceType ?? null,
        serviceNameSnapshot: catalog?.serviceName ?? selectedService.serviceType?.replace(/_/g, " ") ?? "Service",
        priceSnapshot: catalog?.basePriceGbp ?? null,
        durationSnapshot: catalog?.duration ?? null,
    };

    const dayWindows = form.timeSlots.filter((ts) => ts.startsWith(`${dayName}|`));
    const validSlots = generateSlotsFromWindows(
        dayWindows,
        form.slotDurationMinutes,
        form.bufferTimeMinutes,
    );
    if (!validSlots.includes(payload.timeSlot)) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "That time is no longer available.", {
            code: "BOOKING_TIME_UNAVAILABLE",
            retryable: false,
            fieldErrors: { timeSlot: "Please choose another available time." },
        });
    }

    const customAnswers = validateAndSnapshotCustomAnswers(form.fields, payload.answers);
    const dateStart = new Date(`${payload.date}T00:00:00.000Z`);
    const dateEnd   = new Date(`${payload.date}T23:59:59.999Z`);
    const slotLockKey = `booking-slot:${form.id}:${payload.date}:${payload.timeSlot}`;

    // PostgreSQL advisory transaction locks make the count+insert capacity check
    // atomic across every Node process/container. Two customers racing for the
    // final place serialize on the same slot key; the second sees the committed
    // first booking and receives BOOKING_SLOT_FULL instead of overbooking.
    return prisma.$transaction(async (tx) => {
        if (idempotencyKey) {
            const idempotencyLockKey = `booking-idempotency:${form.id}:${idempotencyKey}`;
            await acquireExtendedTextTransactionAdvisoryLock(tx, idempotencyLockKey);
            const existing = await tx.bookingFormSubmission.findFirst({
                where: { formId: form.id, idempotencyKey },
            });
            if (existing) return existing;
        }

        await acquireExtendedTextTransactionAdvisoryLock(tx, slotLockKey);

        const existingCount = await tx.bookingFormSubmission.count({
            where: {
                formId: form.id,
                date: { gte: dateStart, lte: dateEnd },
                timeSlot: payload.timeSlot,
                status: { not: FormSubmissionStatus.DECLINED },
            },
        });

        if (existingCount >= form.maxBookingsPerSlot) {
            throw new AppError(
                status.CONFLICT,
                "That time was just booked. Please choose another available time.",
                {
                    code: "BOOKING_SLOT_FULL",
                    retryable: false,
                    fieldErrors: { timeSlot: "This time is now fully booked." },
                },
            );
        }

        return tx.bookingFormSubmission.create({
            data: {
                ref: generateSubmissionRef(),
                formId: form.id,
                serviceCatalogId: canonicalService.serviceCatalogId,
                serviceType: canonicalService.serviceType,
                serviceNameSnapshot: canonicalService.serviceNameSnapshot,
                priceSnapshot: canonicalService.priceSnapshot,
                durationSnapshot: canonicalService.durationSnapshot,
                idempotencyKey: idempotencyKey ?? null,
                sourceWebsiteId: selector.sourceWebsiteId ?? null,
                date: dateStart,
                timeSlot: payload.timeSlot,
                name: payload.name,
                email: payload.email,
                phone: payload.phone,
                address: payload.address,
                notes: payload.notes || undefined,
                answers: customAnswers as Prisma.InputJsonValue,
            },
        });
    });
};

// Legacy slug routes remain supported for links already shared in email,
// WhatsApp, Google Business, etc. Website runtime routes use the ID + tenant
// selector so a slug can never switch a tenant website to another form.
const getPublicBookingForm = (slug: string) =>
    getPublicBookingFormBySelector({ slug });

const getPublicBookingFormById = (formId: string, adminId: string) =>
    getPublicBookingFormBySelector({ formId, adminId });

const getPublicSlotAvailability = (slug: string, date: string) =>
    getPublicSlotAvailabilityBySelector({ slug }, date);

const getPublicSlotAvailabilityById = (formId: string, adminId: string, date: string) =>
    getPublicSlotAvailabilityBySelector({ formId, adminId }, date);

const submitPublicBookingForm = (slug: string, payload: IPublicBookingSubmission, idempotencyKey?: string) =>
    submitPublicBookingFormBySelector({ slug }, payload, idempotencyKey);

const submitPublicBookingFormById = (
    formId: string,
    adminId: string,
    payload: IPublicBookingSubmission,
    idempotencyKey?: string,
    sourceWebsiteId?: string,
) => submitPublicBookingFormBySelector({ formId, adminId, sourceWebsiteId }, payload, idempotencyKey);

// ─── Export ───────────────────────────────────────────────────────────────────

export const bookingFormService = {
    createBookingForm,
    getAllBookingForms,
    getBookingFormById,
    updateBookingForm,
    deleteBookingForm,
    togglePublished,
    getSubmissions,
    updateSubmissionStatus,
    getPublicBookingForm,
    getPublicBookingFormById,
    getPublicSlotAvailability,
    getPublicSlotAvailabilityById,
    submitPublicBookingForm,
    submitPublicBookingFormById,
};
