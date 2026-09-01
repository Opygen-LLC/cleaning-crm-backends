import { z } from "zod";
import { dataExportSections } from "./dataExport.projections";

const sectionEnum = z.enum(dataExportSections);

export const dataExportSchema = {
  create: z.object({
    sections: z.array(sectionEnum).min(1, "Choose at least one export section").max(dataExportSections.length),
  }).strict().transform((value) => ({
    sections: [...new Set(value.sections)],
  })),
};

export type DataExportRequest = z.infer<typeof dataExportSchema.create>;
