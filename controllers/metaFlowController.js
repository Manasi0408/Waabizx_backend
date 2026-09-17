/**
 * Meta WhatsApp Flow endpoint (data exchange).
 * Meta calls this URL when a Flow needs backend data or on submit.
 */
exports.handleFlowEndpoint = async (req, res) => {
  try {
    console.log('\n=== Meta WhatsApp Flow endpoint ===');
    console.log('Method:', req.method);
    console.log('Body:', JSON.stringify(req.body || {}, null, 2));

    return res.status(200).json({
      version: req.body?.version || '3.0',
      data: {
        status: 'active',
      },
    });
  } catch (error) {
    console.error('Meta Flow endpoint error:', error?.message || error);
    return res.status(500).json({
      error: error?.message || 'Flow endpoint error',
    });
  }
};
