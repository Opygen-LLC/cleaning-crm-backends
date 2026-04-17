import authService from "./auth.service";
import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { tokenUtils } from "../../lib/utils/token";

const register = catchAsync(async (req, res) => {
    const result = await authService.register(req.body);

    sendResponse(res, {
        httpStatusCode: httpStatus.CREATED,
        success: true,
        message: "User Created Successful",
        data: result,
    });
});

const login = catchAsync(async (req, res) => {
    const result = await authService.login(req.body);

    const { accessToken, refreshToken, token, ...rest } = result;

    tokenUtils.setAccessTokenCookie(res, accessToken);
    tokenUtils.setRefreshTokenCookie(res, refreshToken);
    tokenUtils.setBetterAuthSessionCookie(res, token);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User Login Successful",
        data: result,
    });
});

// const verifyEmail = async (req: Request, res: Response) => {
//     try {
//         const { email, code } = req.body;
//         await authService.verifyEmail(email, Number(code));
//         res.status(httpStatus.OK).json(
//             response({
//                 message: "Verification Successful",
//                 status: "OK",
//                 statusCode: httpStatus.OK,
//             }),
//         );
//     } catch (error) {
//         const handledError = handleError(error); // Handle the error using the utility
//         res.status(500).json({ error: handledError.message });
//     }
// };

// const forgotPassword = async (req: Request, res: Response) => {
//     try {
//         const user = await authService.forgotPassword(req.body.email);
//         res.status(httpStatus.OK).json(
//             response({
//                 message: "Verification Sended Successful",
//                 status: "OK",
//                 statusCode: httpStatus.OK,
//                 data: user,
//             }),
//         );
//     } catch (error) {
//         const handledError = handleError(error); // Handle the error using the utility
//         res.status(500).json({ error: handledError.message });
//     }
// };
// const resetPassword = async (req: Request, res: Response) => {
//     try {
//         const { code, newPassword, email } = req.body;
//         const user = await authService.resetPassword(email, code, newPassword);
//         res.status(httpStatus.OK).json(
//             response({
//                 message: "Password Reset Successful",
//                 status: "OK",
//                 statusCode: httpStatus.OK,
//                 data: user,
//             }),
//         );
//     } catch (error) {
//         const handledError = handleError(error); // Handle the error using the utility
//         res.status(500).json({ error: handledError.message });
//     }
// };

// const resendVerification = async (req: Request, res: Response) => {
//     try {
//         const user = await authService.resendVerificationEmail(req.body.email);
//         res.status(httpStatus.OK).json(
//             response({
//                 message: "Resend Verification Code Successful",
//                 status: "OK",
//                 statusCode: httpStatus.OK,
//                 data: user,
//             }),
//         );
//     } catch (error) {
//         const handledError = handleError(error); // Handle the error using the utility
//         res.status(500).json({ error: handledError.message });
//     }
// };

// const deleteUser = async (req: Request, res: Response) => {
//     try {
//         const user = await authService.deleteUser(req.params.userId as string);
//         res.status(httpStatus.OK).json(
//             response({
//                 message: "User Delete Successful",
//                 status: "OK",
//                 statusCode: httpStatus.OK,
//                 data: user,
//             }),
//         );
//     } catch (error) {
//         const handledError = handleError(error); // Handle the error using the utility
//         res.status(500).json({ error: handledError.message });
//     }
// };

// const logout = async (req: Request, res: Response) => {
//     try {
//         const refreshToken = req.headers.authorization?.split(" ")[1];
//         if (!refreshToken)
//             return res.status(400).json({ error: "Refresh token required" });

//         const user = await authService.logout(refreshToken);
//         res.status(httpStatus.OK).json(
//             response({
//                 message: "User Created Successful",
//                 status: "OK",
//                 statusCode: httpStatus.OK,
//                 data: user,
//             }),
//         );
//     } catch (error) {
//         const handledError = handleError(error); // Handle the error using the utility
//         res.status(500).json({ error: handledError.message });
//     }
// };

const authController = {
    register,
    // verifyEmail,
    login,
    // forgotPassword,
    // resetPassword,
    // resendVerification,
    // deleteUser,
    // logout,
};

export default authController;
