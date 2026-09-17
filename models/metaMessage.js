module.exports = (sequelize, DataTypes) => {
    const Message = sequelize.define(
      'Message',
      {
        phone: {
          type: DataTypes.STRING(20),
          allowNull: false
        },
        direction: {
          type: DataTypes.ENUM('inbound', 'outbound'),
          allowNull: false
        },
        message_type: {
          type: DataTypes.STRING(20),
          allowNull: false
        },
        message_text: {
          type: DataTypes.TEXT,
          allowNull: true
        },
        status: {
          type: DataTypes.STRING(20),
          allowNull: false
        },
        projectId: {
          type: DataTypes.INTEGER,
          allowNull: true,
          defaultValue: null
        },
        reactions: {
          type: DataTypes.JSON,
          allowNull: true,
          defaultValue: null
        }
      },
      {
        tableName: 'meta_messages',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: false
      }
    );
  
    return Message;
  };
  