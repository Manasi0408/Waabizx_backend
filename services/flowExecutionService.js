const parseCommaList = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function defaultQuestionFormatErrorMessage(format) {
  const map = {
    any: 'Please enter a valid answer.',
    text: 'Please enter text only (not numbers).',
    number: 'Please enter a valid number.',
    date: 'Please enter a valid date.',
    email: 'Please enter a valid email address.',
    true_false: 'Please enter true or false.',
    regex: 'Answer does not match the required format.',
  };
  return map[String(format || 'any').toLowerCase()] || map.any;
}

function normalizeQuestionNumericInput(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  raw = raw.replace(/^(₹|rs\.?|inr|\$|usd|eur|£)\s*/i, '');
  raw = raw.replace(/\s*(₹|rs\.?|inr|\$|usd|eur|£)\s*$/i, '');
  raw = raw.replace(/,/g, '').replace(/\s+/g, '');
  return raw;
}

function validateQuestionAnswerFormat(value, format, regexPattern) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const f = String(format || 'any').toLowerCase();
  if (f === 'any') return true;
  if (f === 'text') return /[a-zA-Z]/.test(raw) && !/^\d+(\.\d+)?$/.test(raw);
  if (f === 'number') {
    const normalized = normalizeQuestionNumericInput(raw);
    if (!normalized) return false;
    return /^-?\d+(\.\d+)?$/.test(normalized);
  }
  if (f === 'date') return !Number.isNaN(Date.parse(raw));
  if (f === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
  if (f === 'true_false') return /^(true|false|yes|no)$/i.test(raw);
  if (f === 'regex') {
    const pattern = String(regexPattern || '').trim();
    if (!pattern) return true;
    try {
      return new RegExp(pattern).test(raw);
    } catch (_) {
      return true;
    }
  }
  return true;
}

function normalizeTemplateButtons(buttons) {
  return (buttons || [])
    .map((b) => {
      if (typeof b === 'string') return { type: 'QUICK_REPLY', text: b };
      return {
        type: b?.type || 'QUICK_REPLY',
        text: b?.text || b?.title || '',
        url: b?.url,
        phone_number: b?.phone_number,
      };
    })
    .filter((b) => String(b.text || '').trim());
}

function getTemplateButtonsFromNodeData(data) {
  const parts = data?.templateParts;
  if (parts?.buttons?.length) return normalizeTemplateButtons(parts.buttons);
  if (Array.isArray(data?.templateButtons) && data.templateButtons.length) {
    return normalizeTemplateButtons(data.templateButtons);
  }
  // Some saved flows only store quick-reply labels on buttons / buttonsList.
  const fromList = getButtonsFromNodeData(data);
  if (fromList.length) return normalizeTemplateButtons(fromList);
  return [];
}

function parseFlowData(flow) {
  const raw = flow?.data;
  if (!raw) return { nodes: [], edges: [] };
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { nodes: [], edges: [] };
    }
  }
  return raw;
}

function findStartNodeId(nodes) {
  const start = (nodes || []).find((n) => n?.type === 'start');
  return start?.id || (nodes && nodes.length > 0 ? nodes[0].id : null);
}

function inferFlowResumeNodeId(flow, userInput) {
  const nodes = flow?.nodes || [];
  const questions = nodes.filter((n) => n.type === 'question');
  if (!questions.length) return null;
  if (questions.length === 1) return questions[0].id;

  const input = String(userInput || '').trim();
  if (!input) return questions[0].id;

  for (const q of questions) {
    const data = q.data || {};
    const format = data.attributeFormat || 'any';
    if (validateQuestionAnswerFormat(input, format, data.formatRegex)) {
      return q.id;
    }
  }

  return questions[0].id;
}

function normalizeButtonKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/');
}

function buttonsMatch(a, b) {
  const ka = normalizeButtonKey(a);
  const kb = normalizeButtonKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.replace(/\s/g, '') === kb.replace(/\s/g, '')) return true;

  const splitParts = (key) =>
    key
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean);
  const partsA = splitParts(ka);
  const partsB = splitParts(kb);
  if (partsA.length > 1 && partsA.includes(kb)) return true;
  if (partsB.length > 1 && partsB.includes(ka)) return true;
  if (partsA.length && partsB.length && partsA.join('/') === partsB.join('/')) return true;

  return false;
}

function flowInteractiveOptionIndex(userInput, optionCount) {
  const input = String(userInput || '').trim();
  const match = input.match(/^flow_(?:btn|opt)_(\d+)$/i);
  if (!match) return -1;
  const idx = Number(match[1]);
  if (!Number.isFinite(idx) || idx < 0 || idx >= optionCount) return -1;
  return idx;
}

function findMatchingTemplateButton(buttons, userInput) {
  const input = String(userInput || '').trim();
  if (!input) return null;
  const idx = flowInteractiveOptionIndex(input, buttons.length);
  if (idx >= 0) return buttons[idx];
  return (
    buttons.find((b) => buttonsMatch(b.text, input)) ||
    buttons.find((b) => buttonsMatch(b.payload, input)) ||
    buttons.find((b) => buttonsMatch(input, b.text)) ||
    null
  );
}

function pickEdgeForTemplateButton(outgoing, buttons, userInput) {
  const input = String(userInput || '').trim();
  if (!input || !Array.isArray(outgoing) || !outgoing.length) return null;

  const matched = findMatchingTemplateButton(buttons, input);
  const labelsToTry = [input, matched?.text].filter(Boolean);

  for (const label of labelsToTry) {
    const byLabel = outgoing.find((e) => buttonsMatch(e.label || e.data?.label, label));
    if (byLabel?.target) return byLabel.target;
  }

  if (matched) {
    const idx = buttons.findIndex((b) => buttonsMatch(b.text, matched.text));
    if (idx >= 0) {
      const byHandle = outgoing.find(
        (e) => String(e.sourceHandle || '') === `template-btn-${idx}`
      );
      if (byHandle?.target) return byHandle.target;
    }
  }

  return null;
}

function getOutgoingEdgesForNode(flowData, nodeId) {
  const edges = flowData?.edges || [];
  return edges.filter((e) => String(e.source) === String(nodeId));
}

function outgoingEdgeMatchesInput(outgoing, input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return false;
  return (outgoing || []).some((e) => {
    if (buttonsMatch(e.label || e.data?.label, trimmed)) return true;
    const idx = flowInteractiveOptionIndex(trimmed, 20);
    if (idx < 0) return false;
    const handle = String(e.sourceHandle || '');
    return (
      handle === `btn-${idx}` ||
      handle === `flow_btn_${idx}` ||
      handle === `flow_opt_${idx}` ||
      handle === `template-btn-${idx}`
    );
  });
}

function findFlowWaitNodeByButtonReply(flowData, text) {
  const nodes = flowData?.nodes || [];
  const edges = flowData?.edges || [];
  const input = String(text || '').trim();
  if (!input) return null;

  const startNode = nodes.find((n) => n.type === 'start');

  const edgeMatchesInput = (outgoing) => outgoingEdgeMatchesInput(outgoing, input);

  const matchNode = (node) => {
    const outgoing = edges.filter((e) => String(e.source) === String(node.id));
    const edgeHit = edgeMatchesInput(outgoing);

    if (node.type === 'button' || node.type === 'image' || node.type === 'media') {
      const data = node.data || {};
      const buttons = getButtonsFromNodeData(data);
      const idxFromId = flowInteractiveOptionIndex(input, buttons.length);
      const buttonHit =
        idxFromId >= 0 || buttons.some((b) => buttonsMatch(b, input));
      if (buttonHit || edgeHit) return node.id;
      return null;
    }

    if (node.type === 'question') {
      const data = node.data || {};
      const templateButtons = getTemplateButtonsFromNodeData(data);
      if (templateButtons.length && findMatchingTemplateButton(templateButtons, input)) {
        return node.id;
      }
      const options = parseCommaList(data.options);
      const optionHit = options.some((o) => buttonsMatch(o, input));
      if (optionHit || edgeHit) return node.id;
      return null;
    }

    if (node.type === 'start' || node.type === 'template') {
      const data = node.data || {};
      const buttons = getTemplateButtonsFromNodeData(data);
      if (buttons.length && findMatchingTemplateButton(buttons, input)) {
        return node.id;
      }
      if (edgeHit) return node.id;
    }

    return null;
  };

  // Prefer interactive wait nodes (image/button/media/question) over start/template.
  // flow_btn_0 on an image node must not match template-btn-0 on the start node.
  for (const node of nodes) {
    if (node.type === 'start' || node.type === 'template') continue;
    const hit = matchNode(node);
    if (hit) return hit;
  }

  for (const node of nodes) {
    if (node.type !== 'start' && node.type !== 'template') continue;
    const hit = matchNode(node);
    if (hit) return hit;
  }

  if (startNode) {
    const outgoing = edges.filter((e) => String(e.source) === String(startNode.id));
    if (outgoing.some((e) => buttonsMatch(e.label || e.data?.label, input))) {
      return startNode.id;
    }
  }

  return null;
}

function normalizeStartKeywords(raw) {
  if (Array.isArray(raw)) {
    return raw.map((k) => String(k || '').trim()).filter(Boolean);
  }
  return parseCommaList(raw || '');
}

function isStartTemplateButtonEdge(edge) {
  const handle = String(edge?.sourceHandle || '');
  return handle === 'start-header-source' || handle.startsWith('template-btn-');
}

/** Bottom blue-dot path from Flow Start (keyword entry), not template quick-reply edges. */
function pickStartKeywordFlowTarget(outgoing) {
  const list = outgoing || [];
  if (!list.length) return null;
  const bottom = list.find((e) => String(e.sourceHandle || '') === 'start-bottom-source');
  if (bottom?.target) return bottom.target;
  const main = list.find((e) => !isStartTemplateButtonEdge(e));
  if (main?.target) return main.target;
  return list[0]?.target || null;
}

function matchesStartTrigger(startData, text) {
  const input = String(text || '').trim();
  if (!input) return false;

  if (startData?.regexEnabled && startData?.regex) {
    try {
      const re = new RegExp(startData.regex, 'i');
      if (re.test(input)) return true;
    } catch (_) {
      /* invalid regex */
    }
  }

  const keywords = normalizeStartKeywords(startData?.keywords);
  if (keywords.length) {
    const lower = input.toLowerCase();
    return keywords.some((k) => {
      const key = String(k || '').trim().toLowerCase();
      if (!key) return false;
      if (lower === key) return true;
      if (lower.includes(key)) return true;
      try {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(input);
      } catch (_) {
        return false;
      }
    });
  }

  return false;
}

function getMediaUrlFromNodeData(data) {
  return String(data?.mediaUrl || data?.imageUrl || data?.url || '').trim();
}

function getButtonsFromNodeData(data) {
  const list = Array.isArray(data?.buttonsList)
    ? data.buttonsList
    : parseCommaList(data?.buttons || '');
  return list.map((b) => String(b || '').trim()).filter(Boolean);
}

function pickEdgeForFlowButtons(outgoing, buttons, userInput) {
  const input = String(userInput || '').trim();
  const list = outgoing || [];

  const slug = normalizeButtonKey(input).replace(/\s+/g, '_');
  const handleKeys = new Set(
    [input, slug, `btn-${slug}`, `btn_${slug}`, slug.replace(/\//g, '_')]
      .filter(Boolean)
      .map((k) => String(k).toLowerCase())
  );
  for (const edge of list) {
    const handle = String(edge.sourceHandle || '').toLowerCase();
    if (handle && handleKeys.has(handle)) return edge.target;
  }

  const idxFromId = flowInteractiveOptionIndex(input, buttons.length);
  if (idxFromId >= 0) {
    const byHandle = list.find(
      (e) => String(e.sourceHandle || '') === `btn-${idxFromId}`
    );
    if (byHandle?.target) return byHandle.target;
    const label = buttons[idxFromId];
    const byLabel = list.find((e) =>
      buttonsMatch(e.label || e.data?.label, label)
    );
    if (byLabel?.target) return byLabel.target;
  }

  const matched = buttons.find((b) => buttonsMatch(b, input));
  if (matched) {
    const idx = buttons.findIndex((b) => buttonsMatch(b, matched));
    if (idx >= 0) {
      const byHandle = list.find(
        (e) => String(e.sourceHandle || '') === `btn-${idx}`
      );
      if (byHandle?.target) return byHandle.target;
    }
    const byLabel = list.find((e) =>
      buttonsMatch(e.label || e.data?.label, matched)
    );
    if (byLabel?.target) return byLabel.target;
  }

  return pickEdgeForTemplateButton(list, buttons.map((t) => ({ text: t })), input) || null;
}

function isFlowInteractiveReplyId(value) {
  return /^flow_(?:btn|opt)_\d+$/i.test(String(value || '').trim());
}

function sortFlowReplyCandidates(candidates) {
  return [...(candidates || [])]
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .sort((a, b) => {
      const aId = isFlowInteractiveReplyId(a);
      const bId = isFlowInteractiveReplyId(b);
      if (aId === bId) return 0;
      return aId ? 1 : -1;
    });
}

function candidateMatchesWaitNode(node, candidate, flowData) {
  if (!node || !candidate) return false;
  const input = String(candidate).trim();
  const data = node.data || {};
  const outgoing = flowData ? getOutgoingEdgesForNode(flowData, node.id) : [];
  const edgeHit = outgoingEdgeMatchesInput(outgoing, input);

  if (node.type === 'button' || node.type === 'image' || node.type === 'media') {
    const buttons = getButtonsFromNodeData(data);
    if (flowInteractiveOptionIndex(input, buttons.length) >= 0) return true;
    if (buttons.some((b) => buttonsMatch(b, input))) return true;
    return edgeHit;
  }

  if (node.type === 'question') {
    const templateButtons = getTemplateButtonsFromNodeData(data);
    if (templateButtons.length && findMatchingTemplateButton(templateButtons, input)) {
      return true;
    }
    const options = parseCommaList(data.options);
    if (flowInteractiveOptionIndex(input, options.length) >= 0) return true;
    if (options.some((o) => buttonsMatch(o, input))) return true;
    return edgeHit;
  }

  if (node.type === 'start' || node.type === 'template') {
    const buttons = getTemplateButtonsFromNodeData(data);
    if (buttons.length && findMatchingTemplateButton(buttons, input)) return true;
    return edgeHit;
  }

  return false;
}

function isFlowButtonWaitNode(flowData, nodeId) {
  if (!nodeId) return false;
  const nodes = flowData?.nodes || [];
  const edges = flowData?.edges || [];
  const node = nodes.find((n) => String(n.id) === String(nodeId));
  if (!node) return false;
  const data = node.data || {};
  const outgoing = edges.filter((e) => String(e.source) === String(node.id));

  if (node.type === 'button') {
    return getButtonsFromNodeData(data).length > 0;
  }
  if (node.type === 'image' || node.type === 'media') {
    return getButtonsFromNodeData(data).length > 0;
  }
  if (node.type === 'start' || node.type === 'template') {
    return templateNodeShouldWait(data, outgoing);
  }
  if (node.type === 'question') {
    const templateButtons = getTemplateButtonsFromNodeData(data);
    const options = parseCommaList(data.options);
    return templateButtons.length > 0 || options.filter(Boolean).length > 0;
  }
  return false;
}

/**
 * When customer taps a quick-reply / interactive button, find which wait node
 * owns that button and which reply text to feed into runFlow.
 */
function resolveFlowResumeFromButtonReply(flowData, candidates, sessionNodeId) {
  const texts = sortFlowReplyCandidates(candidates);
  if (!texts.length) {
    return { waitNodeId: sessionNodeId || null, userInput: '', matched: false };
  }

  const nodes = flowData?.nodes || [];

  const tryMatchOnNode = (nodeId) => {
    const sessionNode = nodes.find((n) => String(n.id) === String(nodeId));
    if (!sessionNode) return null;

    for (const candidate of texts) {
      if (candidateMatchesWaitNode(sessionNode, candidate, flowData)) {
        return { waitNodeId: nodeId, userInput: candidate, matched: true };
      }
    }

    // Same rules as findFlowWaitNodeByButtonReply — confirm this node owns the reply.
    for (const candidate of texts) {
      const waitId = findFlowWaitNodeByButtonReply(flowData, candidate);
      if (waitId && String(waitId) === String(nodeId)) {
        return { waitNodeId: nodeId, userInput: candidate, matched: true };
      }
    }

    if (sessionNode.type === 'question') {
      const data = sessionNode.data || {};
      const templateButtons = getTemplateButtonsFromNodeData(data);
      const options = parseCommaList(data.options);
      const isOptionQuestion =
        options.filter(Boolean).length > 0 || templateButtons.length > 0;
      if (!isOptionQuestion) {
        return { waitNodeId: nodeId, userInput: texts[0], matched: true };
      }
    }

    if (!isFlowButtonWaitNode(flowData, nodeId)) {
      return { waitNodeId: nodeId, userInput: texts[0], matched: true };
    }

    return { waitNodeId: nodeId, userInput: '', matched: false };
  };

  if (sessionNodeId) {
    const onSession = tryMatchOnNode(sessionNodeId);
    if (onSession?.matched) return onSession;
  }

  for (const candidate of texts) {
    const waitId = findFlowWaitNodeByButtonReply(flowData, candidate);
    if (waitId) {
      return { waitNodeId: waitId, userInput: candidate, matched: true };
    }
  }

  return { waitNodeId: sessionNodeId || null, userInput: '', matched: false };
}

function templateNodeShouldWait(data, outgoing) {
  const buttons = getTemplateButtonsFromNodeData(data);
  if (!buttons.length) return false;
  if ((outgoing || []).length === 0) return true;
  return (outgoing || []).some(
    (e) =>
      String(e.sourceHandle || '').startsWith('template-btn') ||
      buttons.some((b) => buttonsMatch(e.label || e.data?.label, b.text))
  );
}

/**
 * Execute a saved flow graph. Returns output steps to send and next wait node.
 */
function runFlow(flow, { userInput, currentNodeId, entryViaKeyword = false } = {}) {
  const nodes = flow?.nodes || [];
  const edges = flow?.edges || [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outgoingBySource = new Map();
  edges.forEach((e) => {
    const list = outgoingBySource.get(e.source) || [];
    list.push(e);
    outgoingBySource.set(e.source, list);
  });

  const startNode = nodes.find((n) => n.type === 'start');
  let nodeId = currentNodeId || startNode?.id || nodes[0]?.id || null;
  const output = [];
  const visited = new Set();
  let steps = 0;

  const pickEdge = (outgoing, label, handleId) => {
    const list = outgoing || [];
    if (handleId) {
      const byHandle = list.find((e) => String(e.sourceHandle || '') === String(handleId));
      if (byHandle?.target) return byHandle.target;
    }
    if (label) {
      const byLabel = list.find((e) =>
        buttonsMatch(e.label || e.data?.label, label)
      );
      if (byLabel?.target) return byLabel.target;
      const desired = String(label).trim().toLowerCase();
      const byLabelLoose = list.find(
        (e) => String(e.label || e.data?.label || '').trim().toLowerCase() === desired
      );
      if (byLabelLoose?.target) return byLabelLoose.target;
    }
    return list[0]?.target || null;
  };

  let inputConsumed = false;
  const shouldConsume = (id) =>
    !inputConsumed &&
    String(currentNodeId || '').trim() &&
    String(id) === String(currentNodeId) &&
    userInput !== undefined &&
    userInput !== null &&
    String(userInput).trim() !== '';

  while (nodeId && steps < 40) {
    steps += 1;
    if (visited.has(nodeId) && nodeId !== currentNodeId) break;
    visited.add(nodeId);

    const node = nodeById.get(nodeId);
    if (!node) break;
    const outgoing = outgoingBySource.get(nodeId) || [];
    const firstTarget = outgoing[0]?.target || null;
    const data = node.data || {};

    if (node.type === 'start') {
      const keywordEntry =
        entryViaKeyword ||
        (userInput !== undefined &&
          userInput !== null &&
          String(userInput).trim() !== '' &&
          matchesStartTrigger(data, userInput));

      if (keywordEntry) {
        if (data.templateName || data.templateParts) {
          output.push({
            type: 'template',
            nodeId: node.id,
            templateName: data.templateName,
            templateParts: data.templateParts,
            templateContent: data.templateContent,
            headerMediaUrl: data.header_media_url || null,
            templateLanguage: data.templateLanguage || 'en_US',
            buttons: getTemplateButtonsFromNodeData(data).map((b) => b.text),
          });
          return { output, nextNodeId: nodeId, done: false };
        }
        const flowTarget = pickStartKeywordFlowTarget(outgoing) || firstTarget;
        if (flowTarget) {
          inputConsumed = true;
          nodeId = flowTarget;
          continue;
        }
        return { output, nextNodeId: nodeId, done: false };
      }

      if (shouldConsume(nodeId)) {
        const buttons = getTemplateButtonsFromNodeData(data);
        const nextTarget = pickEdgeForTemplateButton(outgoing, buttons, userInput);
        if (!nextTarget) {
          return { output, nextNodeId: nodeId, done: false };
        }
        inputConsumed = true;
        nodeId = nextTarget;
        continue;
      }
      if (data.templateName || data.templateParts) {
        output.push({
          type: 'template',
          nodeId: node.id,
          templateName: data.templateName,
          templateParts: data.templateParts,
          templateContent: data.templateContent,
          headerMediaUrl: data.header_media_url || null,
          templateLanguage: data.templateLanguage || 'en_US',
          buttons: getTemplateButtonsFromNodeData(data).map((b) => b.text),
        });
        return { output, nextNodeId: nodeId, done: false };
      }
      nodeId = firstTarget;
      continue;
    }

    if (node.type === 'template') {
      if (shouldConsume(nodeId)) {
        const buttons = getTemplateButtonsFromNodeData(data);
        const nextTarget = pickEdgeForTemplateButton(outgoing, buttons, userInput);
        if (!nextTarget) {
          return { output, nextNodeId: nodeId, done: false };
        }
        inputConsumed = true;
        nodeId = nextTarget;
        continue;
      }
      if (data.templateName || data.templateParts) {
        output.push({
          type: 'template',
          nodeId: node.id,
          templateName: data.templateName,
          templateParts: data.templateParts,
          templateContent: data.templateContent,
          headerMediaUrl: data.header_media_url || data.headerMediaUrl || null,
          templateLanguage: data.templateLanguage || 'en_US',
          buttons: getTemplateButtonsFromNodeData(data).map((b) => b.text),
        });
        return { output, nextNodeId: nodeId, done: false };
      }
      if (templateNodeShouldWait(data, outgoing)) {
        return { output, nextNodeId: nodeId, done: false };
      }
      nodeId = firstTarget;
      continue;
    }

    if (node.type === 'text' || node.type === 'single_product') {
      output.push({
        type: 'text',
        nodeId: node.id,
        text: data.body || data.text || data.message || '',
        footer: data.footer || '',
        productName: data.productName || '',
      });
      nodeId = firstTarget;
      continue;
    }

    if (node.type === 'set_attribute') {
      output.push({
        type: 'set_attribute',
        nodeId: node.id,
        attribute: data.attribute || '',
        value: data.attributeValue || '',
      });
      nodeId = firstTarget;
      continue;
    }

    if (node.type === 'image' || node.type === 'media') {
      const mediaUrl = getMediaUrlFromNodeData(data);
      const buttons = getButtonsFromNodeData(data);
      const caption = data.caption || data.body || data.text || '';

      if (!shouldConsume(nodeId)) {
        if (mediaUrl || buttons.length) {
          output.push({
            type: 'media',
            nodeId: node.id,
            mediaType: data.mediaType || 'IMAGE',
            mediaUrl,
            caption,
            text: caption,
            buttons,
          });
        }
        if (buttons.length > 0) {
          return { output, nextNodeId: nodeId, done: false };
        }
        nodeId = firstTarget;
        continue;
      }

      const nextTarget = pickEdgeForFlowButtons(outgoing, buttons, userInput);
      if (!nextTarget) {
        return { output, nextNodeId: nodeId, done: false };
      }
      inputConsumed = true;
      nodeId = nextTarget;
      continue;
    }

    if (node.type === 'button') {
      const buttons = getButtonsFromNodeData(data);
      if (!shouldConsume(nodeId)) {
        output.push({
          type: 'button',
          nodeId: node.id,
          text: data.text || data.message || '',
          buttons,
        });
        return { output, nextNodeId: nodeId, done: false };
      }
      const nextTarget = pickEdgeForFlowButtons(outgoing, buttons, userInput);
      if (!nextTarget) {
        return { output, nextNodeId: nodeId, done: false };
      }
      inputConsumed = true;
      nodeId = nextTarget;
      continue;
    }

    if (node.type === 'list_message') {
      output.push({
        type: 'list',
        nodeId: node.id,
        header: data.header || '',
        body: data.body || data.title || '',
        footer: data.footer || '',
        listButton: data.listButton || 'list',
        sections: data.sections || [],
      });
      nodeId = firstTarget;
      continue;
    }

    if (node.type === 'multi_product') {
      output.push({
        type: 'multi_product',
        nodeId: node.id,
        header: data.header || data.title || '',
        body: data.body || '',
        footer: data.footer || '',
        products: Array.isArray(data.productsList) ? data.productsList : parseCommaList(data.products),
      });
      nodeId = firstTarget;
      continue;
    }

    if (node.type === 'question') {
      const options = parseCommaList(data.options);
      const templateButtons = getTemplateButtonsFromNodeData(data);
      const hasTemplate = Boolean(data.templateName || data.templateParts);
      const isOptionQuestion =
        options.filter(Boolean).length > 0 || templateButtons.length > 0;

      const pushQuestionPrompt = () => {
        if (hasTemplate) {
          output.push({
            type: 'template',
            nodeId: node.id,
            templateName: data.templateName,
            templateParts: data.templateParts,
            templateContent: data.templateContent || data.question || '',
            headerMediaUrl: data.header_media_url || data.headerMediaUrl || null,
            templateLanguage: data.templateLanguage || 'en_US',
            buttons: templateButtons.map((b) => b.text),
          });
        } else {
          output.push({
            type: 'question',
            nodeId: node.id,
            question: data.question || '',
            options,
          });
        }
      };

      if (!shouldConsume(nodeId)) {
        pushQuestionPrompt();
        return { output, nextNodeId: nodeId, done: false };
      }

      const input = String(userInput).trim();
      const pushQuestionValidationError = () => {
        const format = data.attributeFormat || 'any';
        const errMsg =
          data.formatErrorMessage ||
          defaultQuestionFormatErrorMessage(isOptionQuestion ? 'any' : format);
        output.push({
          type: 'error',
          nodeId: node.id,
          message: errMsg,
        });
        pushQuestionPrompt();
        return { output, nextNodeId: nodeId, done: false };
      };

      if (hasTemplate && templateButtons.length) {
        const matched = findMatchingTemplateButton(templateButtons, input);
        if (!matched) {
          return pushQuestionValidationError();
        }
        inputConsumed = true;
        const captureKey = String(data.captureAttribute || '').trim();
        if (captureKey) {
          output.push({
            type: 'set_attribute',
            nodeId: node.id,
            attribute: captureKey,
            value: matched.text || input,
          });
        }
        const nextTarget = pickEdgeForTemplateButton(outgoing, templateButtons, input);
        if (!nextTarget) {
          return { output, nextNodeId: nodeId, done: false };
        }
        nodeId = nextTarget;
        continue;
      }

      if (!isOptionQuestion) {
        const format = data.attributeFormat || 'any';
        if (!validateQuestionAnswerFormat(input, format, data.formatRegex)) {
          return pushQuestionValidationError();
        }
        inputConsumed = true;
        let acceptedAnswer = input;
        if (String(format).toLowerCase() === 'number') {
          acceptedAnswer = normalizeQuestionNumericInput(input);
        }
        const captureKey = String(data.captureAttribute || '').trim();
        if (captureKey) {
          output.push({
            type: 'set_attribute',
            nodeId: node.id,
            attribute: captureKey,
            value: acceptedAnswer,
          });
        }
        nodeId = firstTarget;
        continue;
      }

      const matched = options.find((o) => buttonsMatch(o, input));
      if (!matched) {
        return pushQuestionValidationError();
      }
      inputConsumed = true;
      const captureKey = String(data.captureAttribute || '').trim();
      if (captureKey) {
        output.push({
          type: 'set_attribute',
          nodeId: node.id,
          attribute: captureKey,
          value: matched,
        });
      }
      nodeId =
        pickEdgeForFlowButtons(outgoing, options, input) ||
        pickEdge(outgoing, matched);
      if (!nodeId) {
        return { output, nextNodeId: node.id, done: false };
      }
      continue;
    }

    break;
  }

  return { output, nextNodeId: null, done: true };
}

module.exports = {
  runFlow,
  parseFlowData,
  parseCommaList,
  matchesStartTrigger,
  findStartNodeId,
  inferFlowResumeNodeId,
  normalizeQuestionNumericInput,
  validateQuestionAnswerFormat,
  getTemplateButtonsFromNodeData,
  findFlowWaitNodeByButtonReply,
  resolveFlowResumeFromButtonReply,
  pickEdgeForFlowButtons,
  pickEdgeForTemplateButton,
  isFlowButtonWaitNode,
  buttonsMatch,
  normalizeButtonKey,
  getMediaUrlFromNodeData,
  templateNodeShouldWait,
};
