import clusterScope from '../../shared/cluster-scope.json' with { type: 'json' };

export const CARD_COUNT = clusterScope.cardsPerNode;
export const MONITORED_NODE_NAMES = clusterScope.nodeIds.map(node => `node${node}`);
export const MONITORED_NODE_SET = new Set(MONITORED_NODE_NAMES);

export function nodeName(value) {
  const normalized = String(value || '');
  const node = normalized.match(/^(?:gpu-)?node-?(\d+)$/i);
  if (node) return `node${Number(node[1])}`;
  const bdc = normalized.match(/^bdc-?(\d+)$/i);
  return bdc ? `bdc${Number(bdc[1])}` : null;
}

export function botType(bot) {
  return String(bot?.bot_type || bot?.type || 'NODE').toUpperCase();
}

function isActiveLock(state) {
  return state?.status !== 'idle' && Array.isArray(state?.current_users) && state.current_users.length > 0;
}

function addUsers(target, users) {
  const known = new Set(target.map(user => `${user?.user_id || ''}:${user?.start_time || ''}:${user?.duration || ''}`));
  for (const user of users || []) {
    const key = `${user?.user_id || ''}:${user?.start_time || ''}:${user?.duration || ''}`;
    if (!known.has(key)) {
      known.add(key);
      target.push(user);
    }
  }
}

/**
 * Normalize all successful Lock Bot states into one card-granular state per monitored node.
 * A NODE/QUEUE lock occupies all cards; DEVICE locks occupy only their declared card.
 */
export function mergeLockBotStates(stateResults) {
  const cardsByNode = new Map(MONITORED_NODE_NAMES.map(name => [
    name,
    Array.from({ length: CARD_COUNT }, (_, devId) => ({ dev_id: devId, status: 'idle', current_users: [] })),
  ]));
  const failedBotIds = [];

  for (const result of stateResults || []) {
    if (!result?.ok) {
      failedBotIds.push(result?.bot?.id ?? result?.botId ?? 'unknown');
      continue;
    }
    const type = botType(result.bot || { bot_type: result.type });
    for (const [rawName, rawState] of Object.entries(result.state || {})) {
      const name = nodeName(rawName);
      const cards = cardsByNode.get(name);
      if (!cards) continue;
      const deviceStates = type === 'DEVICE' && Array.isArray(rawState)
        ? rawState
        : Array.from({ length: CARD_COUNT }, (_, devId) => ({ ...rawState, dev_id: devId }));
      for (const device of deviceStates) {
        const devId = Number(device?.dev_id);
        if (!Number.isInteger(devId) || devId < 0 || devId >= CARD_COUNT || !isActiveLock(device)) continue;
        const card = cards[devId];
        card.status = 'exclusive';
        addUsers(card.current_users, device.current_users);
      }
    }
  }

  return {
    deviceState: Object.fromEntries(cardsByNode),
    lockStateComplete: failedBotIds.length === 0,
    failedBotIds,
  };
}
