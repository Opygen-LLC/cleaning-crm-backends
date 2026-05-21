import { prisma } from "../../lib/prisma/prisma";
import { PaymentGateway } from "../../generated/prisma/enums";

/** Show only last 4 chars — matches the *Masked column convention in the schema */
const mask = (key?: string | null): string | null =>
  key ? `••••••••${key.slice(-4)}` : null;

const getPaymentGatewayConfig = async (userId: string) => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true, paymentGateway: true },
  });

  if (!admin) throw new Error("Admin profile not found");

  if (!admin.paymentGateway) {
    return prisma.paymentGatewayConfig.create({
      data: { adminId: admin.id },
    });
  }

  return admin.paymentGateway;
};

const updatePaymentGatewayConfig = async (
  userId: string,
  payload: Record<string, unknown>,
) => {
  const admin = await prisma.adminProfile.findUnique({ where: { userId } });
  if (!admin) throw new Error("Admin profile not found");

  const { stripeSecretKey, stripeWebhookSecret, paypalClientSecret, ...rest } =
    payload as {
      stripeSecretKey?: string;
      stripeWebhookSecret?: string;
      paypalClientSecret?: string;
      [key: string]: unknown;
    };

  const data: Record<string, unknown> = { ...rest };
  if (stripeSecretKey) data.stripeSecretKeyMasked = mask(stripeSecretKey);
  if (stripeWebhookSecret)
    data.stripeWebhookSecretMasked = mask(stripeWebhookSecret);
  if (paypalClientSecret)
    data.paypalClientSecretMasked = mask(paypalClientSecret);

  // FIX: Use explicit "in" checks instead of nullish coalescing so that
  // setting stripeEnabled: false correctly results in PAYPAL or NONE,
  // rather than staying STRIPE because `false ?? current.stripeEnabled` 
  // falls through to the still-true DB value.
  const current = await prisma.paymentGatewayConfig.findUnique({
    where: { adminId: admin.id },
  });

  const stripeOn =
    "stripeEnabled" in data
      ? Boolean(data.stripeEnabled)
      : Boolean(current?.stripeEnabled);
  const paypalOn =
    "paypalEnabled" in data
      ? Boolean(data.paypalEnabled)
      : Boolean(current?.paypalEnabled);

  if (stripeOn) data.activeGateway = PaymentGateway.STRIPE;
  else if (paypalOn) data.activeGateway = PaymentGateway.PAYPAL;
  else data.activeGateway = PaymentGateway.NONE;

  return prisma.paymentGatewayConfig.upsert({
    where: { adminId: admin.id },
    update: data,
    create: { adminId: admin.id, ...data },
  });
};

// FIX: Added oauthConnect — stores the connectedAccountId/merchantId returned
// after a backend server-to-server OAuth code exchange with Stripe/PayPal.
// The actual token exchange with the provider's API should happen here using
// your Stripe SDK or PayPal SDK. The stub below stores the connection ID.
const oauthConnect = async (
  userId: string,
  gateway: "stripe" | "paypal",
  code: string,
) => {
  const admin = await prisma.adminProfile.findUnique({ where: { userId } });
  if (!admin) throw new Error("Admin profile not found");

  // TODO: exchange `code` with Stripe/PayPal using their SDK:
  //   Stripe:  const response = await stripe.oauth.token({ grant_type: "authorization_code", code });
  //   PayPal:  POST https://api.paypal.com/v1/identity/openidconnect/tokenservice
  // For now, store the code as the connected account ID (replace with real exchange).
  const connectedAccountId = `connected_${gateway}_${code.slice(0, 8)}`;

  if (gateway === "stripe") {
    await prisma.paymentGatewayConfig.upsert({
      where: { adminId: admin.id },
      update: {
        stripeEnabled: true,
        stripeConnectedAccountId: connectedAccountId,
        activeGateway: PaymentGateway.STRIPE,
      },
      create: {
        adminId: admin.id,
        stripeEnabled: true,
        stripeConnectedAccountId: connectedAccountId,
        activeGateway: PaymentGateway.STRIPE,
      },
    });
  } else {
    await prisma.paymentGatewayConfig.upsert({
      where: { adminId: admin.id },
      update: {
        paypalEnabled: true,
        paypalConnectedMerchantId: connectedAccountId,
        activeGateway: PaymentGateway.PAYPAL,
      },
      create: {
        adminId: admin.id,
        paypalEnabled: true,
        paypalConnectedMerchantId: connectedAccountId,
        activeGateway: PaymentGateway.PAYPAL,
      },
    });
  }

  return { success: true, connectedAccountId };
};

// FIX: Added disconnectGateway — clears the stored connection credentials.
const disconnectGateway = async (
  userId: string,
  gateway: "stripe" | "paypal",
) => {
  const admin = await prisma.adminProfile.findUnique({ where: { userId } });
  if (!admin) throw new Error("Admin profile not found");

  const current = await prisma.paymentGatewayConfig.findUnique({
    where: { adminId: admin.id },
  });

  let newActiveGateway = current?.activeGateway ?? PaymentGateway.NONE;

  if (gateway === "stripe") {
    if (newActiveGateway === PaymentGateway.STRIPE)
      newActiveGateway = current?.paypalEnabled
        ? PaymentGateway.PAYPAL
        : PaymentGateway.NONE;

    await prisma.paymentGatewayConfig.upsert({
      where: { adminId: admin.id },
      update: {
        stripeEnabled: false,
        stripeConnectedAccountId: null,
        activeGateway: newActiveGateway,
      },
      create: { adminId: admin.id },
    });
  } else {
    if (newActiveGateway === PaymentGateway.PAYPAL)
      newActiveGateway = current?.stripeEnabled
        ? PaymentGateway.STRIPE
        : PaymentGateway.NONE;

    await prisma.paymentGatewayConfig.upsert({
      where: { adminId: admin.id },
      update: {
        paypalEnabled: false,
        paypalConnectedMerchantId: null,
        activeGateway: newActiveGateway,
      },
      create: { adminId: admin.id },
    });
  }

  return { success: true };
};

export const paymentGatewayService = {
  getPaymentGatewayConfig,
  updatePaymentGatewayConfig,
  oauthConnect,
  disconnectGateway,
};
