export interface UpdateStaffPayload {
    staffRole?: string;
    mobileNumber?: string;
}

export interface StaffFilterOptions {
    searchTerm?: string;
    adminId?: string;
    staffRole?: string;
}
