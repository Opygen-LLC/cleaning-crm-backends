import { Prisma } from "../../generated/prisma/client";

export const leadListSelect = {
  id: true,
  leadRef: true,
  name: true,
  email: true,
  phone: true,
  serviceInterest: true,
  serviceCatalogId: true,
  estimatedMin: true,
  estimatedMax: true,
  stage: true,
  notes: true,
  sourceRef: true,
  sourceWebsiteId: true,
  convertedClientId: true,
  convertedAt: true,
  lastContactedAt: true,
  createdAt: true,
  convertedClient: { select: { id: true, name: true, email: true } },
  _count: { select: { activities: true } },
  admin: { select: { businessName: true } },
} satisfies Prisma.LeadSelect;

export const leadDetailSelect = {
  ...leadListSelect,
  updatedAt: true,
} satisfies Prisma.LeadSelect;

export const leadMutationSelect = {
  id: true,
  leadRef: true,
  stage: true,
  updatedAt: true,
} satisfies Prisma.LeadSelect;
