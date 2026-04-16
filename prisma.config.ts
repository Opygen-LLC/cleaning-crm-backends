import { defineConfig } from "prisma/config";
import { DATABASE_URL } from "./src/config/ENV";

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: DATABASE_URL,
  },
});
