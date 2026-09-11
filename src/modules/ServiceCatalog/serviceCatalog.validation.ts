import { z } from "zod";
import { ServiceCategory, ServiceStatus, ServiceType } from "../../generated/prisma/enums";

const addOnInputSchema = z
    .object({
        name: z.string().trim().min(1, "Add-on name is required"),
        price: z.number().nonnegative("Price must be non-negative").optional(),
        // Rolling-deploy compatibility for older web clients.
        priceGbp: z.number().nonnegative("Price must be non-negative").optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.price === undefined && value.priceGbp === undefined) {
            ctx.addIssue({
                code: "custom",
                path: ["price"],
                message: "Price is required",
            });
        }
    })
    .transform(({ name, price, priceGbp }) => ({
        name,
        price: price ?? priceGbp ?? 0,
    }));

const serviceCatalogBaseSchema = z.object({
    serviceName: z.string().trim().min(1, "Service name is required"),
    description: z.string().trim().min(1, "Description is required"),
    basePrice: z.number().nonnegative("Price must be non-negative").optional(),
    // Rolling-deploy compatibility. `basePrice` is canonical and is an amount
    // in AdminProfile.currency; the old GBP-specific name is accepted only at
    // the API edge and never propagated into new internal code.
    basePriceGbp: z.number().nonnegative("Price must be non-negative").optional(),
    duration: z.string().trim().min(1, "Duration is required"),
    category: z.nativeEnum(ServiceCategory),
    status: z.nativeEnum(ServiceStatus).optional(),
    onlineBookingEnabled: z.boolean().optional(),
    addOns: z.array(addOnInputSchema).optional(),
    legacyServiceType: z.nativeEnum(ServiceType).nullable().optional(),
});

const createServiceCatalogSchema = serviceCatalogBaseSchema
    .strict()
    .superRefine((value, ctx) => {
        if (value.basePrice === undefined && value.basePriceGbp === undefined) {
            ctx.addIssue({
                code: "custom",
                path: ["basePrice"],
                message: "Base price is required",
            });
        }
    })
    .transform(({ basePrice, basePriceGbp, ...rest }) => ({
        ...rest,
        basePrice: basePrice ?? basePriceGbp ?? 0,
    }));

const bulkCreateServiceCatalogSchema = z
    .array(createServiceCatalogSchema)
    .min(1)
    .max(20);

const updateServiceCatalogSchema = serviceCatalogBaseSchema
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
        message: "Provide at least one service field to update",
    })
    .transform(({ basePrice, basePriceGbp, ...rest }) => ({
        ...rest,
        ...(basePrice !== undefined || basePriceGbp !== undefined
            ? { basePrice: basePrice ?? basePriceGbp }
            : {}),
    }));



const serviceCatalogFiltersSchema = z.object({
    page: z.coerce.number().int().min(1).max(100_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    searchTerm: z.string().trim().max(200).optional(),
    category: z.nativeEnum(ServiceCategory).optional(),
    status: z.nativeEnum(ServiceStatus).optional(),
}).strict();

const serviceCatalogIdParamsSchema = z.object({
    id: z.string().uuid("Choose a valid service."),
}).strict();

export const serviceCatalogValidation = {
    createServiceCatalog: createServiceCatalogSchema,
    bulkCreateServiceCatalog: bulkCreateServiceCatalogSchema,
    updateServiceCatalog: updateServiceCatalogSchema,
    serviceCatalogFilters: serviceCatalogFiltersSchema,
    serviceCatalogIdParams: serviceCatalogIdParamsSchema,
};
