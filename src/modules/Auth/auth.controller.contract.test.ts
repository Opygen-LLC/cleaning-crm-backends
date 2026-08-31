import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const mocks = vi.hoisted(() => ({
    register: vi.fn(), login: vi.fn(), me: vi.fn(), session: vi.fn(), getNewToken: vi.fn(),
    verifyEmail: vi.fn(), resendOtp: vi.fn(), forgotPassword: vi.fn(),
    resetPassword: vi.fn(), changePassword: vi.fn(), logout: vi.fn(),
}));
vi.mock("./auth.service", () => ({ default: mocks }));
import authController from "./auth.controller";

type Captured = { statusCode: number; body: unknown; cookies: Array<{name:string;value:string;options:Record<string,unknown>}>; cleared: Array<{name:string;options:Record<string,unknown>}>; headers: Record<string,string> };
const makeResponse = () => {
    const captured: Captured = { statusCode: 200, body: undefined, cookies: [], cleared: [], headers: {} };
    const res = {
        locals: {},
        status(code:number){ captured.statusCode=code; return this; },
        json(body:unknown){ captured.body=body; return this; },
        cookie(name:string,value:string,options:Record<string,unknown>){ captured.cookies.push({name,value,options}); return this; },
        clearCookie(name:string,options:Record<string,unknown>){ captured.cleared.push({name,options}); return this; },
        setHeader(name:string,value:string){ captured.headers[name.toLowerCase()]=value; return this; },
        vary(name:string){ captured.headers.vary = captured.headers.vary ? `${captured.headers.vary}, ${name}` : name; return this; },
    } as unknown as Response;
    return { res, captured };
};
const call = async (handler:(req:Request,res:Response,next:NextFunction)=>unknown, req:Partial<Request>) => {
    const {res,captured}=makeResponse(); const next=vi.fn() as unknown as NextFunction;
    await handler(req as Request,res,next); expect(next).not.toHaveBeenCalled(); return captured;
};
const user={ id:"user-1", name:"Jamie Doe", email:"jamie@example.com", role:"ADMIN", status:"ACTIVE" };

beforeEach(()=>{
    vi.clearAllMocks();
    mocks.register.mockResolvedValue({ userId:"user-1", reservedSubdomain:"jamie-cleaning" });
    mocks.login.mockResolvedValue({ user, needPasswordChange:false, isOnboardingComplete:false, accessToken:"access-secret", refreshToken:"refresh-secret", sessionToken:"session-secret" });
    mocks.me.mockResolvedValue({ ...user, emailVerified:true });
    mocks.session.mockResolvedValue({
        authenticated: true,
        user: { ...user, emailVerified: true, image: null },
        onboarding: { completed: false, currentStep: "business_profile" },
        needPasswordChange: false,
        session: { expiresAt: new Date("2026-10-01T00:00:00.000Z") },
    });
    mocks.getNewToken.mockResolvedValue({ accessToken:"access-next", refreshToken:"refresh-next", sessionToken:"session-secret" });
    mocks.verifyEmail.mockResolvedValue({ user:{...user,emailVerified:true}, isOnboardingComplete:false, accessToken:"access-secret", refreshToken:"refresh-secret", token:"session-secret" });
    mocks.logout.mockResolvedValue({ success:true });
});

describe("auth HTTP/controller contract",()=>{
    it("register returns application state without credentials",async()=>{
        const r=await call(authController.register,{body:{businessName:"Jamie Cleaning",email:"jamie@example.com"}});
        expect(r.statusCode).toBe(201); expect(r.body).toMatchObject({success:true,data:{userId:"user-1"}});
        expect(JSON.stringify(r.body)).not.toMatch(/access-secret|refresh-secret|session-secret/);
    });
    it("login sets all server credential cookies and never returns tokens in JSON",async()=>{
        const r=await call(authController.login,{body:{email:"jamie@example.com",password:"correct-password"}});
        expect(r.statusCode).toBe(200);
        expect(r.body).toMatchObject({success:true,data:{sessionCreated:true}});
        expect(r.cookies.map(c=>c.name)).toEqual(["accessToken","refreshToken","better-auth.session_token"]);
        expect(JSON.stringify(r.body)).not.toMatch(/access-secret|refresh-secret|session-secret/);
    });
    it("verifyEmail establishes the cookie contract without returning routing authority",async()=>{
        const r=await call(authController.verifyEmail,{body:{email:"jamie@example.com",otp:"123456"}});
        expect(r.statusCode).toBe(200); expect(r.cookies.map(c=>c.name)).toEqual(["accessToken","refreshToken","better-auth.session_token"]);
        expect(r.body).toMatchObject({success:true,data:{verified:true}});
        expect(JSON.stringify(r.body)).not.toMatch(/access-secret|refresh-secret|session-secret/);
    });
    it("me returns current authenticated account state",async()=>{
        const r=await call(authController.me,{user:{id:"user-1",role:"ADMIN",email:"jamie@example.com"} as never});
        expect(r.statusCode).toBe(200); expect(r.body).toMatchObject({success:true,data:{id:"user-1",emailVerified:true,status:"ACTIVE"}});
    });
    it("session returns the lightweight canonical routing snapshot without exposing credentials",async()=>{
        const r=await call(authController.session,{
            user:{id:"user-1",role:"ADMIN",email:"jamie@example.com"} as never,
            cookies:{"better-auth.session_token":"session-secret"},
        } as never);
        expect(r.statusCode).toBe(200);
        expect(mocks.session).toHaveBeenCalledWith(
            expect.objectContaining({id:"user-1",role:"ADMIN"}),
            "session-secret",
        );
        expect(r.headers["cache-control"]).toBe("private, no-store");
        expect(r.headers.vary).toBe("Cookie");
        expect(r.cookies).toEqual(expect.arrayContaining([
            expect.objectContaining({name:"user_role",value:"ADMIN",options:expect.objectContaining({httpOnly:true,path:"/"})}),
        ]));
        expect(r.body).toMatchObject({
            success:true,
            data:{
                authenticated:true,
                user:{id:"user-1",emailVerified:true,status:"ACTIVE",image:null},
                onboarding:{completed:false,currentStep:"business_profile"},
                needPasswordChange:false,
                session:{expiresAt:expect.any(Date)},
            },
        });
        expect(JSON.stringify(r.body)).not.toMatch(/access-secret|refresh-secret|session-secret/);
    });
    it("refresh rotates cookies without returning routing authority",async()=>{
        const r=await call(authController.getNewToken,{cookies:{refreshToken:"refresh-secret","better-auth.session_token":"session-secret"}} as never);
        expect(r.statusCode).toBe(200); expect(r.cookies.map(c=>c.name)).toEqual(["accessToken","refreshToken","better-auth.session_token"]);
        expect(r.body).toMatchObject({success:true,data:{refreshed:true}});
        expect(JSON.stringify(r.body)).not.toMatch(/access-next|refresh-next|session-secret/);
    });
    it("logout revokes the session and clears all auth cookies",async()=>{
        const r=await call(authController.logout,{cookies:{"better-auth.session_token":"session-secret"}} as never);
        expect(mocks.logout).toHaveBeenCalledWith("session-secret"); expect(r.statusCode).toBe(200);
        expect(r.cleared.map(c=>c.name)).toEqual(expect.arrayContaining(["accessToken","refreshToken","better-auth.session_token","user_role"]));
    });
});
