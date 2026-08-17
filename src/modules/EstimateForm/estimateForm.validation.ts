import { z } from "zod";
import {
    ServiceType,
    FormFieldType,
    EstimateSubmissionStatus,
} from "../../generated/prisma/enums";

// ── Sub-schemas ────────────────────────────────────────────────────────────────

const serviceSchema = z.object({
    serviceCatalogId: z.string().uuid().optional(),
    serviceType: z.enum(ServiceType).optional(),
    enabled:     z.boolean().optional(),
    basePrice:   z.number().min(0).optional(),
}).strict().superRefine((value, ctx) => {
    if (!value.serviceCatalogId && !value.serviceType) {
        ctx.addIssue({ code: "custom", path: ["serviceCatalogId"], message: "Choose a service" });
    }
});

const addOnSchema = z.object({
    label:   z.string().min(1),
    price:   z.number().min(0),
    enabled: z.boolean().optional(),
}).strict();

const fieldSchema = z.object({
    type:        z.enum(FormFieldType),
    label:       z.string().min(1),
    placeholder: z.string().optional(),
    required:    z.boolean().optional(),
    enabled:     z.boolean().optional(),
    options:     z.array(z.string()).optional(),
    sortOrder:   z.number().int().min(0).optional(),
}).strict();

// ── Create / Update ────────────────────────────────────────────────────────────

const createEstimateFormSchema = z.object({
    headline:            z.string().min(1, "Headline is required"),
    subheading:          z.string().optional(),
    accentColor:         z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    showReviews:         z.boolean().optional(),
    ctaLabel:            z.string().optional(),
    confirmationMessage: z.string().optional(),
    coveredPostcodes:    z.array(z.string()).optional(),
    coveredCities:       z.array(z.string()).optional(),
    showLiveEstimate:    z.boolean().optional(),
    services:            z.array(serviceSchema).optional(),
    addOns:              z.array(addOnSchema).optional(),
    fields:              z.array(fieldSchema).optional(),
}).strict();

const updateEstimateFormSchema = createEstimateFormSchema
    .omit({ headline: true })
    .extend({
        headline:  z.string().min(1).optional(),
        published: z.boolean().optional(),
    })
    .partial();

// ── Submission status ─────────────────────────────────────────────────────────

const updateSubmissionStatusSchema = z.object({
    status: z.enum(EstimateSubmissionStatus),
}).strict();

// ── Public calculation / submission ──────────────────────────────────────────

const publicCalculationBase = z.object({
    serviceCatalogId: z.string().uuid().optional(),
    serviceType: z.enum(ServiceType).optional(),
    bedrooms:    z.number().int().min(0).max(50),
    bathrooms:   z.number().int().min(0).max(50),
    addOnIds:    z.array(z.string().trim().min(1).max(120)).max(30).default([]),
    postcode:    z.string().trim().max(32).optional(),
    city:        z.string().trim().max(120).optional(),
}).strict();

const requireServiceIdentity = (value: { serviceCatalogId?: string; serviceType?: ServiceType }, ctx: z.RefinementCtx) => {
    if (!value.serviceCatalogId && !value.serviceType) {
        ctx.addIssue({ code: "custom", path: ["serviceCatalogId"], message: "Choose a service" });
    }
};

const publicCalculationSchema = publicCalculationBase.superRefine(requireServiceIdentity);

const publicSubmissionSchema = publicCalculationBase.extend({
    postcode: z.string().trim().min(1, "Postcode is required").max(32),
    city:     z.string().trim().max(120).optional(),
    // Legacy contact fields remain accepted during the rollout; the server
    // derives canonical contact data from semantic form answers when present.
    name:     z.string().trim().max(200).optional(),
    email:    z.string().trim().email("Invalid email").max(254).optional(),
    phone:    z.string().trim().regex(/^[+\d\s()\-.]{7,40}$/, "Enter a valid phone number").max(40).optional(),
    notes:    z.string().trim().max(3000).optional(),
    answers:  z.record(z.string().trim().min(1).max(100), z.string().trim().max(3000))
        .refine((answers) => Object.keys(answers).length <= 50, "Too many custom field answers")
        .optional(),
}).strict().superRefine(requireServiceIdentity);

// ── Export ─────────────────────────────────────────────────────────────────────

export const estimateFormValidation = {
    createEstimateForm:      createEstimateFormSchema,
    updateEstimateForm:      updateEstimateFormSchema,
    updateSubmissionStatus:  updateSubmissionStatusSchema,
    publicCalculation:       publicCalculationSchema,
    publicSubmission:        publicSubmissionSchema,
};
