import express, { Request, Response } from "express";
import routes from "./routes/index";
// TODO: for development parpuse
import logRequestResponse from "./middlewares/logger.middleware";
import compression from "compression";
import cors from "cors";
import { BETTER_AUTH_URL, FRONTEND_URL } from "./config/ENV";
import { globalErrorHandler } from "./middlewares/globalErrorHandler";
import cookieParser from "cookie-parser";
import { notFound } from "./middlewares/notFound";
import path from "path";

const app = express();

app.set("view engine", "ejs");
app.set("views", path.resolve(process.cwd(), `src/lib/templates`));

app.use(express.json());
app.use(express.static("./public"));
app.use(cookieParser());
app.use(express.json());
// Enable CORS for all routes
app.use(
    cors({
        origin: [
            FRONTEND_URL,
            BETTER_AUTH_URL,
            "http://localhost:3000",
            "http://localhost:5000",
        ],
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        // allowedHeaders: ["Content-Type", "Authorization"],
        allowedHeaders: ["*"], //? 🔥 allow all headers
    }),
);

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

// compression the all data
app.use(compression());

// Use the logging middleware for all routes
// app.use(logRequestResponse);
// Use the centralized routes
app.get("/", (req: Request, res: Response) => {
    res.status(200).json({
        success: true,
        message: "Cleaning CRM API is running....",
    });
});
app.use("/api/v1", routes); // This mounts all the routes under the /api prefix (e.g., /api/user)fgh

app.use(globalErrorHandler);
app.use(notFound);

export default app;
