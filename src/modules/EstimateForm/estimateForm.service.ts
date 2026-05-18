import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import {
    ServiceType,
    EstimateSubmissionStatus,
} from "../../generated/prisma/enums";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IQueryParams } from "../../interface/query.interface";
import { IRequestUser } from "../../types/requestUser.interface";
import { IEstimateFormCreate } from "./estimateForm.interface";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

const generateSubmissionRef = async (): Promise<string> => {
    const last = await prisma.estimateFormSubmission.findFirst({
        orderBy: { createdAt: "desc" },
        select: { ref: true },
    });
    let next = 1;
    if (last?.ref) {
        const parts = last.ref.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) next = num + 1;
    }
    return `#EST-SUB-${next.toString().padStart(4, "0")}`;
};

// ─── Standard includes ─────────────────────────────────────────────────────────

const formInclude = {
    fields:      true,
    services:    true,
    addOns:      true,
    _count: {
        select: { submissions: true },
    },
} as const;

// ─── EstimateForm CRUD ────────────────────────────────────────────────────────

const generateSlug = (headline: string, adminId: string): string => {
    const base = headline
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
    return `${base}-${adminId.slice(0, 6)}`;
};

const createEstimateForm = async (
    payload: IEstimateFormCreate,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);
    const slug    = generateSlug(payload.headline, adminId);

    // Ensure slug uniqueness — append a short random suffix if taken
    const existing = await prisma.estimateForm.findUnique({ where: { slug } });
    const finalSlug = existing ? `${slug}-${Date.now().toString(36)}` : slug;

    return prisma.estimateForm.create({
        data: {
            slug:               finalSlug,
            adminId,
            headline:           payload.headline,
            subheading:         payload.subheading,
            accentColor:        payload.accentColor ?? "#000000",
            showReviews:        payload.showReviews ?? true,
            ctaLabel:           payload.ctaLabel ?? "Get my free estimate",
            confirmationMessage: payload.confirmationMessage,
            coveredPostcodes:   payload.coveredPostcodes ?? [],
            coveredCities:      payload.coveredCities ?? [],
            showLiveEstimate:   payload.showLiveEstimate ?? true,
            services: payload.services?.length
                ? {
                    createMany: {
                        data: payload.services.map((s) => ({
                            serviceType: s.serviceType,
                            enabled:     s.enabled ?? true,
                            basePrice:   s.basePrice,
                        })),
                    },
                }
                : undefined,
            addOns: payload.addOns?.length
                ? {
                    createMany: {
                        data: payload.addOns.map((a) => ({
                            label:   a.label,
                            price:   a.price,
                            enabled: a.enabled ?? true,
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

const getAllEstimateForms = async (
    queryParams: IQueryParams,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const forms = await prisma.estimateForm.findMany({
        where:   { adminId },
        include: formInclude,
        orderBy: { createdAt: "desc" },
    });

    // Attach submission stats
    const formIds = forms.map((f) => f.id);
    const submissionCounts = await prisma.estimateFormSubmission.groupBy({
        by:     ["formId"],
        where:  { formId: { in: formIds } },
        _count: { id: true },
    });
    const newCounts = await prisma.estimateFormSubmission.groupBy({
        by:     ["formId"],
        where:  { formId: { in: formIds }, status: EstimateSubmissionStatus.NEW },
        _count: { id: true },
    });
    const convertedCounts = await prisma.estimateFormSubmission.groupBy({
        by:     ["formId"],
        where:  { formId: { in: formIds }, status: EstimateSubmissionStatus.CONVERTED },
        _count: { id: true },
    });

    const countMap       = Object.fromEntries(submissionCounts.map((r) => [r.formId, r._count.id]));
    const newMap         = Object.fromEntries(newCounts.map((r) => [r.formId, r._count.id]));
    const convertedMap   = Object.fromEntries(convertedCounts.map((r) => [r.formId, r._count.id]));

    const enriched = forms.map((f) => ({
        ...f,
        totalSubmissions: countMap[f.id] ?? 0,
        newSubmissions:   newMap[f.id]   ?? 0,
        conversions:      convertedMap[f.id] ?? 0,
        link:             `/estimate/${f.slug}`,
    }));

    const stats = {
        total:             forms.length,
        active:            forms.filter((f) => f.published).length,
        totalSubmissions:  enriched.reduce((s, f) => s + f.totalSubmissions, 0),
        totalConversions:  enriched.reduce((s, f) => s + f.conversions, 0),
        totalNew:          enriched.reduce((s, f) => s + f.newSubmissions, 0),
    };

    return { forms: enriched, total: forms.length, stats };
};

const getEstimateFormById = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const form = await prisma.estimateForm.findFirst({
        where:   { id, adminId },
        include: formInclude,
    });
    if (!form) throw new AppError(status.NOT_FOUND, "Estimate form not found");

    return form;
};

const updateEstimateForm = async (
    id: string,
    payload: Partial<IEstimateFormCreate> & { published?: boolean },
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.estimateForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Estimate form not found");

    return prisma.$transaction(async (tx) => {
        // Replace services when provided
        if (payload.services) {
            await tx.estimateFormService.deleteMany({ where: { formId: id } });
            await tx.estimateFormService.createMany({
                data: payload.services.map((s) => ({
                    formId:      id,
                    serviceType: s.serviceType,
                    enabled:     s.enabled ?? true,
                    basePrice:   s.basePrice,
                })),
            });
        }

        // Replace addOns when provided
        if (payload.addOns) {
            await tx.estimateFormAddOn.deleteMany({ where: { formId: id } });
            await tx.estimateFormAddOn.createMany({
                data: payload.addOns.map((a) => ({
                    formId:  id,
                    label:   a.label,
                    price:   a.price,
                    enabled: a.enabled ?? true,
                })),
            });
        }

        // Replace fields when provided
        if (payload.fields) {
            await tx.estimateFormField.deleteMany({ where: { formId: id } });
            await tx.estimateFormField.createMany({
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

        return tx.estimateForm.update({
            where: { id },
            data: {
                ...(payload.headline            !== undefined && { headline: payload.headline }),
                ...(payload.subheading          !== undefined && { subheading: payload.subheading }),
                ...(payload.accentColor         !== undefined && { accentColor: payload.accentColor }),
                ...(payload.showReviews         !== undefined && { showReviews: payload.showReviews }),
                ...(payload.ctaLabel            !== undefined && { ctaLabel: payload.ctaLabel }),
                ...(payload.confirmationMessage !== undefined && { confirmationMessage: payload.confirmationMessage }),
                ...(payload.coveredPostcodes    !== undefined && { coveredPostcodes: payload.coveredPostcodes }),
                ...(payload.coveredCities       !== undefined && { coveredCities: payload.coveredCities }),
                ...(payload.showLiveEstimate    !== undefined && { showLiveEstimate: payload.showLiveEstimate }),
                ...(payload.published           !== undefined && { published: payload.published }),
            },
            include: formInclude,
        });
    });
};

const deleteEstimateForm = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);
    const existing = await prisma.estimateForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Estimate form not found");
    await prisma.estimateForm.delete({ where: { id } });
};

const togglePublished = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);
    const existing = await prisma.estimateForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Estimate form not found");

    return prisma.estimateForm.update({
        where: { id },
        data:  { published: !existing.published },
        include: formInclude,
    });
};

// ─── Submissions ───────────────────────────────────────────────────────────────

const getSubmissions = async (
    formId: string | undefined,
    queryParams: IQueryParams,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    // If formId provided, verify it belongs to this admin
    if (formId) {
        const form = await prisma.estimateForm.findFirst({ where: { id: formId, adminId } });
        if (!form) throw new AppError(status.NOT_FOUND, "Estimate form not found");
    }

    // Get all formIds for this admin to scope the query
    const adminFormIds = formId
        ? [formId]
        : (await prisma.estimateForm.findMany({
            where:  { adminId },
            select: { id: true },
        })).map((f) => f.id);

    return new QueryBuilder(prisma.estimateFormSubmission, queryParams, {
        searchableFields: ["ref", "name", "email", "phone"],
        filterableFields: ["status", "serviceType"],
    })
        .where({ formId: { in: adminFormIds } })
        .search()
        .filter()
        .sort()
        .paginate()
        .include({ form: { select: { headline: true, slug: true } } })
        .execute();
};

const updateSubmissionStatus = async (
    submissionId: string,
    newStatus: EstimateSubmissionStatus,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    // Verify ownership via the form relationship
    const submission = await prisma.estimateFormSubmission.findFirst({
        where: {
            id:   submissionId,
            form: { adminId },
        },
    });
    if (!submission) throw new AppError(status.NOT_FOUND, "Submission not found");

    return prisma.estimateFormSubmission.update({
        where: { id: submissionId },
        data:  { status: newStatus },
        include: { form: { select: { headline: true } } },
    });
};

// ─── Public endpoint (unauthenticated) ───────────────────────────────────────

const getPublicEstimateForm = async (slug: string) => {
    const form = await prisma.estimateForm.findUnique({
        where:   { slug },
        include: {
            fields:   { where: { enabled: true }, orderBy: { sortOrder: "asc" } },
            services: { where: { enabled: true } },
            addOns:   { where: { enabled: true } },
            admin: {
                include: {
                    user: { select: { name: true } },
                },
            },
        },
    });

    if (!form || !form.published) {
        throw new AppError(status.NOT_FOUND, "Estimate form not found or not published");
    }

    // Omit internal admin fields
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { adminId, ...safeForm } = form;
    return safeForm;
};

const submitPublicEstimateForm = async (
    slug: string,
    payload: {
        serviceType: ServiceType;
        bedrooms:    number;
        bathrooms:   number;
        addOnIds:    string[];
        postcode:    string;
        name:        string;
        email:       string;
        phone:       string;
        notes?:      string;
    },
) => {
    const form = await prisma.estimateForm.findUnique({
        where:   { slug },
        select:  { id: true, published: true, coveredPostcodes: true },
    });

    if (!form || !form.published) {
        throw new AppError(status.NOT_FOUND, "Estimate form not found or not published");
    }

    // Postcode coverage check (optional — only enforced if list is non-empty)
    if (form.coveredPostcodes.length > 0) {
        const postcodePrefix = payload.postcode.split(" ")[0].toUpperCase();
        if (!form.coveredPostcodes.some((p) => postcodePrefix.startsWith(p.toUpperCase()))) {
            throw new AppError(
                status.UNPROCESSABLE_ENTITY,
                `Unfortunately we don't currently cover the postcode ${payload.postcode}.`,
            );
        }
    }

    const ref = await generateSubmissionRef();

    return prisma.estimateFormSubmission.create({
        data: {
            ref,
            formId:      form.id,
            serviceType: payload.serviceType,
            bedrooms:    payload.bedrooms,
            bathrooms:   payload.bathrooms,
            addOnIds:    payload.addOnIds,
            postcode:    payload.postcode,
            name:        payload.name,
            email:       payload.email,
            phone:       payload.phone,
            notes:       payload.notes,
        },
    });
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const estimateFormService = {
    createEstimateForm,
    getAllEstimateForms,
    getEstimateFormById,
    updateEstimateForm,
    deleteEstimateForm,
    togglePublished,
    getSubmissions,
    updateSubmissionStatus,
    getPublicEstimateForm,
    submitPublicEstimateForm,
};
