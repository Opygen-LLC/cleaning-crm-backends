import {
    Currency,
    SubscriptionName,
    SubscriptionPlanInterval,
} from "../../generated/prisma/enums";
import { prisma } from "../prisma/prisma";

const SUBSCRIPTION_PLANS: {
    name: SubscriptionName;
    description: string;
    currency: Currency;
    features: string[];
    plans: {
        interval: SubscriptionPlanInterval;
        price: number;
        maxStaff: number | null;
        maxClient: number | null;
        maxBookingsPerMonth: number | null;
    }[];
}[] = [
    {
        name: SubscriptionName.STARTER,
        description: "Perfect for small businesses just getting started.",
        currency: "USD",
        features: [
            "Up to 3 staff",
            "Up to 50 clients",
            "100 bookings/month",
            "Email support",
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
    {
        name: SubscriptionName.GROWTH,
        description: "For growing teams that need more power.",
        currency: "USD",
        features: [
            "Up to 10 staff",
            "Up to 200 clients",
            "500 bookings/month",
            "Priority support",
            "Analytics dashboard",
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
    {
        name: SubscriptionName.PRO,
        description: "Unlimited scale for large organizations.",
        currency: "USD",
        features: [
            "Unlimited staff",
            "Unlimited clients",
            "Unlimited bookings",
            "24/7 dedicated support",
            "Custom integrations",
            "SLA guarantee",
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
];

export async function seedSubscriptionPlans() {
    console.log("🌱 Seeding subscription plans...");

    for (const sub of SUBSCRIPTION_PLANS) {
        try {
            const subscriptionPlan = await prisma.subscriptionPlan.upsert({
                where: { name: sub.name },
                update: {
                    description: sub.description,
                    currency: sub.currency,
                    features: sub.features,
                },
                create: {
                    name: sub.name,
                    description: sub.description,
                    currency: sub.currency,
                    features: sub.features,
                },
            });

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
                        },
                        create: {
                            price: plan.price,
                            interval: plan.interval,
                            maxStaff: plan.maxStaff,
                            maxClient: plan.maxClient,
                            maxBookingsPerMonth: plan.maxBookingsPerMonth,
                            subscriptionPlanId: subscriptionPlan.id,
                        },
                    });
                } catch (err) {
                    console.log(
                        `⚠️ Plan already exists or failed for ${sub.name} (${plan.interval})`,
                    );
                }
            }
        } catch (err) {
            console.log(`⚠️ SubscriptionPlan exists: ${sub.name}`);
        }
    }

    console.log("🎉 Subscription plans seeded successfully!");
}
