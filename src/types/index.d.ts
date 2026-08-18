import { IRequestUser } from "./requestUser.interface";
import { VerifiedTokenResult } from "../lib/utils/verifiedRequestToken";

// ── Client self-service portal auth (see middlewares/checkPortalAuth.ts) ────
// Resolved from Client.portalAccessToken — intentionally minimal (just the
// two ids needed to scope portal queries to that client's own records).
export interface IPortalClient {
    id: string;
    adminId: string;
}

declare global {
    namespace Express {
        interface Request {
            user: IRequestUser;
            // PERF FIX (Phase 1.4): caches the result of verifying the
            // request's access token so checkAuth / checkSubscription /
            // checkFeature only verify it once per request. See
            // src/lib/utils/verifiedRequestToken.ts.
            verifiedAccessToken?: VerifiedTokenResult;
            // Populated by the subscription gate and reused by checkAuth so
            // the same request never repeats remote status/tenant lookups.
            authRuntime?: {
                userStatus?: string | null;
                adminId?: string | null;
                subscriptionPlanName?: string | null;
                subscriptionFeatures?: import("../lib/utils/subscriptionPlanFeatures").SubscriptionPlanFeature[] | null;
                entitlementSummary?: import("../lib/utils/subscriptionPlanFeatures").SubscriptionPlanFeature[] | null;
            };
            // Set by checkPortalAuth.ts (resolvePortalClient /
            // checkAuthOrPortalClient) when the request is authenticated via
            // a client portal access token rather than an admin/staff
            // session. Undefined for normal session-authenticated requests.
            portalClient?: IPortalClient;
        }
    }
}
