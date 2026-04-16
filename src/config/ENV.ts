import dotenv from "dotenv";
dotenv.config();
export const BACKEND_IP: string = process.env.BACKEND_IP as string;
export const PORT: number = parseInt(process.env.PORT as string, 10);
export const MONGODB_URI: string = process.env.MONGODB_URI as string;
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
