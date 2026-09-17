const Notification = require('../models/notificationModel');

exports.getNotifications = async (req, res) => {
  try {
    // Get user ID from authenticated user (required - protected route)
    const userId = req.user.id;
    
    console.log(`📬 Fetching notifications for user ID: ${userId}`);

    const notifications = await Notification.getByUser(userId);
    
    console.log(`✅ Found ${notifications.length} notifications for user ${userId}`);

    // Ensure notifications are sorted by created_at DESC (newest first)
    const sortedNotifications = notifications.sort((a, b) => {
      const dateA = new Date(a.created_at || 0);
      const dateB = new Date(b.created_at || 0);
      return dateB - dateA; // Descending order (newest first)
    });

    res.json({
      success: true,
      data: sortedNotifications
    });
  } catch (error) {
    console.error('Get Notifications Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to fetch notifications' 
    });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;

    await Notification.markAsRead(id);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.id; // Required - protected route

    await Notification.markAllAsRead(userId);

    res.json({ success: true });
  } catch (error) {
    console.error('Mark All As Read Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to mark all notifications as read' 
    });
  }
};
