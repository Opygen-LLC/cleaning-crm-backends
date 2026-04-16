import { sendEmail } from "../../lib/mail.service";
import { createRefreshToken, createToken } from "./auth.token.services";
import bcrypt from "bcryptjs";

// Demo In-Memory Users
interface IUser {
  id: string;
  name: string;
  email: string;
  password: string;
  phoneNumber: string;
  image?: string;
  role?: string;
  isEmailVerified?: boolean;
  oneTimeCode?: number | null;
  isDeleted?: boolean;
  isResetPassword?: boolean;
}

const users: IUser[] = [];

// Register User
const register = async (userData: {
  name: string;
  email: string;
  password: string;
  phoneNumber: string;
}) => {
  const { email, password, phoneNumber, name } = userData;

  const existingUser = users.find(
    (user) => user.email === email || user.phoneNumber === phoneNumber,
  );

  if (existingUser) throw new Error("Email or Phone number is already taken");

  const oneTimeCode =
    Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;

  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser: IUser = {
    id: Date.now().toString(),
    name,
    email,
    password: hashedPassword,
    phoneNumber,
    oneTimeCode,
    isEmailVerified: false,
    role: "user",
  };

  users.push(newUser);

  const verificationLink = `${process.env.FRONTEND_URL}/verify-email?code=${oneTimeCode}`;
  const emailText = `Please click the following link to verify your email address: ${verificationLink}`;

  await sendEmail(newUser.email, "Verify Your Email Address", emailText);

  return newUser;
};

// Verify Email
const verifyEmail = async (email: string, code: number) => {
  const user = users.find((u) => u.email === email);

  if (!user) throw new Error("User not found");
  if (user.oneTimeCode !== code) throw new Error("Invalid verification code");

  user.isEmailVerified = true;
  user.oneTimeCode = null;

  return "Email Verification Successful";
};

// Login User
const loginUser = async (email: string, password: string) => {
  const user = users.find((u) => u.email === email);

  if (!user) throw new Error("User not found");

  if (!user.isEmailVerified) throw new Error("Email is not verified");

  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) throw new Error("Invalid credentials");

  return { user };
};

// Forgot Password
const forgotPassword = async (email: string) => {
  const user = users.find((u) => u.email === email);

  if (!user) throw new Error("User not found");

  const resetCode = Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;

  user.oneTimeCode = resetCode;

  const resetLink = `${process.env.FRONTEND_URL}/reset-password?code=${resetCode}`;
  const emailText = `Reset Password Link: ${resetLink}`;

  await sendEmail(user.email, "Reset Password", emailText);

  return { message: "Password reset email sent" };
};

// Reset Password
const resetPassword = async (
  email: string,
  code: string,
  newPassword: string,
) => {
  const user = users.find(
    (u) => u.email === email && u.oneTimeCode === Number(code),
  );

  if (!user) throw new Error("Invalid reset code");

  user.password = await bcrypt.hash(newPassword, 10);
  user.oneTimeCode = null;
  user.isResetPassword = true;

  return { message: "Password successfully reset" };
};

// Resend Verification Email
const resendVerificationEmail = async (email: string) => {
  const user = users.find((u) => u.email === email);

  if (!user) throw new Error("User not found");

  const oneTimeCode =
    Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;

  user.oneTimeCode = oneTimeCode;

  const verificationLink = `${process.env.FRONTEND_URL}/verify-email?code=${oneTimeCode}`;
  const emailText = `Verify Email: ${verificationLink}`;

  await sendEmail(user.email, "Verify Email", emailText);

  return { message: "Verification email resent" };
};

// Delete User
const deleteUser = async (userId: string) => {
  const user = users.find((u) => u.id === userId);

  if (!user) throw new Error("User not found");

  user.isDeleted = true;

  return { message: "User deleted successfully" };
};

// Logout
const logout = (refreshToken: string) => {
  return { message: "User logged out" };
};

const userService = {
  register,
  verifyEmail,
  loginUser,
  forgotPassword,
  resetPassword,
  resendVerificationEmail,
  deleteUser,
  logout,
};

export default userService;
