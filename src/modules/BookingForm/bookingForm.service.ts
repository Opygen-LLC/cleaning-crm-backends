import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { FormSubmissionStatus } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import { IBookingFormCreate } from "./bookingForm.interface";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

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
    const adminId = await resolveAdminId(user.id);
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
    const adminId = await resolveAdminId(user.id);

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
    const adminId = await resolveAdminId(user.id);

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
    const adminId = await resolveAdminId(user.id);

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
                ...(payload.published             !== undefined && { published: payload.published }),
            },
            include: formInclude,
        });
    });
};

const deleteBookingForm = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);
    const existing = await prisma.bookingForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Booking form not found");
    await prisma.bookingForm.delete({ where: { id } });
};

const togglePublished = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);
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
    const adminId = await resolveAdminId(user.id);

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
    const adminId = await resolveAdminId(user.id);

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
 * For each configured time slot on that date, returns how many bookings already
 * exist and whether the slot is still open (count < maxBookingsPerSlot).
 *
 * Response shape:
 * {
 *   maxBookingsPerSlot: number,
 *   slots: { time: string; booked: number; available: boolean }[]
 * }
 */
const getPublicSlotAvailability = async (slug: string, date: string) => {
    const form = await prisma.bookingForm.findUnique({
        where:  { slug },
        select: {
            id:                 true,
            published:          true,
            timeSlots:          true,
            availableDays:      true,
            blockedDates:       true,
            maxBookingsPerSlot: true,
        },
    });

    if (!form || !form.published) {
        throw new AppError(status.NOT_FOUND, "Booking form not found or not published");
    }

    // Validate date not blocked
    const isBlocked = form.blockedDates.some((d) => d.startsWith(date));
    if (isBlocked) {
        return { maxBookingsPerSlot: form.maxBookingsPerSlot, slots: [] };
    }

    // Extract unique start times from window strings
    const allStartTimes = new Set<string>();
    for (const ts of form.timeSlots) {
        const [, range] = ts.split("|");
        if (!range) continue;
        const [start] = range.split("-");
        if (start) allStartTimes.add(start);
    }

    const startTimes = Array.from(allStartTimes).sort();

    if (startTimes.length === 0) {
        return { maxBookingsPerSlot: form.maxBookingsPerSlot, slots: [] };
    }

    // Count existing submissions for this form+date grouped by timeSlot
    const dateStart = new Date(`${date}T00:00:00.000Z`);
    const dateEnd   = new Date(`${date}T23:59:59.999Z`);

    const counts = await prisma.bookingFormSubmission.groupBy({
        by:    ["timeSlot"],
        where: {
            formId:  form.id,
            date:    { gte: dateStart, lte: dateEnd },
            // Only count non-declined submissions — a declined booking frees up the slot
            status:  { not: FormSubmissionStatus.DECLINED },
        },
        _count: { id: true },
    });

    const countMap: Record<string, number> = {};
    for (const row of counts) {
        countMap[row.timeSlot] = row._count.id;
    }

    const slots = startTimes.map((time) => {
        const booked = countMap[time] ?? 0;
        return {
            time,
            booked,
            available: booked < form.maxBookingsPerSlot,
        };
    });

    return { maxBookingsPerSlot: form.maxBookingsPerSlot, slots };
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
            id:                 true,
            published:          true,
            blockedDates:       true,
            timeSlots:          true,
            availableDays:      true,
            maxBookingsPerSlot: true,
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

    // Validate time slot exists in configured windows
    if (form.timeSlots.length > 0) {
        const isValid = form.timeSlots.some((ts) => {
            const [, range] = ts.split("|");
            const [start]   = (range ?? "").split("-");
            return start === payload.timeSlot;
        });
        if (!isValid) {
            throw new AppError(status.UNPROCESSABLE_ENTITY, "The selected time slot is not available");
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
