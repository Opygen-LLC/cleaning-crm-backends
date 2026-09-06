import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { WebsitePublicationDeliveryService } from "./websitePublicationDelivery.service";

// Compatibility entrypoint; readiness has one implementation and one contract.
export const WebsiteStatusService = {
  getForUser: async (user: IRequestUser) => {
    const status = await WebsitePublicationDeliveryService.getStatus(await getAdminId(user));
    return status ? { ...status, userId: user.id } : null;
  },
};
