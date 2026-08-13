"use strict";

/*
 * Shared, in-game-only timeline for decision and chat context.
 *
 * This module deliberately stores semantic facts instead of GameEvent/Card
 * objects. Card identities are retained only when the event itself proves that
 * they were public, or for an explicitly entitled viewer. Unknown cards remain
 * counts. The store is never persisted to disk.
 */

const PHASE_NAMES = new Set([
  "phaseZhunbei", "phaseJudge", "phaseDraw", "phaseUse", "phaseDiscard", "phaseJieshu",
]);
const DIRECT_EVENT_KINDS = new Set([
  "phase", "useCard", "respond", "useSkill", "damage", "recover", "die", "judge", "showCards",
]);
const CARD_MOVE_NAMES = new Set([
  "lose", "gain", "cardsDiscard", "cardsGotoOrdering", "cardsGotoSpecial", "cardsGotoPile",
]);
const ACTION_ROOT_KINDS = new Set(["useCard", "respond", "useSkill", "damage", "recover", "die", "judge"]);

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function playerId(player) {
  if (!player) return "";
  return stringValue(player.playerid || player.id || player.name || player.name1);
}

function playerFact(player, runtime) {
  if (!player) return null;
  let name = "";
  let seat = null;
  try {
    const hidden = typeof player.isUnseen === "function" && player.isUnseen(0);
    if (!hidden) {
      if (runtime && typeof runtime.playerLabel === "function") name = stringValue(runtime.playerLabel(player));
      if (!name) name = stringValue(player.displayName || player.name || player.name1);
    }
  } catch (_) { }
  try {
    const rawSeat = typeof player.getSeatNum === "function" ? player.getSeatNum() : player.seatNum;
    if (Number.isFinite(Number(rawSeat))) seat = Number(rawSeat);
  } catch (_) { }
  return {
    id: runtime && typeof runtime.playerKey === "function"
      ? stringValue(runtime.playerKey(player))
      : playerId(player),
    seat,
    name: name || "未公开角色",
  };
}

function uniquePlayerFacts(players, runtime) {
  const result = [];
  const seen = new Set();
  for (const player of players || []) {
    const fact = playerFact(player, runtime);
    if (!fact || !fact.id || seen.has(fact.id)) continue;
    seen.add(fact.id);
    result.push(fact);
  }
  return result;
}

function parentOf(event) {
  if (!event) return null;
  try {
    if (event.parent && event.parent !== event) return event.parent;
    if (typeof event.getParent === "function") {
      const parent = event.getParent();
      if (parent && parent !== event) return parent;
    }
  } catch (_) { /* invalid/mutating event; leave it unlinked */ }
  return null;
}

function ancestorsOf(event, includeSelf = true) {
  const result = [];
  let current = includeSelf ? event : parentOf(event);
  for (let depth = 0; current && depth < 30; depth++) {
    if (result.includes(current)) break;
    result.push(current);
    current = parentOf(current);
  }
  return result;
}

function canonicalKind(event, sourceKind) {
  if (!event) return null;
  const name = stringValue(event.name);
  if (sourceKind === "cardMove" || CARD_MOVE_NAMES.has(name)) return "cardMove";
  if (PHASE_NAMES.has(name)) return "phaseStep";
  return DIRECT_EVENT_KINDS.has(name) ? name : null;
}

function eventCards(event) {
  const result = [];
  if (event && event.card) result.push(event.card);
  if (event && Array.isArray(event.cards)) result.push(...event.cards);
  const seen = new Set();
  return result.filter(card => {
    if (!card || typeof card !== "object") return false;
    if (seen.has(card)) return false;
    seen.add(card);
    return true;
  });
}

function cardNameFact(card) {
  if (!card) return null;
  return {
    id: stringValue(card.cardid || card.id),
    name: stringValue(card.name || "未知牌"),
    nature: Array.isArray(card.nature) ? card.nature.map(stringValue).join("+") : stringValue(card.nature),
    suit: stringValue(card.suit),
    number: card.number === undefined ? null : card.number,
  };
}

function areaName(value, runtime) {
  if (!value) return "";
  if (runtime && typeof runtime.areaName === "function") {
    try {
      const result = runtime.areaName(value);
      if (result) return stringValue(result);
    } catch (_) { /* fall through */ }
  }
  if (typeof value === "string") return value;
  return stringValue(value.id || value.name || (value.classList && value.classList.value));
}

function knowerIds(value) {
  const result = new Set();
  const add = item => {
    const id = typeof item === "string" ? item : playerId(item);
    if (id) result.add(id);
  };
  if (Array.isArray(value)) value.forEach(add);
  else if (value && typeof value !== "string" && value[Symbol.iterator]) {
    try { Array.from(value).forEach(add); } catch (_) { /* ignored */ }
  } else if (value) add(value);
  return result;
}

function eventPublicCardEvidence(event, card, kind, cardRole, runtime) {
  if (cardRole === "action" || kind === "judge" || kind === "showCards") return true;
  if (event && event.visible === true) return true;
  const name = stringValue(event && event.name);
  const type = stringValue(event && event.type);
  if ((kind === "useCard" || kind === "respond") && cardRole === "material") return true;
  if (name === "cardsDiscard") return true;
  if (name === "lose" && ["discard", "use", "respond"].includes(type)) return true;
  if (name === "lose") {
    const destination = areaName(event.position, runtime);
    if (/discard|ordering/i.test(destination)) return true;
    if (Array.isArray(event.es) && event.es.includes(card)) return true;
    if (Array.isArray(event.js) && event.js.includes(card)) return true;
  }
  return false;
}

function viewerIdsForCard(event, card, kind, cardRole, runtime, publicCard) {
  const visibleTo = new Set();
  if (publicCard) visibleTo.add("everyone");

  const receiver = event && event.player;
  const owner = card && (card.owner || card._owner);
  const name = stringValue(event && event.name);
  const active = runtime && isEventActive(event, runtime.currentEvent);
  if (name === "gain" && receiver) visibleTo.add(playerId(receiver));
  if (name === "lose" && receiver) visibleTo.add(playerId(receiver));
  if (active && owner) visibleTo.add(playerId(owner));
  knowerIds(event && event.knowers).forEach(id => visibleTo.add(id));
  if (active) knowerIds(card && card._knowers).forEach(id => visibleTo.add(id));

  // Current-engine knowledge is safe only while the event is on the active
  // stack. Applying it to sealed historical events would retroactively reveal
  // which old hidden draw later became public.
  if (active && Array.isArray(runtime.viewers)) {
    for (const viewer of runtime.viewers) {
      try {
        if (card && typeof card.isKnownBy === "function" && card.isKnownBy(viewer)) {
          visibleTo.add(playerId(viewer));
        }
      } catch (_) { /* default remains hidden */ }
    }
  }
  visibleTo.delete("");
  return Array.from(visibleTo).sort();
}

function cardVisibilityFact(event, card, kind, cardRole, runtime) {
  const publicCard = eventPublicCardEvidence(event, card, kind, cardRole, runtime);
  return {
    card: cardNameFact(card),
    visibleTo: viewerIdsForCard(event, card, kind, cardRole, runtime, publicCard),
  };
}

function mergeVisibleCardFacts(previous, next) {
  const oldByKey = new Map();
  for (const item of previous || []) {
    const key = item.card.id || [item.card.name, item.card.suit, item.card.number].join("|");
    oldByKey.set(key, item);
  }
  return (next || []).map(item => {
    const key = item.card.id || [item.card.name, item.card.suit, item.card.number].join("|");
    const old = oldByKey.get(key);
    if (!old) return item;
    item.visibleTo = Array.from(new Set([...(old.visibleTo || []), ...(item.visibleTo || [])])).sort();
    return item;
  });
}

function createTimelineStore(options = {}) {
  return {
    records: [],
    byId: new Map(),
    eventIds: new WeakMap(),
    nextEventId: 1,
    nextSeq: 1,
    historyRef: null,
    lastRoundNumber: 0,
    lastPhaseNumber: 0,
    maxRecords: Math.max(0, Number(options.maxRecords ?? 240) || 0),
    cutoffSeq: Math.max(0, Number(options.cutoffSeq || 0) || 0),
    ignoredEvents: new WeakSet(),
    trimmedEventIds: new Set(),
  };
}

function resetTimeline(store) {
  store.records.length = 0;
  store.byId.clear();
  store.eventIds = new WeakMap();
  store.nextEventId = 1;
  store.nextSeq = 1;
  store.historyRef = null;
  store.lastRoundNumber = 0;
  store.lastPhaseNumber = 0;
  store.cutoffSeq = 0;
  store.ignoredEvents = new WeakSet();
  store.trimmedEventIds = new Set();
  return store;
}

function clearTimelineBeforeNow(store, globalHistory) {
  const buckets = Array.isArray(globalHistory) ? globalHistory : [];
  for (const bucket of buckets) {
    for (const listName of ["everything", "cardMove"]) {
      for (const event of Array.isArray(bucket && bucket[listName]) ? bucket[listName] : []) {
        if (event && typeof event === "object") store.ignoredEvents.add(event);
      }
    }
  }
  store.records.length = 0;
  store.byId.clear();
  store.cutoffSeq = store.nextSeq;
  return store;
}

function trimTimeline(store, maxRecords) {
  const limit = Math.max(0, Number(maxRecords ?? store.maxRecords) || 0);
  store.maxRecords = limit;
  const removeCount = limit === 0 ? store.records.length : Math.max(0, store.records.length - limit);
  if (!removeCount) return 0;
  const removed = store.records.splice(0, removeCount);
  for (const record of removed) {
    store.byId.delete(record.eventId);
    store.trimmedEventIds.add(record.eventId);
  }
  return removed.length;
}

function ensureEventId(store, event) {
  if (!event || (typeof event !== "object" && typeof event !== "function")) return "";
  let id = store.eventIds.get(event);
  if (!id) {
    id = "evt-" + store.nextEventId++;
    store.eventIds.set(event, id);
  }
  return id;
}

function isEventActive(event, currentEvent) {
  return !!event && ancestorsOf(currentEvent).includes(event);
}

function nearestAncestorByKind(event, predicate) {
  for (const current of ancestorsOf(event)) {
    const kind = canonicalKind(current);
    if (kind && predicate(kind, current)) return current;
  }
  return null;
}

function phaseForEvent(event) {
  const phase = nearestAncestorByKind(event, kind => kind === "phaseStep");
  return phase ? stringValue(phase.name) : "";
}

function actorAndTargets(event, kind, runtime) {
  let actor = event.player || event.source || null;
  let targets = Array.isArray(event.targets) ? event.targets.slice() : (event.target ? [event.target] : []);
  if (["damage", "recover", "die"].includes(kind)) {
    actor = event.source || null;
    targets = event.player ? [event.player] : targets;
  } else if (kind === "cardMove") {
    actor = event.player || event.source || null;
    if (!targets.length && event.toPlayer) targets = [event.toPlayer];
  }
  return { actor: playerFact(actor, runtime), targets: uniquePlayerFacts(targets, runtime) };
}

function recordCards(event, kind, runtime) {
  if (kind === "useCard" || kind === "respond") {
    const result = [];
    if (event.card) result.push(Object.assign({ role: "action" }, cardVisibilityFact(event, event.card, kind, "action", runtime)));
    for (const card of Array.isArray(event.cards) ? event.cards : []) {
      if (card === event.card) continue;
      result.push(Object.assign({ role: "material" }, cardVisibilityFact(event, card, kind, "material", runtime)));
    }
    return result;
  }
  return eventCards(event).map(card => Object.assign(
    { role: kind === "judge" || kind === "showCards" ? "action" : "material" },
    cardVisibilityFact(event, card, kind, kind === "judge" || kind === "showCards" ? "action" : "material", runtime),
  ));
}

function roundByBucket(globalHistory, currentRound) {
  const rounds = new Array(globalHistory.length).fill(Number(currentRound) || 0);
  let round = Number(currentRound) || 0;
  for (let index = globalHistory.length - 1; index >= 0; index--) {
    rounds[index] = round;
    if (index > 0 && globalHistory[index] && globalHistory[index].isRound) round = Math.max(0, round - 1);
  }
  return rounds;
}

function normalizeEvent(store, event, sourceKind, runtime = {}, bucketIndex = 0, bucketRound = 0) {
  const kind = canonicalKind(event, sourceKind);
  if (!kind) return null;
  const eventId = ensureEventId(store, event);
  const parent = nearestAncestorByKind(parentOf(event), () => true);
  const phaseRoot = nearestAncestorByKind(event, currentKind => currentKind === "phase");
  const consequence = ["damage", "recover", "die", "cardMove"].includes(kind);
  const actionRoot = consequence
    ? nearestAncestorByKind(parentOf(event), currentKind => ACTION_ROOT_KINDS.has(currentKind)) || event
    : nearestAncestorByKind(event, currentKind => ACTION_ROOT_KINDS.has(currentKind)) || event;
  const { actor, targets } = actorAndTargets(event, kind, runtime);
  const cards = recordCards(event, kind, runtime);
  const name = stringValue(event.name);
  const info = runtime && typeof runtime.getInfo === "function" && event.skill
    ? (() => { try { return runtime.getInfo(event.skill) || {}; } catch (_) { return {}; } })()
    : {};

  // Direct/log-false skills are engine-internal or intentionally silent. Keep
  // them out of public history unless the event explicitly says it is visible.
  if (kind === "useSkill" && event.visible !== true) return null;

  return {
    seq: store.byId.has(eventId) ? store.byId.get(eventId).seq : store.nextSeq++,
    eventId,
    parentEventId: parent ? ensureEventId(store, parent) : null,
    phaseRootEventId: phaseRoot ? ensureEventId(store, phaseRoot) : null,
    actionRootEventId: actionRoot ? ensureEventId(store, actionRoot) : eventId,
    kind,
    eventName: name,
    historySegment: bucketIndex,
    round: Number(event.roundNumber ?? bucketRound ?? runtime.roundNumber ?? 0) || 0,
    phase: phaseForEvent(event),
    turnActor: playerFact(event.turnActor || runtime.currentPhase, runtime),
    actor,
    targets,
    cards,
    cardCount: Math.max(cards.length, Number(event.cardCount || event.numCards || 0) || 0),
    skill: stringValue(event.skill || event.sourceSkill),
    amount: Number.isFinite(Number(event.num)) ? Number(event.num) : null,
    nature: Array.isArray(event.nature) ? event.nature.map(stringValue).join("+") : stringValue(event.nature),
    moveType: kind === "cardMove" ? name : "",
    from: stringValue(event.from || event.fromPosition),
    to: stringValue(event.to || event.toPosition || areaName(event.position, runtime)),
    status: isEventActive(event, runtime.currentEvent) ? "active" : "sealed",
    revision: 1,
  };
}

function comparable(record) {
  const copy = Object.assign({}, record);
  delete copy.revision;
  return JSON.stringify(copy);
}

function upsertRecord(store, next) {
  const previous = store.byId.get(next.eventId);
  if (!previous) {
    store.byId.set(next.eventId, next);
    store.records.push(next);
    store.records.sort((left, right) => left.seq - right.seq);
    return "added";
  }
  next.cards = mergeVisibleCardFacts(previous.cards, next.cards);
  next.revision = previous.revision;
  if (comparable(previous) === comparable(next)) return "unchanged";
  next.revision++;
  Object.assign(previous, next);
  return "updated";
}

function shouldResetForNewGame(store, globalHistory, runtime) {
  if (!store.records.length) return false;
  if (store.historyRef && store.historyRef !== globalHistory) return true;
  const round = Number(runtime.roundNumber || 0);
  const phase = Number(runtime.phaseNumber || 0);
  if (round && store.lastRoundNumber && round < store.lastRoundNumber) return true;
  if (phase && store.lastPhaseNumber && phase < store.lastPhaseNumber && round <= store.lastRoundNumber) return true;
  return false;
}

function syncTimeline(store, runtime = {}) {
  const globalHistory = Array.isArray(runtime.globalHistory) ? runtime.globalHistory : [];
  const reset = shouldResetForNewGame(store, globalHistory, runtime);
  if (reset) resetTimeline(store);
  store.historyRef = globalHistory;
  store.lastRoundNumber = Number(runtime.roundNumber || store.lastRoundNumber || 0);
  store.lastPhaseNumber = Number(runtime.phaseNumber || store.lastPhaseNumber || 0);
  const stats = { reset, added: 0, updated: 0, unchanged: 0, ignored: 0 };
  const rounds = roundByBucket(globalHistory, runtime.roundNumber);

  const ingest = (event, sourceKind, bucketIndex) => {
    if (!event || typeof event !== "object") return;
    if (store.ignoredEvents.has(event)) return;
    const knownId = store.eventIds.get(event);
    if (knownId && store.trimmedEventIds.has(knownId)) return;
    const record = normalizeEvent(store, event, sourceKind, runtime, bucketIndex, rounds[bucketIndex]);
    if (!record) { stats.ignored++; return; }
    stats[upsertRecord(store, record)]++;
  };
  for (let index = 0; index < globalHistory.length; index++) {
    const bucket = globalHistory[index] || {};
    for (const event of Array.isArray(bucket.everything) ? bucket.everything : []) ingest(event, "everything", index);
  }
  for (let index = 0; index < globalHistory.length; index++) {
    const bucket = globalHistory[index] || {};
    for (const event of Array.isArray(bucket.cardMove) ? bucket.cardMove : []) ingest(event, "cardMove", index);
  }
  stats.trimmed = trimTimeline(store, runtime.maxRecords);
  return stats;
}

function viewerCanSee(cardFact, viewer) {
  const ids = cardFact && cardFact.visibleTo || [];
  return ids.includes("everyone") || (!!playerId(viewer) && ids.includes(playerId(viewer)));
}

function playerLabel(fact) {
  if (!fact) return "未知角色";
  const fields = ["playerId=" + (fact.id || "未知")];
  if (fact.seat) fields.push("seat=" + fact.seat);
  fields.push("name=" + (fact.name || "未公开角色"));
  return "[" + fields.join("|") + "]";
}

function visibleCardsText(record, viewer) {
  const visible = (record.cards || []).filter(item => viewerCanSee(item, viewer));
  const labels = visible.map(item => item.card.name + (item.card.nature ? "/" + item.card.nature : ""));
  const hiddenCount = Math.max(0, Number(record.cardCount || 0) - visible.length);
  if (hiddenCount) labels.push(hiddenCount + "张未知牌");
  return labels.join("、") || (record.cardCount ? record.cardCount + "张未知牌" : "未记录牌");
}

function renderRecord(record, viewer) {
  const actor = playerLabel(record.actor);
  const targets = record.targets.map(playerLabel).join("、") || "无目标";
  const cards = visibleCardsText(record, viewer);
  const amount = record.amount === null ? "" : String(record.amount);
  const prefix = "#" + record.seq + " R" + record.round + (record.phase ? "/" + record.phase : "") + " ";
  switch (record.kind) {
    case "phase": return prefix + actor + " 开始回合";
    case "phaseStep": return prefix + actor + " 进入 " + record.eventName;
    case "useCard": return prefix + actor + " 对 " + targets + " 使用 " + cards;
    case "respond": return prefix + actor + " 响应 " + cards;
    case "useSkill": return prefix + actor + " 发动【" + (record.skill || "技能") + "】" + (record.targets.length ? "，涉及 " + targets : "");
    case "damage": return prefix + actor + " 对 " + targets + " 造成 " + (amount || "?") + " 点" + (record.nature || "") + "伤害";
    case "recover": return prefix + targets + " 回复 " + (amount || "?") + " 点体力" + (record.actor ? "（来源 " + actor + "）" : "");
    case "die": return prefix + targets + " 阵亡" + (record.actor ? "（来源 " + actor + "）" : "");
    case "judge": return prefix + targets + " 判定为 " + cards;
    case "showCards": return prefix + actor + " 展示 " + cards;
    case "cardMove": return prefix + actor + " " + record.moveType + " " + cards + (record.to ? " → " + record.to : "");
    default: return prefix + record.eventName;
  }
}

function renderTimeline(store, viewer, options = {}) {
  const throughSeq = Number.isFinite(Number(options.throughSeq)) ? Number(options.throughSeq) : Infinity;
  const limit = Math.max(1, Number(options.limit || 20));
  return store.records.filter(record => record.seq <= throughSeq).slice(-limit)
    .map(record => renderRecord(record, viewer)).join("\n");
}

function findAnchorRecord(store, event) {
  for (const current of ancestorsOf(event)) {
    const id = store.eventIds.get(current);
    if (id && store.byId.has(id)) return store.byId.get(id);
  }
  return store.records.length ? store.records[store.records.length - 1] : null;
}

function captureChatAnchor(store, event, runtime = {}) {
  const record = findAnchorRecord(store, event);
  return Object.freeze({
    anchorEventId: record ? record.eventId : null,
    actionRootEventId: record ? record.actionRootEventId : null,
    timelineSeq: store.records.length ? store.records[store.records.length - 1].seq : 0,
    round: Number(runtime.roundNumber ?? (record && record.round) ?? 0) || 0,
    phase: record ? record.phase : "",
    at: Number(runtime.at || Date.now()),
  });
}

function renderAtChatAnchor(store, viewer, anchor, options = {}) {
  return renderTimeline(store, viewer, {
    limit: options.limit,
    throughSeq: anchor && Number.isFinite(Number(anchor.timelineSeq)) ? Number(anchor.timelineSeq) : Infinity,
  });
}

module.exports = {
  PHASE_NAMES,
  DIRECT_EVENT_KINDS,
  CARD_MOVE_NAMES,
  createTimelineStore,
  resetTimeline,
  clearTimelineBeforeNow,
  trimTimeline,
  ensureEventId,
  canonicalKind,
  normalizeEvent,
  syncTimeline,
  renderRecord,
  renderTimeline,
  captureChatAnchor,
  renderAtChatAnchor,
};
