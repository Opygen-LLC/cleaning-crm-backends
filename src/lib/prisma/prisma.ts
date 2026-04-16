import { PrismaPg } from "@prisma/adapter-pg";
import { DATABASE_URL } from "../../config/ENV";
import { PrismaClient } from "../../generated/prisma/client";

const connectionString = DATABASE_URL;

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

export { prisma };