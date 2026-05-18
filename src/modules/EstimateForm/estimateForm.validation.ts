import { z } from "zod";
import {
    ServiceType,
    FormFieldType,
    EstimateSubmissionStatus,
} from "../../generated/prisma/enums";

// ── Sub-schemas ────────────────────────────────────────────────────────────────

const serviceSchema = z.object({
    serviceType: z.enum(ServiceType),
    enabled:     z.boolean().optional(),
    basePrice:   z.number().min(0).optional(),
}).strict();

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

// ── Public submission ─────────────────────────────────────────────────────────

const publicSubmissionSchema = z.object({
    serviceType: z.enum(ServiceType),
    bedrooms:    z.number().int().min(0),
    bathrooms:   z.number().int().min(0),
    addOnIds:    z.array(z.string()).default([]),
    postcode:    z.string().min(1, "Postcode is required"),
    name:        z.string().min(1, "Name is required"),
    email:       z.string().email("Invalid email"),
    phone:       z.string().min(1, "Phone is required"),
    notes:       z.string().optional(),
}).strict();

// ── Export ─────────────────────────────────────────────────────────────────────

export const estimateFormValidation = {
    createEstimateForm:      createEstimateFormSchema,
    updateEstimateForm:      updateEstimateFormSchema,
    updateSubmissionStatus:  updateSubmissionStatusSchema,
    publicSubmission:        publicSubmissionSchema,
};
