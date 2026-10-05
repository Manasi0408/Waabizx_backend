const crypto = require('crypto');
const WhatsAppButton = require('../models/WhatsAppButton');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Project = require('../models/Project');

const normalizePhone = (value) => String(value || '').replace(/\D/g, '');

const makePublicId = () => crypto.randomBytes(8).toString('hex');

const resolveProjectPhone = async (projectId) => {
  const account = await WhatsAppAccount.findOne({
    where: { projectId },
    order: [['id', 'DESC']],
  });
  if (account?.display_phone) {
    return normalizePhone(account.display_phone);
  }

  const project = await Project.findById(projectId);
  if (!project) return '';

  const clientId = project.user_id || project.client_id || project.userId;
  if (!clientId) return '';

  const byClient = await WhatsAppAccount.findOne({
    where: { client_id: clientId },
    order: [['id', 'DESC']],
  });
  return normalizePhone(byClient?.display_phone);
};

const buildWaMeUrl = (phone, text) => {
  const digits = normalizePhone(phone);
  const msg = encodeURIComponent(String(text || '').trim());
  if (!digits) return msg ? `https://wa.me/?text=${msg}` : 'https://wa.me/';
  return msg ? `https://wa.me/${digits}?text=${msg}` : `https://wa.me/${digits}`;
};

const getPublicBaseUrl = (req) => {
  const envBase = String(process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || '').replace(/\/$/, '');
  if (envBase) return envBase;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  // return 'https://wabizx.techwhizzc.com';
  return 'https://app.waabizx.com';
};

const buildEmbedScriptSafe = (button, publicBase) => {
  const cfg = {
    id: button.publicId,
    name: button.name,
    ctaColor: button.ctaColor,
    marginLeft: Number(button.marginLeft) || 20,
    marginRight: Number(button.marginRight) || 20,
    marginTop: Number(button.marginTop) || 20,
    marginBottom: Number(button.marginBottom) || 20,
    cornerRadius: Number(button.cornerRadius) || 25,
    prefillMessage: button.prefillMessage,
    position: button.position || 'bottom-right',
    widgetHeading: button.widgetHeading,
    widgetButtonText: button.widgetButtonText,
    widgetButtonColor: button.widgetButtonColor,
    widgetProfileUrl: button.widgetProfileUrl,
    widgetPrefillMessage: button.widgetPrefillMessage,
    phoneNumber: button.phoneNumber,
    trackUrl: `${publicBase}/api/whatsapp-buttons/public/${button.publicId}/visit`,
    waUrl: buildWaMeUrl(button.phoneNumber, button.prefillMessage),
  };

  const runtime = `
(function(){
  var C=${JSON.stringify(cfg)};
  if(window["__waabizxBtn_"+C.id]) return;
  window["__waabizxBtn_"+C.id]=1;
  function track(){try{navigator.sendBeacon(C.trackUrl+"?type=widget")}catch(e){}}
  function go(){track();window.open(C.waUrl,"_blank")}
  function applyPos(el){
    var s=el.style;s.position="fixed";s.zIndex="2147483000";s.bottom=s.top=s.left=s.right="auto";
    if(C.position==="bottom-left"){s.bottom=(C.marginBottom||20)+"px";s.left=(C.marginLeft||20)+"px"}
    else if(C.position==="top-right"){s.top=(C.marginTop||20)+"px";s.right=(C.marginRight||20)+"px"}
    else if(C.position==="top-left"){s.top=(C.marginTop||20)+"px";s.left=(C.marginLeft||20)+"px"}
    else{s.bottom=(C.marginBottom||20)+"px";s.right=(C.marginRight||20)+"px"}
  }
  var wrap=document.createElement("div");applyPos(wrap);
  var btn=document.createElement("button");btn.type="button";
  btn.style.cssText="display:inline-flex;align-items:center;gap:8px;border:none;cursor:pointer;color:#fff;font:600 14px/1.2 system-ui,sans-serif;padding:12px 16px;box-shadow:0 8px 24px rgba(0,0,0,.18);background:"+(C.ctaColor||"#4DC247")+";border-radius:"+(C.cornerRadius||25)+"px";
  btn.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>';
  var label=document.createElement("span");label.textContent=C.name||"Chat with us";btn.appendChild(label);
  var panel=document.createElement("div");
  panel.style.cssText="display:none;position:absolute;bottom:64px;right:0;width:300px;max-width:calc(100vw - 32px);background:#fff;border-radius:16px;box-shadow:0 16px 40px rgba(0,0,0,.2);overflow:hidden;font-family:system-ui,sans-serif";
  if(String(C.position||"").indexOf("left")>=0){panel.style.right="auto";panel.style.left="0"}
  var head=document.createElement("div");head.style.cssText="padding:14px 16px;color:#fff;display:flex;gap:10px;align-items:center;background:"+(C.widgetButtonColor||"#0A5F54");
  var img=document.createElement("img");img.alt="";img.src=C.widgetProfileUrl||"";img.style.cssText="width:40px;height:40px;border-radius:50%;object-fit:cover;background:#fff";
  var title=document.createElement("div");title.style.cssText="font-weight:700;font-size:14px";title.textContent=C.widgetHeading||C.name||"Chat";
  head.appendChild(img);head.appendChild(title);
  var body=document.createElement("div");body.style.cssText="padding:14px 16px;color:#334155;font-size:13px;line-height:1.45";body.textContent=C.widgetPrefillMessage||"Hi, how can I help you?";
  var foot=document.createElement("div");foot.style.cssText="padding:0 16px 16px";
  var start=document.createElement("button");start.type="button";start.textContent=C.widgetButtonText||"Start chat";
  start.style.cssText="width:100%;border:none;border-radius:10px;padding:12px;color:#fff;font-weight:700;cursor:pointer;background:"+(C.widgetButtonColor||"#0A5F54");
  start.onclick=function(e){e.stopPropagation();go()};
  foot.appendChild(start);panel.appendChild(head);panel.appendChild(body);panel.appendChild(foot);
  btn.onclick=function(){panel.style.display=panel.style.display==="none"?"block":"none"};
  wrap.appendChild(panel);wrap.appendChild(btn);document.body.appendChild(wrap);
})();`.trim();

  const encoded = Buffer.from(runtime, 'utf8').toString('base64');
  return `<script>eval(atob('${encoded}'));</script>`;
};

const formatButton = (row, publicBase) => {
  const plain = row?.toJSON ? row.toJSON() : row;
  const qrPrefill = 'Hi';
  const whatsappChatUrl = buildWaMeUrl(plain.phoneNumber, qrPrefill);
  const waabizxRedirectUrl = `${publicBase}/api/whatsapp-buttons/public/${plain.publicId}/r`;
  return {
    ...plain,
    whatsappChatUrl,
    waabizxRedirectUrl,
    whatsappQrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(whatsappChatUrl)}`,
    waabizxQrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(waabizxRedirectUrl)}`,
  };
};

exports.buildWaMeUrl = buildWaMeUrl;
exports.getPublicBaseUrl = getPublicBaseUrl;
exports.formatButton = formatButton;

exports.listButtons = async (projectId, req) => {
  const rows = await WhatsAppButton.findAll({
    where: { projectId },
    order: [['id', 'DESC']],
  });
  const publicBase = getPublicBaseUrl(req);
  return rows.map((r) => formatButton(r, publicBase));
};

exports.createButton = async ({ projectId, userId, body, req }) => {
  let phone = normalizePhone(body.phoneNumber);
  if (!phone) phone = await resolveProjectPhone(projectId);
  if (!phone) {
    const err = new Error('No WhatsApp number found for this project. Connect WhatsApp first.');
    err.status = 400;
    throw err;
  }

  const publicBase = getPublicBaseUrl(req);
  const publicId = makePublicId();
  const defaults = {
    name: String(body.name || 'Chat with us').trim().slice(0, 120) || 'Chat with us',
    ctaColor: String(body.ctaColor || '#4DC247').trim() || '#4DC247',
    marginLeft: Math.max(0, Number(body.marginLeft) || 20),
    marginRight: Math.max(0, Number(body.marginRight) || 20),
    marginTop: Math.max(0, Number(body.marginTop) || 20),
    marginBottom: Math.max(0, Number(body.marginBottom) || 20),
    cornerRadius: Math.max(0, Number(body.cornerRadius) || 25),
    prefillMessage: String(body.prefillMessage || 'Hi').trim().slice(0, 140) || 'Hi',
    position: ['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(body.position)
      ? body.position
      : 'bottom-right',
    widgetHeading: String(body.widgetHeading || '').trim().slice(0, 160),
    widgetButtonText: String(body.widgetButtonText || 'Start chat').trim().slice(0, 80) || 'Start chat',
    widgetButtonColor: String(body.widgetButtonColor || '#0A5F54').trim() || '#0A5F54',
    widgetProfileUrl: String(body.widgetProfileUrl || `${publicBase}/LogoWaabizx.png`).trim(),
    widgetPrefillMessage:
      String(body.widgetPrefillMessage || 'Hi, how can I help you?').trim().slice(0, 280) ||
      'Hi, how can I help you?',
    phoneNumber: phone,
    publicId,
    projectId,
    createdBy: userId || null,
  };

  const created = await WhatsAppButton.create({
    ...defaults,
    embedScript: '',
  });

  const script = buildEmbedScriptSafe(created, publicBase);
  await created.update({ embedScript: script });

  return formatButton(created, publicBase);
};

exports.deleteButton = async ({ projectId, id }) => {
  const button = await WhatsAppButton.findOne({ where: { id, projectId } });
  if (!button) {
    const err = new Error('Button not found');
    err.status = 404;
    throw err;
  }
  await button.destroy();
  return { deleted: true };
};

exports.trackVisit = async (publicId, type = 'widget') => {
  const button = await WhatsAppButton.findOne({ where: { publicId } });
  if (!button) return null;
  if (type === 'qr') {
    await button.increment('qrVisits');
  } else {
    await button.increment('widgetVisits');
  }
  await button.reload();
  return button;
};

exports.getByPublicId = async (publicId) => WhatsAppButton.findOne({ where: { publicId } });
