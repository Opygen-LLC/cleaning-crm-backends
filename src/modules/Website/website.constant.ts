export const RESERVED_WEBSITE_SUBDOMAINS = new Set([
  "www", "admin", "api", "app", "dashboard", "support", "billing",
  "login", "register", "mail", "static", "assets", "cdn", "status",
  "help", "docs", "blog", "portal", "site", "sites", "auth",
]);

export const DEFAULT_WEBSITE_PAGES = [
  { kind: "HOME", slug: "/", title: "Home", showInNavigation: true, sortOrder: 0 },
  { kind: "SERVICES", slug: "/services", title: "Services", showInNavigation: true, sortOrder: 10 },
  { kind: "ABOUT", slug: "/about", title: "About", showInNavigation: true, sortOrder: 20 },
  { kind: "REVIEWS", slug: "/reviews", title: "Reviews", showInNavigation: true, sortOrder: 30 },
  { kind: "CONTACT", slug: "/contact", title: "Contact", showInNavigation: true, sortOrder: 40 },
  { kind: "BOOK", slug: "/book", title: "Book", showInNavigation: true, sortOrder: 50 },
  { kind: "ESTIMATE", slug: "/estimate", title: "Estimate", showInNavigation: false, sortOrder: 60 },
] as const;
