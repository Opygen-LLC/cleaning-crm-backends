import fs from "node:fs";
const [currentFile, baselineFile] = process.argv.slice(2);
if (!currentFile) throw new Error("usage: node evaluateReleaseGate.mjs <current.json> [baseline.json]");
const read = (file) => file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,"utf8")).map(r=>r.jsonPayload||{}).filter(Boolean) : [];
const summarize = (payloads) => {
  const http = payloads.filter(p=>p.event==="http_request" && Number.isFinite(Number(p.totalDurationMs)));
  const values=http.map(p=>Number(p.totalDurationMs)).sort((a,b)=>a-b);
  const p95=values.length ? values[Math.min(values.length-1,Math.ceil(values.length*0.95)-1)] : 0;
  const rate=(fn)=>http.length ? http.filter(fn).length/http.length : 0;
  const starts=payloads.filter(p=>p.event==="onboarding_started").length;
  const completes=payloads.filter(p=>p.event==="onboarding_completed").length;
  return { http, p95, error5xx:rate(p=>Number(p.statusCode)>=500), redisErrors:http.reduce((n,p)=>n+Number(p.redisErrors||0),0), clientErrors:payloads.filter(p=>p.code==="DASHBOARD_CLIENT_ERROR"||p.event==="dashboard_client_error").length, starts, completes, completionRate:starts>=Number(process.env.MIN_ONBOARDING_SAMPLES||10)?completes/starts:null };
};
const cur=summarize(read(currentFile));
const base=summarize(read(baselineFile));
const min=Number(process.env.MIN_RELEASE_REQUESTS||50);
if(cur.http.length<min) throw new Error(`insufficient canary samples: ${cur.http.length}/${min}`);
const failures=[];
if(cur.p95>Number(process.env.MAX_P95_MS||120)) failures.push(`p95 ${cur.p95}ms`);
if(cur.error5xx>Number(process.env.MAX_5XX_RATE||0.01)) failures.push(`5xx ${(cur.error5xx*100).toFixed(2)}%`);
if(cur.redisErrors>Number(process.env.MAX_REDIS_ERRORS||0)) failures.push(`redis errors ${cur.redisErrors}`);
if(cur.clientErrors>Number(process.env.MAX_CLIENT_ERRORS||5)) failures.push(`client errors ${cur.clientErrors}`);
if(cur.completionRate!==null && cur.completionRate<Number(process.env.MIN_ONBOARDING_COMPLETION_RATE||0.85)) failures.push(`onboarding completion ${(cur.completionRate*100).toFixed(1)}%`);
if(base.http.length>=min){
  if(cur.p95>base.p95*(1+Number(process.env.MAX_P95_REGRESSION_RATIO||0.25))) failures.push(`p95 regression ${base.p95}->${cur.p95}ms`);
  if(cur.error5xx>base.error5xx+Number(process.env.MAX_5XX_REGRESSION_ABS||0.005)) failures.push(`5xx regression ${(base.error5xx*100).toFixed(2)}%->${(cur.error5xx*100).toFixed(2)}%`);
  const curClientRate=cur.clientErrors/cur.http.length, baseClientRate=base.clientErrors/base.http.length;
  if(curClientRate>baseClientRate+Number(process.env.MAX_CLIENT_ERROR_REGRESSION_ABS||0.005)) failures.push("frontend exception regression");
  if(cur.completionRate!==null && base.completionRate!==null && cur.completionRate<base.completionRate-Number(process.env.MAX_ONBOARDING_REGRESSION_ABS||0.10)) failures.push(`onboarding regression ${(base.completionRate*100).toFixed(1)}%->${(cur.completionRate*100).toFixed(1)}%`);
}
console.log(JSON.stringify({current:{requests:cur.http.length,p95:cur.p95,error5xx:cur.error5xx,redisErrors:cur.redisErrors,clientErrors:cur.clientErrors,completionRate:cur.completionRate},baseline:{requests:base.http.length,p95:base.p95,error5xx:base.error5xx,clientErrors:base.clientErrors,completionRate:base.completionRate},failures},null,2));
if(failures.length) process.exit(42);
