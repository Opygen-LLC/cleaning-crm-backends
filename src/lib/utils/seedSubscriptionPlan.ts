import {
    Currency,
    SubscriptionName,
    SubscriptionPlanInterval,
} from "../../generated/prisma/enums";
import { prisma } from "../prisma/prisma";

/**
 * Feature label strings must stay in sync with the `featureLabel` /
 * `feature` props used in FeatureGate across the frontend.
 *
 * FeatureGate normalises labels (lowercase, collapse whitespace) before
 * comparing, so casing here doesn't matter — but keeping it readable does.
 *
 * Plan hierarchy (enforced by FeatureGate's PLAN_RANK):
 *   STARTER (0) → GROWTH (1) → PRO (2) → CUSTOM (3)
 *
 * A higher-tier plan automatically inherits all lower-tier features via
 * the PLAN_RANK check in FeatureGate — you only need to list features
 * that *first appear* at a given tier.
 */
const SUBSCRIPTION_PLANS: {
    name: SubscriptionName;
    description: string;
    currency: Currency;
    features: { label: string; included: boolean; limit?: string }[];
    plans: {
        interval: SubscriptionPlanInterval;
        price: number;
        maxStaff: number | null;
        maxClient: number | null;
        maxBookingsPerMonth: number | null;
        baseCharge?: number;
        pricePerStaff?: number;
        pricePerClient?: number;
        pricePerBooking?: number;
    }[];
}[] = [
    // ─── STARTER ────────────────────────────────────────────────────────────────
    {
        name: SubscriptionName.STARTER,
        description: "Perfect for small businesses just getting started.",
        currency: "USD",
        features: [
            { label: "Up to 3 staff", included: true, limit: "3 staff" },
            { label: "Up to 50 clients", included: true, limit: "50 clients" },
            { label: "100 bookings/month", included: true, limit: "100/month" },
            { label: "Bookings", included: true },
            { label: "Jobs", included: true },
            { label: "Clients", included: true },
            { label: "Invoices", included: true },
            { label: "Quotes", included: true },
            { label: "Expenses", included: true },
            { label: "Services", included: true },
            { label: "Email support", included: true },
            // Features NOT included on Starter
            { label: "Online Booking", included: false },
            { label: "Reviews", included: false },
            { label: "Reports", included: false },
            { label: "Leads Pipeline", included: false },
            { label: "Pricing Forms", included: false },
            { label: "Leave Approvals", included: false },
            { label: "Team Performance", included: false },
            { label: "Recurring Bookings", included: false },
            { label: "Auto-Dispatch", included: false },
            { label: "Coupons", included: false },
            { label: "Advanced Pricing Rules", included: false },
        ],
        plans: [
            {
                interval: SubscriptionPlanInterval.MONTHLY,
                price: 19.0,
                maxStaff: 3,
                maxClient: 50,
                maxBookingsPerMonth: 100,
            },
            {
                interval: SubscriptionPlanInterval.YEARLY,
                price: 199.0,
                maxStaff: 3,
                maxClient: 50,
                maxBookingsPerMonth: 100,
            },
        ],
    },

    // ─── GROWTH ─────────────────────────────────────────────────────────────────
    {
        name: SubscriptionName.GROWTH,
        description: "For growing teams that need more power.",
        currency: "USD",
        features: [
            // Limits
            { label: "Up to 10 staff", included: true, limit: "10 staff" },
            {
                label: "Up to 200 clients",
                included: true,
                limit: "200 clients",
            },
            { label: "500 bookings/month", included: true, limit: "500/month" },
            // Core (inherited from Starter, listed for clarity in UI)
            { label: "Bookings", included: true },
            { label: "Jobs", included: true },
            { label: "Clients", included: true },
            { label: "Invoices", included: true },
            { label: "Quotes", included: true },
            { label: "Expenses", included: true },
            { label: "Services", included: true },
            // Growth-tier unlocks
            { label: "Online Booking", included: true },
            { label: "Reviews", included: true },
            { label: "Reports", included: true },
            { label: "Leads Pipeline", included: true },
            { label: "Pricing Forms", included: true },
            { label: "Estimate Submissions", included: true },
            { label: "Leave Approvals", included: true },
            { label: "Team Performance", included: true },
            { label: "Priority support", included: true },
            // Still not on Growth
            { label: "Recurring Bookings", included: false },
            { label: "Auto-Dispatch", included: false },
            { label: "Coupons", included: false },
            { label: "Advanced Pricing Rules", included: false },
        ],
        plans: [
            {
                interval: SubscriptionPlanInterval.MONTHLY,
                price: 49.0,
                maxStaff: 10,
                maxClient: 200,
                maxBookingsPerMonth: 500,
            },
            {
                interval: SubscriptionPlanInterval.YEARLY,
                price: 499.0,
                maxStaff: 10,
                maxClient: 200,
                maxBookingsPerMonth: 500,
            },
        ],
    },

    // ─── PRO ────────────────────────────────────────────────────────────────────
    {
        name: SubscriptionName.PRO,
        description: "Unlimited scale for large organisations.",
        currency: "USD",
        features: [
            // Limits
            { label: "Unlimited staff", included: true, limit: "unlimited" },
            { label: "Unlimited clients", included: true, limit: "unlimited" },
            { label: "Unlimited bookings", included: true, limit: "unlimited" },
            // All Growth features included via PLAN_RANK — list key ones for UI
            { label: "Online Booking", included: true },
            { label: "Reviews", included: true },
            { label: "Reports", included: true },
            { label: "Leads Pipeline", included: true },
            { label: "Pricing Forms", included: true },
            { label: "Estimate Submissions", included: true },
            { label: "Leave Approvals", included: true },
            { label: "Team Performance", included: true },
            // PRO-only unlocks
            { label: "Recurring Bookings", included: true },
            { label: "Auto-Dispatch", included: true },
            { label: "Coupons", included: true },
            { label: "Advanced Pricing Rules", included: true },
            { label: "24/7 dedicated support", included: true },
            { label: "Custom integrations", included: true },
            { label: "SLA guarantee", included: true },
        ],
        plans: [
            {
                interval: SubscriptionPlanInterval.MONTHLY,
                price: 99.0,
                maxStaff: null,
                maxClient: null,
                maxBookingsPerMonth: null,
            },
            {
                interval: SubscriptionPlanInterval.YEARLY,
                price: 999.0,
                maxStaff: null,
                maxClient: null,
                maxBookingsPerMonth: null,
            },
        ],
    },

    // ─── CUSTOM ─────────────────────────────────────────────────────────────────
    {
        name: SubscriptionName.CUSTOM,
        description: "Fully flexible pricing — pay only for what you use.",
        currency: "USD",
        features: [
            { label: "Choose your staff count", included: true },
            { label: "Choose your client limit", included: true },
            { label: "Choose your bookings per month", included: true },
            { label: "$10 base charge", included: true },
            { label: "$5 per staff member", included: true },
            {
                label: "$0.10 per client",
                included: true,
                limit: "10 clients / $1",
            },
            {
                label: "$0.10 per booking",
                included: true,
                limit: "10 bookings / $1",
            },
            // All features enabled — CUSTOM rank is highest
            { label: "Online Booking", included: true },
            { label: "Reviews", included: true },
            { label: "Reports", included: true },
            { label: "Leads Pipeline", included: true },
            { label: "Pricing Forms", included: true },
            { label: "Estimate Submissions", included: true },
            { label: "Leave Approvals", included: true },
            { label: "Team Performance", included: true },
            { label: "Recurring Bookings", included: true },
            { label: "Auto-Dispatch", included: true },
            { label: "Coupons", included: true },
            { label: "Advanced Pricing Rules", included: true },
            { label: "Priority support", included: true },
        ],
        plans: [
            {
                interval: SubscriptionPlanInterval.MONTHLY,
                price: 0,
                maxStaff: null,
                maxClient: null,
                maxBookingsPerMonth: null,
                baseCharge: 10.0,
                pricePerStaff: 5.0,
                pricePerClient: 0.1,
                pricePerBooking: 0.1,
            },
            {
                interval: SubscriptionPlanInterval.YEARLY,
                price: 0,
                maxStaff: null,
                maxClient: null,
                maxBookingsPerMonth: null,
                baseCharge: 120.0,
                pricePerStaff: 5.0,
                pricePerClient: 0.1,
                pricePerBooking: 0.1,
            },
        ],
    },
];

export async function seedSubscriptionPlans() {
    for (const sub of SUBSCRIPTION_PLANS) {
        let subscriptionPlan;

        try {
            subscriptionPlan = await prisma.subscriptionPlan.upsert({
                where: { name: sub.name },
                update: {
                    description: sub.description,
                    currency: sub.currency,
                    features: sub.features.map(f => JSON.stringify(f)),
                },
                create: {
                    name: sub.name,
                    description: sub.description,
                    currency: sub.currency,
                    features: sub.features.map(f => JSON.stringify(f)),
                },
            });
        } catch (err) {
            console.error(
                `❌ Failed to upsert SubscriptionPlan: ${sub.name}`,
                err,
            );
            continue;
        }

        for (const plan of sub.plans) {
            try {
                await prisma.plan.upsert({
                    where: {
                        subscriptionPlanId_interval: {
                            subscriptionPlanId: subscriptionPlan.id,
                            interval: plan.interval,
                        },
                    },
                    update: {
                        price: plan.price,
                        maxStaff: plan.maxStaff,
                        maxClient: plan.maxClient,
                        maxBookingsPerMonth: plan.maxBookingsPerMonth,
                        baseCharge: plan.baseCharge ?? 0,
                        pricePerStaff: plan.pricePerStaff ?? 0,
                        pricePerClient: plan.pricePerClient ?? 0,
                        pricePerBooking: plan.pricePerBooking ?? 0,
                    },
                    create: {
                        price: plan.price,
                        interval: plan.interval,
                        maxStaff: plan.maxStaff,
                        maxClient: plan.maxClient,
                        maxBookingsPerMonth: plan.maxBookingsPerMonth,
                        baseCharge: plan.baseCharge ?? 0,
                        pricePerStaff: plan.pricePerStaff ?? 0,
                        pricePerClient: plan.pricePerClient ?? 0,
                        pricePerBooking: plan.pricePerBooking ?? 0,
                        subscriptionPlanId: subscriptionPlan.id,
                    },
                });
            } catch (err) {
                console.error(
                    `  ❌ Failed to upsert Plan: ${sub.name} (${plan.interval})`,
                    err,
                );
            }
        }
    }

    console.log("🎉 Subscription plans seeded successfully!");
}
