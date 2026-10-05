const express = require('express');
const router = express.Router();

const { generateAIResponse } = require('../services/openaiService');

router.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message is required',
      });
    }

    const reply = await generateAIResponse(message);

    return res.status(200).json({
      success: true,
      reply,
    });
  } catch (error) {
    console.error('[AI_CHAT_ERROR]', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to generate AI response',
    });
  }
});

router.post('/test-ai', async (req, res) => {
  try {
    const reply = await generateAIResponse(req.body.message);

    res.json({
      success: true,
      reply,
    });
  } catch (error) {
    console.error('AI ERROR:', error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;
