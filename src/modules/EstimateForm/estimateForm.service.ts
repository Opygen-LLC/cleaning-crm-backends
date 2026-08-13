import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import status from "http-status";
import {
    ServiceType,
    FormFieldType,
    EstimateSubmissionStatus,
} from "../../generated/prisma/enums";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IQueryParams } from "../../interface/query.interface";
import { IRequestUser } from "../../types/requestUser.interface";
import { IEstimateFormCreate } from "./estimateForm.interface";
import { Prisma } from "../../generated/prisma/client";
import { randomBytes } from "crypto";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const generateSubmissionRef = (): string => {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `#EST-${datePart}-${randomBytes(8).toString("hex").toUpperCase()}`;
};

type EstimateFieldPurpose = "NAME" | "EMAIL" | "PHONE" | "ADDRESS" | "CUSTOM";

type PublicEstimateField = {
    id: string;
    type: FormFieldType;
    label: string;
    placeholder: string | null;
    required: boolean;
    enabled: boolean;
    options: string[];
    sortOrder: number;
    purpose: EstimateFieldPurpose;
};

type StoredEstimateAnswer = {
    fieldId: string;
    label: string;
    type: FormFieldType;
    purpose: EstimateFieldPurpose;
    value: string;
};

type EstimatePricingResult = {
    serviceType: ServiceType;
    bedrooms: number;
    bathrooms: number;
    selectedAddOns: { id: string; label: string; price: number }[];
    basePrice: number | null;
    roomMultiplier: number | null;
    addOnTotal: number;
    min: number | null;
    max: number | null;
    quoteOnly: boolean;
    currency: "GBP";
};

type EstimateCoverageResult = {
    covered: boolean;
    matchedBy: "postcode" | "city" | "unrestricted" | null;
    postcode: string;
    city: string | null;
};

const inferFieldPurpose = (field: { type: FormFieldType; label: string }): EstimateFieldPurpose => {
    const label = field.label.trim().toLowerCase();
    if (field.type === FormFieldType.EMAIL) return "EMAIL";
    if (field.type === FormFieldType.PHONE) return "PHONE";
    if (field.type === FormFieldType.ADDRESS) return "ADDRESS";
    if (
        field.type === FormFieldType.TEXT &&
        /(^|\s)(full\s+name|your\s+name|customer\s+name|contact\s+name|name)(\s|$)/.test(label)
    ) return "NAME";
    return "CUSTOM";
};

const SYSTEM_CONTACT_FIELDS: PublicEstimateField[] = [
    {
        id: "__system_name",
        type: FormFieldType.TEXT,
        label: "Full name",
        placeholder: "Your full name",
        required: true,
        enabled: true,
        options: [],
        sortOrder: 10000,
        purpose: "NAME",
    },
    {
        id: "__system_email",
        type: FormFieldType.EMAIL,
        label: "Email",
        placeholder: "you@example.com",
        required: true,
        enabled: true,
        options: [],
        sortOrder: 10001,
        purpose: "EMAIL",
    },
    {
        id: "__system_phone",
        type: FormFieldType.PHONE,
        label: "Phone",
        placeholder: "Your phone number",
        required: true,
        enabled: true,
        options: [],
        sortOrder: 10002,
        purpose: "PHONE",
    },
];

const buildPublicFields = (fields: Array<{
    id: string;
    type: FormFieldType;
    label: string;
    placeholder: string | null;
    required: boolean;
    enabled: boolean;
    options: string[];
    sortOrder: number;
}>): PublicEstimateField[] => {
    const publicFields = fields
        .filter((field) => field.enabled)
        .map((field) => ({ ...field, purpose: inferFieldPurpose(field) }));

    const purposes = new Set(publicFields.map((field) => field.purpose));
    for (const systemField of SYSTEM_CONTACT_FIELDS) {
        if (!purposes.has(systemField.purpose)) publicFields.push(systemField);
    }

    return publicFields.sort((a, b) => a.sortOrder - b.sortOrder);
};

const normalizeCity = (value: string): string =>
    value.trim().toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ");

const normalizePostcode = (value: string): string =>
    value.toUpperCase().replace(/\s+/g, "").trim();

const postcodeRuleMatches = (postcode: string, configuredRule: string): boolean => {
    const rawPostcode = postcode.trim().toUpperCase();
    const normalizedPostcode = normalizePostcode(rawPostcode);
    const normalizedRule = configuredRule
        .toUpperCase()
        .replace(/\s+/g, "")
        .replace(/[–—]/g, "-");

    if (!normalizedRule) return false;

    // UK inward codes are three characters (e.g. "5AA"). Prefer the explicit
    // outward-code part before a space; for compact input, strip a valid-looking
    // inward code so M145AA is interpreted as M14 rather than district M145.
    const explicitOutward = rawPostcode.includes(" ")
        ? rawPostcode.split(/\s+/)[0]
        : null;
    const compactOutward = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(normalizedPostcode)
        ? normalizedPostcode.slice(0, -3)
        : normalizedPostcode;
    const outwardCode = normalizePostcode(explicitOutward || compactOutward);

    // Supports ranges used by the form builder, e.g. "M1–M99" / "M1-M99".
    const range = normalizedRule.match(/^([A-Z]{1,2})(\d+)-([A-Z]{1,2})?(\d+)$/);
    if (range) {
        const [, startLetters, startRaw, endLettersRaw, endRaw] = range;
        const endLetters = endLettersRaw || startLetters;
        if (startLetters !== endLetters) return false;
        const postcodeDistrict = outwardCode.match(/^([A-Z]{1,2})(\d+)/);
        if (!postcodeDistrict || postcodeDistrict[1] !== startLetters) return false;
        const district = Number(postcodeDistrict[2]);
        return district >= Number(startRaw) && district <= Number(endRaw);
    }

    return normalizedPostcode.startsWith(normalizedRule) || outwardCode.startsWith(normalizedRule);
};

const evaluateCoverage = (
    coveredPostcodes: string[],
    coveredCities: string[],
    postcode: string,
    city?: string,
): EstimateCoverageResult => {
    const hasPostcodeRules = coveredPostcodes.some((rule) => rule.trim());
    const hasCityRules = coveredCities.some((rule) => rule.trim());
    const normalizedPostcodeValue = postcode.trim();
    const normalizedCityValue = city?.trim() || null;

    if (!hasPostcodeRules && !hasCityRules) {
        return {
            covered: true,
            matchedBy: "unrestricted",
            postcode: normalizedPostcodeValue,
            city: normalizedCityValue,
        };
    }

    if (
        normalizedPostcodeValue &&
        hasPostcodeRules &&
        coveredPostcodes.some((rule) => postcodeRuleMatches(normalizedPostcodeValue, rule))
    ) {
        return {
            covered: true,
            matchedBy: "postcode",
            postcode: normalizedPostcodeValue,
            city: normalizedCityValue,
        };
    }

    if (normalizedCityValue && hasCityRules) {
        const candidate = normalizeCity(normalizedCityValue);
        if (coveredCities.some((configured) => normalizeCity(configured) === candidate)) {
            return {
                covered: true,
                matchedBy: "city",
                postcode: normalizedPostcodeValue,
                city: normalizedCityValue,
            };
        }
    }

    return {
        covered: false,
        matchedBy: null,
        postcode: normalizedPostcodeValue,
        city: normalizedCityValue,
    };
};

const validateAndSnapshotAnswers = (
    fields: PublicEstimateField[],
    answers: Record<string, string> | undefined,
    legacy: { name?: string; email?: string; phone?: string },
): { stored: StoredEstimateAnswer[]; name: string; email: string; phone: string; notes?: string } => {
    const fieldErrors: Record<string, string> = {};
    const stored: StoredEstimateAnswer[] = [];
    let name = legacy.name?.trim() ?? "";
    let email = legacy.email?.trim() ?? "";
    let phone = legacy.phone?.trim() ?? "";
    let notes: string | undefined;

    for (const field of fields) {
        const path = `answers.${field.id}`;
        let value = (answers?.[field.id] ?? "").trim();

        if (!value) {
            if (field.purpose === "NAME") value = name;
            if (field.purpose === "EMAIL") value = email;
            if (field.purpose === "PHONE") value = phone;
        }

        const coreRequired = field.purpose === "NAME" || field.purpose === "EMAIL" || field.purpose === "PHONE";
        if (!value) {
            if (field.required || coreRequired) fieldErrors[path] = `${field.label} is required`;
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

        if (field.purpose === "NAME") name = value;
        if (field.purpose === "EMAIL") email = value;
        if (field.purpose === "PHONE") phone = value;
        if (field.type === FormFieldType.TEXTAREA && !notes) notes = value;

        stored.push({
            fieldId: field.id,
            label: field.label,
            type: field.type,
            purpose: field.purpose,
            value,
        });
    }

    if (Object.keys(fieldErrors).length > 0) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "Please check the highlighted details and try again.", {
            code: "ESTIMATE_CONTACT_INVALID",
            retryable: false,
            fieldErrors,
        });
    }

    return { stored, name, email, phone, notes };
};

const calculatePricing = (
    service: { serviceType: ServiceType; basePrice: unknown },
    addOns: Array<{ id: string; label: string; price: unknown }>,
    bedrooms: number,
    bathrooms: number,
): EstimatePricingResult => {
    const selectedAddOns = addOns.map((addOn) => ({
        id: addOn.id,
        label: addOn.label,
        price: Number(addOn.price),
    }));
    const addOnTotal = selectedAddOns.reduce((total, addOn) => total + addOn.price, 0);
    const basePrice = service.basePrice == null ? null : Number(service.basePrice);

    if (basePrice == null || !Number.isFinite(basePrice)) {
        return {
            serviceType: service.serviceType,
            bedrooms,
            bathrooms,
            selectedAddOns,
            basePrice: null,
            roomMultiplier: null,
            addOnTotal,
            min: null,
            max: null,
            quoteOnly: true,
            currency: "GBP",
        };
    }

    const roomMultiplier = Math.max(0.1, 1 + (bedrooms - 1) * 0.22 + (bathrooms - 1) * 0.1);
    const min = Math.round(basePrice * 0.9 * roomMultiplier + addOnTotal);
    const max = Math.round(basePrice * 1.8 * roomMultiplier + addOnTotal);

    return {
        serviceType: service.serviceType,
        bedrooms,
        bathrooms,
        selectedAddOns,
        basePrice,
        roomMultiplier: Number(roomMultiplier.toFixed(4)),
        addOnTotal,
        min,
        max,
        quoteOnly: false,
        currency: "GBP",
    };
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
    const adminId = await getAdminId(user);
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
    const adminId = await getAdminId(user);

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
    const adminId = await getAdminId(user);

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
    const adminId = await getAdminId(user);

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
    const adminId = await getAdminId(user);
    const existing = await prisma.estimateForm.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Estimate form not found");
    await prisma.estimateForm.delete({ where: { id } });
};

const togglePublished = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
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
    const adminId = await getAdminId(user);

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
    const adminId = await getAdminId(user);

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

const publicFormSelect = {
    id: true,
    slug: true,
    published: true,
    headline: true,
    subheading: true,
    accentColor: true,
    showReviews: true,
    ctaLabel: true,
    confirmationMessage: true,
    coveredPostcodes: true,
    coveredCities: true,
    showLiveEstimate: true,
    adminId: true,
    fields: {
        where: { enabled: true },
        orderBy: { sortOrder: "asc" as const },
    },
    services: { where: { enabled: true } },
    addOns: { where: { enabled: true } },
    admin: {
        select: {
            businessName: true,
            businessLogo: true,
            mobileNumber: true,
            businessEmail: true,
            user: { select: { name: true, email: true } },
        },
    },
} as const;

const loadPublishedPublicForm = async (slug: string) => {
    const form = await prisma.estimateForm.findUnique({
        where: { slug },
        select: publicFormSelect,
    });

    if (!form || !form.published) {
        throw new AppError(status.NOT_FOUND, "This estimate page is not available.", {
            code: "ESTIMATE_FORM_UNAVAILABLE",
            retryable: false,
        });
    }

    return form;
};

const getPublicEstimateForm = async (slug: string) => {
    const form = await loadPublishedPublicForm(slug);
    const fields = buildPublicFields(form.fields);

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

    // Do not expose internal ownership identifiers on a public endpoint.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { adminId, ...safeForm } = form;
    return { ...safeForm, fields, reviewSummary };
};

type PublicCalculationPayload = {
    serviceType: ServiceType;
    bedrooms: number;
    bathrooms: number;
    addOnIds: string[];
    postcode?: string;
    city?: string;
};

const calculatePublicEstimate = async (slug: string, payload: PublicCalculationPayload) => {
    const form = await loadPublishedPublicForm(slug);

    const service = form.services.find((candidate) => candidate.serviceType === payload.serviceType);
    if (!service) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "That service is no longer available for this estimate form.", {
            code: "ESTIMATE_SERVICE_UNAVAILABLE",
            retryable: false,
            fieldErrors: { serviceType: "Please choose another service." },
        });
    }

    const requestedIds = Array.from(new Set(payload.addOnIds));
    const selectedAddOns = form.addOns.filter((addOn) => requestedIds.includes(addOn.id));
    if (selectedAddOns.length !== requestedIds.length) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "One or more selected add-ons are no longer available.", {
            code: "ESTIMATE_ADDON_UNAVAILABLE",
            retryable: false,
            fieldErrors: { addOnIds: "Please review your selected add-ons." },
        });
    }

    const coverage = evaluateCoverage(
        form.coveredPostcodes,
        form.coveredCities,
        payload.postcode ?? "",
        payload.city,
    );

    // Coverage is only enforced once the customer has entered a location. This
    // allows the same endpoint to power live pricing during the earlier steps.
    const locationProvided = Boolean(payload.postcode?.trim() || payload.city?.trim());
    if (locationProvided && !coverage.covered) {
        const area = [payload.postcode?.trim(), payload.city?.trim()].filter(Boolean).join(", ");
        throw new AppError(
            status.UNPROCESSABLE_ENTITY,
            area
                ? `Unfortunately we don't currently cover ${area}.`
                : "Unfortunately we don't currently cover that location.",
            {
                code: "ESTIMATE_LOCATION_NOT_COVERED",
                retryable: false,
                fieldErrors: {
                    ...(payload.postcode?.trim() ? { postcode: "This postcode is outside the current service area." } : {}),
                    ...(payload.city?.trim()
                        ? { city: "This city is outside the current service area." }
                        : form.coveredPostcodes.length === 0 && form.coveredCities.length > 0
                          ? { city: "Enter your city or town so we can check coverage." }
                          : {}),
                },
            },
        );
    }

    const pricing = calculatePricing(service, selectedAddOns, payload.bedrooms, payload.bathrooms);
    return {
        pricing: form.showLiveEstimate ? pricing : null,
        coverage,
        showLiveEstimate: form.showLiveEstimate,
    };
};

const submitPublicEstimateForm = async (
    slug: string,
    payload: PublicCalculationPayload & {
        postcode: string;
        city?: string;
        name?: string;
        email?: string;
        phone?: string;
        notes?: string;
        answers?: Record<string, string>;
    },
) => {
    const form = await loadPublishedPublicForm(slug);
    const publicFields = buildPublicFields(form.fields);

    const service = form.services.find((candidate) => candidate.serviceType === payload.serviceType);
    if (!service) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "That service is no longer available for this estimate form.", {
            code: "ESTIMATE_SERVICE_UNAVAILABLE",
            retryable: false,
            fieldErrors: { serviceType: "Please choose another service." },
        });
    }

    const requestedIds = Array.from(new Set(payload.addOnIds));
    const selectedAddOns = form.addOns.filter((addOn) => requestedIds.includes(addOn.id));
    if (selectedAddOns.length !== requestedIds.length) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "One or more selected add-ons are no longer available.", {
            code: "ESTIMATE_ADDON_UNAVAILABLE",
            retryable: false,
            fieldErrors: { addOnIds: "Please review your selected add-ons." },
        });
    }

    const coverage = evaluateCoverage(
        form.coveredPostcodes,
        form.coveredCities,
        payload.postcode,
        payload.city,
    );
    if (!coverage.covered) {
        const area = [payload.postcode.trim(), payload.city?.trim()].filter(Boolean).join(", ");
        throw new AppError(status.UNPROCESSABLE_ENTITY, `Unfortunately we don't currently cover ${area || "that location"}.`, {
            code: "ESTIMATE_LOCATION_NOT_COVERED",
            retryable: false,
            fieldErrors: {
                postcode: "This location is outside the current service area.",
                ...(form.coveredCities.length > 0 && !payload.city?.trim()
                    ? { city: "Enter your city or town so we can check coverage." }
                    : {}),
            },
        });
    }

    const contact = validateAndSnapshotAnswers(publicFields, payload.answers, {
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
    });
    const pricing = calculatePricing(service, selectedAddOns, payload.bedrooms, payload.bathrooms);
    const pricingSnapshot = {
        calculatedAt: new Date().toISOString(),
        ...pricing,
        coverage,
    };

    const submission = await prisma.estimateFormSubmission.create({
        data: {
            ref: generateSubmissionRef(),
            formId: form.id,
            serviceType: payload.serviceType,
            bedrooms: payload.bedrooms,
            bathrooms: payload.bathrooms,
            addOnIds: requestedIds,
            postcode: payload.postcode.trim(),
            city: payload.city?.trim() || undefined,
            name: contact.name,
            email: contact.email,
            phone: contact.phone,
            notes: payload.notes?.trim() || contact.notes || undefined,
            answers: contact.stored as unknown as Prisma.InputJsonValue,
            estimatedMin: pricing.min,
            estimatedMax: pricing.max,
            pricingSnapshot: pricingSnapshot as unknown as Prisma.InputJsonValue,
        },
    });

    return {
        ref: submission.ref,
        pricing: form.showLiveEstimate ? pricing : null,
        coverage,
        showLiveEstimate: form.showLiveEstimate,
    };
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
    calculatePublicEstimate,
    submitPublicEstimateForm,
};
