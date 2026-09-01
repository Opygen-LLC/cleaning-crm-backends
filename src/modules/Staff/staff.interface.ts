import { WeekDay } from "../../generated/prisma/enums";

export interface StaffAvailabilityInput {
    day: WeekDay;
    startTime?: string; // "09:00"
    endTime?: string; // "17:00"
    isActive?: boolean;
}

export interface CreateStaffPayload {
    name: string;
    email: string;
    staffRole: string;

    mobileNumber: string;
    address?: string;

    hourlyRate?: number;
    startDate: string;

    specialty?: string[];

    emergencyName?: string;
    emergencyMobileNumber?: string;
    adminNote?: string;

    staffAvailability: StaffAvailabilityInput[];
}

export interface UpdateStaffPayload {
    staffRole?: string;
    mobileNumber?: string;
    // Editable address for a staff member already on the roster — feeds
    // geocodeStaffAddress() in staff.service.ts so their dispatch-map pin
    // and distance calculations stay accurate. See updateStaffSchema in
    // staff.validation.ts, which must accept this same field.
    address?: string;
    specialty?: string[];
}

export interface UpdateAvailabilityPayload {
    availability: StaffAvailabilityInput[];
}
