export interface IRegisterUserPayload {
    businessName: string;
    name: string;
    email: string;
    password: string;
    /** Phone / WhatsApp number — collected in the 2-step wizard (Step 2) */
    mobileNumber?: string;
    /** Business type — collected in the 2-step wizard (Step 1) */
    businessType?: "residential" | "commercial" | "both";
    /** License or Trade ID — collected in the 2-step wizard (Step 1) */
    licenseNumber?: string;
}

export interface ILoginUserPayload {
    email: string;
    password: string;
}

export interface IChangePasswordPayload {
    currentPassword: string;
    newPassword: string;
}
