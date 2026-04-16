import Joi from "joi";

const registerValidation = Joi.object({
  name: Joi.string().min(3).required(),
  email: Joi.string().email().required(),
  password: Joi.string()
    .min(8)
    .pattern(/[a-zA-Z]/)
    .pattern(/\d/)
    .required(),
  phoneNumber: Joi.string().min(10).required(),
  role: Joi.string().required().valid("user", "admin"),
});

const verificationValidation = Joi.object({
  code: Joi.number().required(),
  email: Joi.string().email().required(),
});

const loginValidation = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
  fcmToken: Joi.string(),
});

const forgotPasswordValidation = Joi.object({
  email: Joi.string().email().required(),
});

// Reset Password Validation Schema
const resetPasswordValidation = Joi.object({
  code: Joi.string().length(6).required(),
  email: Joi.string().email().required(),

  newPassword: Joi.string()
    .min(8)
    .pattern(/[a-zA-Z]/)
    .pattern(/\d/)
    .required(),
});

// Resend Verification Email Validation Schema
const resendVerificationValidation = Joi.object({
  email: Joi.string().email().required(),
});

const authValidator = {
  registerValidation,
  loginValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  resendVerificationValidation,
  verificationValidation,
};

export default authValidator;
