export interface IRegisterUserPayload {
    name: string;
    email: string;
    password: string;
}

export interface ILoginUserPayload {
    email: string;
    password: string;
}
