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
  status?: string;
  isPublished?: boolean;
  adminReply?: string;
}
