export interface IReviewFilters {
  page?: number;
  limit?: number;
  searchTerm?: string;
  status?: string;
  rating?: number;
  staffId?: string;
  jobId?: string;
  dateFrom?: string;
  dateTo?: string;
  scope?: "COMPANY" | "SERVICE" | "JOB" | "STAFF";
  source?: "WEBSITE" | "JOB_TOKEN";
  serviceCatalogId?: string;
}

export interface ISubmitPublicReview {
  serviceRating: number;
  serviceComment?: string;
  staffReviews: {
    staffId: string;
    staffName: string;
    rating: number;
    comment?: string;
  }[];
}

export interface IUpdateReview {
  status?: "pending" | "published" | "unpublished" | "flagged";
  /** @deprecated Rolling-client compatibility; status is canonical. */
  isPublished?: boolean;
  adminReply?: string;
}

export interface ISubmitWebsiteReview {
  scope: "COMPANY" | "SERVICE";
  serviceSlug?: string;
  reviewerName: string;
  reviewerEmail: string;
  reviewerPhone?: string;
  rating: number;
  comment: string;
  companyWebsite?: string;
}

export interface IReviewLinkOptionsQuery {
  jobSearch?: string;
  jobLimit?: number;
}

export type ReviewShareLinkRequest =
  | { kind: "COMPANY" }
  | { kind: "SERVICE"; serviceCatalogId: string }
  | { kind: "JOB"; jobId: string };
