import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { IRequestUser } from '../types/requestUser.interface';

export const authMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Unauthorized Access Denied 😐" });
    }

    try {
        const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
        const user: IRequestUser = {
            id: decoded.userId,
            role: decoded.role,
            name: decoded.name,
            email: decoded.email,
        };
        req.user = user;

        next();
    } catch (error) {
        res.status(400).json({ error: "Invalid token" });
    }
};
