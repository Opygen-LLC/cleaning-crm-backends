import { Request, Response } from "express";
import authService from "./auth.service";
import { handleError } from "../../lib/errorsHandle";
import httpStatus from "http-status";
import { response } from "../../lib/response";
// console log
const register = async (req: Request, res: Response) => {
  try {
    const user = await authService.register(req.body);
    res.status(httpStatus.CREATED).json(
      response({
        message: "User Created Successful",
        status: "OK",
        statusCode: httpStatus.OK,
        data: user,
      })
    );
  } catch (error) {
    const handledError = handleError(error); // Handle the error using the utility
    res.status(500).json({ error: handledError.message });
  }
};

const verifyEmail = async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body;
    await authService.verifyEmail(email, Number(code));
    res.status(httpStatus.OK).json(
      response({
        message: "Verification Successful",
        status: "OK",
        statusCode: httpStatus.OK,
      })
    );
  } catch (error) {
    const handledError = handleError(error); // Handle the error using the utility
    res.status(500).json({ error: handledError.message });
  }
};

const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const user = await authService.loginUser(email, password);
    res.status(httpStatus.OK).json(
      response({
        message: "Login User Successful",
        status: "OK",
        statusCode: httpStatus.OK,
        data: user,
      })
    );
  } catch (error) {
    const handledError = handleError(error); // Handle the error using the utility
    res.status(500).json({ error: handledError.message });
  }
};

const forgotPassword = async (req: Request, res: Response) => {
  try {
    const user = await authService.forgotPassword(req.body.email);
    res.status(httpStatus.OK).json(
      response({
        message: "Verification Sended Successful",
        status: "OK",
        statusCode: httpStatus.OK,
        data: user,
      })
    );
  } catch (error) {
    const handledError = handleError(error); // Handle the error using the utility
    res.status(500).json({ error: handledError.message });
  }
};
const resetPassword = async (req: Request, res: Response) => {
  try {
    const { code, newPassword, email } = req.body;
    const user = await authService.resetPassword(email, code, newPassword);
    res.status(httpStatus.OK).json(
      response({
        message: "Password Reset Successful",
        status: "OK",
        statusCode: httpStatus.OK,
        data: user,
      })
    );
  } catch (error) {
    const handledError = handleError(error); // Handle the error using the utility
    res.status(500).json({ error: handledError.message });
  }
};

const resendVerification = async (req: Request, res: Response) => {
  try {
    const user = await authService.resendVerificationEmail(req.body.email);
    res.status(httpStatus.OK).json(
      response({
        message: "Resend Verification Code Successful",
        status: "OK",
        statusCode: httpStatus.OK,
        data: user,
      })
    );
  } catch (error) {
    const handledError = handleError(error); // Handle the error using the utility
    res.status(500).json({ error: handledError.message });
  }
};

const deleteUser = async (req: Request, res: Response) => {
  try {
    const user = await authService.deleteUser(req.params.userId);
    res.status(httpStatus.OK).json(
      response({
        message: "User Delete Successful",
        status: "OK",
        statusCode: httpStatus.OK,
        data: user,
      })
    );
  } catch (error) {
    const handledError = handleError(error); // Handle the error using the utility
    res.status(500).json({ error: handledError.message });
  }
};

const logout = async (req: Request, res: Response) => {
  try {
    const refreshToken = req.headers.authorization?.split(" ")[1];
    if (!refreshToken)
      return res.status(400).json({ error: "Refresh token required" });

    const user = await authService.logout(refreshToken);
    res.status(httpStatus.OK).json(
      response({
        message: "User Created Successful",
        status: "OK",
        statusCode: httpStatus.OK,
        data: user,
      })
    );
  } catch (error) {
    const handledError = handleError(error); // Handle the error using the utility
    res.status(500).json({ error: handledError.message });
  }
};

const authController = {
  register,
  verifyEmail,
  login,
  forgotPassword,
  resetPassword,
  resendVerification,
  deleteUser,
  logout,
};

export default authController;
