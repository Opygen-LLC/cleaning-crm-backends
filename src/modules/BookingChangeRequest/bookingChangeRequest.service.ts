import status from "http-status";
import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import {
    BookingChangeRequestStatus,
    BookingStatus,
    NotificationType,
} from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import { IPortalClient } from "../../types";
import { createNotification } from "../../lib/utils/createNotification";
import {
    ICreateBookingChangeRequest,
    IDecideBookingChangeRequest,
} from "./bookingChangeRequest.interface";

// ── Client (portal): create a request ─────────────────────────────────────────
const createRequest = async (
    payload: ICreateBookingChangeRequest,
    portalClient: IPortalClient,
) => {
    const booking = await prisma.booking.findFirst({
        where: { id: payload.bookingId, clientId: portalClient.id },
    });
    if (!booking) throw new AppError(status.NOT_FOUND, "Booking not found");

    const reschedulableStatuses: BookingStatus[] = [
        BookingStatus.SCHEDULED,
        BookingStatus.IN_PROGRESS,
    ];
    if (!reschedulableStatuses.includes(booking.status)) {
        throw new AppError(
            status.BAD_REQUEST,
            "Only upcoming bookings can have a reschedule or cancellation requested.",
        );
    }

    // Avoid piling up duplicate pending requests for the same booking.
    const existingPending = await prisma.bookingChangeRequest.findFirst({
        where: { bookingId: booking.id, status: BookingChangeRequestStatus.PENDING },
    });
    if (existingPending) {
        throw new AppError(
            status.BAD_REQUEST,
            "A request for this booking is already pending review.",
        );
    }

    const request = await prisma.bookingChangeRequest.create({
        data: {
            bookingId: booking.id,
            clientId: portalClient.id,
            adminId: portalClient.adminId,
            type: payload.type,
            requestedDate: payload.requestedDate
                ? new Date(payload.requestedDate)
                : null,
            reason: payload.reason,
        },
    });

    await createNotification({
        adminId: portalClient.adminId,
        type: NotificationType.BOOKING,
        title:
            payload.type === "RESCHEDULE"
                ? "Client requested a reschedule"
                : "Client requested a cancellation",
        message: `${booking.bookingRef} — a client has asked to ${payload.type === "RESCHEDULE" ? "reschedule" : "cancel"} their booking. Review it in the portal requests inbox.`,
        relatedId: request.id,
    });

    return request;
};

// ── Admin: list requests (defaults to pending-first) ──────────────────────────
const getRequests = async (
    user: IRequestUser,
    filters: { status?: BookingChangeRequestStatus },
) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId: user.id },
    });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    return prisma.bookingChangeRequest.findMany({
        where: { adminId: admin.id, ...(filters.status ? { status: filters.status } : {}) },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        include: {
            booking: {
                select: {
                    id: true,
                    bookingRef: true,
                    status: true,
                    scheduledDate: true,
                    serviceType: true,
                    address: true,
                },
            },
            client: { select: { id: true, name: true, email: true, phone: true } },
        },
    });
};

// ── Admin: approve/reject ──────────────────────────────────────────────────────
const decideRequest = async (
    id: string,
    payload: IDecideBookingChangeRequest,
    user: IRequestUser,
) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId: user.id },
    });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    const request = await prisma.bookingChangeRequest.findFirst({
        where: { id, adminId: admin.id },
        include: { booking: true },
    });
    if (!request) throw new AppError(status.NOT_FOUND, "Request not found");

    if (request.status !== BookingChangeRequestStatus.PENDING) {
        throw new AppError(status.BAD_REQUEST, "This request has already been decided.");
    }

    const newStatus =
        payload.action === "approve"
            ? BookingChangeRequestStatus.APPROVED
            : BookingChangeRequestStatus.REJECTED;

    const updated = await prisma.$transaction(async (tx) => {
        const decided = await tx.bookingChangeRequest.update({
            where: { id },
            data: {
                status: newStatus,
                decisionNote: payload.decisionNote,
                decidedAt: new Date(),
                decidedBy: admin.id,
            },
        });

        // Approving a cancellation request cancels the booking outright.
        // Approving a reschedule just flags it decided — the admin still
        // needs to actually move the booking to the agreed date via the
        // normal booking edit flow, since that touches staff scheduling too.
        if (
            payload.action === "approve" &&
            request.type === "CANCELLATION"
        ) {
            await tx.booking.update({
                where: { id: request.bookingId },
                data: { status: BookingStatus.CANCELLED },
            });
        }

        return decided;
    });

    return updated;
};

export const bookingChangeRequestService = {
    createRequest,
    getRequests,
    decideRequest,
};
