import { z } from "zod";
import { BookingChangeRequestType } from "../../generated/prisma/enums";

const createBookingChangeRequest = z
    .object({
        bookingId: z.string().uuid("Invalid booking ID"),
        type: z.enum(BookingChangeRequestType),
        requestedDate: z
            .string()
            .datetime({ message: "Invalid ISO date string" })
            .optional(),
        reason: z.string().max(1000).optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
        if (data.type === "RESCHEDULE" && !data.requestedDate) {
            ctx.addIssue({
                code: "custom",
                path: ["requestedDate"],
                message: "requestedDate is required for reschedule requests",
            });
        }
    });

const decideBookingChangeRequest = z
    .object({
        action: z.enum(["approve", "reject"]),
        decisionNote: z.string().max(1000).optional(),
    })
    .strict();

export const bookingChangeRequestValidation = {
    createBookingChangeRequest,
    decideBookingChangeRequest,
};
