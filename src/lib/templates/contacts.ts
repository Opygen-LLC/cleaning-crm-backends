export const contactPageTemplates = (
  name: string,
  phone: string,
  email: string,
  message: string
) => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Contact Message</title>
  <style>
    body {
      font-family: Arial, Helvetica, sans-serif;
      background-color: #f4f6f8;
      padding: 20px;
    }
    .container {
      max-width: 600px;
      margin: auto;
      background-color: #ffffff;
      padding: 24px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }
    h2 {
      color: #333;
      margin-bottom: 16px;
    }
    .info {
      margin-bottom: 12px;
    }
    .label {
      font-weight: bold;
      color: #555;
    }
    .message-box {
      margin-top: 16px;
      padding: 16px;
      background-color: #f9fafb;
      border-left: 4px solid #4f46e5;
      white-space: pre-line;
    }
    footer {
      margin-top: 24px;
      font-size: 12px;
      color: #888;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="info">
      <span class="label">Name:</span> ${name}
    </div>

    <div class="info">
      <span class="label">Email:</span> ${email}
    </div>

    <div class="info">
      <span class="label">Phone:</span> ${phone}
    </div>

    <div class="message-box">
      <span class="label">Message:</span><br />
     ${message}
    </div>

    <footer>
      This message was sent from your website contact form. <a href="https://faysaldev.vercel.app">@faysaldev</a>
    </footer>
  </div>
</body>
</html>
`;
};
