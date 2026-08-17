import { z } from "zod";
import { ServiceStatus, ServiceType } from "../../generated/prisma/enums";

const addOnSchema = z.object({
    name: z.string().min(1, "Add-on name is required"),
    priceGbp: z.number().nonnegative("Price must be non-negative"),
});

const createServiceCatalogSchema = z.object({
    serviceName: z.string().min(1, "Service name is required"),
    description: z.string().min(1, "Description is required"),
    basePriceGbp: z.number().nonnegative("Price must be non-negative"),
    duration: z.string().min(1, "Duration is required"),
    category: z.string().min(1, "Category is required"),
    status: z.nativeEnum(ServiceStatus).optional(),
    onlineBookingEnabled: z.boolean().optional(),
    addOns: z.array(addOnSchema).optional(),
    legacyServiceType: z.nativeEnum(ServiceType).nullable().optional(),
}).strict();

const bulkCreateServiceCatalogSchema = z.array(createServiceCatalogSchema).min(1).max(20);

const updateServiceCatalogSchema = z.object({
    serviceName: z.string().optional(),
    description: z.string().optional(),
    basePriceGbp: z.number().nonnegative().optional(),
    duration: z.string().optional(),
    category: z.string().optional(),
    status: z.nativeEnum(ServiceStatus).optional(),
    onlineBookingEnabled: z.boolean().optional(),
    addOns: z.array(addOnSchema).optional(),
    legacyServiceType: z.nativeEnum(ServiceType).nullable().optional(),
}).strict();

export const serviceCatalogValidation = {
    createServiceCatalog: createServiceCatalogSchema,
    bulkCreateServiceCatalog: bulkCreateServiceCatalogSchema,
    updateServiceCatalog: updateServiceCatalogSchema,
};
