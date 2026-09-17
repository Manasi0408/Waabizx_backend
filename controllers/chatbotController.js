const { User, Campaign, Contact, InboxMessage } = require('../models');
const { Op } = require('sequelize');

// Simple chatbot response logic
const getChatbotResponse = async (message, userId, flowState = null) => {
  const lowerMessage = message.toLowerCase().trim();

  // Handle flow-specific messages
  if (message === '__START_BOT__') {
    return {
      message: "Welcome! 👋 Are you interested in learning more about our services?",
      buttons: [
        { id: 1, text: 'YES', value: 'yes' },
        { id: 2, text: 'NO', value: 'no' }
      ],
      flowState: 'template_sent'
    };
  }

  if (message === '__YES_CLICKED__') {
    return {
      message: "Great! To help you better, could you please tell me your current salary? (Please enter numbers only, e.g., 50000)",
      flowState: 'asking_salary'
    };
  }

  if (message.startsWith('__SALARY_INPUT__:')) {
    const salaryInput = message.replace('__SALARY_INPUT__:', '').trim();
    // Validate salary - should be numeric and reasonable
    const salary = parseFloat(salaryInput);
    const isValid = !isNaN(salary) && salary > 0 && salary <= 10000000; // Max 10 million
    
    if (!isValid) {
      return {
        message: "Please enter a valid salary amount. It should be a positive number (e.g., 50000).",
        isValid: false,
        flowState: 'salary_retry'
      };
    }

    // Valid salary - continue flow
    return {
      message: `Thank you! I've recorded your salary as ₹${salary.toLocaleString('en-IN')}. Is there anything else I can help you with today?`,
      isValid: true,
      flowState: 'completed',
      suggestions: ["View Dashboard", "Create Campaign", "View Analytics"]
    };
  }

  // Greetings
  if (lowerMessage.match(/^(hi|hello|hey|greetings|good morning|good afternoon|good evening)/)) {
    return {
      message: "Hello! 👋 Welcome to AiSensy. I'm here to help you with your WhatsApp marketing needs. How can I assist you today?",
      suggestions: ["How to create a campaign?", "How to send messages?", "View my statistics"]
    };
  }

  // Help/Support
  if (lowerMessage.match(/^(help|support|assist|guide|how can you help)/)) {
    return {
      message: "I can help you with:\n\n✅ Creating and managing campaigns\n✅ Sending WhatsApp messages\n✅ Managing contacts\n✅ Viewing analytics and statistics\n✅ Template management\n✅ Broadcast messages\n\nWhat would you like to know more about?",
      suggestions: ["Create campaign", "Send message", "View analytics"]
    };
  }

  // Campaign related
  if (lowerMessage.match(/campaign|create campaign|new campaign|how to create/)) {
    try {
      const totalCampaigns = await Campaign.count({ where: { userId } });
      return {
        message: `To create a campaign:\n\n1. Go to the "Campaigns" page\n2. Click "Create Campaign" button\n3. Fill in campaign details (name, template, audience)\n4. Click "Start Campaign"\n\nYou currently have ${totalCampaigns} campaign(s). Would you like to create a new one?`,
        suggestions: ["Go to Campaigns", "View my campaigns"]
      };
    } catch (error) {
      return {
        message: "To create a campaign, go to the Campaigns page and click the 'Create Campaign' button. Fill in the details and start your campaign!",
        suggestions: []
      };
    }
  }

  // Messages/Sending
  if (lowerMessage.match(/send message|how to send|send whatsapp|message sending/)) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const messagesToday = await InboxMessage.count({
        where: {
          userId,
          direction: 'outgoing',
          timestamp: { [Op.gte]: today }
        }
      });
      return {
        message: `You can send messages in two ways:\n\n1. **Inbox**: Go to Inbox page, select a contact, and send messages\n2. **Campaigns**: Create a campaign to send bulk messages\n\nYou've sent ${messagesToday} message(s) today! 📱`,
        suggestions: ["Go to Inbox", "Create Campaign"]
      };
    } catch (error) {
      return {
        message: "You can send messages through the Inbox page (for individual messages) or create a Campaign (for bulk messages).",
        suggestions: []
      };
    }
  }

  // Contacts
  if (lowerMessage.match(/contact|contacts|add contact|manage contact/)) {
    try {
      const totalContacts = await Contact.count({ where: { userId } });
      return {
        message: `To manage contacts:\n\n1. Go to the "Contacts" page\n2. Add new contacts manually or import via CSV\n3. Organize contacts with tags and segments\n\nYou currently have ${totalContacts} contact(s) in your database.`,
        suggestions: ["Go to Contacts", "Add new contact"]
      };
    } catch (error) {
      return {
        message: "Go to the Contacts page to add, edit, or manage your contacts. You can also import contacts via CSV file.",
        suggestions: []
      };
    }
  }

  // Analytics/Statistics
  if (lowerMessage.match(/analytics|statistics|stats|performance|report|dashboard/)) {
    try {
      const totalCampaigns = await Campaign.count({ where: { userId } });
      const totalContacts = await Contact.count({ where: { userId } });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const messagesToday = await InboxMessage.count({
        where: {
          userId,
          direction: 'outgoing',
          timestamp: { [Op.gte]: today }
        }
      });
      return {
        message: `Here's your quick overview:\n\n📊 Campaigns: ${totalCampaigns}\n👥 Contacts: ${totalContacts}\n📱 Messages Today: ${messagesToday}\n\nVisit the Analytics or Dashboard page for detailed insights!`,
        suggestions: ["View Dashboard", "View Analytics"]
      };
    } catch (error) {
      return {
        message: "Visit the Dashboard or Analytics page to view detailed statistics about your campaigns, messages, and contacts.",
        suggestions: []
      };
    }
  }

  // Templates
  if (lowerMessage.match(/template|templates|create template|message template/)) {
    return {
      message: "Templates are pre-approved WhatsApp message formats. To create a template:\n\n1. Go to the 'Templates' page\n2. Click 'Create Template'\n3. Fill in template details (name, category, content)\n4. Submit for Meta approval\n\nOnce approved, you can use templates to start conversations with new contacts!",
      suggestions: ["Go to Templates", "Create Template"]
    };
  }

  // Broadcast
  if (lowerMessage.match(/broadcast|bulk message|send to many/)) {
    return {
      message: "Broadcast allows you to send messages to multiple contacts at once:\n\n1. Go to the 'Broadcast' page\n2. Select your audience (CSV, contact list, or manual)\n3. Choose a template\n4. Map template variables\n5. Send your broadcast campaign\n\nPerfect for announcements, promotions, or updates!",
      suggestions: ["Go to Broadcast", "Create Broadcast"]
    };
  }

  // Features
  if (lowerMessage.match(/feature|features|what can|capabilities|what does/)) {
    return {
      message: "AiSensy offers powerful WhatsApp marketing features:\n\n✨ Campaign Management\n✨ Bulk Messaging (Broadcast)\n✨ Contact Management\n✨ Template Management\n✨ Real-time Analytics\n✨ Inbox for Conversations\n✨ Webhook Integration\n\nWhich feature would you like to explore?",
      suggestions: ["Campaigns", "Broadcast", "Analytics"]
    };
  }

  // Pricing/Plans
  if (lowerMessage.match(/price|pricing|plan|cost|subscription|billing/)) {
    return {
      message: "For pricing and subscription details, please visit the Settings page or contact our support team. We offer flexible plans to suit your business needs!",
      suggestions: ["Go to Settings"]
    };
  }

  // Default response
  return {
    message: "I'm here to help! You can ask me about:\n\n• Creating campaigns\n• Sending messages\n• Managing contacts\n• Viewing analytics\n• Templates\n• Broadcast messages\n\nWhat would you like to know?",
    suggestions: ["Create Campaign", "Send Message", "View Analytics"]
  };
};

// Handle chatbot message
exports.sendMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { message, interactionCount = 0, flowState = null } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message is required'
      });
    }

    // Get chatbot response
    const response = await getChatbotResponse(message.trim(), userId, flowState);

    // Prepare response object
    const responseObj = {
      success: true,
      message: response.message || response.response,
      flowState: response.flowState || flowState
    };

    // Add buttons if present (for template messages)
    if (response.buttons && response.buttons.length > 0) {
      responseObj.buttons = response.buttons;
    }

    // Add suggestions if present
    if (response.suggestions && response.suggestions.length > 0) {
      responseObj.suggestions = response.suggestions;
    }

    // Add validation result for salary input
    if (response.isValid !== undefined) {
      responseObj.isValid = response.isValid;
    }

    // Add suggestions based on interaction count (only if not in flow)
    if (!flowState && response.suggestions) {
      let suggestions = response.suggestions;
      // After 2 interactions, suggest human support
      if (interactionCount >= 2 && !suggestions.includes('Talk to Human')) {
        suggestions = [...suggestions, 'Talk to Human'];
      }
      responseObj.suggestions = suggestions;
    }

    res.json(responseObj);
  } catch (error) {
    console.error('Error in chatbot:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Lock chatbot and route to inbox
exports.lockChatbot = async (req, res) => {
  try {
    const userId = req.user.id;

    // Here you could:
    // 1. Create a support ticket
    // 2. Send notification to support team
    // 3. Log the conversation for review
    // 4. Create a contact in inbox for support

    // For now, just return success
    res.json({
      success: true,
      message: 'Chatbot locked. Conversation routed to inbox.'
    });
  } catch (error) {
    console.error('Error locking chatbot:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

