import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
vi.mock("../../config/ENV",()=>({ ACCESS_TOKEN_EXPIRES_IN:"15m", ACCESS_TOKEN_SECRET:"test-access-secret", REFRESH_TOKEN_EXPIRES_IN:"30d", REFRESH_TOKEN_SECRET:"test-refresh-secret", COOKIE_DOMAIN:".opygen.com", NODE_ENV:"production" }));
import { tokenUtils } from "../../lib/utils/token";
const capture=()=>{ const rows:Array<{name:string;value:string;options:Record<string,unknown>}>=[]; const res={cookie(name:string,value:string,options:Record<string,unknown>){rows.push({name,value,options});return this;}} as unknown as Response; return {res,rows}; };
describe("production auth cookie contract",()=>{
    it("accessToken is Secure HttpOnly host-only root scoped",()=>{const {res,rows}=capture(); tokenUtils.setAccessTokenCookie(res,"x"); expect(rows[0]).toEqual(expect.objectContaining({name:"accessToken",options:expect.objectContaining({httpOnly:true,secure:true,sameSite:"lax",path:"/"})})); expect(rows[0].options.domain).toBeUndefined();});
    it("refreshToken is Secure HttpOnly host-only root scoped for the BFF",()=>{const {res,rows}=capture(); tokenUtils.setRefreshTokenCookie(res,"x"); expect(rows[0]).toEqual(expect.objectContaining({name:"refreshToken",options:expect.objectContaining({httpOnly:true,secure:true,sameSite:"lax",path:"/"})})); expect(rows[0].options.domain).toBeUndefined();});
    it("Better Auth session is Secure HttpOnly host-only",()=>{const {res,rows}=capture(); tokenUtils.setBetterAuthSessionCookie(res,"x"); expect(rows[0]).toEqual(expect.objectContaining({name:"better-auth.session_token",options:expect.objectContaining({httpOnly:true,secure:true,sameSite:"lax",path:"/"})})); expect(rows[0].options.domain).toBeUndefined();});
    it("role routing hint is Secure HttpOnly host-only and non-shared",()=>{const {res,rows}=capture(); tokenUtils.setRoleHintCookie(res,"ADMIN"); expect(rows[0]).toEqual(expect.objectContaining({name:"user_role",value:"ADMIN",options:expect.objectContaining({httpOnly:true,secure:true,sameSite:"lax",path:"/"})})); expect(rows[0].options.domain).toBeUndefined();});
});
