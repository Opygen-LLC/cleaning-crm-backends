import { IRequestUser } from "./requestUser.interface";

// A resolved client-portal identity — set by checkPortalAuth middleware when
// a request is authenticated via the client's opaque portalAccessToken
// rather than an admin/staff session. Mutually exclusive with `user` in
// practice (routes that accept both only ever populate one).
export interface IPortalClient {
    id: string;
    adminId: string;
}

declare global {
    namespace Express {
        interface Request {
            user: IRequestUser;
            portalClient?: IPortalClient;
        }
    }
}
