const NotificationModel = require('./Notification');

class Notification {
  static async create({ userId, type, title, body }) {
    const notification = await NotificationModel.create({
      userId,
      type,
      title,
      body
    });
    return notification.id;
  }

  static async getByUser(userId) {
    const notifications = await NotificationModel.findAll({
      where: { userId },
      order: [['created_at', 'DESC']], // Order by created_at descending (newest first)
      attributes: ['id', 'type', 'title', 'body', 'isRead', 'created_at'],
      raw: false // Get full model instances
    });
    
    // Map to plain objects and ensure proper sorting
    const mappedNotifications = notifications.map(n => {
      let created_at = null;
      
      // Safely handle created_at date
      if (n.created_at) {
        try {
          const date = new Date(n.created_at);
          // Check if date is valid
          if (!isNaN(date.getTime())) {
            created_at = date.toISOString();
          }
        } catch (error) {
          // If date conversion fails, use null
          created_at = null;
        }
      }
      
      return {
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        is_read: n.isRead,
        created_at: created_at
      };
    });
    
    // Additional sort to ensure newest first (in case database sort doesn't work)
    return mappedNotifications.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA; // Descending order (newest first)
    });
  }

  static async markAsRead(notificationId) {
    await NotificationModel.update(
      { isRead: true },
      { where: { id: notificationId } }
    );
  }

  static async markAllAsRead(userId) {
    await NotificationModel.update(
      { isRead: true },
      { where: { userId } }
    );
  }
}

module.exports = Notification;
