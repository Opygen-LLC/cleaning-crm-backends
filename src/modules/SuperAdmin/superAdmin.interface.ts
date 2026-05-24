export interface IActivityLogFilters {
  searchTerm?: string;
  action?: string;
  entityType?: string;
  adminId?: string;
  startDate?: string;
  endDate?: string;
}

export interface IAdminAccountFilters {
  searchTerm?: string;
  status?: string;
  subscriptionStatus?: string;
}
