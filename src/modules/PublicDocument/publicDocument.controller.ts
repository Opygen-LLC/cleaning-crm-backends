import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { PublicDocumentLinkService } from "../Website/publicDocumentLink.service";

const resolveForWebsite = catchAsync(async (req, res) => {
  const resourceType = await PublicDocumentLinkService.resolveResourceTypeForWebsite(
    req.params.token as string,
    req.params.websiteId as string,
  );

  res.set("Cache-Control", "private, no-store, max-age=0");
  res.set("Pragma", "no-cache");

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Public document resolved successfully",
    data: { resourceType },
  });
});

export const publicDocumentController = { resolveForWebsite };
