import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { clientService } from "./client.service";
import { IQueryParams } from "../../interface/query.interface";
import { IRequestUser } from "../../types/requestUser.interface";

const createClient = catchAsync(async (req, res) => {
    const user = req.user;
    const result = await clientService.createClient(req.body, user as IRequestUser);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Client created successfully",
        data: result,
    });
});

const getClients = catchAsync(async (req, res) => {
    const query = req.query as IQueryParams;
    const result = await clientService.getClients(query, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Clients retrieved successfully",
        data: result.data,
        meta: result.meta,
    });
});

const getClientById = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await clientService.getClientById(id as string, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Client retrieved successfully",
        data: result,
    });
});

const updateClient = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await clientService.updateClient(id as string, req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Client updated successfully",
        data: result,
    });
});

const deleteClient = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await clientService.deleteClient(id as string, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Client deleted successfully",
        data: result,
    });
});


const getClientPortal = catchAsync(async (req, res) => {
    const { clientId } = req.params;
    const result = await clientService.getClientPortal(clientId as string);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Client portal data retrieved successfully",
        data: result,
    });
});

export const clientController = {
    createClient,
    getClients,
    getClientById,
    updateClient,
    deleteClient,
    getClientPortal,
};
