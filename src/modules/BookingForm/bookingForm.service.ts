import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import status from "http-status";
import { FormSubmissionStatus } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import { IBookingFormCreate } from "./bookingForm.interface";

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

const generateSubmissionRef = async (): Promise<string> => {
    const last = await prisma.bookingFormSubmission.findFirst({
        orderBy: { createdAt: "desc" },
        select: { ref: true },
    });
    let next = 1;
    if (last?.ref) {
        const parts = last.ref.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) next = num + 1;
    }
    return `#BK-SUB-${next.toString().padStart(4, "0")}`;
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
    fields:   true,
    services: true,
    _count: {
        select: { submissions: true },
    },
} as const;

// ─── BookingForm CRUD ─────────────────────────────────────────────────────────

const createBookingForm = async (
    payload: IBookingFormCreate,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);
    const slug    = generateSlug(payload.headline, adminId);

    const existing = await prisma.bookingForm.findUnique({ where: { slug } });
    const finalSlug = existing ? `${slug}-${Date.now().toString(36)}` : slug;

    return prisma.bookingForm.create({
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
                        data: payload.services.map((s) => ({
                            serviceType: s.serviceType,
                            enabled:     s.enabled ?? true,
                            priceLabel:  s.priceLabel,
                            duration:    s.duration,
                        })),
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

    return prisma.$transaction(async (tx) => {
        // Replace services when provided
        if (payload.services) {
            await tx.bookingFormService.deleteMany({ where: { formId: id } });
            await tx.bookingFormService.createMany({
                data: payload.services.map((s) => ({
                    formId:      id,
                    serviceType: s.serviceType,
                    enabled:     s.enabled ?? true,
                    priceLabel:  s.priceLabel,
                    duration:    s.duration,
                })),
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
};

const deleteBookingForm = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const existing = await prisma.bookingForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Booking form not found");
    await prisma.bookingForm.delete({ where: { id } });
};

const togglePublished = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const existing = await prisma.bookingForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Booking form not found");

    return prisma.bookingForm.update({
        where: { id },
        data:  { published: !existing.published },
        include: formInclude,
    });
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

    const adminFormIds = formId
        ? [formId]
        : (await prisma.bookingForm.findMany({
            where:  { adminId },
            select: { id: true },
        })).map((f) => f.id);

    return prisma.bookingFormSubmission.findMany({
        where:   { formId: { in: adminFormIds } },
        include: { form: { select: { headline: true, slug: true } } },
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
            id:   submissionId,
            form: { adminId },
        },
    });
    if (!submission) throw new AppError(status.NOT_FOUND, "Submission not found");

    return prisma.bookingFormSubmission.update({
        where: { id: submissionId },
        data:  { status: newStatus },
        include: { form: { select: { headline: true } } },
    });
};

// ─── Public endpoint (unauthenticated) ───────────────────────────────────────

const getPublicBookingForm = async (slug: string) => {
    const form = await prisma.bookingForm.findUnique({
        where:   { slug },
        include: {
            fields:   { where: { enabled: true }, orderBy: { sortOrder: "asc" } },
            services: { where: { enabled: true } },
            admin: {
                include: {
                    user: { select: { name: true } },
                },
            },
        },
    });

    if (!form || !form.published) {
        throw new AppError(status.NOT_FOUND, "Booking form not found or not published");
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { adminId, ...safeForm } = form;
    return safeForm;
};

/**
 * Returns slot availability for a specific date.
 *
 * Uses the admin-configured slot duration and buffer time to generate the exact
 * same time slots the frontend previews. Only returns slots for the matching
 * weekday (e.g. a Monday date only looks at Monday time windows).
 *
 * Response shape:
 * {
 *   slotDurationMinutes: number,
 *   maxBookingsPerSlot:  number,
 *   slots: { time: string; booked: number; available: boolean }[]
 * }
 */
const getPublicSlotAvailability = async (slug: string, date: string) => {
    const form = await prisma.bookingForm.findUnique({
        where:  { slug },
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
        throw new AppError(status.NOT_FOUND, "Booking form not found or not published");
    }

    // Return empty if this date is blocked
    const isBlocked = form.blockedDates.some((d) => d.startsWith(date));
    if (isBlocked) {
        return {
            slotDurationMinutes: form.slotDurationMinutes,
            maxBookingsPerSlot:  form.maxBookingsPerSlot,
            slots: [],
        };
    }

    // Determine the weekday name for this date (e.g. "Monday", "Tuesday", …)
    const dayName = getDayName(date);

    // Filter the stored windows to only those for this weekday
    const dayWindows = form.timeSlots.filter((ts) => ts.startsWith(`${dayName}|`));

    // Generate actual slot start-times using the admin's slot duration + buffer
    const slotTimes = generateSlotsFromWindows(
        dayWindows,
        form.slotDurationMinutes,
        form.bufferTimeMinutes,
    );

    if (slotTimes.length === 0) {
        return {
            slotDurationMinutes: form.slotDurationMinutes,
            maxBookingsPerSlot:  form.maxBookingsPerSlot,
            slots: [],
        };
    }

    // Count existing (non-declined) bookings for each slot on this date
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

    const countMap: Record<string, number> = {};
    for (const row of counts) {
        countMap[row.timeSlot] = row._count.id;
    }

    const slots = slotTimes.map((time) => {
        const booked = countMap[time] ?? 0;
        return {
            time,
            booked,
            available: booked < form.maxBookingsPerSlot,
        };
    });

    return {
        slotDurationMinutes: form.slotDurationMinutes,
        maxBookingsPerSlot:  form.maxBookingsPerSlot,
        slots,
    };
};

const submitPublicBookingForm = async (
    slug: string,
    payload: {
        serviceType: string;
        date:        string;
        timeSlot:    string;
        name:        string;
        email:       string;
        phone:       string;
        address:     string;
        notes?:      string;
    },
) => {
    const form = await prisma.bookingForm.findUnique({
        where:  { slug },
        select: {
            id:                   true,
            published:            true,
            blockedDates:         true,
            timeSlots:            true,
            availableDays:        true,
            maxBookingsPerSlot:   true,
            slotDurationMinutes:  true,
            bufferTimeMinutes:    true,
        },
    });

    if (!form || !form.published) {
        throw new AppError(status.NOT_FOUND, "Booking form not found or not published");
    }

    // blockedDates are stored as "YYYY-MM-DD|Reason" strings.
    const isBlocked = form.blockedDates.some((d) => d.startsWith(payload.date));
    if (isBlocked) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "The selected date is not available");
    }

    // Validate the time slot exists for this weekday using the slot generation logic
    if (form.timeSlots.length > 0) {
        const dayName    = getDayName(payload.date);
        const dayWindows = form.timeSlots.filter((ts) => ts.startsWith(`${dayName}|`));
        const validSlots = generateSlotsFromWindows(
            dayWindows,
            form.slotDurationMinutes,
            form.bufferTimeMinutes,
        );

        if (validSlots.length > 0 && !validSlots.includes(payload.timeSlot)) {
            throw new AppError(
                status.UNPROCESSABLE_ENTITY,
                "The selected time slot is not available for this date",
            );
        }
    }

    // ── Slot capacity enforcement ──────────────────────────────────────────────
    const dateStart = new Date(`${payload.date}T00:00:00.000Z`);
    const dateEnd   = new Date(`${payload.date}T23:59:59.999Z`);

    const existingCount = await prisma.bookingFormSubmission.count({
        where: {
            formId:   form.id,
            date:     { gte: dateStart, lte: dateEnd },
            timeSlot: payload.timeSlot,
            status:   { not: FormSubmissionStatus.DECLINED },
        },
    });

    if (existingCount >= form.maxBookingsPerSlot) {
        throw new AppError(
            status.CONFLICT,
            `This time slot is fully booked (${form.maxBookingsPerSlot} booking${form.maxBookingsPerSlot > 1 ? "s" : ""} max). Please choose another time.`,
        );
    }
    // ── End capacity enforcement ───────────────────────────────────────────────

    const ref = await generateSubmissionRef();

    return prisma.bookingFormSubmission.create({
        data: {
            ref,
            formId:      form.id,
            serviceType: payload.serviceType as never,
            date:        new Date(payload.date),
            timeSlot:    payload.timeSlot,
            name:        payload.name,
            email:       payload.email,
            phone:       payload.phone,
            address:     payload.address,
            notes:       payload.notes,
        },
    });
};

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
    getPublicSlotAvailability,
    submitPublicBookingForm,
};
