import express, { Request, Response } from "express";
import routes from "./routes/index";
import compression from "compression";
import cors from "cors";
import { globalErrorHandler } from "./middlewares/globalErrorHandler";
import cookieParser from "cookie-parser";
import { notFound } from "./middlewares/notFound";
import path from "path";
import { BETTER_AUTH_URL, FRONTEND_URL } from "./config/ENV";

//? Cron jobs
import "../src/cron/staffStatus.cron";
import "../src/cron/recurringBooking.cron";
import logRequestResponse from "./middlewares/logger.middleware";

const app = express();

app.set("view engine", "ejs");
app.set("views", path.resolve(process.cwd(), `src/lib/templates`));

// FIX: express.json() was registered twice — removed the duplicate
app.use(express.json());
app.use(express.static("./public"));
app.use(cookieParser());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

// Enable CORS for all routes
app.use(
  cors({
    origin: [
      FRONTEND_URL,
      BETTER_AUTH_URL,
      "http://localhost:3000",
      "http://localhost:5000",
      "https://cleaning-crm-clients.vercel.app",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Cookie",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
  }),
);

// Compress all responses
app.use(compression());

// Request/response logging
app.use(logRequestResponse);

app.get("/", (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Cleaning CRM API is running....",
  });
});

app.use("/api/v1", routes);

app.use(globalErrorHandler);
app.use(notFound);

export default app;
