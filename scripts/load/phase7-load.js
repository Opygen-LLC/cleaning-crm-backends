import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const API = (__ENV.API_URL || "").replace(/\/+$/, "").replace(/\/api\/v1$/, "") + "/api/v1";
if (!__ENV.API_URL || __ENV.PERF_STAGING_ACK !== "STAGING_ONLY") throw new Error("Set API_URL and PERF_STAGING_ACK=STAGING_ONLY; no production default is allowed");
const EMAIL = __ENV.LOAD_EMAIL;
const PASSWORD = __ENV.LOAD_PASSWORD;
const IDENTIFIER = __ENV.PUBLIC_WEBSITE_IDENTIFIER;
const MODE = __ENV.CACHE_MODE || "warm";
const ENVIRONMENT = __ENV.TEST_ENVIRONMENT || "local-tunnel";
const failures = new Rate("phase7_failures");
const hot = new Trend("phase7_remote_client_ms", true);
let authenticated = false;
if (MODE === "cold" && __ENV.COLD_RESET_CONFIRMED !== "ISOLATED_STAGING") throw new Error("Cold labels require an externally reset isolated cache; a query nonce is not a cache reset");
if (MODE === "redis-outage" && __ENV.REDIS_OUTAGE_CONFIRMED !== "ISOLATED_STAGING") throw new Error("Use a controlled isolated Redis fault injection first");
export const options = {
  scenarios: {
    reads: { executor: "constant-vus", vus: Number(__ENV.VUS || 20), duration: __ENV.DURATION || "60s", exec: "reads" },
    public_mutations: { executor: "per-vu-iterations", vus: 1, iterations: 1, startTime: "5s", exec: "publicMutations" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    phase7_failures: ["rate<0.01"],
    phase7_remote_client_ms: [`p(95)<${Number(__ENV.CLIENT_P95_MS || 3000)}`],
  },
};
function ok(res){ const pass=check(res,{"successful response":r=>r.status>=200&&r.status<300,"release header":r=>Boolean(r.headers["X-Release-Sha"])}); failures.add(!pass); hot.add(res.timings.duration); return res; }
function login(){ return http.post(`${API}/auth/login`,JSON.stringify({email:EMAIL,password:PASSWORD}),{headers:{"Content-Type":"application/json","Origin":__ENV.FRONTEND_ORIGIN,"X-CSRF-Protection":"1"},tags:{name:"/login",environment:ENVIRONMENT}}); }
export function reads(){
  if (!authenticated) { const response = login(); authenticated = response.status >= 200 && response.status < 300; if (!authenticated) return; }
  const suffix = "";
  for (const path of ["/website/status","/website/editor?surface=content","/website/studio/overview?includeMetrics=false","/admin/bootstrap?surface=onboarding","/admin/onboarding/services","/dashboard/overview","/client?page=1&limit=20"]) ok(http.get(`${API}${path}`,{tags:{name:path.split("?")[0],scenario:MODE,environment:ENVIRONMENT}}));
  if (__ENV.CANONICAL_HOST) ok(http.get(`${API}/website/public/resolve-host/${encodeURIComponent(__ENV.CANONICAL_HOST)}`,{tags:{name:"/website/public/resolve-host/:host",scenario:MODE,environment:ENVIRONMENT}}));
  if (IDENTIFIER) ok(http.get(`${API}/website/public/${IDENTIFIER}${suffix}`,{tags:{name:"/website/public",environment:ENVIRONMENT}}));
  sleep(0.3);
}
export function publicMutations(){
  if (!IDENTIFIER || __ENV.ALLOW_PUBLIC_MUTATIONS !== "STAGING_ONLY") return;
  const key=`phase7-load-${Date.now()}`;
  const websiteBaseDomain=(__ENV.WEBSITE_BASE_DOMAIN || "cleaningcrm.opygen.com").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const origin=__ENV.PUBLIC_WEBSITE_ORIGIN || `https://${IDENTIFIER}.${websiteBaseDomain}`;
  const baseHeaders={"Content-Type":"application/json","Origin":origin,"X-Form-Started-At":String(Date.now()-1500)};
  if(__ENV.TURNSTILE_TEST_TOKEN) baseHeaders["X-Turnstile-Token"]=__ENV.TURNSTILE_TEST_TOKEN;
  const booking=http.post(`${API}/website/public/${IDENTIFIER}/booking`,JSON.stringify({serviceCatalogId:__ENV.PUBLIC_SERVICE_CATALOG_ID,date:new Date(Date.now()+86400000).toISOString().slice(0,10),timeSlot:"10:00",name:"Load Test",email:"load@example.invalid",phone:"+15555550123",address:"1 Load St"}),{headers:{...baseHeaders,"Idempotency-Key":key},tags:{name:"public booking submit",environment:ENVIRONMENT}});
  const bookingOk=check(booking,{"public booking accepted":r=>r.status>=200&&r.status<300}); failures.add(!bookingOk);
  const estimate=http.post(`${API}/website/public/${IDENTIFIER}/estimate`,JSON.stringify({serviceCatalogId:__ENV.PUBLIC_SERVICE_CATALOG_ID,bedrooms:2,bathrooms:1,addOnIds:[],postcode:"10001",name:"Load Test",email:"load@example.invalid",phone:"+15555550123"}),{headers:{...baseHeaders,"Idempotency-Key":`${key}-estimate`},tags:{name:"public estimate submit",environment:ENVIRONMENT}});
  const estimateOk=check(estimate,{"public estimate accepted":r=>r.status>=200&&r.status<300}); failures.add(!estimateOk);
}
