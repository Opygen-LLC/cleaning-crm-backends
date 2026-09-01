import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { dataExportService } from "./dataExport.service";

const createDataExport = catchAsync(async (req, res) => {
  const result = await dataExportService.createDataExport(req.body, req.user);
  res.status(status.OK);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(result.buffer);
});

export const dataExportController = { createDataExport };
