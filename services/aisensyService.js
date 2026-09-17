const axios = require('axios');

// Check if WhatsApp API key is configured and connected
exports.checkApiKeyConnection = async () => {
  try {
    const apiKey = process.env.WHATSAPP_API_KEY || process.env.whatsapp_api_key;
    const campaignName = process.env.WHATSAPP_CAMPAIGN_NAME || process.env.whatsapp_campaign_name;
    
    // Check if API key exists
    if (!apiKey) {
      return {
        connected: false,
        error: 'WHATSAPP_API_KEY is not set in environment variables',
        message: 'Please add WHATSAPP_API_KEY to your .env file'
      };
    }

    // Check if campaign name exists
    if (!campaignName || campaignName.trim() === '') {
      return {
        connected: false,
        error: 'WHATSAPP_CAMPAIGN_NAME is not set in environment variables',
        message: 'Please add WHATSAPP_CAMPAIGN_NAME to your .env file. Create a LIVE campaign in your AiSensy dashboard first.',
        apiKeyPresent: true,
        apiKeyLength: apiKey.length
      };
    }

    // Test API connection with a simple request
    // Using a test endpoint or validation endpoint if available
    // For now, we'll just verify the key is present and format is correct
    const keyLength = apiKey.length;
    const isValidFormat = keyLength > 10; // Basic validation

    if (!isValidFormat) {
      return {
        connected: false,
        error: 'WHATSAPP_API_KEY format appears invalid',
        message: 'API key seems too short. Please verify your API key.'
      };
    }

    // Try to make a test request to verify connectivity
    // Note: Adjust the endpoint based on your AiSensy API documentation
    try {
      const testResponse = await axios.get(
        'https://backend.aisensy.com/api/health',
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000 // 5 second timeout
        }
      );

      return {
        connected: true,
        message: 'WhatsApp API key is connected successfully',
        status: testResponse.status,
        apiKeyPresent: true,
        apiKeyLength: keyLength,
        campaignNamePresent: !!campaignName,
        campaignName: campaignName || 'Not set'
      };
    } catch (testError) {
      // If health endpoint doesn't exist, try a different approach
      // Just verify we can reach the API server
      if (testError.code === 'ENOTFOUND' || testError.code === 'ECONNREFUSED') {
        return {
          connected: false,
          error: 'Cannot reach WhatsApp API server',
          message: 'Network connectivity issue. Please check your internet connection.',
          apiKeyPresent: true,
          apiKeyLength: keyLength,
          campaignNamePresent: !!campaignName,
          campaignName: campaignName || 'Not set'
        };
      }

      // If we get 401/403, key is present but invalid
      if (testError.response && (testError.response.status === 401 || testError.response.status === 403)) {
        return {
          connected: false,
          error: 'WhatsApp API key is invalid or unauthorized',
          message: 'The API key is present but not valid. Please check your API key.',
          apiKeyPresent: true,
          apiKeyLength: keyLength,
          campaignNamePresent: !!campaignName,
          campaignName: campaignName || 'Not set'
        };
      }

      // Other errors - key might be valid but endpoint doesn't exist
      return {
        connected: true, // Assume connected if key is present and server is reachable
        message: 'WhatsApp API key is configured',
        warning: 'Could not verify with health endpoint, but API key is present',
        apiKeyPresent: true,
        apiKeyLength: keyLength,
        campaignNamePresent: !!campaignName,
        campaignName: campaignName || 'Not set'
      };
    }
  } catch (error) {
    return {
      connected: false,
      error: error.message || 'Unknown error checking API key',
      message: 'Failed to check API key connection'
    };
  }
};

// Send message - supports text, media, and template
exports.sendMessage = async ({ phone, text, type, template, campaignName, mediaUrl, mediaType }) => {
  const apiKey = process.env.WHATSAPP_API_KEY;
  
  if (!apiKey) {
    throw new Error('WHATSAPP_API_KEY is not configured. Please add it to your .env file.');
  }

  // Get campaign name from parameter or environment variable
  const campaign = campaignName || 
                   process.env.WHATSAPP_CAMPAIGN_NAME || 
                   process.env.whatsapp_campaign_name || 
                   null;
  
  if (!campaign || campaign.trim() === '') {
    throw new Error('Campaign name is required. Please set WHATSAPP_CAMPAIGN_NAME in .env file or pass campaignName parameter. Create a LIVE campaign in your AiSensy dashboard first.');
  }

  // Normalize phone number - ensure it has + prefix (required by AiSensy)
  let normalizedPhone = phone.toString().trim();
  if (!normalizedPhone.startsWith('+')) {
    // If phone doesn't start with +, add it (assuming country code is included)
    normalizedPhone = '+' + normalizedPhone;
  }
  console.log('📞 Phone normalized:', phone, '→', normalizedPhone);

  // Determine message type
  const messageType = type || (mediaUrl ? 'media' : (text ? 'text' : 'template'));

  // Build payload based on message type
  let payload;

  // Build payload - campaign endpoint requires specific fields
  if (messageType === 'template') {
    // For template messages: campaign endpoint might need flattened structure
    // Extract media URL from components if present (for campaign endpoint requirement)
    let mediaUrl = null;
    if (template.components && Array.isArray(template.components)) {
      const headerComponent = template.components.find(comp => comp.type === 'header');
      if (headerComponent && headerComponent.parameters) {
        const imageParam = headerComponent.parameters.find(param => param.type === 'image' && param.image?.link);
        if (imageParam && imageParam.image?.link) {
          mediaUrl = imageParam.image.link;
          console.log('Extracted media URL from template components:', mediaUrl);
        }
      }
    }
    
    // Debug: Log template structure
    console.log('Template structure:', JSON.stringify(template, null, 2));
    
    // Campaign endpoint requires: apiKey, campaignName, destination, userName, source
    payload = {
      apiKey: apiKey,
      campaignName: campaign,
      destination: normalizedPhone, // ✅ Use normalized phone with +
      userName: 'User', // Required field - must be a string
      source: 'WhatsApp', // Required field
      template: template // ✅ Pass FULL template object as-is (includes components with image)
    };
    
    // Campaign endpoint REQUIRES media field when template has image header
    // Extract and add media field from template components
    if (mediaUrl) {
      payload.media = {
        url: mediaUrl,
        filename: 'image.jpg'
      };
    } else {
      // If no media URL found but template has components, try to extract from any location
      // This handles edge cases where the structure might be slightly different
      console.warn('No media URL found in template components, but template has components');
    }
    
    // Add templateParams if provided in template
    if (template.params || template.parameters) {
      payload.templateParams = template.params || template.parameters;
    }
    
    // Add tags and attributes if needed (optional)
    payload.tags = [];
    payload.attributes = {};
  } else if (messageType === 'media' && mediaUrl) {
    // For media messages - AiSensy v2 API requires mediaUrl
    payload = {
      apiKey: apiKey,
      campaignName: campaign,
      destination: normalizedPhone, // ✅ Use normalized phone with +
      userName: 'User', // Required field - must be a string
      source: 'WhatsApp', // Required field
      mediaUrl: mediaUrl, // ✅ Media URL is required for media messages
      mediaType: mediaType || 'image', // image, video, document, audio
      message: text || '', // Optional caption for media
      tags: [],
      attributes: {}
    };
    console.log('📷 Sending media message with URL:', mediaUrl);
  } else {
    // For text messages - AiSensy v2 API expects 'message' field, NOT 'text.body'
    // IMPORTANT: Do NOT include 'media' or 'mediaUrl' fields for text messages
    // If campaign is configured for media, it will fail - need text-only campaign
    payload = {
      apiKey: apiKey,
      campaignName: campaign,
      destination: normalizedPhone, // ✅ Use normalized phone with +
      userName: 'User', // Required field - must be a string
      source: 'WhatsApp', // Required field
      message: text, // ✅ AiSensy v2 API requires 'message' field for text messages
      // ✅ DO NOT include 'media' or 'mediaUrl' for text messages
      tags: [],
      attributes: {}
    };
    console.log('💬 Sending text-only message (no media):', text.substring(0, 50));
    console.log('⚠️  Note: Campaign must be configured for TEXT messages, not media');
    console.log('⚠️  If you get "Media URL Missing" error, your campaign is configured for media - use a text-only campaign');
  }

  // Debug: Log the payload being sent (hide API key)
  const debugPayload = { ...payload };
  if (debugPayload.apiKey) {
    debugPayload.apiKey = '***HIDDEN***';
  }
  console.log('📤 SENDING TO AISENSY:', JSON.stringify(debugPayload, null, 2));
  console.log('   Campaign:', campaign);
  console.log('   Destination:', phone);
  console.log('   Message Type:', messageType);

  try {
    // Campaign endpoint uses apiKey in payload, not Bearer token
    const response = await axios.post(
      'https://backend.aisensy.com/campaign/t1/api/v2',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  } catch (error) {
    // Log detailed error for debugging
    const errorData = error.response?.data || {};
    const errorMsg =
      errorData.errorMessage ||
      errorData.message ||
      errorData.error ||
      error.message ||
      'Unknown error';
    
    console.error('AiSensy API Error Details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: errorData,
      message: errorMsg,
      url: 'https://backend.aisensy.com/campaign/t1/api/v2',
      requestPayload: debugPayload
    });
    
    // Special handling for "Media URL Missing" error with text messages
    if (errorMsg.includes('Media URL Missing') && messageType === 'text' && text) {
      const helpfulError = `Campaign "${campaign}" is configured for MEDIA messages, but you're sending TEXT. ` +
                          `Solution: Create a text-only campaign in AiSensy dashboard or configure the campaign to accept text messages. ` +
                          `Current campaign requires media URL for all messages.`;
      console.error('⚠️  CAMPAIGN CONFIGURATION ISSUE:', helpfulError);
      throw new Error(helpfulError);
    }
    
    // Pass through the original error from AiSensy with more details
    throw new Error(errorMsg);
  }
};

// Keep backward compatibility - alias for sendMessage
exports.sendTextMessage = exports.sendMessage;
