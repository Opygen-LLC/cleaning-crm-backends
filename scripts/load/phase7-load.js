import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const API = __ENV.API_URL || "https://api.opygen.com/api/v1";
const EMAIL = __ENV.LOAD_EMAIL;
const PASSWORD = __ENV.LOAD_PASSWORD;
const IDENTIFIER = __ENV.PUBLIC_WEBSITE_IDENTIFIER;
const MODE = __ENV.CACHE_MODE || "warm";
const failures = new Rate("phase7_failures");
const hot = new Trend("phase7_hot_ms", true);
export const options = {
  scenarios: {
    reads: { executor: "constant-vus", vus: Number(__ENV.VUS || 20), duration: __ENV.DURATION || "60s", exec: "reads" },
    public_mutations: { executor: "per-vu-iterations", vus: 1, iterations: 1, startTime: "5s", exec: "publicMutations" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    phase7_failures: ["rate<0.01"],
    phase7_hot_ms: ["p(95)<120"],
  },
};
function ok(res){ const pass=check(res,{"status < 500":r=>r.status<500,"release header":r=>Boolean(r.headers["X-Release-Sha"])}); failures.add(!pass); hot.add(res.timings.duration); return res; }
function login(){ return ok(http.post(`${API}/auth/login`,JSON.stringify({email:EMAIL,password:PASSWORD}),{headers:{"Content-Type":"application/json"},tags:{name:"/login"}})); }
export function reads(){
  login();
  const suffix = MODE === "cold" ? `?phase7=${__VU}-${__ITER}-${Date.now()}` : "";
  for (const path of ["/user/me","/admin/bootstrap?surface=onboarding","/dashboard/overview","/client","/booking","/job"]) ok(http.get(`${API}${path}${path.includes("?")?"&":"?"}phase7Mode=${MODE}`,{tags:{name:path.split("?")[0]}}));
  if (IDENTIFIER) ok(http.get(`${API}/website/public/${IDENTIFIER}${suffix}`,{tags:{name:"/website/public"}}));
  sleep(0.3);
}
export function publicMutations(){
  if (!IDENTIFIER) return;
  const key=`phase7-load-${Date.now()}`;
  const origin=__ENV.PUBLIC_WEBSITE_ORIGIN || `https://${IDENTIFIER}.cleaning.opygen.com`;
  const baseHeaders={"Content-Type":"application/json","Origin":origin,"X-Form-Started-At":String(Date.now()-1500)};
  if(__ENV.TURNSTILE_TEST_TOKEN) baseHeaders["X-Turnstile-Token"]=__ENV.TURNSTILE_TEST_TOKEN;
  const booking=http.post(`${API}/website/public/${IDENTIFIER}/booking`,JSON.stringify({serviceCatalogId:__ENV.PUBLIC_SERVICE_CATALOG_ID,date:new Date(Date.now()+86400000).toISOString().slice(0,10),timeSlot:"10:00",name:"Load Test",email:"load@example.invalid",phone:"+15555550123",address:"1 Load St"}),{headers:{...baseHeaders,"Idempotency-Key":key},tags:{name:"public booking submit"}});
  const bookingOk=check(booking,{"public booking accepted":r=>r.status>=200&&r.status<300}); failures.add(!bookingOk);
  const estimate=http.post(`${API}/website/public/${IDENTIFIER}/estimate`,JSON.stringify({serviceCatalogId:__ENV.PUBLIC_SERVICE_CATALOG_ID,bedrooms:2,bathrooms:1,addOnIds:[],postcode:"10001",name:"Load Test",email:"load@example.invalid",phone:"+15555550123"}),{headers:{...baseHeaders,"Idempotency-Key":`${key}-estimate`},tags:{name:"public estimate submit"}});
  const estimateOk=check(estimate,{"public estimate accepted":r=>r.status>=200&&r.status<300}); failures.add(!estimateOk);
}
