import jwt, { SignOptions } from "jsonwebtoken";
import ms from "ms";

interface UserTokenPayload {
  userId: string;
  role: string;
  name: string;
  email: string;
  image: string;
  password: string;
  phoneNumber: string;
}

export const createToken = (
  userDetails: UserTokenPayload,
  secret: string,
  expiresIn: string | number
): string => {
  const options: SignOptions = { expiresIn: expiresIn as ms.StringValue };

  return jwt.sign(userDetails, secret, options);
};

// Generate Refresh Token
export const createRefreshToken = (userDetails: UserTokenPayload): string => {
  return createToken(userDetails, process.env.JWT_REFRESH_SECRET!, "30d");
};
