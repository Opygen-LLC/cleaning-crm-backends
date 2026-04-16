import { Request } from "express";
import { ProtectedUser } from "./types";

declare interface ProtectedRequest extends Request {
  user?: ProtectedUser;
}
