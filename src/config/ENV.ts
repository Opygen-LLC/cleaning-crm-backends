import dotenv from "dotenv";
dotenv.config();

export const NODE_ENV: string = process.env.NODE_ENV as string;
export const BACKEND_IP: string = process.env.BACKEND_IP as string;
export const PORT: number = parseInt(process.env.PORT as string, 10);
export const DATABASE_URL: string = process.env.DATABASE_URL as string;
export const JWT_SECRET: string = process.env.JWT_SECRET as string;
export const CLOUDINARY_CLOUD_NAME: string = process.env
    .CLOUDINARY_CLOUD_NAME as string;
export const CLOUDINARY_API_KEY: string = process.env
    .CLOUDINARY_API_KEY as string;
export const CLOUDINARY_API_SECRET: string = process.env
    .CLOUDINARY_API_SECRET as string;
export const STRIPE_SECRET_KEY: string = process.env
    .STRIPE_SECRET_KEY as string;
export const FRONT_END_URL: string = process.env.FRONT_END_URL as string;
export const BETTER_AUTH_SECRET: string = process.env
    .BETTER_AUTH_SECRET as string;
export const BETTER_AUTH_URL: string = process.env.BETTER_AUTH_URL as string;
export const APP_URL: string = process.env.APP_URL as string;
export const FRONTEND_URL: string = process.env.FRONTEND_URL as string;

export const ACCESS_TOKEN_SECRET: string = process.env.ACCESS_TOKEN_SECRET as string;
export const REFRESH_TOKEN_SECRET: string = process.env.REFRESH_TOKEN_SECRET as string;
export const ACCESS_TOKEN_EXPIRES_IN: string = process.env.ACCESS_TOKEN_EXPIRES_IN as string;
export const REFRESH_TOKEN_EXPIRES_IN: string = process.env.REFRESH_TOKEN_EXPIRES_IN as string;
