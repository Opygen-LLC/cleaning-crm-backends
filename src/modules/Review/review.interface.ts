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
