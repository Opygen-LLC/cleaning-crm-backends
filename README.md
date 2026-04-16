# TS Backend Kit

A TypeScript-based backend starter kit that helps you quickly set up APIs with the required features for modern backend applications. It includes essential features like user authentication, JWT tokens, and email verification.

This starter kit is structured and modular, providing a clear separation of concerns for routes, controllers, services, and validation.

## Features

- **User Registration & Login**
- **Email Verification**
- **Password Reset & Change**
- **JWT Authentication**
- **API Validation with Joi**
- **Email Sending with Nodemailer**
- **MongoDB Integration**
- **CRUD Operations for Users**

## Getting Started

Follow these steps to set up the backend project on your local machine.

### 1. Clone the repository

Clone the repository using the command below:

```
bash
git clone https://github.com/faysaldev/ts-backend-kit.git
2. Navigate to the project directory
After cloning, change your directory to the project folder:

bash
cd ts-backend-kit
3. Install dependencies
Use the following command to install the necessary dependencies:

bash
npm install
4. Set up environment variables
Create a .env file in the root of your project (if it doesn't already exist) and add the following values to it:

env
# Backend IP address and Port number
BACKEND_IP=10.10.11.69
PORT=9900

# Database URL (MongoDB)
DATABASE_URL=mongodb://localhost:27017/fms

# JWT settings
JWT_SECRET=your_secret_key
JWT_EXPIRE_TIME=30000
JWT_REFRESH_SECRET=your_refresh_secret

# Email settings (for sending verification emails)
EMAIL_USERNAME=your_email
EMAIL_PASSWORD=your_password

# Stripe integration (if needed)
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_webhook_secret_key
Ensure you replace the placeholders with your actual values:

# Redis Connection
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

BACKEND_IP and PORT: Define the backend server's IP address and port number

DATABASE_URL: MongoDB connection string

JWT_SECRET: Secret key for signing JWT tokens

JWT_EXPIRE_TIME: The expiration time for JWT tokens (in seconds)

JWT_REFRESH_SECRET: Secret key for refresh tokens

EMAIL_USERNAME & EMAIL_PASSWORD: Your credentials for sending emails via Nodemailer (You can use Gmail or other email services. Make sure to allow less secure apps if using Gmail)

STRIPE_SECRET_KEY & STRIPE_WEBHOOK_SECRET: If you're integrating Stripe for payments, you'll need these keys

5. Run the application
Once you've set up the .env file, you can run the project using the following command:

bash
npm run dev
```
