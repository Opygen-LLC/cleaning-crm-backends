import { UserRole } from "../generated/prisma/enums";

export interface IRequestUser {
    id: string;
    email: string;
    role: UserRole;
    // PERF FIX (Phase 2): pre-resolved userId -> AdminProfile.id, attached by
    // checkAuth.ts for ADMIN-role requests (Redis-cached, see checkAuth.ts).
    // Also resolved for STAFF to the owning tenant; undefined/null for
    // SUPER_ADMIN or in contexts
    // that build an IRequestUser by hand (crons, tests) without going
    // through checkAuth — src/lib/utils/resolveAdminId.ts falls back to a
    // live DB lookup whenever this isn't set, so it's always safe to read.
    adminId?: string | null;
}
