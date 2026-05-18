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

    //? For custom plans
    baseCharge?: number;
    pricePerStaff?: number;
    pricePerClient?: number;
    pricePerBooking?: number;
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
  {
    name: SubscriptionName.CUSTOM,
    description: "Fully flexible pricing — pay only for what you use.",
    currency: "USD",
    features: [
      "Choose your staff count",
      "Choose your client limit",
      "Choose your bookings per month",
      "$10 base charge",
      "$5 per staff member",
      "$0.10 per client (10 clients / $1)",
      "$0.10 per booking (10 bookings / $1)",
      "Priority support",
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
  // for (const sub of SUBSCRIPTION_PLANS) {
  //     try {
  //         const subscriptionPlan = await prisma.subscriptionPlan.upsert({
  //             where: { name: sub.name },
  //             update: {
  //                 description: sub.description,
  //                 currency: sub.currency,
  //                 features: sub.features,
  //             },
  //             create: {
  //                 name: sub.name,
  //                 description: sub.description,
  //                 currency: sub.currency,
  //                 features: sub.features,
  //             },
  //         });

  //         for (const plan of sub.plans) {
  // 			try {
  //                 await prisma.plan.upsert({
  //                     where: {
  //                         subscriptionPlanId_interval: {
  //                             subscriptionPlanId: subscriptionPlan.id,
  //                             interval: plan.interval,
  //                         },
  //                     },
  //                     update: {
  //                         price: plan.price,
  //                         maxStaff: plan.maxStaff,
  //                         maxClient: plan.maxClient,
  //                         maxBookingsPerMonth: plan.maxBookingsPerMonth,
  //                     },
  //                     create: {
  //                         price: plan.price,
  //                         interval: plan.interval,
  //                         maxStaff: plan.maxStaff,
  //                         maxClient: plan.maxClient,
  //                         maxBookingsPerMonth: plan.maxBookingsPerMonth,
  //                         subscriptionPlanId: subscriptionPlan.id,
  //                     },
  //                 });
  //             } catch (err) {
  //                 console.log(
  //                     `⚠️ Plan already exists or failed for ${sub.name} (${plan.interval})`,
  //                 );
  //             }
  //         }
  //     } catch (err) {
  //         console.log(`⚠️ SubscriptionPlan exists: ${sub.name}`);
  //     }
  // }

  for (const sub of SUBSCRIPTION_PLANS) {
    let subscriptionPlan;

    try {
      subscriptionPlan = await prisma.subscriptionPlan.upsert({
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

      // console.log(`✅ SubscriptionPlan upserted: ${sub.name}`);
    } catch (err) {
      console.error(`❌ Failed to upsert SubscriptionPlan: ${sub.name}`, err);
      continue; // skip inner loop if the plan itself failed
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

        // console.log(`  ✅ Plan upserted: ${sub.name} (${plan.interval})`);
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
