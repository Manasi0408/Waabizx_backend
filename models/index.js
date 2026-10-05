const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');
const User = require('./User');
const Campaign = require('./Campaign');
const CampaignAudience = require('./CampaignAudience');
const Contact = require('./Contact');
const Template = require('./Template');
const Message = require('./Message');
const Notification = require('./Notification');
const InboxMessage = require('./InboxMessage');
const ClientWhatsApp = require('./ClientWhatsApp');
const Client = require('./Client');
const WhatsAppAccount = require('./WhatsAppAccount');
const CannedMessage = require('./CannedMessage');
const Flow = require("./Flow");
const Account = require('./Account');
const RealConversation = require('./RealConversation');
const PasswordResetToken = require('./PasswordResetToken');
const Plan = require('./Plan');
const PlatformSetting = require('./PlatformSetting');
const PartnerBusiness = require('./PartnerBusiness');
const Tag = require('./Tag');
const ContactTag = require('./ContactTag');
const UserAttribute = require('./UserAttribute');
const WhatsAppButton = require('./WhatsAppButton');
const RcsMessage = require('./RcsMessage');
const RcsSettings = require('./RcsSettings');
const ChannelStat = require('./ChannelStat');
const MessageTemplateChannel = require('./MessageTemplateChannel');
const RcsCampaign = require('./RcsCampaign');
const DemoBooking = require('./DemoBooking');
const WebsiteLead = require('./WebsiteLead');
const Blog = require('./Blog');
const WhatsappPricing = require('./WhatsappPricing');
const ExchangeRate = require('./ExchangeRate');
const AgentProject = require('./AgentProject');
const ProjectApiToken = require('./ProjectApiToken');

// Import meta models for webhooks
const WebhookLog = require('./metaWebhook')(sequelize, DataTypes);
const MetaMessage = require('./metaMessage')(sequelize, DataTypes);

// Define associations
User.hasMany(Campaign, { foreignKey: 'userId', onDelete: 'CASCADE' });
Campaign.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Contact, { foreignKey: 'userId', onDelete: 'CASCADE' });
Contact.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Template, { foreignKey: 'userId', onDelete: 'CASCADE' });
Template.belongsTo(User, { foreignKey: 'userId' });

Campaign.hasMany(Message, { foreignKey: 'campaignId', onDelete: 'CASCADE' });
Message.belongsTo(Campaign, { foreignKey: 'campaignId' });

Campaign.hasMany(CampaignAudience, { foreignKey: 'campaignId', onDelete: 'CASCADE' });
CampaignAudience.belongsTo(Campaign, { foreignKey: 'campaignId' });

Contact.hasMany(Message, { foreignKey: 'contactId', onDelete: 'CASCADE' });
Message.belongsTo(Contact, { foreignKey: 'contactId' });

Contact.hasMany(InboxMessage, { foreignKey: 'contactId', onDelete: 'CASCADE' });
InboxMessage.belongsTo(Contact, { foreignKey: 'contactId' });

User.hasMany(InboxMessage, { foreignKey: 'userId', onDelete: 'CASCADE' });
InboxMessage.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Notification, { foreignKey: 'userId', onDelete: 'CASCADE' });
Notification.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(ClientWhatsApp, { foreignKey: 'client_id', onDelete: 'CASCADE' });
ClientWhatsApp.belongsTo(User, { foreignKey: 'client_id' });

Client.hasMany(WhatsAppAccount, { foreignKey: 'client_id', onDelete: 'CASCADE' });
WhatsAppAccount.belongsTo(Client, { foreignKey: 'client_id' });

User.hasMany(CannedMessage, { foreignKey: 'userId', onDelete: 'CASCADE' });
CannedMessage.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(AgentProject, { foreignKey: 'agentId', as: 'agentProjectLinks' });
AgentProject.belongsTo(User, { foreignKey: 'agentId', as: 'agent' });

Tag.hasMany(ContactTag, { foreignKey: 'tagId', onDelete: 'CASCADE', as: 'contactTagLinks' });
ContactTag.belongsTo(Tag, { foreignKey: 'tagId' });
Contact.hasMany(ContactTag, { foreignKey: 'contactId', onDelete: 'CASCADE' });
ContactTag.belongsTo(Contact, { foreignKey: 'contactId' });
Contact.belongsToMany(Tag, { through: ContactTag, foreignKey: 'contactId', otherKey: 'tagId' });
Tag.belongsToMany(Contact, { through: ContactTag, foreignKey: 'tagId', otherKey: 'contactId' });

const syncDatabase = async () => {
  try {
    // Use force: false to avoid recreating tables
    // Only create tables if they don't exist
    await sequelize.sync({ force: false, alter: false });
    console.log('✅ Database synchronized successfully.');
    
    // Ensure InboxMessage table exists (create if doesn't exist)
    try {
      await InboxMessage.sync({ force: false, alter: true });
      console.log('✅ InboxMessage table verified/created.');
      try {
        const queryInterface = sequelize.getQueryInterface();
        const imTable = await queryInterface.describeTable('inboxmessages');
        const colNames = Object.keys(imTable || {}).map((c) => c.toLowerCase());
        const hasTemplateFlagCol = colNames.includes('istemplatesend');
        if (!hasTemplateFlagCol) {
          await queryInterface.addColumn('inboxmessages', 'isTemplateSend', {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false
          });
          console.log('✅ inboxmessages.isTemplateSend column added.');
        }
        if (!colNames.includes('templatename')) {
          await queryInterface.addColumn('inboxmessages', 'templateName', {
            type: DataTypes.STRING,
            allowNull: true,
            defaultValue: null,
          });
          console.log('✅ inboxmessages.templateName column added.');
        }
        if (!colNames.includes('templatesnapshot')) {
          await queryInterface.addColumn('inboxmessages', 'templateSnapshot', {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
          });
          console.log('✅ inboxmessages.templateSnapshot column added.');
        }
        if (!colNames.includes('payload')) {
          await queryInterface.addColumn('inboxmessages', 'payload', {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
          });
          console.log('✅ inboxmessages.payload column added.');
        }
        if (!colNames.includes('mediaurl')) {
          await queryInterface.addColumn('inboxmessages', 'mediaUrl', {
            type: DataTypes.TEXT,
            allowNull: true,
            defaultValue: null,
          });
          console.log('✅ inboxmessages.mediaUrl column added.');
        }
        // Best-effort: older rows that stored template sends as message "Template: …"
        await sequelize.query(`
          UPDATE inboxmessages
          SET isTemplateSend = 1
          WHERE direction = 'outgoing'
            AND status = 'sent'
            AND (isTemplateSend IS NULL OR isTemplateSend = 0)
            AND (TRIM(message) LIKE 'Template:%' OR TRIM(message) LIKE 'Template :%')
        `);
      } catch (imFlagErr) {
        console.warn('⚠️  inboxmessages isTemplateSend ensure/backfill:', imFlagErr?.message || imFlagErr);
      }
    } catch (inboxError) {
      console.error('⚠️  InboxMessage table sync error:', inboxError.message);
      console.error('Full error:', inboxError);
    }
    
    // Ensure CampaignAudience table exists
    try {
      await CampaignAudience.sync({ force: false, alter: true });
      console.log('✅ CampaignAudience table verified/created.');
    } catch (audienceError) {
      console.error('⚠️  CampaignAudience table sync error:', audienceError.message);
    }
    
    // Ensure Campaign table has new columns (template_name, template_language, etc.)
    try {
      await Campaign.sync({ force: false, alter: true });
      console.log('✅ Campaign table synced with new columns.');
    } catch (campaignError) {
      console.error('⚠️  Campaign table sync error:', campaignError.message);
    }
    try {
      const { ensureCampaignCarouselMediaColumn } = require('../utils/dbSchemaEnsure');
      await ensureCampaignCarouselMediaColumn();
    } catch (carouselColErr) {
      console.warn('⚠️  campaigns.carousel_card_media_urls ensure:', carouselColErr?.message || carouselColErr);
    }
    
    // Ensure Template table has updated ENUM values (including marketing category)
    try {
      await Template.sync({ force: false, alter: true });
      console.log('✅ Template table synced with updated categories.');
    } catch (templateError) {
      console.error('⚠️  Template table sync error:', templateError.message);
    }
    // Ensure User table has updated role ENUM (admin, manager, agent, user)
    try {
      await User.sync({ force: false, alter: true });
      console.log('✅ User table synced with updated roles (admin, manager, agent, user).');
    } catch (userError) {
      console.error('⚠️  User table sync error:', userError.message);
    }
    // Ensure Users mobile column exists (supports mobile_number / mobileNumber)
    try {
      const queryInterface = sequelize.getQueryInterface();
      let userTable = 'users';
      let table;
      try {
        table = await queryInterface.describeTable('users');
      } catch (_) {
        userTable = 'Users';
        table = await queryInterface.describeTable('Users');
      }
      const hasMobileColumn = !!table.mobile_number || !!table.mobileNumber;
      if (!hasMobileColumn) {
        await queryInterface.addColumn(userTable, 'mobile_number', {
          type: DataTypes.STRING(20),
          allowNull: true,
          unique: true
        });
        console.log(`✅ ${userTable}.mobile_number column added.`);
      } else {
        console.log('✅ Users mobile column already exists.');
      }
    } catch (mobileColumnError) {
      console.error('⚠️  Users mobile column ensure error:', mobileColumnError.message);
    }
    // Ensure Contact table has whatsappOptInAt for keyword opt-in
    try {
      const Contact = require('./Contact');
      await Contact.sync({ force: false, alter: true });
      // contacts should be unique per user + phone (not globally by phone)
      try {
        const queryInterface = sequelize.getQueryInterface();
        const indexes = await queryInterface.showIndex('contacts');
        const fieldNames = (idx) => (idx.fields || []).map((f) => f.attribute || f.name).filter(Boolean);
        const hasProjectScopedUnique = indexes.some((idx) => {
          const fields = fieldNames(idx);
          return (
            idx.unique &&
            fields.length === 3 &&
            fields.includes('userId') &&
            fields.includes('phone') &&
            fields.includes('projectId')
          );
        });

        if (!hasProjectScopedUnique) {
          for (const idx of indexes) {
            const fields = fieldNames(idx);
            if (!idx.unique || idx.name === 'PRIMARY') continue;
            const isLegacyPhoneOnly = fields.length === 1 && fields[0] === 'phone';
            const isLegacyUserPhone = fields.length === 2 && fields.includes('userId') && fields.includes('phone');
            if (isLegacyPhoneOnly || isLegacyUserPhone) {
              try {
                await queryInterface.removeIndex('contacts', idx.name);
                console.log(`✅ Removed legacy unique index on contacts (${idx.name}).`);
              } catch (removeErr) {
                console.error(`⚠️ Could not remove index ${idx.name}:`, removeErr.message);
              }
            }
          }
          await queryInterface.addIndex('contacts', ['userId', 'phone', 'projectId'], {
            unique: true,
            name: 'contacts_user_phone_project_unique'
          });
          console.log('✅ Added contacts unique index on (userId, phone, projectId).');
        } else {
          console.log('✅ contacts unique index (userId, phone, projectId) already exists.');
        }
      } catch (contactIndexError) {
        console.error('⚠️ Contact index ensure error:', contactIndexError.message);
      }
      console.log('✅ Contact table synced (whatsappOptInAt).');
    } catch (contactError) {
      console.error('⚠️  Contact table sync error:', contactError.message);
    }

    // Ensure messages table supports project scoping.
    try {
      const queryInterface = sequelize.getQueryInterface();
      const messageTable = await queryInterface.describeTable('messages');
      if (!messageTable.projectId) {
        await queryInterface.addColumn('messages', 'projectId', {
          type: DataTypes.INTEGER,
          allowNull: true,
          defaultValue: null
        });
        console.log('✅ messages.projectId column added.');
      } else {
        console.log('✅ messages.projectId column already exists.');
      }

      await sequelize.query(`
        UPDATE messages m
        JOIN contacts c ON c.id = m.contactId
        SET m.projectId = c.projectId
        WHERE m.projectId IS NULL
          AND c.projectId IS NOT NULL
      `);

      const messagesCols = await queryInterface.describeTable('messages');
      if (!messagesCols.reactions) {
        await queryInterface.addColumn('messages', 'reactions', {
          type: DataTypes.JSON,
          allowNull: true,
          defaultValue: null
        });
        console.log('✅ messages.reactions column added.');
      } else {
        console.log('✅ messages.reactions column already exists.');
      }
    } catch (messageProjectError) {
      console.error('⚠️ messages projectId ensure error:', messageProjectError.message);
    }

    // Ensure conversations table supports project scoping.
    try {
      const queryInterface = sequelize.getQueryInterface();
      const conversationTable = await queryInterface.describeTable('conversations');
      if (!conversationTable.project_id) {
        await queryInterface.addColumn('conversations', 'project_id', {
          type: DataTypes.INTEGER,
          allowNull: true,
          defaultValue: null
        });
        console.log('✅ conversations.project_id column added.');
      } else {
        console.log('✅ conversations.project_id column already exists.');
      }

      // Backfill project_id from contacts by phone where possible.
      await sequelize.query(`
        UPDATE conversations c
        JOIN (
          SELECT phone, MAX(projectId) AS projectId
          FROM contacts
          WHERE projectId IS NOT NULL
          GROUP BY phone
        ) ct ON ct.phone = c.phone
        SET c.project_id = ct.projectId
        WHERE c.project_id IS NULL
      `);

      const indexes = await queryInterface.showIndex('conversations');
      const hasUniqueProjectPhone = indexes.some((idx) => {
        const fields = (idx.fields || []).map((f) => f.attribute || f.name).filter(Boolean);
        return idx.unique && fields.length === 2 && fields.includes('project_id') && fields.includes('phone');
      });
      if (!hasUniqueProjectPhone) {
        await queryInterface.addIndex('conversations', ['project_id', 'phone'], {
          unique: true,
          name: 'conversations_project_phone_unique'
        });
        console.log('✅ Added conversations unique key on (project_id, phone).');
      }
    } catch (conversationProjectError) {
      console.error('⚠️ conversations project_id ensure error:', conversationProjectError.message);
    }

    // Ensure ClientWhatsApp (clients_whatsapp) table exists for Meta onboarding
    try {
      await ClientWhatsApp.sync({ force: false, alter: true });
      console.log('✅ ClientWhatsApp table verified/created.');
      try {
        const queryInterface = sequelize.getQueryInterface();
        const cwaTable = await queryInterface.describeTable('clients_whatsapp');
        if (!cwaTable.phone) {
          await queryInterface.addColumn('clients_whatsapp', 'phone', {
            type: DataTypes.STRING(20),
            allowNull: true
          });
        }
        if (!cwaTable.project_id) {
          await queryInterface.addColumn('clients_whatsapp', 'project_id', {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: null
          });
        }
        const cwaIndexes = await queryInterface.showIndex('clients_whatsapp');
        const hasPhoneIdx = cwaIndexes.some((idx) => {
          const fields = (idx.fields || []).map((f) => f.attribute || f.name).filter(Boolean);
          return fields.length === 1 && fields[0] === 'phone';
        });
        if (!hasPhoneIdx) {
          await queryInterface.addIndex('clients_whatsapp', ['phone'], {
            name: 'clients_whatsapp_phone_idx'
          });
        }
      } catch (cwaSchemaErr) {
        console.error('⚠️ clients_whatsapp schema ensure error:', cwaSchemaErr.message);
      }
    } catch (clientWaError) {
      console.error('⚠️  ClientWhatsApp table sync error:', clientWaError.message);
    }
    // Production SaaS: clients and whatsapp_accounts (multi-tenant)
    try {
      await Client.sync({ force: false, alter: true });
      console.log('✅ Client table verified/created.');
    } catch (clientError) {
      console.error('⚠️  Client table sync error:', clientError.message);
    }
    try {
      await WhatsAppAccount.sync({ force: false, alter: true });
      console.log('✅ WhatsAppAccount table verified/created.');
    } catch (waAccError) {
      console.error('⚠️  WhatsAppAccount table sync error:', waAccError.message);
    }

    try {
      await MetaMessage.sync({ force: false, alter: true });
      console.log('✅ MetaMessage table synced (project scoping).');
      try {
        const qi = sequelize.getQueryInterface();
        const metaDesc = await qi.describeTable('meta_messages');
        if (!metaDesc.reactions) {
          await qi.addColumn('meta_messages', 'reactions', {
            type: DataTypes.JSON,
            allowNull: true,
            defaultValue: null
          });
          console.log('✅ meta_messages.reactions column added.');
        } else {
          console.log('✅ meta_messages.reactions column already exists.');
        }
      } catch (metaReactionsErr) {
        console.error('⚠️ meta_messages.reactions ensure error:', metaReactionsErr.message);
      }
    } catch (metaMsgSyncError) {
      console.error('⚠️  MetaMessage table sync error:', metaMsgSyncError.message);
    }

    // Ensure CannedMessage table exists
    try {
      await CannedMessage.sync({ force: false, alter: true });
      console.log('✅ CannedMessage table verified/created.');
    } catch (cannedError) {
      console.error('⚠️  CannedMessage table sync error:', cannedError.message);
    }

    // Ensure Flow table exists
    try {
      await Flow.sync({ force: false, alter: true });
      console.log("✅ Flow table verified/created.");
    } catch (flowError) {
      console.error("⚠️ Flow table sync error:", flowError.message);
    }

    // Ensure PasswordResetToken table exists
    try {
      await PasswordResetToken.sync({ force: false, alter: true });
      console.log('✅ PasswordResetToken table verified/created.');
    } catch (resetTokenError) {
      console.error('⚠️ PasswordResetToken table sync error:', resetTokenError.message);
    }

    try {
      await Plan.sync({ force: false, alter: true });
      const { ensureDefaultPlans } = require('../controllers/planController');
      await ensureDefaultPlans();
      console.log('✅ Plans table verified/created.');
    } catch (planError) {
      console.error('⚠️ Plans table sync error:', planError.message);
    }

    try {
      await PlatformSetting.sync({ force: false, alter: true });
      const { ensureConversationMetricsLoaded } = require('../services/conversationMetricsService');
      await ensureConversationMetricsLoaded();
      console.log('✅ Platform settings table verified/created.');
    } catch (platformSettingError) {
      console.error('⚠️ Platform settings table sync error:', platformSettingError.message);
    }

    try {
      await PartnerBusiness.sync({ force: false, alter: true });
      console.log('✅ PartnerBusiness table verified/created.');
    } catch (partnerError) {
      console.error('⚠️ PartnerBusiness table sync error:', partnerError.message);
    }

    try {
      await Tag.sync({ force: false, alter: true });
      await ContactTag.sync({ force: false, alter: true });
      console.log('✅ Tag / ContactTag tables verified/created.');
    } catch (tagError) {
      console.error('⚠️ Tag table sync error:', tagError.message);
    }

    try {
      await UserAttribute.sync({ force: false, alter: true });
      console.log('✅ UserAttribute table verified/created.');
    } catch (userAttributeError) {
      console.error('⚠️ UserAttribute table sync error:', userAttributeError.message);
    }

    try {
      await WhatsAppButton.sync({ force: false, alter: true });
      console.log('✅ WhatsAppButton table verified/created.');
    } catch (waButtonError) {
      console.error('⚠️ WhatsAppButton table sync error:', waButtonError.message);
    }

    try {
      await RcsMessage.sync({ force: false, alter: true });
      await RcsSettings.sync({ force: false, alter: true });
      await ChannelStat.sync({ force: false, alter: true });
      await MessageTemplateChannel.sync({ force: false, alter: true });
      await RcsCampaign.sync({ force: false, alter: true });
      console.log('✅ RCS tables verified/created.');
    } catch (rcsError) {
      console.error('⚠️ RCS table sync error:', rcsError.message);
    }

    try {
      await DemoBooking.sync({ force: false, alter: true });
      await WebsiteLead.sync({ force: false, alter: true });
      console.log('✅ DemoBooking / WebsiteLead tables verified/created.');
    } catch (leadError) {
      console.error('⚠️ DemoBooking / WebsiteLead table sync error:', leadError.message);
    }

    try {
      await Blog.sync({ force: false, alter: true });
      console.log('✅ Blog table verified/created.');
    } catch (blogError) {
      console.error('⚠️ Blog table sync error:', blogError.message);
    }

    try {
      await AgentProject.sync({ force: false, alter: true });
      const { backfillFromUsersProjectId } = require('../services/agentProjectService');
      await backfillFromUsersProjectId();
      console.log('✅ AgentProject table verified/created.');
    } catch (agentProjectError) {
      console.error('⚠️ AgentProject table sync error:', agentProjectError.message);
    }

    try {
      await ProjectApiToken.sync({ force: false, alter: true });
      console.log('✅ ProjectApiToken table verified/created.');
    } catch (projectApiTokenError) {
      console.error('⚠️ ProjectApiToken table sync error:', projectApiTokenError.message);
    }
  } catch (error) {
    console.error('❌ Database synchronization failed:', error.message);
    console.error('Full error:', error);
    // If sync fails, try to continue - tables might already exist
    console.log('⚠️  Continuing anyway - tables may already exist');
  }
};

module.exports = {
  sequelize,
  User,
  Campaign,
  CampaignAudience,
  Contact,
  Template,
  Message,
  Notification,
  InboxMessage,
  ClientWhatsApp,
  Client,
  WhatsAppAccount,
  CannedMessage,
  Flow,
  Account,
  RealConversation,
  PasswordResetToken,
  Plan,
  PlatformSetting,
  PartnerBusiness,
  Tag,
  ContactTag,
  UserAttribute,
  WhatsAppButton,
  RcsMessage,
  RcsSettings,
  ChannelStat,
  MessageTemplateChannel,
  RcsCampaign,
  DemoBooking,
  WebsiteLead,
  Blog,
  WhatsappPricing,
  ExchangeRate,
  AgentProject,
  ProjectApiToken,
  WebhookLog,
  MetaMessage,
  syncDatabase
};