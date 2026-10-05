const { DataTypes } = require("sequelize");
const sequelize = require("../config/database"); // adjust path if needed

const Setting = sequelize.define(
  "Setting",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },

    companyName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },

    whatsappNumber: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },

    timezone: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: "Asia/Kolkata",
    },

    adminName: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },

    adminEmail: {
      type: DataTypes.STRING(150),
      allowNull: false,
      validate: {
        isEmail: true,
      },
    },
  },
  {
    tableName: "settings",
    timestamps: true,
  }
);

module.exports = Setting;
