import { prisma } from "../../lib/prisma/prisma";

/** Show only last 4 chars — matches the *Masked column convention in the schema */
const mask = (key?: string | null): string | null =>
  key ? `••••••••${key.slice(-4)}` : null;

const getPaymentGatewayConfig = async (userId: string) => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true, paymentGateway: true },
  });

  if (!admin) throw new Error("Admin profile not found");

  // Auto-create with schema defaults if row doesn't exist yet
  if (!admin.paymentGateway) {
    return prisma.paymentGatewayConfig.create({
      data: { adminId: admin.id },
    });
  }

  return admin.paymentGateway; // secrets already stored masked
};

const updatePaymentGatewayConfig = async (
  userId: string,
  payload: Record<string, unknown>,
) => {
  const admin = await prisma.adminProfile.findUnique({ where: { userId } });
  if (!admin) throw new Error("Admin profile not found");

  // Destructure raw secret fields and remap to masked DB columns
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

  // Derive activeGateway from enabled flags to avoid inconsistent state
  const current = await prisma.paymentGatewayConfig.findUnique({
    where: { adminId: admin.id },
  });
  const stripeOn = data.stripeEnabled ?? current?.stripeEnabled;
  const paypalOn = data.paypalEnabled ?? current?.paypalEnabled;

  if (stripeOn) data.activeGateway = "STRIPE";
  else if (paypalOn) data.activeGateway = "PAYPAL";
  else data.activeGateway = "NONE";

  return prisma.paymentGatewayConfig.upsert({
    where: { adminId: admin.id },
    update: data,
    create: { adminId: admin.id, ...data },
  });
};

export const paymentGatewayService = {
  getPaymentGatewayConfig,
  updatePaymentGatewayConfig,
};
