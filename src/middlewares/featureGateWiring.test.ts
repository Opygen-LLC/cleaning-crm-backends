/**
 * featureGateWiring.test.ts
 *
 * "Feature-gate bypass attempts" coverage for the Phase 1 fix.
 *
 * checkSubscription.test.ts already unit-tests checkFeature(key)'s own
 * allow/block logic in isolation. What it can't catch is a regression where
 * someone adds a new admin route to one of these files (or refactors an
 * existing one) without wiring the gate back in — the middleware would
 * still work perfectly, it just wouldn't be *attached* to the route, so a
 * locked-out tenant could hit that one endpoint directly and bypass the
 * plan restriction entirely, exactly like the Phase 1 audit found.
 *
 * These tests don't dispatch real HTTP requests (that would need a live
 * Express app + database). Instead they mock checkAuth/checkFeature with
 * deterministic marker functions, import the *real* router modules, and
 * inspect each router's compiled `.stack` to assert the correct marker is
 * physically present in the middleware chain for every route that Phase 1
 * was supposed to lock down — i.e. that a request to that exact method+path
 * cannot reach the controller without first passing through the gate.
 *
 * Controllers and Zod validation objects are mocked with a Proxy that hands
 * back a no-op vi.fn() for any property access, since their real business
 * logic is irrelevant here — we only care about *which* middlewares are
 * wired onto *which* routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response, Router } from "express";

type Marker = (req: Request, res: Response, next: NextFunction) => void;

// One stable marker function per feature key / role-set, memoised so calling
// checkFeature("leads pipeline") (or checkAuth(UserRole.ADMIN)) twice — once
// while the route module builds itself, once from the test asserting what
// key was used — returns the exact same function reference both times.
const featureMarkers = new Map<string, Marker>();
const authMarkers = new Map<string, Marker>();

function markerFor(map: Map<string, Marker>, key: string): Marker {
    let marker = map.get(key);
    if (!marker) {
        marker = (() => {}) as unknown as Marker;
        map.set(key, marker);
    }
    return marker;
}

vi.mock("../middlewares/checkSubscription", () => ({
    checkFeature: vi.fn((key: string) => markerFor(featureMarkers, key)),
    checkSubscription: vi.fn(),
}));

vi.mock("../middlewares/checkAuth", () => ({
    checkAuth: vi.fn((...roles: string[]) =>
        markerFor(authMarkers, roles.join(",")),
    ),
}));

/** Proxy standing in for a whole controller/validation module: any property
 * access (createLead, getLeads, updateLeadStage, ...) returns a fresh no-op
 * function, so the real routes file can wire up as many handlers as it
 * wants without this mock needing to enumerate them by name. */
function proxyModule() {
    return new Proxy(
        {},
        { get: () => vi.fn() },
    ) as Record<string, (...args: unknown[]) => unknown>;
}

vi.mock("../modules/BookingForm/bookingForm.controller", () => ({
    bookingFormController: proxyModule(),
}));
vi.mock("../modules/BookingForm/bookingForm.validation", () => ({
    bookingFormValidation: proxyModule(),
}));

vi.mock("../modules/Lead/lead.controller", () => ({ leadController: proxyModule() }));
vi.mock("../modules/Lead/lead.validation", () => ({ leadValidation: proxyModule() }));

vi.mock("../modules/EstimateForm/estimateForm.controller", () => ({
    estimateFormController: proxyModule(),
}));
vi.mock("../modules/EstimateForm/estimateForm.validation", () => ({
    estimateFormValidation: proxyModule(),
}));

vi.mock("../modules/Staff/staff.controller", () => ({ staffController: proxyModule() }));
vi.mock("../modules/Staff/staff.validation", () => ({ staffValidation: proxyModule() }));
vi.mock("../modules/StaffLeave/staffLeave.controller", () => ({
    staffLeaveController: proxyModule(),
}));

vi.mock("../modules/PricingRules/pricingRules.controller", () => ({
    pricingRulesController: proxyModule(),
}));
vi.mock("../modules/PricingRules/pricingRules.validation", () => ({
    pricingRulesValidation: proxyModule(),
}));

// Router.stack layer shape, narrowed to just what we read.
interface RouteLayer {
    route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: Marker }>;
    };
}

/** True if `marker` gates the given method+path — either passed inline as
 * one of the route's own middleware args, or applied earlier in the file via
 * `router.use(marker)` (which, in Express, runs for every route registered
 * after it, since dispatch tries each top-level layer in registration order
 * and a route registered earlier — e.g. a public endpoint — never reaches a
 * `.use()` layer that comes after it in the stack). */
function routeHasMiddleware(
    router: Router,
    method: "get" | "post" | "patch" | "put" | "delete",
    path: string,
    marker: Marker,
): boolean {
    // Express's public `Router` type doesn't expose `.stack` with a shape
    // precise enough to type-check the reads below (its `IRoute.methods` is
    // effectively untyped) — but `.stack` is a stable, well-documented
    // runtime structure, so we narrow to what we actually read here rather
    // than fighting the upstream types.
    const stack = router.stack as unknown as RouteLayer[];
    const routeIndex = stack.findIndex(
        (l) => l.route?.path === path && l.route?.methods[method],
    );
    if (routeIndex === -1) {
        throw new Error(`No ${method.toUpperCase()} ${path} route found on this router`);
    }

    const gatedGlobally = stack
        .slice(0, routeIndex)
        .some((l) => !l.route && (l as unknown as { handle: Marker }).handle === marker);

    const gatedInline = stack[routeIndex].route!.stack.some((l) => l.handle === marker);

    return gatedGlobally || gatedInline;
}

beforeEach(() => {
    vi.resetModules();
    featureMarkers.clear();
    authMarkers.clear();
});

describe("BookingForm routes — gated behind 'online booking'", () => {
    it("wires the gate onto every admin route, and NOT onto the public widget routes", async () => {
        const { bookingFormRoutes } = await import(
            "../modules/BookingForm/bookingForm.routes"
        );
        const gate = markerFor(featureMarkers, "online_booking");

        for (const [method, path] of [
            ["get", "/"],
            ["post", "/"],
            ["get", "/submissions"],
            ["patch", "/submissions/:submissionId/status"],
            ["get", "/:id"],
            ["patch", "/:id"],
            ["delete", "/:id"],
            ["patch", "/:id/publish"],
            ["get", "/:id/submissions"],
        ] as const) {
            expect(
                routeHasMiddleware(bookingFormRoutes, method, path, gate),
                `${method.toUpperCase()} ${path} should be gated behind "online booking"`,
            ).toBe(true);
        }

        // Public booking-widget routes must stay open — no admin auth exists yet
        // to gate at that point (an anonymous client is filling out the form).
        for (const [method, path] of [
            ["get", "/public/:slug"],
            ["get", "/public/:slug/slots"],
        ] as const) {
            expect(
                routeHasMiddleware(bookingFormRoutes, method, path, gate),
            ).toBe(false);
        }
    });
});

describe("Lead routes — gated behind 'leads pipeline'", () => {
    it("wires the gate onto every route", async () => {
        const { leadRoutes } = await import("../modules/Lead/lead.routes");
        const gate = markerFor(featureMarkers, "crm_leads");

        for (const [method, path] of [
            ["post", "/"],
            ["get", "/"],
            ["get", "/:id"],
            ["patch", "/:id"],
            ["patch", "/:id/stage"],
            ["post", "/:id/convert-to-client"],
            ["delete", "/:id"],
        ] as const) {
            expect(
                routeHasMiddleware(leadRoutes, method, path, gate),
                `${method.toUpperCase()} ${path} should be gated behind "leads pipeline"`,
            ).toBe(true);
        }
    });
});

describe("EstimateForm routes — split between 'pricing forms' and 'estimate submissions'", () => {
    it("gates the form-builder CRUD routes behind 'pricing forms'", async () => {
        const { estimateFormRoutes } = await import(
            "../modules/EstimateForm/estimateForm.routes"
        );
        const formsGate = markerFor(featureMarkers, "pricing_forms");

        for (const [method, path] of [
            ["post", "/"],
            ["get", "/"],
            ["get", "/:id"],
            ["patch", "/:id"],
            ["delete", "/:id"],
            ["patch", "/:id/toggle-published"],
        ] as const) {
            expect(
                routeHasMiddleware(estimateFormRoutes, method, path, formsGate),
                `${method.toUpperCase()} ${path} should be gated behind "pricing forms"`,
            ).toBe(true);
        }
    });

    it("gates the submissions inbox routes behind 'estimate submissions', not 'pricing forms'", async () => {
        const { estimateFormRoutes } = await import(
            "../modules/EstimateForm/estimateForm.routes"
        );
        const submissionsGate = markerFor(featureMarkers, "estimate_submissions");
        const formsGate = markerFor(featureMarkers, "pricing_forms");

        for (const [method, path] of [
            ["get", "/submissions"],
            ["patch", "/submissions/:submissionId/status"],
            ["get", "/:id/submissions"],
        ] as const) {
            expect(
                routeHasMiddleware(estimateFormRoutes, method, path, submissionsGate),
                `${method.toUpperCase()} ${path} should be gated behind "estimate submissions"`,
            ).toBe(true);
            // A plan with pricing-forms access but not estimate-submissions
            // access must not get a free pass on the submissions inbox.
            expect(
                routeHasMiddleware(estimateFormRoutes, method, path, formsGate),
            ).toBe(false);
        }
    });
});

describe("Staff leave routes — one authoritative owner", () => {
    it("keeps leave routes out of Staff/staff.routes.ts", async () => {
        const { staffRoutes } = await import("../modules/Staff/staff.routes");
        const paths = (staffRoutes.stack as unknown as RouteLayer[])
            .map((layer) => layer.route?.path)
            .filter(Boolean);

        expect(paths.some((path) => String(path).startsWith("/leave"))).toBe(false);
    });

    it("gates admin review endpoints on the authoritative StaffLeave router", async () => {
        const { staffLeaveRoutes } = await import(
            "../modules/StaffLeave/staffLeave.routes"
        );
        const gate = markerFor(featureMarkers, "leave_approvals");

        expect(
            routeHasMiddleware(staffLeaveRoutes, "get", "/leave/all", gate),
        ).toBe(true);
        expect(
            routeHasMiddleware(staffLeaveRoutes, "patch", "/leave/:id/review", gate),
        ).toBe(true);
    });
});

describe("PricingRules routes — gated behind 'advanced pricing rules'", () => {
    it("wires the gate onto both routes", async () => {
        const { pricingRulesRoutes } = await import(
            "../modules/PricingRules/pricingRules.routes"
        );
        const gate = markerFor(featureMarkers, "advanced_pricing_rules");

        expect(routeHasMiddleware(pricingRulesRoutes, "get", "/", gate)).toBe(true);
        expect(routeHasMiddleware(pricingRulesRoutes, "put", "/", gate)).toBe(true);
    });
});
