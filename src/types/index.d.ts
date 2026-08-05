import { IRequestUser } from "./requestUser.interface";
import { VerifiedTokenResult } from "../lib/utils/verifiedRequestToken";

declare global {
    namespace Express {
        interface Request {
            user: IRequestUser;
            // PERF FIX (Phase 1.4): caches the result of verifying the
            // request's access token so checkAuth / checkSubscription /
            // checkFeature only verify it once per request. See
            // src/lib/utils/verifiedRequestToken.ts.
            verifiedAccessToken?: VerifiedTokenResult;
        }
    }
}
