#!/usr/bin/env node
const api = (process.env.FRESH_DB_API_URL || "http://127.0.0.1:5099/api/v1").replace(/\/+$/, "");
const token = process.env.E2E_TEST_TOKEN || "";
const domain = process.env.E2E_TEST_EMAIL_DOMAIN || "e2e.invalid";
const password = process.env.E2E_TEST_PASSWORD || "Fresh!Database123";
if (token.length < 32) { console.error("E2E_TEST_TOKEN must be at least 32 characters"); process.exit(2); }
const email = `fresh-db-${Date.now()}@${domain}`;
const jar = new Map();
const ingest = (headers) => { const rows = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean); for (const row of rows) { const pair=row.split(";",1)[0]; const i=pair.indexOf("="); if(i<1) continue; const k=pair.slice(0,i),v=pair.slice(i+1); v?jar.set(k,v):jar.delete(k); } };
const cookie = () => [...jar].map(([k,v])=>`${k}=${v}`).join("; ");
const call = async (path, init={}) => { const headers=new Headers(init.headers||{}); headers.set("Accept","application/json"); if(init.body) headers.set("Content-Type","application/json"); if(jar.size) headers.set("Cookie",cookie()); const response=await fetch(`${api}${path}`,{...init,headers}); ingest(response.headers); const body=await response.json().catch(()=>null); if(!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body?.code||body?.message||""}`); return body; };
const otp = async () => { const deadline=Date.now()+15000; while(Date.now()<deadline){ const response=await fetch(`${api}/__e2e/verification-code?email=${encodeURIComponent(email)}`,{headers:{"x-e2e-token":token}}); if(response.ok) return (await response.json()).data.otp; if(response.status!==409) throw new Error(`OTP hook HTTP ${response.status}`); await new Promise(r=>setTimeout(r,250)); } throw new Error("OTP not available"); };
try {
  await call("/auth/register", { method:"POST", body:JSON.stringify({ businessName:"Fresh Database Cleaning", name:"Fresh Database", email, password }) });
  const code = await otp();
  const verified = await call("/auth/verify-email", { method:"POST", body:JSON.stringify({email,otp:code}) }); if(verified?.data?.verified!==true) throw new Error("verification contract failed");
  const session = await call("/auth/session"); if(session?.data?.authenticated!==true) throw new Error("session contract failed after verification");
  await call("/auth/logout", {method:"POST"}); jar.clear();
  const login = await call("/auth/login", {method:"POST",body:JSON.stringify({email,password})}); if(login?.data?.sessionCreated!==true) throw new Error("login contract failed");
  const refresh = await call("/auth/refresh-token", {method:"POST"}); if(refresh?.data?.refreshed!==true) throw new Error("refresh contract failed");
  await call("/auth/logout", {method:"POST"});
  console.log("Fresh database migrate/register/verify/login/refresh/logout smoke: OK");
} catch(error) { console.error(`Fresh database auth smoke FAILED: ${error instanceof Error?error.message:String(error)}`); process.exit(1); }
