import Stripe from "stripe";
import { FRONT_END_URL, STRIPE_SECRET_KEY } from "../../config/ENV";
// import { ObjectId } from "mongoose";

const stripe = new Stripe(STRIPE_SECRET_KEY);

interface PaymentData {
  amount: number; // Amount in cents (smallest currency unit)
  name: string;
  author_id: string;
  booking_id: string;
}

/**
 * Creates a Stripe payment link for property booking
 * @param paymentData - Object containing amount, name, author_id, booking_id, and optional URLs
 * @returns Payment link URL
 */
const createStripePaymentLink = async (paymentData: PaymentData) => {
  try {
    const { amount, name, author_id, booking_id } = paymentData;
    const successUrl = `${FRONT_END_URL}/bookings/success`;
    const cancelUrl = `${FRONT_END_URL}/bookings/cancel`;
    // Create a Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd", // You can make this configurable if needed
            product_data: {
              name: name,
              metadata: {
                author_id: author_id.toString(),
                booking_id: booking_id.toString(),
              },
            },
            unit_amount: amount * 100, // Amount in cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${cancelUrl}?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        author_id: author_id.toString(),
        booking_id: booking_id.toString(),
      },
    });

    return session.url!;
  } catch (error) {
    throw new Error(
      `Failed to create payment link: ${(error as Error).message}`,
    );
  }
};

/**
 * Checks the status of a Stripe payment session
 * @param sessionId - The ID of the Stripe checkout session to check
 * @returns Payment status and metadata
 */
const checkPaymentStatusHelper = async (sessionId: string) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    return {
      status: session.payment_status,
      metadata: session.metadata,
      sessionData: {
        id: session.id,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_email: session.customer_details?.email,
        payment_intent: session.payment_intent,
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to check payment status: ${(error as Error).message}`,
    );
  }
};

export { createStripePaymentLink, checkPaymentStatusHelper };
