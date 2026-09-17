const { parseCommaList } = require('./flowExecutionService');

const META_FLOW_VERSION = '6.0';

/** Meta screen ids: letters and underscores only (no digits). */
function indexToScreenId(index) {
  let n = index;
  let suffix = '';
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `SCREEN_${suffix}`;
}

function indexToOptionId(index) {
  let n = index;
  let suffix = '';
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `OPT_${suffix}`;
}

function sanitizeScreenId(_nodeId, index) {
  return indexToScreenId(index);
}

function orderFlowNodes(nodes, edges) {
  const nodeById = new Map((nodes || []).map((n) => [n.id, n]));
  const outgoing = new Map();
  (edges || []).forEach((e) => {
    const list = outgoing.get(e.source) || [];
    list.push(e);
    outgoing.set(e.source, list);
  });

  const start = (nodes || []).find((n) => n.type === 'start');
  const ordered = [];
  const visited = new Set();

  const walk = (nodeId) => {
    if (!nodeId || visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = nodeById.get(nodeId);
    if (!node) return;
    if (node.type !== 'start') ordered.push(node);
    (outgoing.get(nodeId) || []).forEach((edge) => walk(edge.target));
  };

  if (start) walk(start.id);
  (nodes || []).forEach((n) => {
    if (n.type !== 'start' && !visited.has(n.id)) ordered.push(n);
  });

  return ordered;
}

function buildRoutingModel(screens) {
  const model = {};
  (screens || []).forEach((screen, index) => {
    if (screen.terminal || index >= screens.length - 1) {
      model[screen.id] = [];
      return;
    }
    model[screen.id] = [screens[index + 1].id];
  });
  return model;
}

function buildScreenChildren(node, { isLast, nextScreenId, flowName }) {
  const data = node.data || {};
  const children = [];
  const formFields = [];

  const addFormField = (field) => {
    formFields.push(field);
  };

  if (node.type === 'text' || node.type === 'single_product') {
    const heading = data.title || data.productName || flowName || 'Message';
    const body = data.body || data.text || data.message || '';
    children.push({ type: 'TextHeading', text: String(heading).slice(0, 80) });
    if (body) children.push({ type: 'TextBody', text: String(body).slice(0, 1024) });
  } else if (node.type === 'question') {
    const question = data.question || 'Your answer';
    const options = parseCommaList(data.options || '');
    children.push({ type: 'TextHeading', text: String(question).slice(0, 80) });
    if (options.length > 1) {
      addFormField({
        type: 'RadioButtonsGroup',
        label: 'Choose one',
        name: 'answer',
        required: true,
        'data-source': options.map((opt, idx) => ({
          id: indexToOptionId(idx),
          title: String(opt).slice(0, 80),
        })),
      });
    } else {
      addFormField({
        type: 'TextInput',
        label: String(question).slice(0, 80),
        name: 'answer',
        required: true,
        'input-type': 'text',
      });
    }
  } else if (node.type === 'template') {
    const title = data.templateName || 'Template';
    const body =
      data.templateContent ||
      data.templateParts?.body ||
      `Template step: ${title}`;
    children.push({ type: 'TextHeading', text: String(title).slice(0, 80) });
    children.push({ type: 'TextBody', text: String(body).slice(0, 1024) });
  } else if (node.type === 'button') {
    const body = data.text || data.message || 'Choose an option';
    children.push({ type: 'TextHeading', text: String(body).slice(0, 80) });
    const buttons = Array.isArray(data.buttonsList)
      ? data.buttonsList
      : parseCommaList(data.buttons || '');
    if (buttons.length > 1) {
      addFormField({
        type: 'RadioButtonsGroup',
        label: 'Select',
        name: 'choice',
        required: true,
        'data-source': buttons.map((opt, idx) => ({
          id: indexToOptionId(idx),
          title: String(opt).slice(0, 80),
        })),
      });
    }
  } else if (node.type === 'image') {
    children.push({ type: 'TextHeading', text: 'Media' });
    children.push({
      type: 'TextBody',
      text: String(data.caption || data.url || 'Image content').slice(0, 1024),
    });
  } else if (node.type !== 'start' && node.type !== 'set_attribute') {
    children.push({ type: 'TextHeading', text: flowName || 'Step' });
    children.push({ type: 'TextBody', text: `Step type: ${node.type}` });
  }

  const layoutChildren = [...children];
  if (formFields.length) {
    layoutChildren.push({
      type: 'Form',
      name: 'form',
      children: formFields,
    });
  }

  const completePayload = formFields.reduce((acc, field) => {
    if (field?.name) acc[field.name] = `\${form.${field.name}}`;
    return acc;
  }, {});

  if (isLast) {
    layoutChildren.push({
      type: 'Footer',
      label: 'Submit',
      'on-click-action': {
        name: 'complete',
        payload: completePayload,
      },
    });
  } else {
    const navigatePayload = formFields.reduce((acc, field) => {
      if (field?.name) acc[field.name] = `\${form.${field.name}}`;
      return acc;
    }, {});

    layoutChildren.push({
      type: 'Footer',
      label: 'Continue',
      'on-click-action': {
        name: 'navigate',
        next: {
          type: 'screen',
          name: nextScreenId,
        },
        ...(Object.keys(navigatePayload).length ? { payload: navigatePayload } : {}),
      },
    });
  }

  return layoutChildren;
}

/**
 * Convert React Flow builder JSON (nodes + edges) into Meta WhatsApp Flow JSON.
 */
function convertReactFlowToMetaFlow({ name, nodes, edges, useEndpoint = false }) {
  const ordered = orderFlowNodes(nodes, edges);
  const screenMeta = ordered.map((node, index) => ({
    node,
    id: sanitizeScreenId(node.id, index),
    index,
  }));

  let screens = screenMeta.map(({ node, id, index }) => {
    const isLast = index === screenMeta.length - 1;
    const nextScreenId = isLast ? null : screenMeta[index + 1].id;
    const title =
      node.data?.title ||
      node.data?.templateName ||
      node.data?.question ||
      `${name || 'Flow'} — Step ${index + 1}`;

    const screen = {
      id,
      title: String(title).slice(0, 80),
      terminal: isLast,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: buildScreenChildren(node, {
          isLast,
          nextScreenId,
          flowName: name,
        }),
      },
    };

    if (isLast) {
      screen.success = true;
    }

    return screen;
  });

  if (!screens.length) {
    screens = [
      {
        id: 'WELCOME',
        title: name || 'Flow',
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: name || 'Welcome' },
            {
              type: 'Footer',
              label: 'Complete',
              'on-click-action': { name: 'complete', payload: {} },
            },
          ],
        },
      },
    ];
  }

  const payload = {
    version: META_FLOW_VERSION,
    screens,
  };

  if (useEndpoint) {
    payload.data_api_version = '3.0';
    payload.routing_model = buildRoutingModel(screens);
  }

  return payload;
}

module.exports = {
  convertReactFlowToMetaFlow,
  META_FLOW_VERSION,
};
