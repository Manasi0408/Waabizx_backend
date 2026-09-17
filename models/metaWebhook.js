module.exports = (sequelize, DataTypes) => {
    const WebhookLog = sequelize.define(
      'WebhookLog',
      {
        event_type: {
          type: DataTypes.STRING(50),
          allowNull: false
        },
        payload: {
          type: DataTypes.TEXT('long'),
          allowNull: false
        }
      },
      {
        tableName: 'webhook_logs',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: false
      }
    );
  
    return WebhookLog;
  };
  