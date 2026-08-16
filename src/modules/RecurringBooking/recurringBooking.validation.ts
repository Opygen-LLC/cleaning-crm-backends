import { z } from "zod";
import {
  RecurringFrequency,
  RecurringStatus,
  ServiceType,
  WeekDay,
} from "../../generated/prisma/enums";

const createScheduleSchema = z
  .object({
    clientId: z.string().uuid("Invalid client ID"),
    serviceCatalogId: z.string().uuid("Invalid service catalog ID").optional(),
    serviceType: z.enum(ServiceType).optional(),
    address: z.string().min(1, "Address is required"),
    durationMins: z.number().int().positive("Duration must be positive"),
    total: z.number().positive("Total must be positive"),
    notes: z.string().optional(),

    frequency: z.enum(RecurringFrequency),
    dayOfWeek: z.enum(WeekDay),
    timeHour: z.number().int().min(0).max(23),
    timeMinute: z.number().int().min(0).max(59),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),

    staffIds: z.array(z.string().uuid()).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.serviceCatalogId && !data.serviceType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["serviceCatalogId"], message: "Choose a service" });
    }
  });

const updateScheduleSchema = z
  .object({
    serviceCatalogId: z.string().uuid("Invalid service catalog ID").optional(),
    serviceType: z.enum(ServiceType).optional(),
    address: z.string().min(1).optional(),
    durationMins: z.number().int().positive().optional(),
    total: z.number().positive().optional(),
    notes: z.string().optional(),
    frequency: z.enum(RecurringFrequency).optional(),
    dayOfWeek: z.enum(WeekDay).optional(),
    timeHour: z.number().int().min(0).max(23).optional(),
    timeMinute: z.number().int().min(0).max(59).optional(),
    staffIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

const statusActionSchema = z
  .object({
    action: z.enum(["pause", "resume", "cancel"]),
  })
  .strict();

export const recurringBookingValidation = {
  createSchedule: createScheduleSchema,
  updateSchedule: updateScheduleSchema,
  statusAction: statusActionSchema,
};
