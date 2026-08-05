import { BookingChangeRequestType } from "../../generated/prisma/enums";

export interface ICreateBookingChangeRequest {
    bookingId: string;
    type: BookingChangeRequestType;
    requestedDate?: string; // ISO date, required for RESCHEDULE
    reason?: string;
}

export interface IDecideBookingChangeRequest {
    action: "approve" | "reject";
    decisionNote?: string;
}
