import { NextFunction, Request, Response } from "express";
import status from "http-status";
import z from "zod";
import { TErrorResponse, TErrorSources } from "../interface/error.interface";
import AppError from "../errorHelper/AppError";
import { handleZodError } from "../errorHelper/handleZodError";
import { Prisma } from "../generated/prisma/client";
import { NODE_ENV } from "../config/ENV";
import { handlePrismaClientKnownRequestError, handlePrismaClientUnknownError, handlePrismaClientValidationError, handlerPrismaClientInitializationError, handlerPrismaClientRustPanicError } from "../errorHelper/handlePrismaError";
import logger from "../lib/logger";


export const globalErrorHandler = async (
    err: any,
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    if (NODE_ENV === "development") {
        logger.error("Error from Global Error Handler", err);
    }

    // if(req.file){
    //     await deleteFileFromCloudinary(req.file.path)
    // }

    // if(req.files && Array.isArray(req.files) && req.files.length > 0){
    //     const imageUrls = req.files.map((file) => file.path);
    //     await Promise.all(imageUrls.map(url => deleteFileFromCloudinary(url)));
    // }

    // await deleteUploadedFilesFromGlobalErrorHandler(req);

    let errorSources: TErrorSources[] = [];
    let statusCode: number = status.INTERNAL_SERVER_ERROR;
    let message: string = "Internal Server Error";
    let stack: string | undefined = undefined;

    //Zod Error Patttern
    /*
        error.issues; 
        /* [
        {
            expected: 'string',
            code: 'invalid_type',
            path: [ 'username' , 'password' ], => username password
            message: 'Invalid input: expected string'
        },
        {
            expected: 'number',
            code: 'invalid_type',
            path: [ 'xp' ],
            message: 'Invalid input: expected number'
        }
        ] 
    */
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        const simplifiedError = handlePrismaClientKnownRequestError(err);
        statusCode = simplifiedError.statusCode as number;
        message = simplifiedError.message;
        errorSources = [...simplifiedError.errorSources];
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientUnknownRequestError) {
        const simplifiedError = handlePrismaClientUnknownError(err);
        statusCode = simplifiedError.statusCode as number;
        message = simplifiedError.message;
        errorSources = [...simplifiedError.errorSources];
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientValidationError) {
        const simplifiedError = handlePrismaClientValidationError(err);
        statusCode = simplifiedError.statusCode as number;
        message = simplifiedError.message;
        errorSources = [...simplifiedError.errorSources];
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientRustPanicError) {
        const simplifiedError = handlerPrismaClientRustPanicError();
        statusCode = simplifiedError.statusCode as number;
        message = simplifiedError.message;
        errorSources = [...simplifiedError.errorSources];
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientInitializationError) {
        const simplifiedError = handlerPrismaClientInitializationError(err);
        statusCode = simplifiedError.statusCode as number;
        message = simplifiedError.message;
        errorSources = [...simplifiedError.errorSources];
        stack = err.stack;
    } else if (err instanceof z.ZodError) {
        const simplifiedError = handleZodError(err);
        statusCode = simplifiedError.statusCode as number;
        message = simplifiedError.message;
        errorSources = [...simplifiedError.errorSources];
        stack = err.stack;
    } else if (err instanceof AppError) {
        statusCode = err.statusCode;
        message = err.message;
        stack = err.stack;
        errorSources = [
            {
                path: "",
                message: err.message,
            },
        ];
    } else if (err instanceof Error) {
        statusCode = status.INTERNAL_SERVER_ERROR;
        message = err.message;
        stack = err.stack;
        errorSources = [
            {
                path: "",
                message: err.message,
            },
        ];
    }

    const errorResponse: TErrorResponse = {
        success: false,
        message: message,
        errorSources,
        error: NODE_ENV === "development" ? err : undefined,
        stack: NODE_ENV === "development" ? stack : undefined,
    };

    res.status(statusCode).json(errorResponse);
};
