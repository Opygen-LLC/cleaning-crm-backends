export interface IRegisterUserPayload {
    businessName: string;
    name: string;
    email: string;
    password: string;
}

export interface ILoginUserPayload {
    email: string;
    password: string;
}

export interface IChangePasswordPayload {
    currentPassword: string;
    newPassword: string;
}