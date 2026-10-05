# Environment Variables Setup Guide

## Required Variables for Message Sending

To send messages via Meta WhatsApp API, you need to add these variables to your `.env` file:

### 1. PHONE_NUMBER_ID
Your Meta WhatsApp Phone Number ID (from Meta Business Manager)

**How to get it:**
1. Go to [Meta Business Manager](https://business.facebook.com/)
2. Navigate to WhatsApp → API Setup
3. Find your Phone Number ID (usually a long number like `123456789012345`)

**Add to .env:**
```env
PHONE_NUMBER_ID=123456789012345
```

### 2. PERMANENT_TOKEN
Your Meta WhatsApp Permanent Access Token

**How to get it:**
1. Go to [Meta Business Manager](https://business.facebook.com/)
2. Navigate to WhatsApp → API Setup
3. Generate a Permanent Access Token
4. Copy the token (starts with `EAAB...`)

**Add to .env:**
```env
PERMANENT_TOKEN=EAABsbCS1iHgBO7ZC...
```

## Complete .env Example

```env
# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=aisensy_db

# Server
PORT=5000
JWT_SECRET=your_jwt_secret_here
FRONTEND_URL=http://localhost:3000

# Meta WhatsApp API
PHONE_NUMBER_ID=123456789012345
PERMANENT_TOKEN=EAABsbCS1iHgBO7ZC...

# Webhook
VERIFY_TOKEN=mysecretverifytoken123
```

## After Adding Variables

1. **Save the .env file**
2. **Restart your server:**
   ```bash
   # Stop the server (Ctrl+C)
   # Then start again
   npm run dev
   ```

## Verify Setup

Test with CURL:
```bash
curl -X POST http://localhost:5000/api/messages/send \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"918600137050\",\"message\":\"Hello from CURL\",\"userId\":1}"
```

## Troubleshooting

### Error: "Missing API credentials"
- Check that both `PHONE_NUMBER_ID` and `PERMANENT_TOKEN` are in your `.env` file
- Make sure there are no extra spaces or quotes around the values
- Restart the server after adding variables

### Error: "Meta API Error"
- Verify your Phone Number ID is correct
- Check that your Access Token is valid and not expired
- Ensure your WhatsApp Business Account is approved

### Alternative Variable Names
The code also checks for these alternative names:
- `Phone_Number_ID` (with underscores)
- `phone_number_id` (lowercase)
- `ACCESS_TOKEN` (alternative name)
- `Access_Token` (with underscore)

