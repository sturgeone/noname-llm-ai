/* ============================================
 * 大模型AI 无名杀扩展
 * 让无名杀 AI 用大模型思考：局面转中文 -> LLM 决策 -> 回填执行
 * 作者: 千里南鲟
 * ============================================ */
import { lib, game, ui, get, ai, _status } from "../../noname.js";
import { CacheContext } from "../../noname/library/cache/cacheContext.js";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let skillSourceRuntime = null;
let timelineRuntime = null;
const loggedSkillPromptMetrics = new Map();

const EXT_NAME = "大模型AI";
const EXT_VERSION = "1.3.0";
const CORE_BRIDGE = "__nonameLLMChoose";
const CORE_PATCH_SCHEMA_VERSION = 2;
const LINE_ANIMATION_PATCH_SCHEMA_VERSION = 1;
const LINE_ANIMATION_PATCH_ID = "safe-animation-node-cleanup";
const LINE_ANIMATION_PATCH_TARGET = "noname/game/index.js";
const LINE_ANIMATION_PATCH_MARKER = "/* llm-ai:safe-animation-node-cleanup:v1 */";
const CHAT_TIMEOUT_MS = 60000;
const DECISION_LOG_FILENAME = "AI决策日志.txt";
const DECISION_LOG_ARCHIVE_DIRNAME = "AI决策日志";
const DECISION_LOG_ARCHIVE_PATTERN = /^AI决策日志-\d{8}-\d{6}(?:-[^.]+)?\.txt$/;
const DECISION_LOG_MAX_BYTES = 2 * 1024 * 1024;
const ACTION_CHAT_CONTEXT_LIMIT = 6;
const CHAT_REPLY_HISTORY_LIMIT = 12;
const MEMORY_SCHEMA_VERSION = 7;
const WORLD_CONTEXT_SCHEMA_VERSION = 1;
const SKILL_SOURCE_SCHEMA_VERSION = 1;
const TIMELINE_DETAIL_LIMIT = 24;
const CONFIG_EXPORT_SCHEMA = "noname-llm-ai-config";
const CONFIG_EXPORT_SCHEMA_VERSION = 1;
const LEGACY_ORIGINAL_AI_TAKEOVER_MODES = ["off", "always", "inside_phase_use", "outside_phase_use"];
const ORIGINAL_AI_EVENT_CATEGORIES = Object.freeze({
  play_plan: Object.freeze({ key: "originalAITakeoverPlayPlan", label: "出牌规划" }),
  tactical: Object.freeze({ key: "originalAITakeoverTactical", label: "技能与战术选择" }),
  response: Object.freeze({ key: "originalAITakeoverResponse", label: "响应与救援" }),
  resource: Object.freeze({ key: "originalAITakeoverResource", label: "手牌与资源整理" }),
  mechanical: Object.freeze({ key: "originalAITakeoverMechanical", label: "强制或机械选择" })
});
const ORIGINAL_AI_CATEGORY_CONFIG_KEYS = Object.values(ORIGINAL_AI_EVENT_CATEGORIES).map(item => item.key);
const DEFAULT_CONFIG = {
  apiKey: "",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  timeout: 20,
  temperature: 0.25,
  topP: 1,
  serverReasoningEffort: "low",
  promptThinkingDepth: 50,
  actionMaxTokens: 8192,
  retryCount: 2,
  decisionLog: true,
  decisionLogRetention: 20,
  timelineMaxRecords: 240,
  /* 新安装的推荐组合：主动出牌和主要战术交给模型，其余高频小选择交给原版 AI。 */
  originalAITakeoverPlayPlan: false,
  originalAITakeoverTactical: false,
  originalAITakeoverResponse: true,
  originalAITakeoverResource: true,
  originalAITakeoverMechanical: true,
  skillInfo: true,
  memoryPolicy: "all",
  originalAIProbability: 0,
  aiSpeechProbability: 15,
  originalAIReferenceStrength: 50,
  skillDescLen: 600,
  debugUI: false
};
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);
const CONFIG_EXPORT_KEYS = CONFIG_KEYS.filter(key => key !== "apiKey");
const ORIGINAL_AI_TAKEOVER_CONFIG_KEY = "extension_" + EXT_NAME + "_originalAITakeoverMode";
const ORIGINAL_AI_CATEGORY_CONFIG_PREFIX = "extension_" + EXT_NAME + "_";
const LEGACY_AI_ENABLED_CONFIG_KEY = "extension_" + EXT_NAME + "_aiEnabled";
const OUTSIDE_PHASE_CONFIG_KEY = "extension_" + EXT_NAME + "_outsidePhaseUseOriginalAI";
const LEGACY_TAKE_RESPOND_CONFIG_KEY = "extension_" + EXT_NAME + "_takeRespond";
const SERVER_REASONING_CONFIG_KEY = "extension_" + EXT_NAME + "_serverReasoningEffort";
const PROMPT_DEPTH_CONFIG_KEY = "extension_" + EXT_NAME + "_promptThinkingDepth";
const LEGACY_REASONING_CONFIG_KEY = "extension_" + EXT_NAME + "_reasoningEffort";

function legacyOriginalAITakeoverMode(source, prefix) {
  source = source && typeof source === "object" ? source : {};
  prefix = prefix || "";
  const enabledKey = prefix + "aiEnabled";
  const outsideKey = prefix + "outsidePhaseUseOriginalAI";
  const takeRespondKey = prefix + "takeRespond";
  const enabled = Object.prototype.hasOwnProperty.call(source, enabledKey) ? Boolean(source[enabledKey]) :
    !prefix && Object.prototype.hasOwnProperty.call(source, "enabled") ? Boolean(source.enabled) : true;
  const outside = Object.prototype.hasOwnProperty.call(source, outsideKey) ? Boolean(source[outsideKey]) :
    Object.prototype.hasOwnProperty.call(source, takeRespondKey) ? !Boolean(source[takeRespondKey]) : false;
  return !enabled ? "always" : outside ? "outside_phase_use" : "off";
}

function originalAICategorySettingsForLegacyMode(mode) {
  const all = mode === "always";
  const inside = mode === "inside_phase_use";
  const outside = mode === "outside_phase_use";
  return Object.freeze({
    originalAITakeoverPlayPlan: all || inside,
    originalAITakeoverTactical: all || outside,
    originalAITakeoverResponse: all || outside,
    originalAITakeoverResource: all || outside,
    originalAITakeoverMechanical: all || outside
  });
}

function originalAITakeoverSummary(config) {
  const source = config && typeof config === "object" ? config : {};
  const labels = Object.values(ORIGINAL_AI_EVENT_CATEGORIES)
    .filter(item => !!source[item.key])
    .map(item => item.label);
  return labels.length ? labels.join("、") : "全部关闭";
}

function captureOriginalAITakeoverMigration(configStore) {
  const source = configStore && typeof configStore === "object" ? configStore : {};
  const hasCategorySetting = ORIGINAL_AI_CATEGORY_CONFIG_KEYS.some(key =>
    Object.prototype.hasOwnProperty.call(source, ORIGINAL_AI_CATEGORY_CONFIG_PREFIX + key));
  const hasPreviousModeSetting = Object.prototype.hasOwnProperty.call(source, ORIGINAL_AI_TAKEOVER_CONFIG_KEY);
  const hasAIEnabledSetting = Object.prototype.hasOwnProperty.call(source, LEGACY_AI_ENABLED_CONFIG_KEY);
  const hasOutsidePhaseSetting = Object.prototype.hasOwnProperty.call(source, OUTSIDE_PHASE_CONFIG_KEY);
  const hasTakeRespondSetting = Object.prototype.hasOwnProperty.call(source, LEGACY_TAKE_RESPOND_CONFIG_KEY);
  const rawMode = hasPreviousModeSetting ? source[ORIGINAL_AI_TAKEOVER_CONFIG_KEY] : null;
  const mode = LEGACY_ORIGINAL_AI_TAKEOVER_MODES.includes(rawMode)
    ? rawMode : legacyOriginalAITakeoverMode(source, "extension_" + EXT_NAME + "_");
  return Object.freeze({
    needed: !hasCategorySetting && (hasPreviousModeSetting || hasAIEnabledSetting || hasOutsidePhaseSetting || hasTakeRespondSetting),
    mode,
    settings: originalAICategorySettingsForLegacyMode(mode)
  });
}

/* 菜单初始化可能先写入新键，因此必须在 game.import 前保存旧配置是否真实存在。 */
const CAPTURED_ORIGINAL_AI_TAKEOVER_MIGRATION = captureOriginalAITakeoverMigration(lib && lib.config);
let originalAITakeoverMigrationPersisted = false;

function legacyReasoningSettings(value) {
  return {
    low: { serverReasoningEffort: "disabled", promptThinkingDepth: 25 },
    medium: { serverReasoningEffort: "low", promptThinkingDepth: 50 },
    high: { serverReasoningEffort: "high", promptThinkingDepth: 75 },
    max: { serverReasoningEffort: "high", promptThinkingDepth: 100 }
  }[String(value || "").toLowerCase()] || null;
}

function captureReasoningMigration(configStore) {
  const source = configStore && typeof configStore === "object" ? configStore : {};
  const legacy = legacyReasoningSettings(source[LEGACY_REASONING_CONFIG_KEY]);
  return Object.freeze({
    serverNeeded: !!legacy && !Object.prototype.hasOwnProperty.call(source, SERVER_REASONING_CONFIG_KEY),
    depthNeeded: !!legacy && !Object.prototype.hasOwnProperty.call(source, PROMPT_DEPTH_CONFIG_KEY),
    values: legacy
  });
}

/* game.import 初始化菜单时可能写入新键，先捕获用户旧版真实档位。 */
const CAPTURED_REASONING_MIGRATION = captureReasoningMigration(lib && lib.config);
let reasoningMigrationPersisted = false;

/* 无名杀通过 http://localhost:8089 加载扩展，import.meta.url 不是 file:// 协议，
 * 无法用 fileURLToPath 定位磁盘路径。改为从 exe 路径推导 + 探测确认。 */
function findExtDir() {
  const cands = [];
  try { cands.push(path.join(path.dirname(process.execPath), "resources", "app", "extension", EXT_NAME)); } catch (e) { }
  try { cands.push(path.join(process.cwd(), "resources", "app", "extension", EXT_NAME)); } catch (e) { }
  try { cands.push(path.join(process.cwd(), "extension", EXT_NAME)); } catch (e) { }
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, "extension.js"))) return c; } catch (e) { }
  }
  return cands[0];
}
const DIR = findExtDir();
try {
  skillSourceRuntime = require(path.join(DIR, "skill-source-snapshot.cjs"));
  timelineRuntime = require(path.join(DIR, "game-timeline.cjs"));
} catch (e) {
  console.error("[大模型AI] 认知运行时模块加载失败，将安全回落原版AI", e);
}
let cfg = Object.assign({}, DEFAULT_CONFIG);
let corePatchReady = false;
let originalAIControlledPlayerKeys = new Set();
let decisionSessionSequence = 0;
let gameTimelineStore = null;
const pendingActionPlans = new WeakMap();
const livePendingActionPlans = new Set();
const rollingPhasePlans = new WeakMap();
const liveRollingPhasePlans = new Set();
const pendingCardCompletions = new WeakMap();
const livePendingCardCompletions = new Set();
const activeThinkingUIByPlayer = new WeakMap();

function findAppDir() {
  const cands = [];
  try { cands.push(path.join(path.dirname(process.execPath), "resources", "app")); } catch (e) { }
  try { cands.push(path.resolve(DIR, "..", "..")); } catch (e) { }
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, "noname", "library", "element", "content.js"))) return c; } catch (e) { }
  }
  return cands[0];
}

function normalizeBaseURL(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function coerceConfig() {
  cfg.baseURL = normalizeBaseURL(cfg.baseURL) || DEFAULT_CONFIG.baseURL;
  cfg.model = String(cfg.model || DEFAULT_CONFIG.model).trim();
  cfg.apiKey = String(cfg.apiKey || "").trim();
  cfg.timeout = Math.min(86400, Math.max(0.1, Number(cfg.timeout) || DEFAULT_CONFIG.timeout));
  cfg.temperature = Math.min(2, Math.max(0, Number(cfg.temperature)));
  if (!Number.isFinite(cfg.temperature)) cfg.temperature = DEFAULT_CONFIG.temperature;
  cfg.topP = Math.min(1, Math.max(0.01, Number(cfg.topP)));
  if (!Number.isFinite(cfg.topP)) cfg.topP = DEFAULT_CONFIG.topP;
  cfg.retryCount = Math.min(100, Math.max(0, Math.floor(Number(cfg.retryCount) || 0)));
  cfg.decisionLogRetention = Math.min(9999, Math.max(1, Math.floor(Number(cfg.decisionLogRetention) || DEFAULT_CONFIG.decisionLogRetention)));
  cfg.timelineMaxRecords = Math.min(10000, Math.max(0, Math.floor(Number(cfg.timelineMaxRecords) || 0)));
  cfg.promptThinkingDepth = Math.min(100, Math.max(1, Math.round(Number(cfg.promptThinkingDepth) || DEFAULT_CONFIG.promptThinkingDepth)));
  cfg.actionMaxTokens = Math.min(65536, Math.max(64, Math.floor(Number(cfg.actionMaxTokens) || DEFAULT_CONFIG.actionMaxTokens)));
  cfg.skillDescLen = Math.min(1200, Math.max(120, Number(cfg.skillDescLen) || DEFAULT_CONFIG.skillDescLen));
  if (!["disabled", "low", "high", "max"].includes(cfg.serverReasoningEffort)) cfg.serverReasoningEffort = DEFAULT_CONFIG.serverReasoningEffort;
  if (!["all", "friends", "enemies"].includes(cfg.memoryPolicy)) cfg.memoryPolicy = DEFAULT_CONFIG.memoryPolicy;
  cfg.decisionLog = !!cfg.decisionLog;
  ORIGINAL_AI_CATEGORY_CONFIG_KEYS.forEach(key => { cfg[key] = !!cfg[key]; });
  cfg.originalAIProbability = Math.min(100, Math.max(0, Number(cfg.originalAIProbability)));
  if (!Number.isFinite(cfg.originalAIProbability)) cfg.originalAIProbability = DEFAULT_CONFIG.originalAIProbability;
  cfg.aiSpeechProbability = Math.min(100, Math.max(0, Number(cfg.aiSpeechProbability)));
  if (!Number.isFinite(cfg.aiSpeechProbability)) cfg.aiSpeechProbability = DEFAULT_CONFIG.aiSpeechProbability;
  cfg.originalAIReferenceStrength = Math.min(100, Math.max(0, Number(cfg.originalAIReferenceStrength)));
  if (!Number.isFinite(cfg.originalAIReferenceStrength)) cfg.originalAIReferenceStrength = DEFAULT_CONFIG.originalAIReferenceStrength;
}

function loadConfig(runtimeConfig, options) {
  const loadOptions = options || {};
  cfg = Object.assign({}, DEFAULT_CONFIG);
  const legacy = {};
  try {
    const p = path.join(DIR, "config.json");
    if (fs.existsSync(p)) Object.assign(legacy, JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch (e) {
    log("读取配置失败: " + e);
  }
  const runtimeHasCategorySetting = !!(runtimeConfig && ORIGINAL_AI_CATEGORY_CONFIG_KEYS.some(key =>
    Object.prototype.hasOwnProperty.call(runtimeConfig, key)));
  CONFIG_KEYS.forEach(key => {
    if (runtimeConfig && runtimeConfig[key] !== undefined) cfg[key] = runtimeConfig[key];
    else if (legacy[key] !== undefined) cfg[key] = legacy[key];
  });
  let migratedTakeoverSettings = null;
  if (loadOptions.applyCapturedOriginalAITakeoverMigration && CAPTURED_ORIGINAL_AI_TAKEOVER_MIGRATION.needed) {
    migratedTakeoverSettings = CAPTURED_ORIGINAL_AI_TAKEOVER_MIGRATION.settings;
  } else if (!runtimeHasCategorySetting && runtimeConfig) {
    const previousMode = LEGACY_ORIGINAL_AI_TAKEOVER_MODES.includes(runtimeConfig.originalAITakeoverMode)
      ? runtimeConfig.originalAITakeoverMode : null;
    if (previousMode) migratedTakeoverSettings = originalAICategorySettingsForLegacyMode(previousMode);
    else if (runtimeConfig.aiEnabled !== undefined || runtimeConfig.outsidePhaseUseOriginalAI !== undefined || runtimeConfig.takeRespond !== undefined) {
      migratedTakeoverSettings = originalAICategorySettingsForLegacyMode(legacyOriginalAITakeoverMode(runtimeConfig));
    }
  }
  if (migratedTakeoverSettings) Object.assign(cfg, migratedTakeoverSettings);
  const runtimeLegacyReasoning = runtimeConfig && legacyReasoningSettings(runtimeConfig.reasoningEffort);
  const fileLegacyReasoning = legacyReasoningSettings(legacy.reasoningEffort);
  const capturedReasoning = loadOptions.applyCapturedReasoningMigration ? CAPTURED_REASONING_MIGRATION.values : null;
  if (loadOptions.applyCapturedReasoningMigration && CAPTURED_REASONING_MIGRATION.serverNeeded) {
    cfg.serverReasoningEffort = capturedReasoning.serverReasoningEffort;
  } else if (!(runtimeConfig && runtimeConfig.serverReasoningEffort !== undefined) && runtimeLegacyReasoning) {
    cfg.serverReasoningEffort = runtimeLegacyReasoning.serverReasoningEffort;
  } else if (!(runtimeConfig && runtimeConfig.serverReasoningEffort !== undefined) && legacy.serverReasoningEffort === undefined && fileLegacyReasoning) {
    cfg.serverReasoningEffort = fileLegacyReasoning.serverReasoningEffort;
  }
  if (loadOptions.applyCapturedReasoningMigration && CAPTURED_REASONING_MIGRATION.depthNeeded) {
    cfg.promptThinkingDepth = capturedReasoning.promptThinkingDepth;
  } else if (!(runtimeConfig && runtimeConfig.promptThinkingDepth !== undefined) && runtimeLegacyReasoning) {
    cfg.promptThinkingDepth = runtimeLegacyReasoning.promptThinkingDepth;
  } else if (!(runtimeConfig && runtimeConfig.promptThinkingDepth !== undefined) && legacy.promptThinkingDepth === undefined && fileLegacyReasoning) {
    cfg.promptThinkingDepth = fileLegacyReasoning.promptThinkingDepth;
  }
  if (cfg.baseURL.includes("127.0.0.1:18080") || cfg.baseURL.includes("localhost:18080")) {
    cfg.baseURL = DEFAULT_CONFIG.baseURL;
  }
  coerceConfig();
  if (loadOptions.persistCapturedOriginalAITakeoverMigration && CAPTURED_ORIGINAL_AI_TAKEOVER_MIGRATION.needed && !originalAITakeoverMigrationPersisted) {
    originalAITakeoverMigrationPersisted = true;
    try {
      ORIGINAL_AI_CATEGORY_CONFIG_KEYS.forEach(key => game.saveExtensionConfig(EXT_NAME, key, cfg[key]));
      log("已迁移旧 AI 接管设置（" + CAPTURED_ORIGINAL_AI_TAKEOVER_MIGRATION.mode + "）为事件类别：" + originalAITakeoverSummary(cfg));
    } catch (e) {
      originalAITakeoverMigrationPersisted = false;
      log("迁移旧 AI 接管设置失败: " + e);
    }
  }
  if (loadOptions.persistCapturedReasoningMigration && !reasoningMigrationPersisted &&
    (CAPTURED_REASONING_MIGRATION.serverNeeded || CAPTURED_REASONING_MIGRATION.depthNeeded)) {
    reasoningMigrationPersisted = true;
    try {
      if (CAPTURED_REASONING_MIGRATION.serverNeeded) game.saveExtensionConfig(EXT_NAME, "serverReasoningEffort", cfg.serverReasoningEffort);
      if (CAPTURED_REASONING_MIGRATION.depthNeeded) game.saveExtensionConfig(EXT_NAME, "promptThinkingDepth", cfg.promptThinkingDepth);
      log("已迁移旧思考档位：服务端推理=" + cfg.serverReasoningEffort + "，提示词深度=" + cfg.promptThinkingDepth + "%");
    } catch (e) {
      reasoningMigrationPersisted = false;
      log("迁移旧思考档位失败: " + e);
    }
  }
  return cfg;
}

function log(msg) {
  try {
    const safe = redactJournalSecrets(msg);
    console.log("[大模型AI] " + safe);
    fs.appendFileSync(path.join(DIR, "log.txt"), new Date().toLocaleTimeString() + " " + safe + "\n");
  } catch (e) { }
}

function readCorePatchMeta(metaPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const validHash = value => /^[a-f0-9]{64}$/i.test(String(value || ""));
    if (!meta || meta.extension !== EXT_NAME || !validHash(meta.backupHash) || !validHash(meta.patchedHash)) return null;
    return meta;
  } catch (e) {
    return null;
  }
}

function writeCorePatchMeta(metaPath, meta) {
  const tempPath = metaPath + ".tmp";
  try {
    fs.writeFileSync(tempPath, JSON.stringify(meta, null, 2), "utf8");
    const staged = readCorePatchMeta(tempPath);
    if (!staged || staged.backupHash !== meta.backupHash || staged.patchedHash !== meta.patchedHash) {
      throw new Error("补丁元数据写入校验失败");
    }
    fs.copyFileSync(tempPath, metaPath);
    const written = readCorePatchMeta(metaPath);
    if (!written || written.backupHash !== meta.backupHash || written.patchedHash !== meta.patchedHash) {
      throw new Error("补丁元数据落盘校验失败");
    }
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) { }
  }
}

function readLineAnimationPatchMeta(metaPath) {
  const meta = readCorePatchMeta(metaPath);
  if (!meta || meta.patchId !== LINE_ANIMATION_PATCH_ID || meta.target !== LINE_ANIMATION_PATCH_TARGET) return null;
  return meta;
}

function patchLineAnimationCleanup() {
  const appDir = findAppDir();
  const gamePath = appDir && path.join(appDir, "noname", "game", "index.js");
  if (!gamePath || !fs.existsSync(gamePath)) {
    return { ready: false, changed: false, optional: true, message: "未找到本体指示线源码，已跳过兼容修复" };
  }
  const backupPath = gamePath + ".bak-llm-ai";
  const metaPath = gamePath + ".llm-ai-meta.json";
  const original = fs.readFileSync(gamePath, "utf8");
  const originalHash = sha256(original);
  const functionStartMarker = "  zsPlayLineAnimation(name2, node, fake, points) {";
  const functionEndMarker = "\n  zsPlayLineAnimationByName(";
  const functionStart = original.indexOf(functionStartMarker);
  if (functionStart < 0) {
    return { ready: false, changed: false, optional: true, message: "当前本体没有需要修复的指示线方法，已跳过" };
  }
  const functionEnd = original.indexOf(functionEndMarker, functionStart + functionStartMarker.length);
  if (functionEnd < 0) {
    return { ready: false, changed: false, warning: true, message: "无法确定本体指示线方法边界，已拒绝修改" };
  }
  const animationSource = original.slice(functionStart, functionEnd);
  const markerCount = animationSource.split(LINE_ANIMATION_PATCH_MARKER).length - 1;
  const oldBlock = [
    "          if (fake == true) {",
    "            ui.window.removeChild(div);",
    "          } else {",
    "            if (node == void 0 || node == false) {",
    "              ui.window.removeChild(div);",
    "            } else {",
    "              node.removeChild(div);",
    "            }",
    "          }",
    "          if (div2 != void 0) {",
    "            node.removeChild(div2);",
    "          }"
  ].join("\n");
  const oldBlockCount = animationSource.split(oldBlock).length - 1;
  const hasBackup = fs.existsSync(backupPath);
  const hasMeta = fs.existsSync(metaPath);
  if (hasBackup !== hasMeta) {
    return { ready: false, changed: false, warning: true, message: "指示线补丁备份与校验元数据不完整，已拒绝覆盖本体" };
  }
  let backupText = null;
  let meta = null;
  let previousMetaText = null;
  if (hasBackup && hasMeta) {
    backupText = fs.readFileSync(backupPath, "utf8");
    previousMetaText = fs.readFileSync(metaPath, "utf8");
    meta = readLineAnimationPatchMeta(metaPath);
    if (!meta || sha256(backupText) !== meta.backupHash) {
      return { ready: false, changed: false, warning: true, message: "指示线补丁备份或校验元数据无效，已拒绝覆盖本体" };
    }
  }
  if (markerCount === 1) {
    if (!meta || originalHash !== meta.patchedHash) {
      return { ready: false, changed: false, warning: true, message: "指示线补丁源码在安装后发生变化，已拒绝覆盖" };
    }
    if (meta.patchSchemaVersion !== LINE_ANIMATION_PATCH_SCHEMA_VERSION || meta.state !== "installed" || meta.version !== EXT_VERSION) {
      try {
        writeCorePatchMeta(metaPath, Object.assign({}, meta, {
          version: EXT_VERSION,
          patchSchemaVersion: LINE_ANIMATION_PATCH_SCHEMA_VERSION,
          state: "installed",
          updatedAt: Date.now()
        }));
      } catch (e) {
        return { ready: false, changed: false, warning: true, message: "指示线补丁有效，但升级校验元数据失败: " + e.message };
      }
    }
    return { ready: true, changed: false, message: "太虚幻境结算兼容补丁完整，备份与哈希有效" };
  }
  if (markerCount !== 0) {
    return { ready: false, changed: false, warning: true, message: "检测到重复指示线补丁标记，已拒绝覆盖本体" };
  }
  if (oldBlockCount === 0) {
    if (!hasBackup) {
      return { ready: false, changed: false, optional: true, message: "当前本体没有需要修复的指示线清理代码，已跳过" };
    }
    return { ready: false, changed: false, warning: true, message: "本体指示线源码已更新，旧备份不再匹配；已拒绝覆盖" };
  }
  if (oldBlockCount !== 1) {
    return { ready: false, changed: false, warning: true, message: "本体指示线清理代码命中 " + oldBlockCount + " 处，已拒绝不确定修改" };
  }
  if (meta && (meta.state !== "prepared" || originalHash !== meta.backupHash)) {
    return { ready: false, changed: false, warning: true, message: "本体指示线源码已更新或补丁事务状态异常，已拒绝覆盖" };
  }

  const newBlock = [
    "          " + LINE_ANIMATION_PATCH_MARKER,
    "          if (div != void 0 && div.parentNode) {",
    "            div.parentNode.removeChild(div);",
    "          }",
    "          if (div2 != void 0 && div2.parentNode) {",
    "            div2.parentNode.removeChild(div2);",
    "          }"
  ].join("\n");
  const patchedAnimationSource = animationSource.replace(oldBlock, newBlock);
  const patched = original.slice(0, functionStart) + patchedAnimationSource + original.slice(functionEnd);
  if ((patchedAnimationSource.split(LINE_ANIMATION_PATCH_MARKER).length - 1) !== 1 || patchedAnimationSource.includes(oldBlock)) {
    return { ready: false, changed: false, warning: true, message: "指示线补丁生成校验失败，未写入本体" };
  }
  const tempPath = gamePath + ".llm-ai.tmp";
  const backupTempPath = backupPath + ".tmp";
  let createdBackup = false;
  try {
    if (!hasBackup) {
      fs.writeFileSync(backupTempPath, original, "utf8");
      if (sha256(fs.readFileSync(backupTempPath, "utf8")) !== originalHash) throw new Error("指示线补丁备份写入校验失败");
      fs.copyFileSync(backupTempPath, backupPath, fs.constants.COPYFILE_EXCL);
      if (sha256(fs.readFileSync(backupPath, "utf8")) !== originalHash) throw new Error("指示线补丁备份落盘校验失败");
      backupText = original;
      createdBackup = true;
    }
    const nextMeta = {
      extension: EXT_NAME,
      version: EXT_VERSION,
      patchSchemaVersion: LINE_ANIMATION_PATCH_SCHEMA_VERSION,
      patchId: LINE_ANIMATION_PATCH_ID,
      target: LINE_ANIMATION_PATCH_TARGET,
      state: "prepared",
      backupHash: sha256(backupText),
      patchedHash: sha256(patched),
      createdAt: meta && meta.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    writeCorePatchMeta(metaPath, nextMeta);
    fs.writeFileSync(tempPath, patched, "utf8");
    if (sha256(fs.readFileSync(tempPath, "utf8")) !== nextMeta.patchedHash) throw new Error("指示线补丁临时文件哈希校验失败");
    fs.copyFileSync(tempPath, gamePath);
    fs.unlinkSync(tempPath);
    const written = fs.readFileSync(gamePath, "utf8");
    if ((written.split(LINE_ANIMATION_PATCH_MARKER).length - 1) !== 1 || sha256(written) !== nextMeta.patchedHash) {
      throw new Error("指示线补丁写入后校验失败");
    }
    nextMeta.state = "installed";
    nextMeta.updatedAt = Date.now();
    writeCorePatchMeta(metaPath, nextMeta);
    return { ready: false, changed: true, message: "太虚幻境结算兼容补丁已完成并备份" };
  } catch (e) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e2) { }
    try { if (fs.existsSync(backupTempPath)) fs.unlinkSync(backupTempPath); } catch (e2) { }
    try { fs.writeFileSync(gamePath, original, "utf8"); } catch (e2) { }
    try {
      if (previousMetaText !== null) fs.writeFileSync(metaPath, previousMetaText, "utf8");
      else if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    } catch (e2) { }
    try { if (createdBackup && fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch (e2) { }
    return { ready: false, changed: false, warning: true, message: "写入指示线兼容补丁失败: " + e.message };
  } finally {
    try { if (fs.existsSync(backupTempPath)) fs.unlinkSync(backupTempPath); } catch (e) { }
  }
}

function patchCoreForAsyncAI() {
  const appDir = findAppDir();
  const contentPath = appDir && path.join(appDir, "noname", "library", "element", "content.js");
  if (!contentPath || !fs.existsSync(contentPath)) {
    return { ready: false, changed: false, message: "未找到本体 content.js" };
  }
  const backupPath = contentPath + ".bak-llm-ai";
  const metaPath = contentPath + ".llm-ai-meta.json";
  const original = fs.readFileSync(contentPath, "utf-8");
  const originalHash = sha256(original);
  const bridgeCount = (original.match(/globalThis\.__nonameLLMChoose\s*\?/g) || []).length;
  const awaitCount = (original.match(/await ai\.basic\.(chooseCard|chooseTarget|chooseButton)\(/g) || []).length;
  const asyncButtonCount = (original.match(/ui\.create\.control\("AI代选", async \(\) => \{/g) || []).length;

  const hasBackup = fs.existsSync(backupPath);
  const hasMeta = fs.existsSync(metaPath);
  if (hasBackup !== hasMeta) {
    return { ready: false, changed: false, message: "补丁备份与校验元数据不完整，已拒绝修改本体；请先人工核对残留侧车文件" };
  }
  let backupText = null;
  let meta = null;
  let previousMetaText = null;
  if (hasBackup && hasMeta) {
    backupText = fs.readFileSync(backupPath, "utf8");
    previousMetaText = fs.readFileSync(metaPath, "utf8");
    meta = readCorePatchMeta(metaPath);
    if (!meta) {
      return { ready: false, changed: false, message: "补丁校验元数据无效，已拒绝修改本体" };
    }
    if (sha256(backupText) !== meta.backupHash) {
      return { ready: false, changed: false, message: "本体补丁备份哈希不匹配，已拒绝修改本体" };
    }
  }

  if (bridgeCount === 18 && asyncButtonCount === 2) {
    if (!meta) {
      return { ready: false, changed: false, message: "本体已有桥接补丁，但缺少可信备份与校验元数据；为保证卸载可还原，已停止接管" };
    }
    if (originalHash !== meta.patchedHash) {
      return { ready: false, changed: false, message: "桥接补丁源码在安装后发生变化，已停止接管并拒绝覆盖" };
    }
    if (meta.patchSchemaVersion !== CORE_PATCH_SCHEMA_VERSION || meta.state !== "installed" || meta.version !== EXT_VERSION) {
      try {
        writeCorePatchMeta(metaPath, Object.assign({}, meta, {
          version: EXT_VERSION,
          patchSchemaVersion: CORE_PATCH_SCHEMA_VERSION,
          state: "installed",
          updatedAt: Date.now()
        }));
      } catch (e) {
        return { ready: false, changed: false, message: "桥接补丁有效，但升级校验元数据失败: " + e.message };
      }
    }
    return { ready: true, changed: false, message: "本体安全桥接补丁完整（18/18），备份与哈希有效" };
  }
  if (bridgeCount !== 0 && bridgeCount !== 18) {
    return { ready: false, changed: false, message: "检测到不完整桥接补丁（" + bridgeCount + "/18），为避免损坏本体已停止" };
  }
  if (awaitCount !== 0 && awaitCount !== 18) {
    return { ready: false, changed: false, message: "检测到不完整补丁（" + awaitCount + "/18），为避免损坏本体已停止" };
  }
  if (awaitCount === 18) {
    const resumableMigration = meta && meta.state === "prepared" && originalHash === meta.previousPatchedHash;
    if (!meta || (originalHash !== meta.patchedHash && !resumableMigration)) {
      return { ready: false, changed: false, message: "检测到旧异步补丁，但其源码或备份无法通过哈希校验，已拒绝迁移" };
    }
  } else if (meta && originalHash !== meta.backupHash) {
    return { ready: false, changed: false, message: "本体源码已更新或被修改，旧备份不再匹配；为避免还原到旧本体，已拒绝自动补丁" };
  }

  const conditional = /ai\.basic\.(chooseCard|chooseTarget|chooseButton)\(([^)]+)\)(?= \|\| (?:forced|event\.forced))/g;
  const statement = /ai\.basic\.(chooseCard|chooseTarget|chooseButton)\(([^)]+)\)(?=;)/g;
  const button = /ui\.create\.control\("AI代选", \(\) => \{/g;
  const kindOf = name => name === "chooseCard" ? "card" : name === "chooseTarget" ? "target" : "button";
  const bridgeExpr = (name, arg) =>
    '(globalThis.' + CORE_BRIDGE + ' ? await globalThis.' + CORE_BRIDGE + '("' + kindOf(name) + '", ' + arg + ', event) : ai.basic.' + name + '(' + arg + '))';
  let patched = original;

  if (awaitCount === 18) {
    patched = patched.replace(/\(await ai\.basic\.(chooseCard|chooseTarget|chooseButton)\(([^)]+)\)\)/g, (_, name, arg) => bridgeExpr(name, arg));
    patched = patched.replace(/await ai\.basic\.(chooseCard|chooseTarget|chooseButton)\(([^)]+)\)/g, (_, name, arg) => bridgeExpr(name, arg));
  } else {
    const conditionalCount = (original.match(conditional) || []).length;
    const statementCount = (original.match(statement) || []).length;
    const buttonCount = (original.match(button) || []).length;
    if (conditionalCount !== 16 || statementCount !== 2 || buttonCount !== 2) {
      return {
        ready: false,
        changed: false,
        message: "本体版本不匹配：预期调用 16+2、AI代选 2，实际 " + conditionalCount + "+" + statementCount + "、" + buttonCount
      };
    }
    patched = patched.replace(conditional, (_, name, arg) => bridgeExpr(name, arg));
    patched = patched.replace(statement, (_, name, arg) => bridgeExpr(name, arg));
    patched = patched.replace(button, 'ui.create.control("AI代选", async () => {');
  }
  const patchedBridgeCount = (patched.match(/globalThis\.__nonameLLMChoose\s*\?/g) || []).length;
  const patchedButtonCount = (patched.match(/ui\.create\.control\("AI代选", async \(\) => \{/g) || []).length;
  if (patchedBridgeCount !== 18 || patchedButtonCount !== 2) {
    return { ready: false, changed: false, message: "补丁生成后校验失败，未写入本体" };
  }

  const tempPath = contentPath + ".llm-ai.tmp";
  const backupTempPath = backupPath + ".tmp";
  let createdBackup = false;
  try {
    if (!hasBackup) {
      fs.writeFileSync(backupTempPath, original, "utf8");
      if (sha256(fs.readFileSync(backupTempPath, "utf8")) !== originalHash) throw new Error("补丁备份写入校验失败");
      fs.copyFileSync(backupTempPath, backupPath, fs.constants.COPYFILE_EXCL);
      if (sha256(fs.readFileSync(backupPath, "utf8")) !== originalHash) throw new Error("补丁备份落盘校验失败");
      backupText = original;
      createdBackup = true;
    }
    const backupHash = sha256(backupText);
    const patchedHash = sha256(patched);
    const nextMeta = {
      extension: EXT_NAME,
      version: EXT_VERSION,
      patchSchemaVersion: CORE_PATCH_SCHEMA_VERSION,
      state: "prepared",
      backupHash,
      patchedHash,
      createdAt: meta && meta.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    if (awaitCount === 18) nextMeta.previousPatchedHash = originalHash;
    writeCorePatchMeta(metaPath, nextMeta);
    fs.writeFileSync(tempPath, patched, "utf-8");
    if (sha256(fs.readFileSync(tempPath, "utf8")) !== patchedHash) throw new Error("补丁临时文件哈希校验失败");
    fs.copyFileSync(tempPath, contentPath);
    fs.unlinkSync(tempPath);
    const written = fs.readFileSync(contentPath, "utf-8");
    const verified = (written.match(/globalThis\.__nonameLLMChoose\s*\?/g) || []).length === 18 &&
      (written.match(/ui\.create\.control\("AI代选", async \(\) => \{/g) || []).length === 2 &&
      sha256(written) === patchedHash;
    if (!verified) throw new Error("写入后 18 处桥接校验失败");
    nextMeta.state = "installed";
    nextMeta.updatedAt = Date.now();
    writeCorePatchMeta(metaPath, nextMeta);
    return { ready: false, changed: true, message: awaitCount === 18 ? "旧异步补丁已迁移为安全桥接补丁" : "本体安全桥接补丁已完成并备份" };
  } catch (e) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e2) { }
    try { if (fs.existsSync(backupTempPath)) fs.unlinkSync(backupTempPath); } catch (e2) { }
    try { fs.writeFileSync(contentPath, original, "utf-8"); } catch (e2) { }
    try {
      if (previousMetaText !== null) fs.writeFileSync(metaPath, previousMetaText, "utf8");
      else if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    } catch (e2) { }
    try { if (createdBackup && fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch (e2) { }
    return { ready: false, changed: false, message: "写入本体失败: " + e.message };
  } finally {
    try { if (fs.existsSync(backupTempPath)) fs.unlinkSync(backupTempPath); } catch (e) { }
  }
}

function chatCompletionURL() {
  const base = normalizeBaseURL(cfg.baseURL);
  if (/\/chat\/completions$/i.test(base)) return base;
  return base + "/chat/completions";
}

function extractAPIError(data, status) {
  const detail = data && data.error && (data.error.message || data.error.code) || data && data.message;
  return "HTTP " + status + (detail ? ": " + String(detail).slice(0, 240) : "");
}

function responseBlockText(value, kind, depth) {
  depth = Number(depth) || 0;
  if (depth > 6 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => responseBlockText(item, kind, depth + 1)).filter(Boolean).join("\n").trim();
  if (typeof value !== "object") return "";
  const marker = String(value.type || value.name || value.role || "").toLowerCase();
  const isReasoning = /reasoning|thinking|analysis/.test(marker);
  if (kind === "final" && isReasoning) return "";
  /* reasoning_content 有些中转会返回无 type 的文本数组，不能因缺少标签丢失。 */
  if (kind === "reasoning" && marker && !isReasoning && !/text|content|summary/.test(marker)) return "";
  if (typeof value.text === "string") return value.text;
  if (value.text && typeof value.text.value === "string") return value.text.value;
  for (const key of kind === "reasoning" ? ["content", "summary", "reasoning_content", "reasoning"] : ["content", "output_text", "value"]) {
    const text = responseBlockText(value[key], kind, depth + 1);
    if (text) return text;
  }
  return "";
}

function chatContentText(value) {
  return responseBlockText(value, "final", 0).trim();
}

function extractChatResponseText(data) {
  const choice = data && data.choices && data.choices[0];
  const message = choice && choice.message;
  const values = [
    message && message.content,
    message && message.output_text,
    choice && choice.text,
    data && data.output_text
  ];
  for (const value of values) {
    const text = chatContentText(value);
    if (text) return text;
  }
  return "";
}

function extractChatReasoningText(data) {
  const choice = data && data.choices && data.choices[0];
  const message = choice && choice.message;
  const values = [
    message && message.reasoning_content,
    message && message.reasoning,
    message && message.reasoning_details
  ];
  for (const value of values) {
    const text = responseBlockText(value, "reasoning", 0).trim();
    if (text) return text.slice(0, DECISION_LOG_MAX_BYTES);
  }
  if (message && Array.isArray(message.content)) {
    const reasoningBlocks = message.content.filter(item => item && typeof item === "object" &&
      /reasoning|thinking|analysis/.test(String(item.type || item.name || "").toLowerCase()));
    const text = responseBlockText(reasoningBlocks, "reasoning", 0).trim();
    if (text) return text.slice(0, DECISION_LOG_MAX_BYTES);
  }
  return "";
}

function recoverFinalJSONFromReasoning(data) {
  let text = extractChatReasoningText(data).trim();
  if (!text || text.length > 50000) return "";
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) {
    /* 一些推理接口把“简短分析 + 最终 JSON”全放进 reasoning_content，却把
     * content 留空。只接受位于推理文本末尾且自身可完整 JSON.parse 的对象，
     * 不从中间随便捞示例 JSON，避免把分析草稿误当最终答案。 */
    let terminal = text.replace(/\s*```\s*$/, "").trim();
    for (let start = terminal.lastIndexOf("{"); start >= 0; start = terminal.lastIndexOf("{", start - 1)) {
      try {
        const candidate = JSON.parse(terminal.slice(start));
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          parsed = candidate;
          break;
        }
      } catch (ignored) { }
    }
    if (!parsed) return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const looksLikeFinalAnswer = typeof parsed.action === "string" ||
    Array.isArray(parsed.steps) || parsed.choice && typeof parsed.choice === "object" ||
    parsed.decision && typeof parsed.decision === "object" ||
    parsed.result && typeof parsed.result === "object" ||
    parsed.selection && typeof parsed.selection === "object";
  return looksLikeFinalAnswer ? JSON.stringify(parsed) : "";
}

let decisionJournalSequence = 0;
let decisionJournalNeedsNewGame = true;
let decisionJournalTruncated = false;

function decisionCandidateLabel(type, candidate, index, plan) {
  let label = "";
  try {
    if (type === "card") label = typeof candidate === "string" ? "技能 " + safeTranslation(candidate, candidate) + " [" + candidate + "]" : cardPromptText(candidate, null, false);
    else if (type === "target") label = targetPromptText(candidate) + orderedTargetCandidateMarker(plan, candidate);
    else label = buttonPromptText(candidate);
  } catch (e) { label = String(candidate || "候选"); }
  return index + ". " + label;
}

function beginDecisionJournal(event, type, candidates, session) {
  if (!cfg.decisionLog) return null;
  const targetPlan = type === "target" ? orderedTargetPlan(candidates) : null;
  return {
    id: ++decisionJournalSequence,
    startedAt: Date.now(),
    actor: makePlayerRef(event && event.player) || playerDisplayName(event && event.player),
    event: eventFactText(event),
    eventName: translateEventName(event && event.name),
    type: String(type || "unknown"),
    sessionId: session && session.id || null,
    worldSchemaVersion: session && session.world && session.world.schemaVersion || null,
    worldFingerprint: session && session.world && session.world.fingerprint || null,
    candidates: (Array.isArray(candidates) ? candidates : []).map((candidate, index) => decisionCandidateLabel(type, candidate, index, targetPlan)),
    candidateScope: targetPlan ? "ordered_target_plan" : "legal",
    settings: {
      serverReasoningEffort: cfg.serverReasoningEffort,
      promptThinkingDepth: cfg.promptThinkingDepth,
      temperature: cfg.temperature,
      topP: cfg.topP,
      actionMaxTokens: cfg.actionMaxTokens,
      timeout: cfg.timeout,
      retryCount: cfg.retryCount
    },
    attempts: [],
    notes: [],
    finished: false
  };
}

function attachDecisionJournalResponse(entry, detail) {
  if (!entry || entry.finished || !detail) return;
  const current = entry.attempts.length ? entry.attempts[entry.attempts.length - 1] : null;
  if (current && (!detail.httpAttempt || current.httpAttempt === detail.httpAttempt)) Object.assign(current, detail);
  else entry.attempts.push(Object.assign({}, detail));
}

function redactJournalSecrets(value) {
  let text = String(value === undefined || value === null ? "" : value);
  /* 中转站有时会在错误正文中回显请求头；决策日志必须再次兜底脱敏。 */
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{6,}/gi, "Bearer [已隐藏]");
  if (cfg.apiKey) text = text.split(String(cfg.apiKey)).join("[已隐藏]");
  return text;
}

function sanitizeJournalText(value, maxChars) {
  const text = redactJournalSecrets(value).replace(/\r\n/g, "\n").trim();
  const limit = Math.max(0, Number(maxChars) || 0);
  return limit && text.length > limit ? text.slice(0, limit) + "\n[内容过长，已截断]" : text;
}

function journalChoiceText(choice, entry) {
  if (!choice) return "无";
  if (Array.isArray(choice.steps)) {
    let planRaw = "";
    try { planRaw = JSON.stringify(choice.steps); } catch (e) { planRaw = String(choice.steps); }
    return "动作=执行组合计划；步骤=" + planRaw;
  }
  let raw = "";
  try { raw = JSON.stringify(choice); } catch (e) { raw = String(choice); }
  const actionNames = { use: "选择/使用", target: "选择目标", skill: "发动技能", skip: "跳过" };
  const parts = ["动作=" + (actionNames[choice.action] || choice.action || "未知")];
  if (Array.isArray(choice.indices) && choice.indices.length) {
    const labels = choice.indices.map(index => {
      const label = entry && entry.candidates && entry.candidates[index];
      return label ? label.replace(/^\d+\.\s*/, "") : "候选序号 " + index;
    });
    parts.push("对象=" + labels.join("、"));
  }
  if (choice.cardName) parts.push("牌=" + choice.cardName);
  if (choice.skillName) parts.push("技能=" + choice.skillName);
  if (choice.targetSeat !== undefined) parts.push("座位=" + choice.targetSeat);
  if (Array.isArray(choice.targetSeats) && choice.targetSeats.length) parts.push("座位=" + choice.targetSeats.join("、"));
  if (choice.buttonText) parts.push("按钮=" + choice.buttonText);
  return parts.join("；") + "；结构化值=" + raw;
}

/* 行动记忆会再次发给模型，只能使用模型被允许输出的公开协议。
 * journalChoiceText() 可保留内部诊断结构写入 TXT，但不得把 stableStep/field/values
 * 或候选下标当作示例重新喂给模型，否则模型会照抄扩展内部格式。 */
function modelProtocolPlanStep(step) {
  if (!step || typeof step !== "object") return null;
  const source = step.stableStep && typeof step.stableStep === "object" ? step.stableStep : step;
  const kind = normalizePlanStepKind(source.kind || source.type || source.slot || step.kind || step.type || step.slot);
  if (!kind) return null;
  const refs = stablePlanRefs(source, kind);
  const field = canonicalPlanRefField(kind, refs.field);
  if (!field || field === "indices" || !refs.values.length) return null;
  const result = { kind };
  /* 多选字段始终保持数组，避免把复数 targetIds/cardIds 又示范成标量。
   * 技能和控制项的正式单值字段则使用 skillName/controlText。 */
  if (field === "skillNames" && refs.values.length === 1) result.skillName = refs.values[0];
  else if (field === "controls" && refs.values.length === 1) result.controlText = refs.values[0];
  else result[field] = refs.values.slice();
  return result;
}

function actionMemoryChoiceText(choice, entry) {
  if (!choice) return "无";
  if (Array.isArray(choice.steps)) {
    const steps = choice.steps.map(modelProtocolPlanStep).filter(Boolean);
    if (steps.length) return "动作=执行组合计划；正式步骤=" + JSON.stringify(steps);
  }
  /* 单槽选择保留可读候选名称，但移除仅供本地诊断的结构化下标。 */
  return journalChoiceText(choice, entry).replace(/；结构化值=[\s\S]*$/, "");
}

function journalModeText(mode) {
  return ({ normal: "普通思考（normal）", speed: "聊天“快点”触发的快速决策（speed）" })[mode] || String(mode || "未知");
}

function journalStatusText(status) {
  return ({
    success: "接口成功返回", success_recovered_reasoning_json: "正文为空，已从末尾完整 JSON 恢复", valid: "已解析为合法选择",
    invalid_json: "JSON 无法解析", invalid_choice: "选择不合法", empty: "接口返回空正文",
    truncated: "输出达到 token 上限被截断", timeout: "超过绝对时间", cancelled: "控制权变化，已正常取消", error: "请求失败"
  })[status] || String(status || "未知");
}

function journalOutcomeText(outcome) {
  return ({ applied: "已执行模型选择", skipped: "模型决定跳过", fallback: "已交给原版 AI", stale: "事件已过期，模型结果未执行" })[outcome] || String(outcome || "未知");
}

function compactJournalOneLine(value, maxChars) {
  const text = sanitizeJournalText(value, maxChars || 1200).replace(/\s+/g, " ").trim();
  return text || "无";
}

function liveModelOutputWithoutSpeech(raw) {
  try {
    const parsed = parseJSONObject(raw);
    if (!parsed || typeof parsed !== "object") return raw;
    const copy = Object.assign({}, parsed);
    delete copy.speech;
    delete copy.say;
    return JSON.stringify(copy);
  } catch (e) { return raw; }
}

function compactDecisionJournalText(entry, result) {
  result = result || {};
  const lines = [];
  lines.push("\n#" + entry.id + " " + (entry.actor || "未知角色") + "｜" + (entry.eventName || entry.type || "未知事件"));
  lines.push("思考设置：服务端=" + String(entry.settings && entry.settings.serverReasoningEffort || "未知") +
    "｜提示词深度=" + String(entry.settings && entry.settings.promptThinkingDepth !== undefined ? entry.settings.promptThinkingDepth + "%" : "未知") +
    "｜Temperature=" + String(entry.settings && entry.settings.temperature !== undefined ? entry.settings.temperature : "未知") +
    "｜Top P=" + String(entry.settings && entry.settings.topP !== undefined ? entry.settings.topP : "未知") +
    "｜最大输出=" + String(entry.settings && entry.settings.actionMaxTokens !== undefined ? entry.settings.actionMaxTokens : "未知"));
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
  if (!attempts.length) lines.push("请求：未发出或无统计");
  attempts.forEach((attempt, index) => {
    const prompt = Number(attempt.promptTokens);
    const completion = Number(attempt.completionTokens);
    const total = Number(attempt.totalTokens);
    const reasoning = Number(attempt.reasoningTokens);
    const cached = Number(attempt.cacheHitTokens !== undefined ? attempt.cacheHitTokens : attempt.cachedTokens);
    const cacheRate = Number.isFinite(prompt) && prompt > 0 && Number.isFinite(cached)
      ? (cached * 100 / prompt).toFixed(1) + "%" : "未知";
    const tokenParts = [];
    if (Number.isFinite(prompt)) tokenParts.push("输入 " + prompt);
    if (Number.isFinite(completion)) tokenParts.push("输出 " + completion);
    if (Number.isFinite(reasoning)) tokenParts.push("其中推理 " + reasoning);
    if (Number.isFinite(total)) tokenParts.push("合计 " + total);
    lines.push("请求" + (index + 1) + "：" +
      (attempt.elapsedMs === undefined ? "耗时未知" : "耗时 " + (Number(attempt.elapsedMs) / 1000).toFixed(2) + " 秒") +
      "｜Token " + (tokenParts.length ? tokenParts.join(" / ") : "未知") +
      "｜缓存命中 " + cacheRate +
      "｜" + journalStatusText(attempt.status));
  });
  const finalAttempt = attempts.slice().reverse().find(attempt => attempt && (attempt.raw || attempt.error));
  if (finalAttempt && finalAttempt.raw) lines.push("模型输出：" + compactJournalOneLine(liveModelOutputWithoutSpeech(finalAttempt.raw), 1400));
  else if (finalAttempt && finalAttempt.error) lines.push("模型输出：请求失败｜" + compactJournalOneLine(finalAttempt.error, 500));
  else lines.push("模型输出：无可显示结果");
  lines.push("执行结果：" + journalOutcomeText(result.outcome) +
    (result.choice ? "｜" + compactJournalOneLine(journalChoiceText(result.choice, entry), 900) : "") +
    (result.detail ? "｜" + compactJournalOneLine(result.detail, 500) : ""));
  return lines.join("\n") + "\n";
}

function refreshDecisionJournalView(text, append) {
  try {
    const box = window._llmChatBox;
    const panel = box && box._llmLogRecords;
    if (!panel) return;
    const oldTop = Math.max(0, Number(panel.scrollTop) || 0);
    const oldHeight = Math.max(0, Number(panel.scrollHeight) || 0);
    const clientHeight = Math.max(0, Number(panel.clientHeight) || 0);
    const wasAtBottom = oldHeight - clientHeight - oldTop <= 4;
    if (append) panel.appendChild(document.createTextNode(String(text || "")));
    else panel.textContent = String(text || "");
    const maxTop = Math.max(0, (Number(panel.scrollHeight) || 0) - (Number(panel.clientHeight) || 0));
    panel.scrollTop = wasAtBottom ? (Number(panel.scrollHeight) || maxTop) : Math.min(oldTop, maxTop);
  } catch (e) { }
}

function writeDecisionJournalText(text, append, force) {
  if ((!cfg.decisionLog && !force) || (decisionJournalTruncated && !force)) return;
  const filePath = decisionJournalCurrentPath();
  try {
    fs.mkdirSync(decisionJournalArchiveDir(), { recursive: true });
    const currentBytes = append && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const buffer = Buffer.from(String(text || ""), "utf8");
    if (!force && currentBytes + buffer.length > DECISION_LOG_MAX_BYTES) {
      const remaining = Math.max(0, DECISION_LOG_MAX_BYTES - currentBytes - 80);
      const clipped = remaining ? buffer.subarray(0, remaining).toString("utf8") : "";
      const output = clipped + "\n\n[本局决策日志达到 2 MiB，后续内容已停止记录]\n";
      if (append) fs.appendFileSync(filePath, output, "utf8");
      else fs.writeFileSync(filePath, output, "utf8");
      decisionJournalTruncated = true;
      return;
    }
    if (append) fs.appendFileSync(filePath, text, "utf8");
    else fs.writeFileSync(filePath, text, "utf8");
  } catch (e) { log("写入 AI 决策日志失败: " + e.message); }
}

function decisionJournalArchiveDir() {
  return path.join(DIR, DECISION_LOG_ARCHIVE_DIRNAME);
}

function decisionJournalCurrentPath() {
  return path.join(decisionJournalArchiveDir(), DECISION_LOG_FILENAME);
}

function legacyDecisionJournalPath() {
  return path.join(DIR, DECISION_LOG_FILENAME);
}

function decisionJournalTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const pad = number => String(number).padStart(2, "0");
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" +
    pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

function decisionJournalArchiveFiles() {
  const archiveDir = decisionJournalArchiveDir();
  try {
    if (!fs.existsSync(archiveDir)) return [];
    return fs.readdirSync(archiveDir).filter(name => DECISION_LOG_ARCHIVE_PATTERN.test(name)).sort();
  } catch (e) {
    log("读取 AI 决策日志归档失败: " + e.message);
    return [];
  }
}

function uniqueDecisionJournalArchivePath(suffix) {
  const archiveDir = decisionJournalArchiveDir();
  fs.mkdirSync(archiveDir, { recursive: true });
  const cleanSuffix = String(suffix || "").replace(/[<>:\"/\\|?*\x00-\x1f.]/g, "").trim();
  const base = "AI决策日志-" + decisionJournalTimestamp() + (cleanSuffix ? "-" + cleanSuffix : "");
  let target = path.join(archiveDir, base + ".txt");
  for (let counter = 2; fs.existsSync(target); counter++) target = path.join(archiveDir, base + "-" + counter + ".txt");
  return target;
}

function pruneDecisionJournalArchives(retention) {
  const keep = Math.min(9999, Math.max(1, Math.floor(Number(retention) || cfg.decisionLogRetention || DEFAULT_CONFIG.decisionLogRetention)));
  const archiveDir = decisionJournalArchiveDir();
  const files = decisionJournalArchiveFiles();
  const remove = files.slice(0, Math.max(0, files.length - keep));
  remove.forEach(name => {
    try { fs.unlinkSync(path.join(archiveDir, name)); } catch (e) { log("删除过期 AI 决策日志失败: " + name + "，" + e.message); }
  });
  return { kept: files.length - remove.length, removed: remove.length };
}

function archiveDecisionJournalFile(filePath, suffix) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const original = fs.readFileSync(filePath, "utf8");
    const redacted = redactJournalSecrets(original);
    if (redacted !== original) fs.writeFileSync(filePath, redacted, "utf8");
    const target = uniqueDecisionJournalArchivePath(suffix);
    try {
      fs.renameSync(filePath, target);
    } catch (renameError) {
      fs.copyFileSync(filePath, target);
      fs.unlinkSync(filePath);
    }
    pruneDecisionJournalArchives();
    return target;
  } catch (e) {
    log("归档 AI 决策日志失败: " + e.message);
    return null;
  }
}

function archiveCurrentDecisionJournal(suffix) {
  return archiveDecisionJournalFile(decisionJournalCurrentPath(), suffix);
}

function recoverStaleDecisionJournal() {
  const sources = [decisionJournalCurrentPath(), legacyDecisionJournalPath()]
    .filter((filePath, index, list) => list.indexOf(filePath) === index && fs.existsSync(filePath));
  let recovered = null;
  sources.forEach(filePath => {
    try {
      fs.appendFileSync(filePath, "\n【上局未正常结束】扩展在下次加载时恢复并归档了这份日志。\n", "utf8");
    } catch (e) { log("标记遗留 AI 决策日志失败: " + e.message); }
    recovered = archiveDecisionJournalFile(filePath, "未正常结束") || recovered;
  });
  decisionJournalNeedsNewGame = true;
  decisionJournalTruncated = false;
  return recovered;
}

function clearDecisionJournalFiles() {
  const filePath = decisionJournalCurrentPath();
  const legacyPath = legacyDecisionJournalPath();
  const archiveDir = decisionJournalArchiveDir();
  let removed = 0;
  if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); removed++; }
  if (legacyPath !== filePath && fs.existsSync(legacyPath)) { fs.unlinkSync(legacyPath); removed++; }
  decisionJournalArchiveFiles().forEach(name => {
    fs.unlinkSync(path.join(archiveDir, name));
    removed++;
  });
  decisionJournalNeedsNewGame = true;
  decisionJournalTruncated = false;
  refreshDecisionJournalView("", false);
  return removed;
}

function finishDecisionJournal(entry, result) {
  if (!entry || entry.finished || !cfg.decisionLog) return;
  entry.finished = true;
  result = result || {};
  const lines = [];
  lines.push("\n============================================================");
  lines.push("【决策 #" + entry.id + "】" + new Date(entry.startedAt).toLocaleString());
  lines.push("【谁在操作】" + (entry.actor || "未知角色"));
  lines.push("【当前事件】" + (entry.eventName || entry.type) + " | " + entry.event);
  if (entry.sessionId) lines.push("【上下文快照】session=" + entry.sessionId + "；world=v" + entry.worldSchemaVersion + "/" + entry.worldFingerprint);
  lines.push((entry.candidateScope === "ordered_target_plan" ? "【动态有序目标池（首项合法性见提示，后项逐步实时校验）】" : "【合法选择】") +
    "\n" + (entry.candidates.length ? entry.candidates.join("\n") : "无候选摘要"));
  lines.push("【本次设置】服务端推理=" + entry.settings.serverReasoningEffort +
    "；提示词深度=" + entry.settings.promptThinkingDepth + "%；最大生成token=" + entry.settings.actionMaxTokens +
    "；Temperature=" + entry.settings.temperature + "；Top P=" + entry.settings.topP +
    "；绝对时间=" + entry.settings.timeout + "秒；失败后最多重试=" + entry.settings.retryCount + "次");
  entry.attempts.forEach((attempt, index) => {
    lines.push("\n【第 " + (index + 1) + " 次请求】模式=" + journalModeText(attempt.mode || attempt.requestMode || "normal") +
      "；状态=" + journalStatusText(attempt.status) + "；耗时=" + (attempt.elapsedMs === undefined ? "?" : attempt.elapsedMs) + " ms");
    const promptTokens = Number(attempt.promptTokens);
    const completionTokens = Number(attempt.completionTokens);
    const totalTokens = Number(attempt.totalTokens);
    const cachedTokens = Number(attempt.cacheHitTokens !== undefined ? attempt.cacheHitTokens : attempt.cachedTokens);
    if (Number.isFinite(promptTokens) || Number.isFinite(completionTokens) || Number.isFinite(totalTokens)) {
      const cacheRate = Number.isFinite(promptTokens) && promptTokens > 0 && Number.isFinite(cachedTokens)
        ? (cachedTokens * 100 / promptTokens).toFixed(1) + "%" : "未知";
      lines.push("Token统计：输入=" + (Number.isFinite(promptTokens) ? promptTokens : "?") +
        "；输出=" + (Number.isFinite(completionTokens) ? completionTokens : "?") +
        "；其中推理=" + (Number.isFinite(Number(attempt.reasoningTokens)) ? Number(attempt.reasoningTokens) : "?") +
        "；合计=" + (Number.isFinite(totalTokens) ? totalTokens : "?") +
        "；缓存命中=" + (Number.isFinite(cachedTokens) ? cachedTokens : "?") + "（" + cacheRate + "）");
    }
    if (attempt.error) lines.push("请求错误：" + sanitizeJournalText(attempt.error, 2000));
    if (attempt.reasoning) lines.push("服务端公开的自然语言推理原文（扩展未改写）：\n" + sanitizeJournalText(attempt.reasoning, DECISION_LOG_MAX_BYTES));
    else if (attempt.status !== "error" && attempt.status !== "timeout") {
      const tokenNote = attempt.reasoningTokens !== undefined && attempt.reasoningTokens !== null ? "；reasoning_tokens=" + attempt.reasoningTokens : "";
      lines.push("服务端公开的自然语言推理原文：接口未提供该字段" + tokenNote);
    }
    if (attempt.raw) lines.push("模型原始输出：\n" + sanitizeJournalText(attempt.raw, 120000));
    if (attempt.reason) lines.push("模型在最终答案中给出的决策理由：\n" + sanitizeJournalText(attempt.reason, 4000));
    if (attempt.choice) lines.push("扩展解析后的选择：" + journalChoiceText(attempt.choice, entry));
    if (attempt.reason && !attempt.raw && attempt.status !== "error") lines.push("校验说明：" + sanitizeJournalText(attempt.reason, 4000));
  });
  lines.push("\n【游戏实际执行】" + journalOutcomeText(result.outcome) +
    (result.choice ? "；最终选择=" + journalChoiceText(result.choice, entry) : "") +
    (result.detail ? "\n" + sanitizeJournalText(result.detail, 8000) : ""));
  lines.push("============================================================\n");
  const append = !decisionJournalNeedsNewGame;
  if (!append) {
    decisionJournalNeedsNewGame = false;
    decisionJournalTruncated = false;
    refreshDecisionJournalView("", false);
    writeDecisionJournalText("大模型AI 本局决策日志\n说明：服务端公开的 reasoning_content 会按原文记录；若接口不提供该字段，则记录模型最终 JSON 中的自然语言决策理由。扩展不会伪造未公开的模型思维。\n", false);
  }
  writeDecisionJournalText(lines.join("\n"), true);
  refreshDecisionJournalView(compactDecisionJournalText(entry, result), true);
}

function endDecisionJournalGame() {
  const filePath = decisionJournalCurrentPath();
  if (!decisionJournalNeedsNewGame && fs.existsSync(filePath)) {
    writeDecisionJournalText("\n【本局结束】" + new Date().toLocaleString() + "\n", true, true);
    archiveCurrentDecisionJournal("");
  }
  decisionJournalNeedsNewGame = true;
  decisionJournalTruncated = false;
}

function openDecisionJournalFile() {
  const archiveDir = decisionJournalArchiveDir();
  try { fs.mkdirSync(archiveDir, { recursive: true }); } catch (e) {
    showExtensionNotice("无法创建 AI 决策日志文件夹\n" + e.message, "error");
    return;
  }
  try {
    const electron = require("electron");
    const openResult = electron && electron.shell && electron.shell.openPath ? electron.shell.openPath(archiveDir) : null;
    if (openResult && typeof openResult.then === "function") {
      openResult.then(error => {
        if (error) showExtensionNotice("无法打开决策日志文件夹\n" + error, "error");
      }).catch(error => showExtensionNotice("无法打开决策日志文件夹\n" + error.message, "error"));
      return;
    }
  } catch (e) { }
  try {
    const child = require("child_process").spawn("explorer.exe", [archiveDir], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch (e) {
    showExtensionNotice("无法自动打开决策日志文件夹\n文件位置：" + archiveDir + "\n" + e.message, "error", 10000);
  }
}

function clearDecisionJournalFile() {
  showExtensionConfirm("确定清空当前日志和全部已归档的 AI 决策日志吗？此操作不影响游戏和扩展设置。", () => {
    try {
      cancelActiveDecisionForLifecycle("玩家清空了决策日志，当前尚未完成的模型请求已取消并交给原版 AI");
      const removed = clearDecisionJournalFiles();
      showExtensionNotice("AI 决策日志已清空（删除 " + removed + " 份）", "success");
    } catch (e) {
      showExtensionNotice("清空 AI 决策日志失败\n" + e.message, "error");
    }
  });
}

function httpStatusFromError(error) {
  const match = String(error && error.message || "").match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function retryableLLMError(error) {
  if (!error || error.name === "AbortError" || error.name === "StaleDecisionError" || error.expectedCancellation) return false;
  const status = error.httpStatus || httpStatusFromError(error);
  if (status !== null) return status === 429 || status >= 500;
  return true;
}

async function requestChat(payload, options) {
  options = options || {};
  const ctrl = options.controller || new AbortController();
  const timeoutMs = options.timeoutMs === Infinity ? Infinity : Math.max(1, Number(options.timeoutMs) || cfg.timeout * 1000);
  let timedOut = false;
  const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs) : null;
  const startedAt = Date.now();
  const promptChars = Array.isArray(payload && payload.messages) ? payload.messages.reduce((total, message) => {
    const content = message && message.content;
    if (typeof content === "string") return total + content.length;
    try { return total + JSON.stringify(content || "").length; } catch (e) { return total; }
  }, 0) : 0;
  if (options.actionDecision) {
    const parts = (payload.messages || []).map((message, index) => {
      const content = message && message.content;
      let length = 0;
      if (typeof content === "string") length = content.length;
      else try { length = JSON.stringify(content || "").length; } catch (e) { }
      return index + ":" + String(message && message.role || "unknown") + "=" + length;
    });
    log("[提示组成] type=" + (options.decisionType || "unknown") + " total_chars=" + promptChars + " messages=" + parts.join(","));
  }
  try {
    const resp = await fetch(chatCompletionURL(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { }
    if (!resp.ok || data && data.error) {
      const error = new Error(extractAPIError(data, resp.status));
      error.httpStatus = resp.status;
      throw error;
    }
    if (!data) throw new Error("接口返回空响应或无法解析的 JSON");
    const choice = data && data.choices && data.choices[0];
    const finish = choice && choice.finish_reason || "未知";
    if (finish === "length") {
      const usage = data.usage || {};
      const promptDetails = usage.prompt_tokens_details || {};
      const completionDetails = usage.completion_tokens_details || {};
      const cachedTokens = promptDetails.cached_tokens !== undefined ? promptDetails.cached_tokens : usage.prompt_cache_hit_tokens;
      attachDecisionJournalResponse(options.journal, {
        httpAttempt: options.httpAttempt,
        mode: options.requestMode || "unknown",
        type: options.decisionType || "unknown",
        status: "truncated",
        elapsedMs: Date.now() - startedAt,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        cachedTokens,
        cacheHitTokens: usage.prompt_cache_hit_tokens !== undefined ? usage.prompt_cache_hit_tokens : cachedTokens,
        cacheMissTokens: usage.prompt_cache_miss_tokens,
        reasoning: extractChatReasoningText(data),
        reasoningTokens: completionDetails.reasoning_tokens,
        raw: extractChatResponseText(data)
      });
      const error = new Error("模型输出达到 max_tokens，被服务端截断");
      error.llmTruncated = true;
      throw error;
    }
    let content = extractChatResponseText(data);
    let recoveredFromReasoning = false;
    if (!content) {
      content = recoverFinalJSONFromReasoning(data);
      recoveredFromReasoning = !!content;
      if (recoveredFromReasoning) log("接口正文为空，但 reasoning_content 是完整合法 JSON；已作为最终输出恢复，避免浪费本次请求");
    }
    if (!content) {
      const message = choice && choice.message;
      const keys = message && typeof message === "object" ? Object.keys(message).join(",") : "无message";
      const finish = choice && choice.finish_reason || "未知";
      const reasoningLength = message && typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0;
      const usage = data.usage || {};
      const promptDetails = usage.prompt_tokens_details || {};
      const completionDetails = usage.completion_tokens_details || {};
      const cachedTokens = promptDetails.cached_tokens !== undefined ? promptDetails.cached_tokens : usage.prompt_cache_hit_tokens;
      attachDecisionJournalResponse(options.journal, {
        httpAttempt: options.httpAttempt,
        mode: options.requestMode || "unknown",
        type: options.decisionType || "unknown",
        status: "empty",
        elapsedMs: Date.now() - startedAt,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        cachedTokens,
        cacheHitTokens: usage.prompt_cache_hit_tokens !== undefined ? usage.prompt_cache_hit_tokens : cachedTokens,
        cacheMissTokens: usage.prompt_cache_miss_tokens,
        reasoning: extractChatReasoningText(data),
        reasoningTokens: completionDetails.reasoning_tokens,
        raw: ""
      });
      throw new Error("接口成功但返回内容为空（字段=" + keys + "，结束原因=" + finish + "，推理字符=" + reasoningLength + "）");
    }
    const usage = data.usage || {};
    const promptDetails = usage.prompt_tokens_details || {};
    const completionDetails = usage.completion_tokens_details || {};
    const cachedTokens = promptDetails.cached_tokens !== undefined ? promptDetails.cached_tokens : usage.prompt_cache_hit_tokens;
    const cacheHitTokens = usage.prompt_cache_hit_tokens !== undefined ? usage.prompt_cache_hit_tokens : cachedTokens;
    const cacheMissTokens = usage.prompt_cache_miss_tokens;
    const value = item => item === undefined || item === null ? "?" : item;
    log("[Token用量] mode=" + (options.requestMode || "unknown") +
      " type=" + (options.decisionType || "unknown") +
      " elapsed=" + (Date.now() - startedAt) + "ms" +
      " prompt_chars=" + promptChars +
      " prompt_tokens=" + value(usage.prompt_tokens) +
      " cached_tokens=" + value(cachedTokens) +
      " cache_hit_tokens=" + value(cacheHitTokens) +
      " cache_miss_tokens=" + value(cacheMissTokens) +
      " completion_tokens=" + value(usage.completion_tokens) +
      " reasoning_tokens=" + value(completionDetails.reasoning_tokens) +
      " total_tokens=" + value(usage.total_tokens));
    attachDecisionJournalResponse(options.journal, {
      httpAttempt: options.httpAttempt,
      mode: options.requestMode || "unknown",
      type: options.decisionType || "unknown",
      status: recoveredFromReasoning ? "success_recovered_reasoning_json" : "success",
      elapsedMs: Date.now() - startedAt,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cachedTokens,
      cacheHitTokens,
      cacheMissTokens,
      reasoning: extractChatReasoningText(data),
      reasoningTokens: completionDetails.reasoning_tokens,
      raw: content
    });
    return content;
  } catch (e) {
    if (timedOut && e && (e.name === "AbortError" || ctrl.signal.aborted)) e.llmTimedOut = true;
    if (!timedOut && ctrl.signal.aborted && e) {
      e.expectedCancellation = true;
      if (!e.name || e.name === "TypeError") e.name = "AbortError";
    }
    const existingAttempt = options.journal && options.journal.attempts && options.journal.attempts.length
      ? options.journal.attempts[options.journal.attempts.length - 1] : null;
    const preservedStatus = existingAttempt && existingAttempt.httpAttempt === options.httpAttempt &&
      ["truncated", "empty"].includes(existingAttempt.status) ? existingAttempt.status : null;
    const failureDetail = {
      httpAttempt: options.httpAttempt,
      mode: options.requestMode || "unknown",
      type: options.decisionType || "unknown",
      status: preservedStatus || (e && e.llmTimedOut ? "timeout" : e && e.expectedCancellation ? "cancelled" : "error"),
      elapsedMs: Date.now() - startedAt
    };
    if (e && e.expectedCancellation) failureDetail.reason = "控制权或游戏生命周期变化，模型请求已正常取消";
    else failureDetail.error = String(e && e.message || e);
    attachDecisionJournalResponse(options.journal, failureDetail);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callLLM(messages, options) {
  options = options || {};
  if (!cfg.apiKey) throw new Error("尚未在扩展设置中填写 API Key");
  if (!cfg.baseURL) throw new Error("API 地址为空");
  if (!cfg.model) throw new Error("模型名为空");
  const payload = {
    model: cfg.model,
    messages: messages,
    temperature: options.temperature !== undefined ? options.temperature : cfg.temperature,
    top_p: options.topP !== undefined ? options.topP : cfg.topP,
    stream: false
  };
  const maxTokens = Number(options.maxTokens || (options.actionDecision ? cfg.actionMaxTokens : 0));
  if (maxTokens > 0) payload.max_tokens = Math.floor(maxTokens);
  if (options.json) payload.response_format = { type: "json_object" };
  const serverEffort = options.reasoningEffort || (options.actionDecision ? cfg.serverReasoningEffort : null);
  if (serverEffort === "disabled" || options.thinking === false && options.explicitThinkingDisabled) {
    payload.thinking = { type: "disabled" };
  } else if (options.thinking !== false || options.actionDecision) {
    payload.thinking = { type: "enabled" };
    payload.reasoning_effort = serverEffort || cfg.serverReasoningEffort;
  }

  const variants = [payload];
  if (options.compatibilityFallback !== false && (payload.response_format || payload.thinking)) {
    const compatible = Object.assign({}, payload);
    delete compatible.response_format;
    delete compatible.thinking;
    delete compatible.reasoning_effort;
    variants.push(compatible);
  }
  let lastError = null;
  const budgetMs = options.timeoutMs === Infinity ? Infinity : (Number(options.timeoutMs) || cfg.timeout * 1000);
  const suppliedDeadline = Number(options.absoluteDeadline);
  const deadlineAt = Number.isFinite(suppliedDeadline) ? suppliedDeadline : budgetMs === Infinity ? Infinity : Date.now() + budgetMs;
  const retryCount = Math.min(100, options.retryCount === undefined ? cfg.retryCount : Math.max(0, Math.floor(Number(options.retryCount) || 0)));
  let attemptsSent = 0;
  for (let v = 0; v < variants.length; v++) {
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      if (attemptsSent >= retryCount + 1) break;
      try {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new DOMException("请求超时", "AbortError");
        attemptsSent++;
        return await requestChat(variants[v], {
          timeoutMs: remaining,
          controller: options.controller,
          requestMode: options.requestMode,
          decisionType: options.decisionType,
          actionDecision: !!options.actionDecision,
          journal: options.journal,
          httpAttempt: options.httpAttempt || attemptsSent,
          absoluteDeadline: deadlineAt
        });
      } catch (e) {
        lastError = e;
        if (e && e.expectedCancellation) log("API 请求已按控制权/生命周期变化正常取消，不计为网络错误");
        else log("API 调用失败（方案" + (v + 1) + "，第" + (attempt + 1) + "次）: " + e.message);
        if (!retryableLLMError(e)) break;
      }
    }
  }
  throw lastError || new Error("API 调用失败");
}

/* ============ 局内记忆与最近对话 ============
 * 只保存在当前页面内存中，不读写磁盘；对局结束或游戏重载后自动清空。 */
function emptyMemoryData() {
  return { version: MEMORY_SCHEMA_VERSION, rules: [], chat: [], controls: [], actionGuidance: [] };
}

let memoryData = emptyMemoryData();

function currentDecisionTurnAnchor() {
  return {
    phaseNumber: Number(game.phaseNumber || 0),
    roundNumber: Number(game.roundNumber || 0),
    currentPhase: playerMemoryKey(_status.currentPhase)
  };
}

function rememberSuccessfulModelDecision(player, event, choice, reason, journal) {
  if (!player || !choice || choice.action === "skip") return;
  if (!Array.isArray(memoryData.actionGuidance)) memoryData.actionGuidance = [];
  const anchor = currentDecisionTurnAnchor();
  const playerKey = playerMemoryKey(player);
  let action = "";
  try { action = actionMemoryChoiceText(choice, journal); } catch (e) { action = String(choice.action || "已执行操作"); }
  action = action.replace(/\s+/g, " ").slice(0, 420);
  const chainFacts = [];
  let current = event;
  for (let depth = 0; current && depth < 8; depth++) {
    try {
      if (Array.isArray(current.cards) && current.cards.length) {
        const cards = current.cards.map(cardText).filter(Boolean).join("、");
        if (cards) chainFacts.push("事件链已选牌=" + cards);
      }
    } catch (e) { }
    try {
      const targets = [];
      if (current.target) targets.push(current.target);
      if (Array.isArray(current.targets)) current.targets.forEach(target => { if (target && !targets.includes(target)) targets.push(target); });
      if (targets.length) chainFacts.push("事件链已选目标=" + targets.map(target => makePlayerRef(target) || safeTranslation(target)).join("、"));
    } catch (e) { }
    current = eventParent(current);
  }
  const engineFact = (translateEventName(event && event.name) + "：" + action +
    (chainFacts.length ? "；" + Array.from(new Set(chainFacts)).join("；") : "")).replace(/\s+/g, " ").slice(0, 760);
  const cleanReason = String(reason || "").replace(/\s+/g, " ").trim().slice(0, 320);
  const nextIntent = String(choice.__llmNextIntent || "").replace(/\s+/g, " ").trim().slice(0, 500);
  let skillName = "";
  try {
    if (choice.action === "skill" && choice.skillName) skillName = String(choice.skillName);
    if (!skillName && choice.action === "skill" && typeof event.skill === "string") skillName = event.skill;
    if (!skillName && Array.isArray(choice.steps)) {
      const skillStep = choice.steps.find(step => step && (step.kind === "skill" || step.type === "skill"));
      skillName = String(skillStep && (skillStep.skillName || skillStep.stableStep && skillStep.stableStep.skillName) || "");
    }
  } catch (e) { }
  memoryData.actionGuidance.push({
    player: playerKey,
    phaseNumber: anchor.phaseNumber,
    roundNumber: anchor.roundNumber,
    currentPhase: anchor.currentPhase,
    event: translateEventName(event && event.name),
    action,
    engineFact,
    intent: cleanReason,
    nextIntent,
    skillName,
    at: Date.now()
  });
  /* 每名 AI 单独保留最近 24 条，避免多人局里某个角色的记忆被其他角色迅速挤掉。 */
  const own = memoryData.actionGuidance.filter(item => item && item.player === playerKey);
  while (own.length > 24) {
    const expired = own.shift();
    const index = memoryData.actionGuidance.indexOf(expired);
    if (index >= 0) memoryData.actionGuidance.splice(index, 1);
  }
  if (memoryData.actionGuidance.length > 200) memoryData.actionGuidance = memoryData.actionGuidance.slice(-200);
}

function recentActionGuidanceText(player) {
  if (!player || !Array.isArray(memoryData.actionGuidance)) return "";
  const anchor = currentDecisionTurnAnchor();
  const key = playerMemoryKey(player);
  const ownMemories = memoryData.actionGuidance.filter(item => item && item.player === key);
  const currentTurn = ownMemories.filter(item =>
    item.phaseNumber === anchor.phaseNumber && item.roundNumber === anchor.roundNumber &&
    item.currentPhase === anchor.currentPhase).slice(-3);
  const currentSet = new Set(currentTurn);
  const earlier = ownMemories.filter(item => !currentSet.has(item)).slice(-2);
  const recent = earlier.concat(currentTurn);
  if (!recent.length) return "";
  const lines = recent.map((item, index) => {
    const fact = item.engineFact || (item.event + "：" + item.action);
    const intent = item.intent || item.reason || "";
    const reason = intent ? "；模型当时意图（可能含规则误解）=" + intent : "";
    const sameTurn = item.phaseNumber === anchor.phaseNumber && item.roundNumber === anchor.roundNumber && item.currentPhase === anchor.currentPhase;
    return (index + 1) + ". [" + (sameTurn ? "本回合" : "本局较早") + "] 引擎已确认选择=" + fact + reason;
  });
  return "【当前操作者的本局行动记忆】\n" + lines.join("\n") +
    "\n‘引擎已确认选择’是已发生的操作事实；‘模型当时意图’只是当时计划，可能误解规则，绝不能反过来覆盖当前技能说明、世界状态和事件时间线。" +
    "本回合合理意图可以延续；本局较早记忆用于保持长期目标和敌我判断，但不机械照搬。" +
    "普通的掉血、出闪、失去牌或进入同一行动引出的装备/技能事件，往往正是计划过程，不会自动使方针失效。" +
    "只在当前合法候选已不支持、关键对象已不存在，或新事件与该方针明显无关时重新评估；最终仍以当前合法候选为准。";
}

function skillStageContinuationText(player, event, type) {
  if (!player || !["button", "card", "target"].includes(type) || !Array.isArray(memoryData.actionGuidance)) return "";
  const anchor = currentDecisionTurnAnchor();
  const playerKey = playerMemoryKey(player);
  const recentSkill = memoryData.actionGuidance.slice().reverse().find(item => item && item.player === playerKey && item.skillName &&
    item.phaseNumber === anchor.phaseNumber && item.roundNumber === anchor.roundNumber && item.currentPhase === anchor.currentPhase);
  if (!recentSkill) return "";
  const chainSkills = new Set();
  let current = event;
  for (let depth = 0; current && depth < 10; depth++) {
    for (const key of ["skill", "sourceSkill", "originSkill"]) {
      try { if (typeof current[key] === "string" && current[key]) chainSkills.add(current[key]); } catch (e) { }
    }
    current = eventParent(current);
  }
  /* 标准 chooseButton 链不总是保留 sourceSkill；按钮槽可用同回合最近技能作软续接。
   * 牌/目标槽更常见于普通操作，为避免错误关联，必须能从当前事件链确认技能来源。
   * 这里只提供方针，不自动点击，也不绕过模型或本体合法性。 */
  if (chainSkills.size) {
    const linked = Array.from(chainSkills).some(name => name === recentSkill.skillName ||
      name.startsWith(recentSkill.skillName + "_") || recentSkill.skillName.startsWith(name + "_"));
    if (!linked) return "";
  } else if (type !== "button") return "";
  const slotLabel = type === "button" ? "按钮" : type === "card" ? "选牌" : "目标";
  return "【技能后继" + slotLabel + "续接】刚才引擎已确认发动技能 " + safeTranslation(recentSkill.skillName, recentSkill.skillName) +
    " [" + recentSkill.skillName + "]。当前" + slotLabel + "槽优先视为该技能的紧接操作，不要重新论证是否该发动技能，也不要从头复盘整局。" +
    (recentSkill.nextIntent ? "模型为后继步骤明确留下的行动方针：" + recentSkill.nextIntent + "。" :
      recentSkill.intent ? "沿用上次模型方针：" + recentSkill.intent + "。" : "沿用刚才发动该技能的目的。") +
    "若方针提到的对象或效果出现在当前合法候选中，直接选择；若没有精确对应，只比较当前候选之间的差异。最终仍只能选择当前合法候选。";
}

function actionMemorySystemMessage(player, event, type) {
  const memory = recentActionGuidanceText(player);
  const continuation = skillStageContinuationText(player, event, type);
  const rolling = rollingPhasePlanText(player);
  if (!memory && !continuation && !rolling) return null;
  return {
    role: "system",
    content: "【本局连续上下文】以下记录把引擎确认的操作事实与模型当时意图区分开，不是新的玩家命令。" +
      "把它当作自己的本局记忆；优先相信当前世界状态、当前相关规则和引擎事实，再决定是否延续旧意图，不要因为普通事件推进就从零思考。\n" +
      [rolling, continuation, memory].filter(Boolean).join("\n")
  };
}

function rollingPhasePlanFor(player) {
  const plan = player && rollingPhasePlans.get(player);
  if (!plan || plan.finished) return null;
  const anchor = currentDecisionTurnAnchor();
  if (plan.player !== player || plan.phaseNumber !== anchor.phaseNumber || plan.roundNumber !== anchor.roundNumber ||
    plan.currentPhase !== anchor.currentPhase || _status.currentPhase !== player) {
    clearRollingPhasePlan(plan, "阶段或回合已经结束");
    return null;
  }
  return plan;
}

function clearRollingPhasePlan(plan, reason) {
  if (!plan || plan.finished) return;
  plan.finished = true;
  try { rollingPhasePlans.delete(plan.player); } catch (e) { }
  liveRollingPhasePlans.delete(plan);
  if (reason) log("本回合连续计划结束：" + reason);
}

function rollingStepText(step) {
  if (!step) return "";
  const protocol = modelProtocolPlanStep(step);
  return protocol ? JSON.stringify(protocol) : "";
}

function rollingPhasePlanText(player) {
  const plan = rollingPhasePlanFor(player);
  if (!plan) return "";
  const remaining = plan.steps.slice(plan.nextIndex).map(rollingStepText).filter(Boolean);
  if (!remaining.length) return "";
  return "【本回合尚未完成的行动方针】按顺序执行正式步骤：" + remaining.join(" → ") +
    (plan.intent ? "；原计划目的=" + plan.intent : "") +
    (plan.lastFailure ? "；上次未能直接续接=" + plan.lastFailure : "") +
    "。这是一份软计划：普通结算变化不会自动清空；能在当前合法候选中映射时直接续接，不能映射时只修正剩余部分。";
}

function installRollingPhasePlan(player, event, plan, choice, directiveOverride) {
  const previous = rollingPhasePlanFor(player);
  if (previous) clearRollingPhasePlan(previous, "模型已给出更新后的剩余计划");
  const steps = plan && Array.isArray(plan.rollingSteps) ? plan.rollingSteps.map(step => ({
    kind: step.kind, field: step.field, values: Array.isArray(step.values) ? step.values.slice() : []
  })) : [];
  if (choice && choice.action === "skill" && steps[0] && steps[0].kind === "card") {
    const costStep = steps[0];
    const selected = Array.from(ui.selected.cards || []);
    const matched = selected.some(card => costStep.field === "cardIds"
      ? costStep.values.map(String).includes(candidateCardId(card))
      : costStep.field === "cardNames" && costStep.values.map(String).includes(String(card && card.name || "")));
    if (matched) steps.shift();
  }
  if (!player || !steps.length || _status.currentPhase !== player) return null;
  const anchor = currentDecisionTurnAnchor();
  const rolling = {
    player,
    phaseNumber: anchor.phaseNumber,
    roundNumber: anchor.roundNumber,
    currentPhase: anchor.currentPhase,
    steps,
    nextIndex: 0,
    intent: String(choice && (choice.__llmNextIntent || choice.__llmReason) || plan.reason || "").slice(0, 500),
    directiveOverride: !!directiveOverride,
    lastFailure: "",
    suspendedEvent: null,
    finished: false
  };
  rollingPhasePlans.set(player, rolling);
  liveRollingPhasePlans.add(rolling);
  log("已保存本回合连续计划：" + steps.map(rollingStepText).join(" -> "));
  return rolling;
}

function advanceRollingPhasePlan(plan, count) {
  if (!plan || plan.finished) return;
  plan.nextIndex += Math.max(0, Number(count) || 0);
  plan.lastFailure = "";
  plan.suspendedEvent = null;
  while (plan.steps[plan.nextIndex] && plan.steps[plan.nextIndex].kind === "control") plan.nextIndex++;
  if (plan.nextIndex >= plan.steps.length) clearRollingPhasePlan(plan, "全部计划步骤已经消费");
}

async function waitForNaturalPlanPace() {
  try { await game.delayx(0.6); } catch (e) { }
}

function captureChatContext(startEvent, chatTarget) {
  const event = startEvent || _status.event || null;
  const timelineAnchor = captureTimelineAnchor(event);
  const world = captureWorldContext(event, chatTarget || game.me, {
    audience: "public_chat",
    timelineAnchor,
    throughSeq: timelineAnchor.timelineSeq,
    timelineLimit: TIMELINE_DETAIL_LIMIT
  });
  return {
    event,
    directiveAnchor: directiveEventAnchor(event),
    currentPhase: _status.currentPhase || null,
    phaseNumber: game.phaseNumber,
    roundNumber: game.roundNumber,
    timelineAnchor,
    world,
    worldText: world.worldText
  };
}

function scopeAnchorForChat(scope, context, exactEvent) {
  context = context || captureChatContext(_status.event);
  if (scope === "event") return exactEvent ? (context.event || null) : (context.directiveAnchor || context.event || null);
  if (scope === "turn") return {
    currentPhase: context.currentPhase || null,
    phaseNumber: context.phaseNumber,
    roundNumber: context.roundNumber
  };
  return null;
}

function sameScopeAnchor(scope, left, right) {
  if (scope === "event") return left === right;
  if (scope !== "turn") return true;
  return !!left && !!right && left.currentPhase === right.currentPhase &&
    left.phaseNumber === right.phaseNumber && left.roundNumber === right.roundNumber;
}

function scopeActive(scope, anchor, event) {
  if (scope === "event") return !!anchor && (event === anchor || eventWithinDirectiveAnchor(event, anchor));
  if (scope === "turn") {
    return !!anchor && !!anchor.currentPhase && _status.currentPhase === anchor.currentPhase &&
      game.phaseNumber === anchor.phaseNumber && game.roundNumber === anchor.roundNumber;
  }
  return true;
}

function playerMemoryKey(p) {
  try {
    if (p && p.playerid) return String(p.playerid);
    const name = p && (p.name || p.name1) || get.translation(p) || "unknown";
    return String(name) + "#" + seatNumber(p);
  } catch (e) { return "unknown"; }
}

function addMemoryRule(target, targetName, text, options) {
  options = options || {};
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!clean) return false;
  const scope = ["event", "turn", "game"].includes(options.scope) ? options.scope : "game";
  const anchor = scope === "game" ? null : options.anchor || scopeAnchorForChat(scope, options.sentContext);
  const duplicateIndex = memoryData.rules.findIndex(rule => rule.target === target && rule.text === clean &&
    rule.scope === scope && sameScopeAnchor(scope, rule.anchor, anchor));
  if (duplicateIndex >= 0) {
    const duplicate = memoryData.rules.splice(duplicateIndex, 1)[0];
    duplicate.updatedAt = Date.now();
    duplicate.createdAt = duplicate.updatedAt;
    if (options.explicit) duplicate.explicit = true;
    if (options.semantic) duplicate.semantic = options.semantic;
    duplicate.revision = Number(duplicate.revision || 1) + 1;
    memoryData.rules.push(duplicate);
    return duplicate;
  }
  const rule = {
    id: Date.now().toString(36),
    target: target || "*",
    targetName: targetName || "全部AI",
    text: clean,
    explicit: !!options.explicit,
    semantic: options.semantic || null,
    scope,
    anchor,
    revision: 1,
    createdAt: Date.now()
  };
  memoryData.rules.push(rule);
  if (memoryData.rules.length > 100) memoryData.rules = memoryData.rules.slice(-100);
  return rule;
}

function parseSeatReference(value) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : NaN;
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(?:第)?(\d{1,2})号(?:位)?$/);
  return match ? Number(match[1]) : NaN;
}

function removeMemoryRule(rule) {
  if (!rule) return false;
  const index = memoryData.rules.indexOf(rule);
  if (index < 0) return false;
  memoryData.rules.splice(index, 1);
  return true;
}

function rememberChat(role, target, targetName, text, metadata) {
  metadata = metadata || {};
  memoryData.chat.push({
    role: role,
    target: target,
    targetName: targetName,
    text: String(text || "").slice(0, 300),
    at: Date.now(),
    anchorEventId: metadata.anchorEventId || null,
    anchorSeq: Number(metadata.anchorSeq || 0) || 0,
    replyTo: metadata.replyTo || null
  });
  if (memoryData.chat.length > 100) memoryData.chat = memoryData.chat.slice(-100);
}

function normalizeSemanticIntent(raw) {
  if (!raw) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const active = raw.isDirective !== undefined ? !!raw.isDirective :
    raw.active !== undefined ? !!raw.active : String(raw.type || "").toLowerCase() === "decision";
  if (!active) return null;
  const confidence = raw.confidence === undefined ? 0.8 : Number(raw.confidence);
  if (!Number.isFinite(confidence)) return null;
  const scope = String(raw.scope || "").toLowerCase();
  if (!["event", "turn", "game"].includes(scope)) return null;
  let decisionTypes = raw.decisionTypes !== undefined ? raw.decisionTypes : raw.decisions;
  if (!Array.isArray(decisionTypes)) decisionTypes = decisionTypes ? [decisionTypes] : [];
  const aliases = {
    any: "all", action: "all", response: "response", respond: "response",
    play: "play", use: "play", discard: "discard", card: "card", target: "target", button: "button"
  };
  decisionTypes = decisionTypes.map(value => aliases[String(value || "").toLowerCase()]).filter(Boolean);
  if (!decisionTypes.length) return null;
  const targetSeat = raw.targetSeat === undefined || raw.targetSeat === null || raw.targetSeat === "" ? null : parseSeatReference(raw.targetSeat);
  if (targetSeat !== null && (!Number.isInteger(targetSeat) || targetSeat <= 0)) return null;
  const targetMode = String(raw.target || "").toLowerCase();
  if (targetSeat === null && !["addressed", "all"].includes(targetMode)) return null;
  let subjects = raw.subjects;
  if (!Array.isArray(subjects)) subjects = subjects ? [subjects] : [];
  subjects = Array.from(new Set(subjects.map(value => String(value || "").trim().toLowerCase().slice(0, 48)).filter(Boolean)));
  if (decisionTypes.includes("response") && !subjects.length) return null;
  return {
    type: "decision",
    scope,
    decisionTypes: Array.from(new Set(decisionTypes)),
    targetMode: targetSeat !== null ? "seat" : targetMode,
    targetSeat,
    subjects,
    summary: String(raw.summary || raw.intent || "").trim().slice(0, 160),
    confidence
  };
}

function resolveSemanticIntentTarget(intent, addressedTarget) {
  if (!intent) return null;
  if (intent.targetSeat !== null) {
    const player = findAllowedAIBySeat(intent.targetSeat);
    if (!player) return null;
    return { key: playerMemoryKey(player), name: makePlayerRef(player) || playerDisplayName(player), player };
  }
  if (intent.targetMode === "all") return { key: "*", name: "所有获准AI", player: null };
  if (!addressedTarget || !mayWriteInGameMemory(relationToPlayer(addressedTarget))) return null;
  return { key: playerMemoryKey(addressedTarget), name: makePlayerRef(addressedTarget) || playerDisplayName(addressedTarget), player: addressedTarget };
}

function semanticIntentMatchesDecision(intent, type, event) {
  if (!intent || intent.type !== "decision") return false;
  const types = Array.isArray(intent.decisionTypes) ? intent.decisionTypes : [];
  if (types.includes("all") || types.includes(type)) return true;
  if (types.includes("response") && directiveIsResponseDecision(event)) return true;
  if (types.includes("discard") && type === "card" && event && event.name === "chooseToDiscard") return true;
  return types.includes("play") && isCardPlayDirectiveDecision(type, event) && !directiveIsResponseDecision(event);
}

function normalizeDecisionSpeedControl(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (String(raw.type || "decision_speed") !== "decision_speed") return null;
  const mode = String(raw.mode || "").toLowerCase();
  const scope = String(raw.scope || "").toLowerCase();
  const confidence = raw.confidence === undefined ? 0.8 : Number(raw.confidence);
  if (!["fast", "normal"].includes(mode) || !["event", "turn", "game"].includes(scope)) return null;
  if (!Number.isFinite(confidence)) return null;
  const targetSeat = raw.targetSeat === undefined || raw.targetSeat === null || raw.targetSeat === "" ? null : parseSeatReference(raw.targetSeat);
  if (targetSeat !== null && (!Number.isInteger(targetSeat) || targetSeat <= 0)) return null;
  const targetMode = String(raw.target || "addressed").toLowerCase() === "all" ? "all" : "addressed";
  return { type: "decision_speed", mode, scope, targetSeat, targetMode, confidence };
}

function findAllowedAIBySeat(seat) {
  return chatVisibleAIs().find(player => seatNumber(player) === seat) || null;
}

function addDecisionSpeedControl(raw, addressedTarget, sentContext) {
  const normalized = normalizeDecisionSpeedControl(raw);
  if (!normalized) return null;
  let target = addressedTarget;
  if (normalized.targetSeat !== null) target = findAllowedAIBySeat(normalized.targetSeat);
  const appliesToAll = normalized.targetMode === "all";
  if (!appliesToAll && (!target || !mayWriteInGameMemory(relationToPlayer(target)))) return null;
  const control = {
    id: Date.now().toString(36),
    type: "decision_speed",
    mode: normalized.mode,
    scope: normalized.scope,
    target: appliesToAll ? "*" : playerMemoryKey(target),
    targetName: appliesToAll ? "所有获准AI" : (makePlayerRef(target) || playerDisplayName(target)),
    anchor: scopeAnchorForChat(normalized.scope, sentContext, true),
    createdAt: Date.now()
  };
  if (control.scope !== "game" && !control.anchor) return null;
  if (control.scope === "turn" && !control.anchor.currentPhase) return null;
  memoryData.controls.push(control);
  if (memoryData.controls.length > 60) memoryData.controls = memoryData.controls.slice(-60);
  try {
    if (activeDecision && activeDecision.context && activeDecision.context.player &&
      speedControlApplies(control, activeDecision.context.player, activeDecision.context.event)) {
      const shouldAbort = control.mode === "fast" || activeDecision.requestMode === "speed";
      if (shouldAbort) {
        activeDecision.cancelledBySpeedControl = true;
        if (activeDecision.controller) activeDecision.controller.abort();
      }
    }
  } catch (e) { }
  return control;
}

function speedControlApplies(control, player, event) {
  if (!control || control.type !== "decision_speed" || !player) return false;
  if (!mayWriteInGameMemory(relationToPlayer(player))) return false;
  if (control.target !== "*" && control.target !== playerMemoryKey(player)) return false;
  if (control.scope === "event") return !!control.anchor && event === control.anchor;
  return scopeActive(control.scope, control.anchor, event);
}

function activeDecisionSpeedControl(player, event) {
  const controls = (memoryData.controls || []).filter(control => speedControlApplies(control, player, event));
  return controls.length ? controls[controls.length - 1] : null;
}

function decisionSpeedMode(player, event) {
  const control = activeDecisionSpeedControl(player, event);
  return control ? control.mode : "normal";
}

function lessonsText(player) {
  if (!mayWriteInGameMemory(relationToPlayer(player))) return "";
  const key = playerMemoryKey(player);
  const active = memoryData.rules.filter(rule => scopeActive(rule.scope, rule.anchor, _status.event));
  const explicit = active.filter(rule => rule.explicit);
  const ordinary = active.filter(rule => !rule.explicit).slice(-20);
  const relevant = ordinary.concat(explicit).sort((a, b) => a.createdAt - b.createdAt);
  if (!relevant.length) return "";
  return "\n【共享局内记忆】\n" + relevant.map(rule => {
    const owner = rule.target === "*" ? "全部AI" : (rule.targetName || "某AI");
    const scopeText = rule.scope === "event" ? "仅当前事件" : rule.scope === "turn" ? "仅当前回合" : "本局";
    const prefix = (rule.explicit ? "明确指令" : "策略记忆") + "·" + scopeText;
    return "- [" + prefix + "→" + owner + "] " + rule.text;
  }).join("\n") +
    "\n所有获准参与局内聊天的 AI 都能看到这些记忆；只有标给你的明确指令要求你执行，标给其他 AI 的内容只作共享上下文。冲突时以较新的指令为准；‘允许/解禁’只撤销旧禁止，不等于强制选择。游戏合法性永远优先。\n";
}

function chatHistoryText(player, limit) {
  if (!mayWriteInGameMemory(relationToPlayer(player))) return "";
  const count = Number(limit);
  const recent = Number.isFinite(count) && count > 0 ? memoryData.chat.slice(-count) : memoryData.chat.slice();
  if (!recent.length) return "";
  return recent.map(item => item.role === "user"
    ? "玩家对" + (item.targetName || "AI") + "：" + item.text
      : (item.targetName || "AI") + "：" + item.text).join("\n");
}

function decisionChatContextText(player, limit, excludedText) {
  if (!mayWriteInGameMemory(relationToPlayer(player))) return "";
  const key = playerMemoryKey(player);
  const count = Math.max(1, Number(limit) || ACTION_CHAT_CONTEXT_LIMIT);
  const excluded = String(excludedText || "");
  return memoryData.chat.filter(item => item.target === key &&
    (item.role !== "user" || !item.text || !excluded.includes(item.text)))
    .slice(-count).map(item => item.role === "user" ? "玩家：" + item.text : "你先前回复：" + item.text).join("\n");
}

function directiveEventAnchor(startEvent) {
  let current = startEvent || _status.event;
  const fallback = current || null;
  for (let depth = 0; current && depth < 10; depth++) {
    /* 绑定最近的牌事件。继续向上覆盖会把“这个”错误地挂到外层牌或整段阶段。 */
    if (current.name === "useCard" || current.card) return current;
    let parent = null;
    try { parent = typeof current.getParent === "function" ? current.getParent() : current.parent; } catch (e) { }
    if (!parent || parent === current) break;
    current = parent;
  }
  return fallback;
}

function eventWithinDirectiveAnchor(event, anchor) {
  if (!anchor) return false;
  let current = event;
  for (let depth = 0; current && depth < 12; depth++) {
    if (current === anchor) return true;
    let parent = null;
    try { parent = typeof current.getParent === "function" ? current.getParent() : current.parent; } catch (e) { }
    if (!parent || parent === current) break;
    current = parent;
  }
  return false;
}

function explicitRulesForPlayer(player, event) {
  if (!mayWriteInGameMemory(relationToPlayer(player))) return [];
  const key = playerMemoryKey(player);
  return memoryData.rules.filter(rule => rule.explicit && (rule.target === key || rule.target === "*") &&
    scopeActive(rule.scope, rule.anchor, event));
}

function directiveCandidateLabel(type, candidate) {
  if (type === "card") return typeof candidate === "string" ? safeTranslation(candidate, candidate) : safeTranslation(candidate && candidate.name, cardText(candidate));
  if (type === "target") return makePlayerRef(candidate) || playerDisplayName(candidate);
  return buttonText(candidate);
}

function directiveStateForDecision(player, type, event, candidates) {
  const relevant = explicitRulesForPlayer(player, event)
    /* 只有聊天模型产出的结构化意图才能成为行动指令；原话由行动模型理解。 */
    .filter(rule => rule.semantic && semanticIntentMatchesDecision(rule.semantic, type, event));
  const selected = relevant.slice(-8);
  return {
    text: selected.map(rule => "- " + rule.text).join("\n"),
    signature: selected.map(rule => rule.id + ":" + (rule.revision || 1) + ":" + (rule.updatedAt || rule.createdAt || 0)).join("|")
  };
}

function normalizeDirectiveText(value) {
  return String(value || "").toLowerCase().replace(/[\s，。！？!?,.;:；：、…“”‘’"'（）()\[\]【】]/g, "");
}

function directiveCardIdentity(card) {
  if (!card || typeof card !== "object") return "";
  const name = normalizeDirectiveText(card.name);
  if (name !== "sha") return name;
  let nature = card.nature;
  try {
    if (typeof get.natureList === "function") {
      const list = get.natureList(card);
      if (Array.isArray(list) && list.length) nature = list;
    }
  } catch (e) { }
  const natures = (Array.isArray(nature) ? nature : [nature]).map(normalizeDirectiveText);
  if (natures.includes("thunder") || natures.includes("雷")) return "thunder_sha";
  if (natures.includes("fire") || natures.includes("火")) return "fire_sha";
  if (natures.includes("ice") || natures.includes("冰")) return "ice_sha";
  if (natures.includes("kami") || natures.includes("神")) return "kami_sha";
  return "sha";
}

function currentDirectiveCard(event) {
  try {
    if (typeof get.card === "function") {
      const card = get.card();
      if (card) return card;
    }
  } catch (e) { }
  try { if (ui.selected && ui.selected.cards && ui.selected.cards.length) return ui.selected.cards[0]; } catch (e) { }
  let current = event;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current.card) return current.card;
    let parent = null;
    try { parent = typeof current.getParent === "function" ? current.getParent() : current.parent; } catch (e) { }
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

function addDirectiveAlias(set, value) {
  if (typeof value !== "string" && typeof value !== "number") return;
  const raw = String(value).trim();
  if (!raw || raw === "[object Object]") return;
  const clean = normalizeDirectiveText(raw);
  if (clean) set.add(clean);
  const withoutDetails = normalizeDirectiveText(raw.replace(/[（(][^）)]*[）)]/g, ""));
  if (withoutDetails) set.add(withoutDetails);
}

function collectDirectiveCandidateValues(value, set, depth) {
  if (value === null || value === undefined || depth > 3) return;
  if (typeof value === "string" || typeof value === "number") {
    addDirectiveAlias(set, value);
    try { addDirectiveAlias(set, safeTranslation(value, value)); } catch (e) { }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectDirectiveCandidateValues(item, set, depth + 1));
    return;
  }
  if (typeof value === "object") {
    if (value.name !== undefined) collectDirectiveCandidateValues(value.name, set, depth + 1);
    if (value.link !== undefined && value.link !== value) collectDirectiveCandidateValues(value.link, set, depth + 1);
  }
}

function candidateDirectiveAliases(type, candidate) {
  const aliases = new Set();
  addDirectiveAlias(aliases, directiveCandidateLabel(type, candidate));
  if (type === "target") {
    addDirectiveAlias(aliases, makePlayerRef(candidate));
    const seat = seatNumber(candidate);
    if (seat !== 999) { addDirectiveAlias(aliases, seat + "号"); addDirectiveAlias(aliases, seat + "号位"); }
    try { if (candidate === game.me) addDirectiveAlias(aliases, "我"); } catch (e) { }
  } else {
    collectDirectiveCandidateValues(candidate, aliases, 0);
    if (candidate && typeof candidate === "object") collectDirectiveCandidateValues(candidate.link, aliases, 0);
    if (type === "card" && candidate && typeof candidate === "object") addDirectiveAlias(aliases, directiveCardIdentity(candidate));
  }
  return Array.from(aliases).filter(Boolean).sort((a, b) => b.length - a.length);
}

function isCardPlayDirectiveDecision(type, event) {
  if (type !== "card" && type !== "target") return false;
  let current = event;
  for (let depth = 0; current && depth < 8; depth++) {
    const name = String(current.name || "");
    if (name === "chooseToUse" || name === "chooseToRespond" || name === "useCard") return true;
    let parent = null;
    try { parent = typeof current.getParent === "function" ? current.getParent() : current.parent; } catch (e) { }
    if (!parent || parent === current) break;
    current = parent;
  }
  if (type === "target") {
    try { return !!currentDirectiveCard(event); } catch (e) { }
  }
  return false;
}

function directiveIsResponseDecision(event) {
  let current = event;
  for (let depth = 0; current && depth < 8; depth++) {
    if (String(current.name || "") === "chooseToRespond") return true;
    let parent = null;
    try { parent = typeof current.getParent === "function" ? current.getParent() : current.parent; } catch (e) { }
    if (!parent || parent === current) break;
    current = parent;
  }
  return false;
}

function isWuxieDecision(event) {
  return !!(event && String(event.type || "").toLowerCase() === "wuxie");
}

function wuxieChainContext(event) {
  if (!isWuxieDecision(event)) return null;
  const map = event.info_map && typeof event.info_map === "object" ? event.info_map : {};
  const sourceMap = map._source && typeof map._source === "object" ? map._source : map;
  const state = Number(event.state !== undefined ? event.state : map.state) < 0 ? -1 : 1;
  const immediateCard = map.card || (Array.isArray(event.respondTo) ? event.respondTo[1] : null);
  const immediatePlayer = map.player || (Array.isArray(event.respondTo) ? event.respondTo[0] : null);
  /* state is the parity of the whole chain, not an indicator that the directly
   * challenged card is Wuxie. Odd counter layers can have state=+1. */
  const previousPlayer = directiveCardIdentity(immediateCard) === "wuxie" ? immediatePlayer : null;
  const originalCard = sourceMap.card || (Array.isArray(event.respondTo) ? event.respondTo[1] : null);
  const originalPlayer = sourceMap.isJudge ? sourceMap.target :
    (sourceMap.player || (Array.isArray(event.respondTo) ? event.respondTo[0] : null));
  const currentTarget = sourceMap.target || event.source || null;
  const originalTargets = Array.isArray(sourceMap.targets) && sourceMap.targets.length
    ? sourceMap.targets.slice() : currentTarget ? [currentTarget] : [];
  return { map, sourceMap, state, immediateCard, immediatePlayer, previousPlayer, originalCard, originalPlayer, currentTarget, originalTargets };
}

function wuxiePlayerRelation(actor, other) {
  if (!actor || !other) return 0;
  if (actor === other) return 1;
  try {
    const attitude = Number(get.attitude(actor, other));
    /* The native Wuxie AI also treats |attitude| < 3 as uncertain. */
    if (Number.isFinite(attitude) && attitude >= 3) return 1;
    if (Number.isFinite(attitude) && attitude <= -3) return -1;
  } catch (e) { }
  /* isFriendOf/isEnemyOf mean fixed teams in some modes, but in identity mode
   * two different rebels can report false/true respectively. Only a real side
   * flag is safe as a fallback when the attitude engine is undecided. */
  if (typeof actor.side === "boolean" && typeof other.side === "boolean") {
    return actor.side === other.side ? 1 : -1;
  }
  return 0;
}

function wuxieFriendlyCounterGuard(event) {
  const context = wuxieChainContext(event);
  /* Every layer after the first directly challenges another Wuxie. The chain
   * state only says whether the original trick is currently active, so odd
   * counter layers (state=+1) must receive the same teammate protection. */
  if (!context || !context.previousPlayer) return null;
  if (wuxiePlayerRelation(event.player, context.previousPlayer) <= 0) return null;
  return {
    action: "skip",
    indices: [],
    previousPlayer: context.previousPlayer,
    sourceMap: context.sourceMap
  };
}

function wuxieFriendlyOriginalGuard(event, scores) {
  const context = wuxieChainContext(event);
  if (!context || context.state <= 0 || directiveCardIdentity(context.immediateCard) === "wuxie") return null;
  if (wuxiePlayerRelation(event.player, context.originalPlayer) <= 0) return null;
  const advice = originalAIRecommendation(scores, event);
  if (!Number.isFinite(advice.bestCommit) || advice.bestCommit > 0) return null;
  return {
    action: "skip",
    indices: [],
    originalPlayer: context.originalPlayer,
    originalCard: context.originalCard,
    currentTarget: context.currentTarget
  };
}

function eventParent(event) {
  if (!event) return null;
  try { return typeof event.getParent === "function" ? event.getParent() : event.parent; } catch (e) { return event.parent || null; }
}

function activePhaseUseRoot(event) {
  /* “出牌阶段内/外”始终以当前作选择的武将本人为基准。
   * 响应事件有时也是 chooseToUse，并可能继承 type="phase"；若不先核对
   * currentPhase，就会把别人回合里打闪、无懈等误认成响应者自己的出牌阶段。 */
  if (!event || !event.player || _status.currentPhase !== event.player) return null;
  let current = event;
  for (let depth = 0; current && depth < 12; depth++) {
    if (current.name === "chooseToUse" && current.type === "phase" && current.player === event.player) return current;
    /* 主动技能确认后产生的 chooseCard/chooseTarget 可能已经离开最初 chooseToUse，
     * 但仍挂在同一 phaseUse 下；它们也属于操作者自己的出牌阶段内。 */
    if (current.name === "phaseUse" && event && event.player === current.player && _status.currentPhase === event.player) return current;
    /* Inserted response chains are outside the actor's active play phase. */
    if (current !== event && (current.name === "chooseToRespond" || isWuxieDecision(current) || current.type === "dying")) return null;
    const parent = eventParent(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

function isActivePhaseUseDecision(event) {
  if (!event || isWuxieDecision(event) || event.type === "dying" || event.name === "chooseToRespond") return false;
  return !!activePhaseUseRoot(event);
}

function responseOrRescueRoot(event) {
  if (!event) return null;
  let current = event;
  let deferredChooseToUse = null;
  for (let depth = 0; current && depth < 14; depth++) {
    const name = String(current.name || "").toLowerCase();
    const type = String(current.type || "").toLowerCase();
    if (isWuxieDecision(current) || name === "choosetorespond" || name === "dying" ||
      type === "dying" || type === "wuxie" || type.indexOf("respond") === 0) return current;
    if (name === "choosetouse") {
      if (type === "phase" && current.player === event.player && _status.currentPhase === event.player) return null;
      deferredChooseToUse = deferredChooseToUse || current;
    }
    /* 主动出牌链里的 chooseToUse 可能没有 type；先找 phaseUse，再决定它不是响应。 */
    if (name === "phaseuse" && current.player === event.player && _status.currentPhase === event.player) return null;
    const parent = eventParent(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return deferredChooseToUse;
}

const RESOURCE_SELECTION_EVENT_NAMES = new Set([
  "choosetodiscard", "discardplayercard", "gainplayercard", "chooseplayercard",
  "choosetogive", "choosecardtogive", "chooseexchange", "choosetomove",
  "choosecardtomove", "phasediscard"
]);

function resourceSelectionRoot(event) {
  let current = event;
  for (let depth = 0; current && depth < 12; depth++) {
    if (RESOURCE_SELECTION_EVENT_NAMES.has(String(current.name || "").toLowerCase())) return current;
    const parent = eventParent(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

function selectedCountForType(type) {
  try {
    if (type === "card") return ui.selected.cards.length;
    if (type === "target") return ui.selected.targets.length;
    if (type === "button") return ui.selected.buttons.length;
  } catch (e) { }
  return 0;
}

function mechanicalSelectionReason(event, type, range, candidates) {
  if (!event || !event.forced) return "";
  const name = String(event.name || "").toLowerCase();
  if (name === "choosetodiscard") return "强制弃牌事件";
  if (!Array.isArray(candidates)) return "";
  const unique = Array.from(new Set(candidates.filter(Boolean)));
  if (unique.length <= 1) return "强制事件至多一个合法候选";
  if (!Array.isArray(range)) return "";
  const already = selectedCountForType(type);
  const min = Math.max(0, Number(range[0]) - already);
  if (min > 0 && unique.length <= min) return "强制事件的全部剩余候选都必须选择";
  return "";
}

function classifyOriginalAIEvent(event, type, range, candidates) {
  const mechanicalReason = mechanicalSelectionReason(event, type, range, candidates);
  if (mechanicalReason) return { id: "mechanical", reason: mechanicalReason };
  /* 除强制弃牌外，forced 事件要看到实时候选后才能判断是不是“机械选择”。
   * 首次桥接的早期检查还没有候选，不能提前把它误归到其他开关。 */
  if (event && event.forced && !Array.isArray(candidates)) return { id: null, reason: "等待实时候选后分类" };
  if (responseOrRescueRoot(event)) return { id: "response", reason: "响应、无懈、濒死救援或被要求使用牌" };
  if (resourceSelectionRoot(event)) return { id: "resource", reason: "弃牌、获得/弃置他人牌、给牌或移动整理资源" };
  if (isActivePhaseUseDecision(event)) return { id: "play_plan", reason: "当前武将自己的主动出牌链" };
  return { id: "tactical", reason: "技能、按钮、目标或其他战术选择" };
}

function originalAITakeoverDecision(event, type, range, candidates) {
  const classified = classifyOriginalAIEvent(event, type, range, candidates);
  const definition = ORIGINAL_AI_EVENT_CATEGORIES[classified.id];
  if (!definition) return { id: null, label: "待分类", key: "", reason: classified.reason, enabled: false };
  return {
    id: classified.id,
    label: definition.label,
    key: definition.key,
    reason: classified.reason,
    enabled: !!cfg[definition.key]
  };
}

function shouldUseOriginalAIByEventCategory(event, type, range, candidates) {
  return originalAITakeoverDecision(event, type, range, candidates).enabled;
}

function logOriginalAITakeover(event, type, range, candidates) {
  const decision = originalAITakeoverDecision(event, type, range, candidates);
  if (decision.enabled) log("原版 AI 事件托管=" + decision.label + "（" + decision.reason + "），本次不调用模型");
  return decision.enabled;
}

/* Generic rules do not bind Wuxie decisions. Explicit Wuxie response rules can,
 * while ordinary Wuxie choices are still decided from the live board state. */
function explicitWuxieDirectiveState(player, type, event) {
  if (!isWuxieDecision(event) || !player) return { text: "", signature: "" };
  const selected = explicitRulesForPlayer(player, event).filter(rule => {
    const intent = rule && rule.semantic;
    const types = intent && Array.isArray(intent.decisionTypes) ? intent.decisionTypes : [];
    const subjects = intent && Array.isArray(intent.subjects) ? intent.subjects : [];
    return intent && intent.type === "decision" && types.includes("response") &&
      (subjects.includes("wuxie") || subjects.includes("any_response"));
  }).slice(-4);
  return {
    text: selected.map(rule => "- " + rule.text).join("\n"),
    signature: selected.map(rule => rule.id + ":" + (rule.revision || 1) + ":" + (rule.updatedAt || rule.createdAt || 0)).join("|")
  };
}

function clearMemory(options) {
  options = options || {};
  memoryData = emptyMemoryData();
  resetCognitiveRuntime({ preserveHistoryCutoff: !options.newGame });
  lastChatTarget = null;
  try {
    const box = window._llmChatBox;
    if (box && box._llmRecords) box._llmRecords.replaceChildren();
    if (window._llmChatInput) window._llmChatInput.value = "";
    if (box && box._llmCloseMenu) box._llmCloseMenu();
  } catch (e) { }
}

function registerInGameMemoryReset() {
  if (window._llmInGameMemoryReset) return;
  window._llmInGameMemoryReset = function () {
    cancelActiveDecisionForLifecycle("本局已经结束，尚未完成的模型请求已取消，结果不会跨局执行");
    endDecisionJournalGame();
    clearMemory({ newGame: true });
    resetOriginalAIControl({ silent: true });
    log("对局已结束，共享聊天与局内记忆已清空");
  };
  if (!Array.isArray(lib.onover)) lib.onover = [];
  lib.onover.push(window._llmInGameMemoryReset);
}

function parseJSONObject(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object") return raw;
  const text = String(raw).trim();
  try { return JSON.parse(text); } catch (e) { }
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { break; }
      }
    }
  }
  return null;
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function resetCognitiveRuntime(options) {
  options = options || {};
  loggedSkillPromptMetrics.clear();
  Array.from(livePendingActionPlans).forEach(plan => {
    try { if (plan.event === _status.event) restoreSelectionTransaction(plan.transaction); } catch (e) { }
    clearPendingPlan(plan, "stale", "局内认知已清理，未完成的元计划不会继续执行");
  });
  Array.from(liveRollingPhasePlans).forEach(plan => clearRollingPhasePlan(plan, "局内认知已清理"));
  Array.from(livePendingCardCompletions).forEach(receipt => settleCardCompletion(receipt, "stale", "局内认知已清理，尚未完成的牌目标流程不记为成功"));
  try {
    if (options.preserveHistoryCutoff && gameTimelineStore && timelineRuntime) {
      timelineRuntime.clearTimelineBeforeNow(gameTimelineStore, timelineHistoryBuckets());
      gameTimelineStore.maxRecords = cfg.timelineMaxRecords;
    } else {
      gameTimelineStore = timelineRuntime && timelineRuntime.createTimelineStore({ maxRecords: cfg.timelineMaxRecords });
    }
  }
  catch (e) { gameTimelineStore = null; }
}

function timelineHistoryBuckets() {
  try { return Array.isArray(_status.globalHistory) ? _status.globalHistory : []; } catch (e) { return []; }
}

function syncGameTimeline(currentEvent) {
  if (!timelineRuntime) return null;
  if (!gameTimelineStore) resetCognitiveRuntime();
  if (!gameTimelineStore) return null;
  try {
    timelineRuntime.syncTimeline(gameTimelineStore, {
      globalHistory: timelineHistoryBuckets(),
      currentEvent: currentEvent || _status.event,
      currentPhase: _status.currentPhase,
      phaseNumber: game.phaseNumber,
      roundNumber: game.roundNumber,
      maxRecords: cfg.timelineMaxRecords,
      game,
      get,
      lib,
      getInfo: value => get.info(value),
      areaName: value => safeTranslation(value, value),
      playerKey: publicPlayerId,
      playerLabel: player => {
        let hidden = false;
        try { hidden = typeof player.isUnseen === "function" && player.isUnseen(0); } catch (e) { }
        return hidden ? "未公开角色" : playerDisplayName(player);
      },
      playerSeat: seatNumber
    });
  } catch (e) { log("战局时间线同步失败，已保留当前局面快照: " + e.message); }
  return gameTimelineStore;
}

function timelineTextFor(viewer, event, options) {
  options = options || {};
  const store = syncGameTimeline(event);
  if (!store) return "暂无";
  try {
    return timelineRuntime.renderTimeline(store, viewer, {
      throughSeq: options.throughSeq,
      limit: options.limit || TIMELINE_DETAIL_LIMIT
    }) || "暂无";
  } catch (e) { return "时间线渲染失败：" + e.message; }
}

function publicTimelineText(event, throughSeq, limit) {
  const store = syncGameTimeline(event);
  if (!store) return "暂无";
  try {
    const records = store.records.filter(record => record.seq <= (Number.isFinite(Number(throughSeq)) ? Number(throughSeq) : Infinity))
      .slice(-Math.max(1, Number(limit || TIMELINE_DETAIL_LIMIT)));
    return records.map(record => {
      const visible = (record.cards || []).filter(item => item && item.visibleTo && item.visibleTo.includes("everyone"));
      const clone = Object.assign({}, record, {
        cards: visible,
        cardCount: Math.max(Number(record.cardCount || 0), visible.length),
        skill: record.kind === "useSkill" ? "" : record.skill
      });
      return timelineRuntime.renderRecord(clone, null);
    }).join("\n") || "暂无";
  } catch (e) { return "暂无"; }
}

function publicEventContextText(event) {
  const store = syncGameTimeline(event);
  if (!store) return "私密事件细节省略";
  try {
    let current = event;
    const lines = [];
    for (let depth = 0; current && depth < 8; depth++) {
      const id = store.eventIds && store.eventIds.get(current);
      const record = id && store.byId.get(id);
      if (record) {
        const clone = Object.assign({}, record, {
          cards: (record.cards || []).filter(item => item && item.visibleTo && item.visibleTo.includes("everyone")),
          skill: record.kind === "useSkill" ? "" : record.skill
        });
        lines.push(timelineRuntime.renderRecord(clone, null));
      }
      current = eventParent(current);
    }
    return lines.length ? lines.join(" <- ") : "私密事件细节省略";
  } catch (e) { return "私密事件细节省略"; }
}

function captureTimelineAnchor(event) {
  const store = syncGameTimeline(event);
  if (!store) return Object.freeze({ anchorEventId: null, timelineSeq: 0, round: Number(game.roundNumber || 0), phase: "" });
  try {
    return timelineRuntime.captureChatAnchor(store, event, {
      roundNumber: game.roundNumber,
      phase: _status.event && _status.event.name,
      currentPhase: _status.currentPhase
    });
  } catch (e) { return Object.freeze({ anchorEventId: null, timelineSeq: 0, round: Number(game.roundNumber || 0), phase: "" }); }
}

function battleSkillSourceSnapshot(viewer, event, options) {
  if (!skillSourceRuntime) throw new Error("技能源码运行时模块未加载");
  options = options || {};
  const extraSkills = [];
  try { if (!options.publicOnly && event && typeof event.skill === "string") extraSkills.push(event.skill); } catch (e) { }
  const publicChat = !!options.publicOnly;
  const snapshot = skillSourceRuntime.buildStableSkillSourceSnapshot({
    lib,
    game,
    viewer,
    crypto,
    extraSkills,
    getPlayerSeat: (player, index) => seatNumber(player) || index + 1,
    getPlayerKey: player => playerMemoryKey(player),
    getPlayerLabel: player => makePlayerRef(player) || playerDisplayName(player),
    getSkillDefinition: name => {
      try { return get.info(name); } catch (e) { return undefined; }
    },
    /* lib.skill.global 是所有已加载包共同维护的全局注册表，包含大量与本局无关的
     * UI/内部/模式技能。把它整体展开会把单次提示从约一万 token 推到十几万。
     * 本次以在场角色实际技能和当前动态入口为根；技能声明的 global/group 等关联
     * 再由定义闭包追踪，避免遗漏所属技能的全局效果，同时不发送整个加载注册表。 */
    getGlobalSkills: () => [],
    getPlayerSkills: (player, observer) => {
      try { return player.getSkills(!publicChat && player === observer ? "invisible" : null, true, true); } catch (e) { return playerSkillNames(player, publicChat ? null : observer); }
    }
  });
  return snapshot;
}

function battleSkillDirectoryScope(viewer, options) {
  return (options && options.publicOnly ? "public:" : "actor:") + playerMemoryKey(viewer);
}

function dynamicSkillOwnershipPrompt(snapshot) {
  if (!snapshot || !snapshot.data) return "【本次技能归属】不可用";
  const data = snapshot.data;
  const owners = (data.owners || []).map(owner => [
    String(owner && owner.playerRef || owner && owner.playerKey || "?"),
    String(owner && owner.visibility || "public_only"),
    Array.isArray(owner && owner.skills) ? owner.skills : []
  ]);
  return "【本次技能归属与动态根】owners格式=[角色,可见性,技能ID列表]" +
    "\nowners=" + skillSourceRuntime.canonicalJSONStringify(owners) +
    "\nglobalSkills=" + skillSourceRuntime.canonicalJSONStringify(data.globalSkills || []) +
    "\ncurrentEventExtraSkills=" + skillSourceRuntime.canonicalJSONStringify(data.extraSkills || []);
}

function activeSkillRuleSummaries(snapshot) {
  if (!snapshot || !snapshot.data || !Array.isArray(snapshot.data.definitions)) return [];
  const descriptionLimit = Math.max(120, Math.min(1200, Number(cfg.skillDescLen) || 600));
  return snapshot.data.definitions.map(item => {
    const description = compactRuleText(item && item.description || "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      name: String(item && item.name || ""),
      title: String(item && item.title || ""),
      description: description.slice(0, descriptionLimit),
      descriptionStatus: description ? "available" : "unavailable"
    };
  }).filter(item => item.name);
}

function battleDynamicSkillSummaries(viewer, options) {
  let players = [];
  try { players = (game.filterPlayer ? game.filterPlayer() : []).slice().sort((a, b) => seatNumber(a) - seatNumber(b)); } catch (e) { }
  return players.map(player => {
    const description = playerDynamicSkillText(player, options && options.publicOnly ? null : viewer);
    if (!description) return null;
    const playerRef = options && options.publicOnly
      ? "playerId=" + publicPlayerId(player) + "|seat=" + (seatNumber(player) === 999 ? "?" : seatNumber(player))
      : (makePlayerRef(player) || playerDisplayName(player));
    return { player: playerRef, description };
  }).filter(Boolean);
}

function currentBattleSkillNames(snapshot) {
  if (!snapshot || !snapshot.data) return [];
  const names = [];
  const add = value => {
    if (typeof value === "string" && value && !names.includes(value)) names.push(value);
  };
  (snapshot.data.owners || []).forEach(owner => (owner && owner.skills || []).forEach(add));
  (snapshot.data.extraSkills || []).forEach(add);
  return names;
}

function activeSkillRuleSummariesForBattle(snapshot) {
  const active = new Set(currentBattleSkillNames(snapshot));
  const definitions = snapshot && snapshot.data && Array.isArray(snapshot.data.definitions) ? snapshot.data.definitions : [];
  /* definitions 已包含从当前根技能追到的 group/global/inherit/subSkill 闭包；
   * 因而可全部保留，不再混入注册表里与本局无关的其他全局技能。 */
  definitions.forEach(item => { if (item && item.name) active.add(String(item.name)); });
  return activeSkillRuleSummaries(snapshot).filter(item => active.has(item.name));
}

function battleSkillSourceMessages(viewer, event, options) {
  try {
    /* 只用安全快照确定当前技能及关联闭包；原始 JavaScript 定义不再进入 API 请求。 */
    const snapshot = battleSkillSourceSnapshot(viewer, event, options);
    if (!snapshot.complete) {
      const reason = snapshot.diagnostics.slice(0, 3).map(item => item.path + ":" + item.reason).join("；");
      log("技能规则目录快照不完整，本次仍使用可用中文说明：" + reason);
    }
    let eventSkill = "";
    try { eventSkill = event && typeof event.skill === "string" ? event.skill : ""; } catch (e) { }
    const compactRules = activeSkillRuleSummariesForBattle(snapshot).map(item => [
      item.name,
      item.title,
      item.description || "[中文说明不可用]"
    ]);
    const compactDynamicRules = battleDynamicSkillSummaries(viewer, options).map(item => [item.player, item.description]);
    const dynamic = dynamicSkillOwnershipPrompt(snapshot) +
      "\n【当前在场技能中文规则】不发送JavaScript源码；必须结合中文规则、动态说明和实时合法候选理解技能，不能仅凭技能ID猜测。" +
      "\nactiveSkillRules格式=[技能ID,中文名,中文效果]" +
      "\nactiveSkillRules=" + skillSourceRuntime.canonicalJSONStringify(compactRules) +
      "\ndynamicSkillRules格式=[角色,当前动态说明]" +
      "\ndynamicSkillRules=" + skillSourceRuntime.canonicalJSONStringify(compactDynamicRules) +
      (eventSkill ? "\ncurrentEventSkill=" + skillSourceRuntime.canonicalJSONStringify([eventSkill]) : "");
    const scope = battleSkillDirectoryScope(viewer, options);
    const metric = "roots=" + currentBattleSkillNames(snapshot).length +
      " definitions=" + (snapshot.data && snapshot.data.definitions || []).length +
      " source_sent_chars=0" +
      " rule_summary_chars=" + dynamic.length;
    if (loggedSkillPromptMetrics.get(scope) !== metric) {
      loggedSkillPromptMetrics.set(scope, metric);
      log("[技能提示体积] scope=" + scope + " " + metric);
    }
    return {
      stable: "",
      stableMessages: [],
      dynamic,
      catalogHash: snapshot.catalogHash || ""
    };
  } catch (e) {
    log("技能中文规则快照构建失败：" + e.message);
    const unavailable = "【技能中文规则快照不可用】" + e.message;
    return { stable: "", stableMessages: [], dynamic: unavailable, catalogHash: "" };
  }
}

function battleSkillSourcePrompt(viewer, event, options) {
  const messages = battleSkillSourceMessages(viewer, event, options);
  return [messages.stable, messages.dynamic].filter(Boolean).join("\n");
}

function publicBattleSkillSourcePrompt(viewer, event) {
  return battleSkillSourcePrompt(viewer, event, { publicOnly: true });
}

function currentGameModeContext() {
  let modeId = "unknown";
  let subMode = "";
  try { modeId = String((typeof get.mode === "function" && get.mode()) || lib.config.mode || "unknown"); } catch (e) { }
  try { subMode = String(_status.mode || ""); } catch (e) { }
  const names = {
    identity: "身份", doudizhu: "斗地主", guozhan: "国战", versus: "对决",
    single: "单挑", boss: "挑战", chess: "战棋", tafang: "塔防", brawl: "乱斗",
    connect: "联机", stone: "炉石"
  };
  let modeName = names[modeId] || "";
  if (!modeName) {
    try { modeName = safeTranslation(modeId, modeId); } catch (e) { modeName = modeId; }
  }
  let identityRule = "本模式的阵营公开规则可能由模式或扩展自定义；以全场状态中每名角色当前显示的身份和关系估计为事实，不得把未公开身份当作已知。";
  if (modeId === "identity") {
    identityRule = "身份模式通常在开局隐藏主公以外的身份，之后可能因死亡、技能或本体规则逐步公开；自己知道自己的真实身份，其他角色以当前界面是否已经公开为准。";
  } else if (modeId === "doudizhu") {
    identityRule = "斗地主是明阵营模式：角色确定后地主与农民身份公开；地主对应主公阵营，农民对应反贼阵营，应直接按公开身份判断敌友。";
  } else if (modeId === "guozhan") {
    identityRule = "国战中武将和势力可能从暗置开始，亮将后才公开相应信息；以当前实际亮将、势力和界面状态为准。";
  } else if (["versus", "single", "boss", "chess", "tafang"].includes(modeId)) {
    identityRule = "这是阵营或对抗关系通常公开的模式；仍以当前界面状态和本体提供的阵营关系为最终事实。";
  }
  let shown = 0;
  let hidden = 0;
  try {
    const players = (game.players || []).concat(game.dead || []);
    players.forEach(player => {
      const isShown = !!(player && (player.identityShown || player.isZhu || player.identity === "zhu" || player.identity === "lord"));
      if (isShown) shown++; else hidden++;
    });
  } catch (e) { }
  const modeText = "modeId=" + modeId + "|modeName=" + modeName +
    (subMode ? "|subMode=" + subMode : "") +
    "|identityRule=" + identityRule +
    "|currentVisibility=已公开" + shown + "人，未公开" + hidden + "人；模式的一般规则只解释背景，每名角色当前状态行里的身份显示是本时点事实。";
  return Object.freeze({ modeId, modeName, subMode, identityRule, shown, hidden, modeText });
}

function captureWorldContext(event, viewer, options) {
  options = options || {};
  const timelineAnchor = options.timelineAnchor || captureTimelineAnchor(event);
  const throughSeq = options.throughSeq === undefined ? timelineAnchor.timelineSeq : options.throughSeq;
  const mode = currentGameModeContext();
  const world = {
    schemaVersion: WORLD_CONTEXT_SCHEMA_VERSION,
    capturedAt: Date.now(),
    audience: options.audience || "actor_decision",
    match: {
      phaseNumber: Number(game.phaseNumber || 0),
      roundNumber: Number(game.roundNumber || 0),
      currentPhase: playerMemoryKey(_status.currentPhase),
      modeId: mode.modeId,
      modeName: mode.modeName,
      subMode: mode.subMode
    },
    modeText: mode.modeText,
    actor: makePlayerRef(viewer) || playerDisplayName(viewer),
    boardText: options.audience === "public_chat" ? publicPlayersStateText() : allPlayersStateText(viewer),
    handText: options.audience === "public_chat" ? "SELF_HAND=[聊天公开视角不提供任何玩家的私密手牌]" : selfHandText(viewer),
    eventText: options.audience === "public_chat" ? publicEventContextText(event) : eventFactText(event),
    eventChainText: options.audience === "public_chat" ? "不展开私密事件链；以上述公开事件和公开时间线为准" : eventChainText(event, false),
    selectedText: selectedText(),
    timelineText: options.audience === "public_chat" ? publicTimelineText(event, throughSeq, options.timelineLimit) : timelineTextFor(viewer, event, {
      audience: options.audience || "actor_decision",
      throughSeq,
      limit: options.timelineLimit || TIMELINE_DETAIL_LIMIT
    }),
    recentChatText: chatHistoryText(viewer, CHAT_REPLY_HISTORY_LIMIT),
    timelineAnchor
  };
  const fingerprintPayload = Object.assign({}, world);
  delete fingerprintPayload.capturedAt;
  if (fingerprintPayload.timelineAnchor) {
    fingerprintPayload.timelineAnchor = Object.assign({}, fingerprintPayload.timelineAnchor);
    delete fingerprintPayload.timelineAnchor.at;
  }
  world.fingerprint = sha256(JSON.stringify(fingerprintPayload));
  world.worldText = "【当前游戏模式】" + world.modeText +
    "\n【当前全场状态】\n" + world.boardText +
    "\n【当前事件】" + world.eventText +
    "\n【事件链】" + world.eventChainText +
    "\n【本局公开事件时间线】\n" + world.timelineText;
  return Object.freeze(world);
}

function decisionWorldWithSpeechRequest(world, speechRequested) {
  /* WorldContext 本身故意冻结，避免请求期间被后续逻辑篡改。
   * 决策会话私有的随机发言开关放进新的外层快照，不能修改原对象。 */
  return Object.freeze(Object.assign({}, world, { speechRequested: !!speechRequested }));
}

function restoreCoreOnRemove() {
  const appDir = findAppDir();
  const contentPath = appDir && path.join(appDir, "noname", "library", "element", "content.js");
  if (!contentPath || !fs.existsSync(contentPath)) return { restored: false, message: "未找到本体源码，无需还原" };
  const backupPath = contentPath + ".bak-llm-ai";
  const metaPath = contentPath + ".llm-ai-meta.json";
  const current = fs.readFileSync(contentPath, "utf8");
  const currentHash = sha256(current);
  const hasPatch = /globalThis\.__nonameLLMChoose\s*\?/.test(current) || /await ai\.basic\.(chooseCard|chooseTarget|chooseButton)\(/.test(current);
  const hasBackup = fs.existsSync(backupPath);
  const hasMeta = fs.existsSync(metaPath);
  if (hasBackup !== hasMeta) {
    return { restored: false, warning: true, message: "缺少补丁备份或校验元数据，已拒绝覆盖本体源码" };
  }
  if (!hasBackup) {
    return hasPatch
      ? { restored: false, warning: true, message: "本体源码含大模型AI补丁，但没有可信备份，已拒绝覆盖" }
      : { restored: false, message: "本体源码未含大模型AI补丁，无需还原" };
  }
  const backup = fs.readFileSync(backupPath, "utf8");
  const meta = readCorePatchMeta(metaPath);
  if (!meta || sha256(backup) !== meta.backupHash) {
    return { restored: false, warning: true, message: "补丁备份或校验元数据无效，已拒绝自动覆盖本体源码" };
  }
  if (!hasPatch) {
    if (currentHash !== meta.backupHash) {
      return { restored: false, warning: true, message: "本体源码已更新，旧补丁备份不再匹配；源码保持不变，请人工核对残留侧车文件" };
    }
    try {
      fs.unlinkSync(metaPath);
      fs.unlinkSync(backupPath);
      return { restored: true, message: "本体源码已是原版，已清理补丁备份与校验元数据" };
    } catch (e) {
      return { restored: false, warning: true, message: "本体源码已是原版，但清理补丁侧车文件失败: " + e.message };
    }
  }
  if (currentHash !== meta.patchedHash) {
    return { restored: false, warning: true, message: "检测到本体或备份在安装后发生变化，已拒绝自动覆盖；当前桥接仍会回落同步原版AI" };
  }
  const tempPath = contentPath + ".llm-ai-restore.tmp";
  try {
    fs.writeFileSync(tempPath, backup, "utf8");
    if (sha256(fs.readFileSync(tempPath, "utf8")) !== meta.backupHash) throw new Error("还原临时文件哈希校验失败");
    fs.copyFileSync(tempPath, contentPath);
    fs.unlinkSync(tempPath);
    if (sha256(fs.readFileSync(contentPath, "utf8")) !== meta.backupHash) throw new Error("还原后哈希校验失败");
    fs.unlinkSync(metaPath);
    fs.unlinkSync(backupPath);
    return { restored: true, message: "已还原本体 content.js，并移除补丁备份与校验元数据" };
  } catch (e) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e2) { }
    return { restored: false, warning: true, message: "自动还原本体失败: " + e.message };
  }
}

function restoreLineAnimationOnRemove() {
  const appDir = findAppDir();
  const gamePath = appDir && path.join(appDir, "noname", "game", "index.js");
  if (!gamePath || !fs.existsSync(gamePath)) return { restored: false, message: "未找到本体指示线源码，无需还原" };
  const backupPath = gamePath + ".bak-llm-ai";
  const metaPath = gamePath + ".llm-ai-meta.json";
  const current = fs.readFileSync(gamePath, "utf8");
  const currentHash = sha256(current);
  const markerCount = current.split(LINE_ANIMATION_PATCH_MARKER).length - 1;
  const hasBackup = fs.existsSync(backupPath);
  const hasMeta = fs.existsSync(metaPath);
  if (hasBackup !== hasMeta) {
    return { restored: false, warning: true, message: "指示线补丁缺少备份或校验元数据，已拒绝覆盖本体" };
  }
  if (!hasBackup) {
    return markerCount
      ? { restored: false, warning: true, message: "本体含指示线兼容补丁，但没有可信备份，已拒绝覆盖" }
      : { restored: false, message: "本体指示线源码未含兼容补丁，无需还原" };
  }
  const backup = fs.readFileSync(backupPath, "utf8");
  const meta = readLineAnimationPatchMeta(metaPath);
  if (!meta || sha256(backup) !== meta.backupHash) {
    return { restored: false, warning: true, message: "指示线补丁备份或校验元数据无效，已拒绝覆盖本体" };
  }
  if (markerCount === 0) {
    if (currentHash !== meta.backupHash) {
      return { restored: false, warning: true, message: "本体指示线源码已更新，旧补丁备份不再匹配；已拒绝覆盖" };
    }
    try {
      fs.unlinkSync(metaPath);
      fs.unlinkSync(backupPath);
      return { restored: true, message: "本体指示线源码已是原版，已清理兼容补丁侧车文件" };
    } catch (e) {
      return { restored: false, warning: true, message: "本体指示线源码已是原版，但清理侧车文件失败: " + e.message };
    }
  }
  if (markerCount !== 1 || currentHash !== meta.patchedHash) {
    return { restored: false, warning: true, message: "检测到本体指示线源码在安装后发生变化，已拒绝自动覆盖" };
  }
  const tempPath = gamePath + ".llm-ai-restore.tmp";
  try {
    fs.writeFileSync(tempPath, backup, "utf8");
    if (sha256(fs.readFileSync(tempPath, "utf8")) !== meta.backupHash) throw new Error("指示线源码还原临时文件校验失败");
    fs.copyFileSync(tempPath, gamePath);
    fs.unlinkSync(tempPath);
    if (sha256(fs.readFileSync(gamePath, "utf8")) !== meta.backupHash) throw new Error("指示线源码还原后校验失败");
    fs.unlinkSync(metaPath);
    fs.unlinkSync(backupPath);
    return { restored: true, message: "已还原本体 game/index.js，并移除兼容补丁侧车文件" };
  } catch (e) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e2) { }
    return { restored: false, warning: true, message: "自动还原本体指示线源码失败: " + e.message };
  }
}

function plainText(value, fallback) {
  try {
    if (value && typeof value === "object" && value.nodeType) {
      value = value.innerText || value.textContent || "";
    }
    const text = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
    if (text && text !== "[object HTMLDivElement]" && text !== "[object Object]") return text;
  } catch (e) { }
  return String(fallback || "").trim();
}

function playerDisplayName(player) {
  try {
    const ids = [player && player.name1, player && player.name, player && player.name2]
      .filter((value, index, list) => typeof value === "string" && value && list.indexOf(value) === index);
    const names = ids.map(id => plainText(get.translation(id), id)).filter(Boolean);
    if (names.length) return names.join("/");
    return plainText(get.translation(player), player && player.playerid || "AI");
  } catch (e) { return plainText(player && player.name, "AI"); }
}

/* ========== 自建聊天框（彻底脱离十周年UI聊天框） ==========
 * 自己创建聊天 UI 挂到 body 右下角：输入框 + 发送按钮 + 消息记录 + @候选菜单。
 * 所有内部元素用普通文档流布局，@菜单用 absolute 相对聊天框本身（聊天框是 fixed，
 * 内部 absolute 天然相对它）——零外部坐标计算，缩放/遮罩/重建问题全部绕开。
 * 缩放适配：聊天框挂在 body 下，body 的 transform:scale 会整体缩放它，视觉正常。 */
function setupChatBox() {
  try {
    if (window._llmChatBox && document.body.contains(window._llmChatBox)) return window._llmChatBox;
    const box = document.createElement("div");
    box.id = "llm-ai-chatbox";
    box.style.cssText = "position:fixed;right:20px;bottom:16px;width:260px;height:190px;z-index:999999;" +
      "background:rgba(20,20,25,0.94);border:1px solid #666;border-radius:8px;display:flex;flex-direction:column;" +
      "font:12px/1.6 sans-serif;color:#eee;user-select:none;box-shadow:0 4px 20px rgba(0,0,0,0.5);";

    /* 标题栏：折叠/展开 + 关闭 */
    const title = document.createElement("div");
    title.style.cssText = "position:relative;width:100%;height:28px;padding:0 8px;border-bottom:1px solid #444;font-weight:bold;font-size:11px;flex:0 0 28px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;z-index:2;";
    const titleLeft = document.createElement("span");
    titleLeft.style.cssText = "display:flex;align-items:center;gap:5px;min-width:0;";
    const fastAIBtn = document.createElement("span");
    fastAIBtn.textContent = "🤖";
    fastAIBtn.setAttribute("role", "button");
    fastAIBtn.setAttribute("tabindex", "0");
    fastAIBtn.style.cssText = "display:inline-flex;width:22px;height:22px;align-items:center;justify-content:center;flex:0 0 22px;cursor:pointer;border:1px solid transparent;border-radius:4px;transition:none;";
    ["mousedown", "mouseup", "touchstart", "touchend"].forEach(name => fastAIBtn.addEventListener(name, event => {
      clearPointerResidueForTextInput();
      event.stopPropagation();
    }, name.startsWith("touch") ? { passive: true } : false));
    const titleText = document.createElement("span");
    titleText.textContent = "大模型聊天";
    titleText.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const titleBtns = document.createElement("span");
    titleBtns.style.cssText = "display:flex;gap:6px;";
    const foldBtn = document.createElement("span");
    foldBtn.textContent = "—";
    foldBtn.style.cssText = "cursor:pointer;color:#aaa;font-size:13px;padding:0 3px;";
    const closeBtn = document.createElement("span");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = "cursor:pointer;color:#aaa;font-size:13px;padding:0 3px;";
    titleBtns.appendChild(foldBtn);
    titleBtns.appendChild(closeBtn);
    titleLeft.appendChild(fastAIBtn);
    titleLeft.appendChild(titleText);
    title.appendChild(titleLeft);
    title.appendChild(titleBtns);
    box.appendChild(title);

    /* 聊天/日志页签 */
    const tabRow = document.createElement("div");
    tabRow.style.cssText = "position:relative;display:flex;flex:0 0 25px;height:25px;border-bottom:1px solid #444;";
    const chatTab = document.createElement("button");
    const logTab = document.createElement("button");
    chatTab.type = logTab.type = "button";
    chatTab.textContent = "聊天";
    logTab.textContent = "日志";
    [chatTab, logTab].forEach(button => {
      button.style.cssText = "flex:1 1 50%;height:25px;padding:0;border:0;background:transparent;color:#aaa;font:12px/25px sans-serif;cursor:pointer;";
      button.addEventListener("mousedown", event => event.stopPropagation());
    });
    tabRow.appendChild(chatTab);
    tabRow.appendChild(logTab);
    box.appendChild(tabRow);

    /* 消息记录区 */
    const records = document.createElement("div");
    records.style.cssText = "position:relative;display:block;width:100%;min-height:0;flex:1 1 auto;overflow-y:auto;padding:6px 8px;";
    box.appendChild(records);

    const logRecords = document.createElement("pre");
    logRecords.style.cssText = "position:relative;display:none;width:100%;min-height:0;flex:1 1 auto;overflow-y:auto;margin:0;padding:6px 8px;white-space:pre-wrap;word-break:break-word;user-select:text;font:11px/1.5 Consolas,'Microsoft YaHei',monospace;color:#ddd;";
    logRecords.textContent = cfg.decisionLog
      ? "本页只显示实时摘要：耗时、Token、缓存命中率、模型最终输出与执行结果。\n完整候选、提示、理由和服务端推理请在扩展设置中打开 TXT 决策日志。"
      : "决策日志未开启。";
    box.appendChild(logRecords);

    /* 输入区（纯文档流，天然贴合） */
    const inputRow = document.createElement("div");
    inputRow.style.cssText = "position:relative;width:100%;flex:0 0 auto;display:flex;padding:6px;border-top:1px solid #444;gap:4px;z-index:2;";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "@武将名 …";
    input.style.cssText = "flex:1 1 auto;background:rgba(255,255,255,0.12);border:1px solid #555;border-radius:4px;color:#eee;padding:4px 6px;font-size:12px;outline:none;min-width:0;";
    const sendBtn = document.createElement("button");
    sendBtn.textContent = "发送";
    sendBtn.style.cssText = "flex:0 0 auto;background:#c0392b;border:none;border-radius:4px;color:#fff;padding:4px 10px;cursor:pointer;font-size:12px;";
    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);
    box.appendChild(inputRow);

    document.body.appendChild(box);
    window._llmChatBox = box;
    window._llmChatInput = input;
    box._llmRecords = records;
    box._llmChatRecords = records;
    box._llmLogRecords = logRecords;
    box._llmTabRow = tabRow;
    box._llmActiveTab = "chat";
    box.addEventListener("mousedown", event => event.stopPropagation());
    box.addEventListener("touchstart", event => event.stopPropagation(), { passive: true });

    /* 标题栏拖动；位置写入本地存储，重启后仍保留。 */
    const positionKey = "llm-ai-chat-position-v2";
    const getZoom = () => {
      const zoom = Number(game.documentZoom);
      return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    };
    const clampPosition = (left, top) => {
      const zoom = getZoom();
      const width = box.offsetWidth || 260;
      const height = box.offsetHeight || 30;
      return {
        left: Math.max(0, Math.min(left, Math.max(0, window.innerWidth / zoom - width))),
        top: Math.max(0, Math.min(top, Math.max(0, window.innerHeight / zoom - height)))
      };
    };
    try {
      const saved = JSON.parse(localStorage.getItem(positionKey) || "null");
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        const point = clampPosition(saved.left, saved.top);
        box.style.left = point.left + "px";
        box.style.top = point.top + "px";
        box.style.right = "auto";
        box.style.bottom = "auto";
      }
    } catch (e) { }
    box._llmEnsureVisible = () => {
      const point = clampPosition(box.offsetLeft, box.offsetTop);
      box.style.left = point.left + "px";
      box.style.top = point.top + "px";
      box.style.right = "auto";
      box.style.bottom = "auto";
      try { localStorage.setItem(positionKey, JSON.stringify(point)); } catch (e) { }
    };
    let dragState = null;
    let suppressTitleClick = false;
    const moveDrag = event => {
      if (!dragState) return;
      const screenDX = event.clientX - dragState.startX;
      const screenDY = event.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(screenDX, screenDY) < 4) return;
      dragState.moved = true;
      const zoom = getZoom();
      const dx = screenDX / zoom;
      const dy = screenDY / zoom;
      const point = clampPosition(dragState.left + dx, dragState.top + dy);
      box.style.left = point.left + "px";
      box.style.top = point.top + "px";
      box.style.right = "auto";
      box.style.bottom = "auto";
    };
    const stopDrag = () => {
      if (!dragState) return;
      if (dragState.moved) {
        suppressTitleClick = true;
        try { localStorage.setItem(positionKey, JSON.stringify({ left: parseFloat(box.style.left) || 0, top: parseFloat(box.style.top) || 0 })); } catch (e) { }
        setTimeout(() => { suppressTitleClick = false; }, 0);
      }
      dragState = null;
      document.removeEventListener("mousemove", moveDrag, true);
      document.removeEventListener("mouseup", stopDrag, true);
    };
    title.addEventListener("mousedown", event => {
      if (event.button !== 0 || event.target === fastAIBtn || fastAIBtn.contains(event.target) || event.target === foldBtn || event.target === closeBtn || titleBtns.contains(event.target)) return;
      dragState = { startX: event.clientX, startY: event.clientY, left: box.offsetLeft, top: box.offsetTop, moved: false };
      document.addEventListener("mousemove", moveDrag, true);
      document.addEventListener("mouseup", stopDrag, true);
      event.preventDefault();
    }, true);

    const applyTab = () => {
      const chatActive = box._llmActiveTab !== "log";
      records.style.display = chatActive ? "block" : "none";
      logRecords.style.display = chatActive ? "none" : "block";
      inputRow.style.display = chatActive ? "flex" : "none";
      chatTab.style.color = chatActive ? "#fff" : "#999";
      logTab.style.color = chatActive ? "#999" : "#fff";
      chatTab.style.background = chatActive ? "rgba(255,255,255,.12)" : "transparent";
      logTab.style.background = chatActive ? "transparent" : "rgba(255,255,255,.12)";
    };

    /* 折叠/展开：默认收起成小条，不挡出牌 */
    let folded = true;
    box._llmSetTab = name => {
      if (name !== "chat" && name !== "log") return;
      box._llmActiveTab = name;
      if (box._llmCloseMenu) box._llmCloseMenu();
      if (!folded) applyTab();
    };
    chatTab.onclick = event => { event.stopPropagation(); box._llmSetTab("chat"); };
    logTab.onclick = event => { event.stopPropagation(); box._llmSetTab("log"); };
    const applyFold = () => {
      box._llmFolded = folded;
      if (folded) {
        if (box._llmCloseMenu) box._llmCloseMenu();
        box.style.height = "30px";
        box.style.width = "260px";
        tabRow.style.display = "none";
        records.style.display = "none";
        logRecords.style.display = "none";
        inputRow.style.display = "none";
        foldBtn.textContent = "+";
      } else {
        box.style.height = "215px";
        box.style.width = "260px";
        tabRow.style.display = "flex";
        applyTab();
        foldBtn.textContent = "—";
      }
      if (box._llmUpdateOriginalAIControl) box._llmUpdateOriginalAIControl();
    };
    box._llmUpdateOriginalAIControl = () => {
      const state = originalAIControlState();
      const count = state.selected.length;
      fastAIBtn.setAttribute("aria-pressed", state.allSelected ? "true" : count ? "mixed" : "false");
      fastAIBtn.title = "选择由原版 AI 接管的角色";
      fastAIBtn.style.background = state.allSelected ? "rgba(46,204,113,0.3)" : count ? "rgba(230,166,54,0.28)" : "transparent";
      fastAIBtn.style.borderColor = state.allSelected ? "#2ecc71" : count ? "#e6a636" : "transparent";
      fastAIBtn.style.opacity = count ? "1" : "0.72";
      titleText.textContent = state.allSelected ? "全体原版AI接管" : count ? "原版AI接管 " + count + "人" : (folded ? "聊天 (点击展开)" : "大模型聊天");
      if (box._llmRefreshOriginalAIControlMenu) box._llmRefreshOriginalAIControlMenu();
    };
    box._llmUnfold = () => { folded = false; applyFold(); };
    applyFold();
    title.onclick = (e) => {
      if (suppressTitleClick) return;
      if (e.target === fastAIBtn || fastAIBtn.contains(e.target)) return;
      if (e.target === closeBtn) return;
      if (e.target === foldBtn) return;
      folded = !folded;
      applyFold();
    };
    foldBtn.onclick = (e) => { e.stopPropagation(); folded = !folded; applyFold(); };
    fastAIBtn.onclick = (e) => {
      e.stopPropagation();
      showOriginalAIControlMenu();
    };
    fastAIBtn.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        showOriginalAIControlMenu();
      }
    };
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      try {
        if (box._llmCloseMenu) box._llmCloseMenu();
        box.style.display = "none";
      } catch (e2) { }
    };

    /* @ 候选菜单（挂在聊天框内部，absolute 相对聊天框，零错位） */
    let menu = null;
    let menuKind = "";
    const closeMenu = () => {
      if (menu) menu.remove();
      menu = null;
      menuKind = "";
    };
    box._llmCloseMenu = closeMenu;
    const showOriginalAIControlMenu = refresh => {
      if (!refresh && menu && menuKind === "original-ai") {
        closeMenu();
        return;
      }
      closeMenu();
      const state = originalAIControlState();
      const options = originalAIControlOptions();
      menuKind = "original-ai";
      menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.style.cssText = "position:absolute;left:4px;width:244px;max-height:150px;overflow-y:auto;z-index:4;" +
        "background:rgba(10,10,12,0.98);border:1px solid #666;border-radius:4px;padding:4px;" +
        "display:block;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.55);";
      const openAbove = folded && (box.offsetTop || 0) >= 160;
      if (openAbove) {
        menu.style.top = "auto";
        menu.style.bottom = "32px";
      } else {
        menu.style.top = "30px";
        menu.style.bottom = "auto";
      }
      ["mousedown", "mouseup", "touchstart", "touchend", "click"].forEach(name => menu.addEventListener(name, event => {
        clearPointerResidueForTextInput();
        event.stopPropagation();
      }, name.startsWith("touch") ? { passive: true } : false));
      const appendItem = (label, selected, onToggle, disabled) => {
        const item = document.createElement("div");
        item.setAttribute("role", "menuitemcheckbox");
        item.setAttribute("aria-checked", selected ? "true" : "false");
        item.style.cssText = "position:relative;display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:4px 7px;box-sizing:border-box;cursor:" +
          (disabled ? "default" : "pointer") + ";white-space:nowrap;overflow:hidden;color:" + (disabled ? "#888" : "#eee") + ";background:" +
          (selected ? "rgba(46,204,113,.2)" : "transparent") + ";";
        const mark = document.createElement("span");
        mark.textContent = selected ? "✓" : "";
        mark.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:0 0 16px;width:16px;height:16px;box-sizing:border-box;border:1px solid " +
          (selected ? "#65d48b" : "#777") + ";background:" + (selected ? "rgba(46,204,113,.25)" : "transparent") + ";color:#9af0b7;font:12px/16px sans-serif;";
        const text = document.createElement("span");
        text.textContent = label;
        text.style.cssText = "display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;";
        item.appendChild(mark);
        item.appendChild(text);
        if (!disabled) {
          item.onmouseenter = () => { item.style.background = selected ? "rgba(46,204,113,.3)" : "rgba(255,255,255,.13)"; };
          item.onmouseleave = () => { item.style.background = selected ? "rgba(46,204,113,.2)" : "transparent"; };
          item.onmousedown = event => { event.preventDefault(); event.stopPropagation(); };
          item.onclick = event => { event.stopPropagation(); onToggle(); };
        }
        menu.appendChild(item);
      };
      appendItem(options[0].label, options[0].selected, () => setAllOriginalAIControlled(!options[0].selected), !state.players.length);
      options.slice(1).forEach(option => {
        appendItem(option.label, option.selected, () => setOriginalAIControlled(option.player, !option.selected), false);
      });
      if (!state.players.length) appendItem("当前没有可接管的 AI 角色", false, () => {}, true);
      box.appendChild(menu);
    };
    box._llmRefreshOriginalAIControlMenu = () => {
      if (menu && menuKind === "original-ai") showOriginalAIControlMenu(true);
    };
    box._llmShowOriginalAIControlMenu = showOriginalAIControlMenu;
    const showMenu = (filterText) => {
      closeMenu();
      let players = chatVisibleAIs();
      if (filterText) players = players.filter(p => makePlayerRef(p).includes(filterText));
      if (!players.length) return;
      menuKind = "mentions";
      menu = document.createElement("div");
      menu.style.cssText = "position:absolute;left:8px;right:8px;bottom:44px;width:auto;max-height:112px;overflow-y:auto;z-index:3;" +
        "background:rgba(10,10,12,0.97);border:1px solid #666;border-radius:6px;padding:4px 0;" +
        "display:block;font-size:13px;";
      players.forEach(p => {
        const playerRef = makePlayerRef(p);
        const item = document.createElement("div");
        item.textContent = "@" + playerRef;
        item.style.cssText = "position:relative;display:block;width:100%;height:auto;min-height:32px;padding:4px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:24px;";
        item.onmouseenter = () => (item.style.background = "rgba(255,255,255,0.15)");
        item.onmouseleave = () => (item.style.background = "transparent");
        item.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
        item.onclick = (e) => {
          e.stopPropagation();
          const inp = window._llmChatInput;
          if (inp) {
            const caret = inp.selectionStart !== undefined ? inp.selectionStart : inp.value.length;
            const before = inp.value.slice(0, caret).replace(/@[^\s@，。！？!?,.;:；：、…]*$/, "@" + playerRef);
            const after = inp.value.slice(caret);
            const spacer = /^\s/.test(after) ? "" : " ";
            inp.value = before + spacer + after;
            const nextCaret = before.length + spacer.length;
            if (typeof inp.setSelectionRange === "function") inp.setSelectionRange(nextCaret, nextCaret);
          }
          closeMenu();
          window._llmJustPicked = true;
          setTimeout(() => { window._llmJustPicked = false; if (inp) inp.focus(); }, 100);
          log("已选择 @" + playerRef);
        };
        menu.appendChild(item);
      });
      box.appendChild(menu);
    };

    /* 输入事件：@ 触发候选菜单 */
    input.addEventListener("input", () => {
      const v = input.value;
      const caret = input.selectionStart !== undefined ? input.selectionStart : v.length;
      const before = v.slice(0, caret);
      const m = before.match(/@([^\s@，。！？!?,.;:；：、…]*)$/);
      if (m && !window._llmJustPicked) showMenu(m[1]);
      else closeMenu();
    });

    /* 发送 */
    const send = () => {
      const v = input.value.trim();
      if (!v) return;
      closeMenu();
      addChatRecord("你", v);
      handleChatMessage(v);
      input.value = "";
    };
    sendBtn.onclick = send;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); send(); }
    };

    log("自建聊天框已创建（右下角）");
    return box;
  } catch (e) {
    log("自建聊天框失败: " + e);
    return null;
  }
}

function isOriginalAIControlled(player) {
  if (!player) return false;
  return originalAIControlledPlayerKeys.has(playerMemoryKey(player));
}

function originalAIControlState() {
  const players = aliveAIs();
  const selected = players.filter(isOriginalAIControlled);
  return {
    players,
    selected,
    allSelected: players.length > 0 && selected.length === players.length
  };
}

function originalAIControlOptions() {
  const state = originalAIControlState();
  return [{ key: "all", label: "全体角色", selected: state.allSelected, player: null }].concat(
    state.players.map(player => ({
      key: playerMemoryKey(player),
      label: makePlayerRef(player),
      selected: isOriginalAIControlled(player),
      player
    }))
  );
}

function refreshOriginalAIControlUI() {
  try {
    const box = window._llmChatBox;
    if (box && box._llmUpdateOriginalAIControl) box._llmUpdateOriginalAIControl();
  } catch (e) { }
}

function abortActiveDecisionIfControlled() {
  if (!activeDecision || !activeDecision.context || !isOriginalAIControlled(activeDecision.context.player)) return;
  activeDecision.cancelledByFastMode = true;
  activeDecision.cancelReason = "player_original_ai_control";
  try { if (activeDecision.controller) activeDecision.controller.abort(); } catch (e) { }
}

function setOriginalAIControlled(player, enabled, options) {
  options = options || {};
  if (!player) return false;
  const key = playerMemoryKey(player);
  const before = originalAIControlledPlayerKeys.has(key);
  const next = !!enabled;
  if (next) originalAIControlledPlayerKeys.add(key);
  else originalAIControlledPlayerKeys.delete(key);
  if (next) abortActiveDecisionIfControlled();
  refreshOriginalAIControlUI();
  if (before !== next && !options.silent) {
    log(makePlayerRef(player) + (next ? " 已切换为原版 AI 接管" : " 已恢复大模型接管"));
  }
  return before !== next;
}

function setAllOriginalAIControlled(enabled, options) {
  options = options || {};
  const players = aliveAIs();
  const before = originalAIControlState();
  if (enabled) players.forEach(player => originalAIControlledPlayerKeys.add(playerMemoryKey(player)));
  else originalAIControlledPlayerKeys.clear();
  if (enabled) abortActiveDecisionIfControlled();
  refreshOriginalAIControlUI();
  const changed = before.selected.length !== originalAIControlState().selected.length;
  if (changed && !options.silent) log(enabled ? "全体角色已切换为原版 AI 接管" : "全体角色已恢复大模型接管");
  return changed;
}

function resetOriginalAIControl(options) {
  options = options || {};
  const changed = originalAIControlledPlayerKeys.size > 0;
  originalAIControlledPlayerKeys.clear();
  refreshOriginalAIControlUI();
  if (changed && !options.silent) log("全部角色已恢复大模型接管");
}

function openOrRestoreChatBox() {
  let box = window._llmChatBox;
  if (!box || !document.body.contains(box)) box = setupChatBox();
  if (!box) {
    showExtensionNotice("聊天框创建失败，请查看游戏控制台中的大模型AI日志。", "error");
    return;
  }
  try {
    if (box._llmUnfold) box._llmUnfold();
    if (box._llmEnsureVisible) box._llmEnsureVisible();
    box.style.display = "flex";
    setTimeout(() => {
      try { if (window._llmChatInput) window._llmChatInput.focus(); } catch (e) { }
    }, 0);
  } catch (e) {
    log("恢复聊天框失败: " + e.message);
  }
}

/* 在自建聊天框的记录区添加一条消息；折叠时自动展开 */
function addChatRecord(who, text) {
  try {
    const box = window._llmChatBox;
    if (!box) return;
    if (box._llmFolded === true) {
      box._llmUnfold && box._llmUnfold();
    }
    const records = box._llmChatRecords || box._llmRecords;
    if (!records) return;
    const line = document.createElement("div");
    line.style.cssText = "position:relative;display:block;width:100%;height:auto;padding:2px 0;word-break:break-all;";
    const whoSpan = document.createElement("span");
    whoSpan.style.cssText = "color:#7ecb7e;font-weight:bold;";
    whoSpan.textContent = who + ": ";
    const textSpan = document.createElement("span");
    textSpan.textContent = text;
    line.appendChild(whoSpan);
    line.appendChild(textSpan);
    records.appendChild(line);
    records.scrollTop = records.scrollHeight;
    if (records.childNodes.length > 100) records.removeChild(records.firstChild);
  } catch (e) { }
}

/* ========== 玩家对象安全判断 ==========
 * 无名杀 game.filterPlayer() 返回的列表可能混入没有 isMe/isAlive 方法的元素
 * （实际报错：p.isMe is not a function），所有玩家判断必须走这里 */
function isAIPlayer(p) {
  try {
    if (!p || typeof p !== "object") return false;
    if (typeof p.isMe === "function") return !p.isMe();
    return p !== game.me; /* 没有 isMe 方法时退化为身份比较 */
  } catch (e) { return false; }
}
function isAlivePlayer(p) {
  try { return !!p && typeof p.isAlive === "function" && p.isAlive(); } catch (e) { return false; }
}
function aliveAIs() {
  try {
    const players = game.filterPlayer ? game.filterPlayer() : [];
    return players.filter(p => isAIPlayer(p) && isAlivePlayer(p)).sort((a, b) => seatNumber(a) - seatNumber(b));
  } catch (e) { return []; }
}

/* ========== @ 输入触发候选菜单 ==========
 * 用户输入 @ 后弹出在场玩家列表，按座位号排序，点选填入 @武将名·N号。
 * 注意：body 有 transform:scale(zoom)，fixed 元素退化相对 body 定位，
 * 坐标必须用 rect(物理) / zoom(逻辑) 换算 */

function seatNumber(player) {
  try {
    const direct = typeof player.getSeatNum === "function" ? Number(player.getSeatNum()) : Number(player.seatNum);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const players = Array.isArray(game.players) ? game.players : (game.filterPlayer ? game.filterPlayer() : []);
    const index = players.indexOf(player);
    return index >= 0 ? index + 1 : 999;
  } catch (e) { return 999; }
}

function makePlayerRef(player) {
  const seat = seatNumber(player);
  return (playerDisplayName(player) || "玩家") + (seat === 999 ? "" : "·" + seat + "号");
}

/* @ 指定目标必须带座位号；候选菜单会自动填入“武将名·N号”。 */
function findPlayerByRef(text) {
  const atMatch = text.match(/@([^\s@，。！？!?,.;:；：、…]+)/);
  if (!atMatch) return null;
  const ref = atMatch[1];
  const ais = chatVisibleAIs();
  const exact = ais.find(p => makePlayerRef(p) === ref);
  if (exact) return exact;
  const seatMatch = ref.match(/(?:^|·)(\d+)号(?:位)?$/);
  if (seatMatch) {
    const bySeat = ais.find(p => seatNumber(p) === Number(seatMatch[1]));
    if (bySeat) return bySeat;
  }
  return null;
}

let lastChatTarget = null;

function relationToPlayer(target) {
  let isFriend = false;
  let isEnemy = false;
  try {
    if (game.me && typeof game.me.isFriendOf === "function") isFriend = !!game.me.isFriendOf(target);
  } catch (e) { }
  try {
    if (game.me && typeof game.me.isEnemyOf === "function") isEnemy = !!game.me.isEnemyOf(target);
  } catch (e) { }
  try {
    if (!isEnemy && target && typeof target.isEnemyOf === "function") isEnemy = !!target.isEnemyOf(game.me);
  } catch (e) { }
  if (!isFriend && !isEnemy) {
    try {
      const attitude = Number(get.attitude(game.me, target));
      if (Number.isFinite(attitude)) {
        isFriend = attitude > 0;
        isEnemy = attitude < 0;
      }
    } catch (e) { }
  }
  return { isFriend, isEnemy };
}

function mayWriteInGameMemory(relation) {
  return cfg.memoryPolicy === "all" ||
    (cfg.memoryPolicy === "friends" && relation.isFriend) ||
    (cfg.memoryPolicy === "enemies" && relation.isEnemy);
}

function chatVisibleAIs() {
  return aliveAIs().filter(player => mayWriteInGameMemory(relationToPlayer(player)));
}

function findChatTarget(text) {
  const hasExplicitTarget = /@[^\s@，。！？!?,.;:；：、…]+/.test(text);
  const explicit = findPlayerByRef(text);
  if (explicit) return explicit;
  if (hasExplicitTarget) return null;
  const ais = chatVisibleAIs();
  if (!ais.length) return null;
  try {
    const eventPlayer = _status.event && _status.event.player;
    if (eventPlayer && ais.includes(eventPlayer)) return eventPlayer;
  } catch (e) { }
  try {
    if (_status.currentPhase && ais.includes(_status.currentPhase)) return _status.currentPhase;
  } catch (e) { }
  if (lastChatTarget && ais.includes(lastChatTarget)) return lastChatTarget;
  return ais[0];
}

async function handleChatMessage(text) {
  const trimmed = String(text || "").trim();
  if (trimmed === "/清空记忆") {
    showExtensionConfirm("确定清空大模型AI的全部局内记忆和最近对话吗？", () => {
      cancelActiveDecisionForLifecycle("玩家清空了局内认知，旧请求不会继续执行");
      clearMemory();
      addChatRecord("系统", "记忆已清空");
    });
    return;
  }

  const target = findChatTarget(trimmed);
  if (!target) {
    addChatRecord("系统", "当前没有符合局内记忆权限的可聊天 AI 武将");
    return;
  }
  lastChatTarget = target;
  const name = makePlayerRef(target) || "AI";
  const message = trimmed.replace(/@[^\s@，。！？!?,.;:；：、…]+/, "").trim() || trimmed;
  const relation = relationToPlayer(target);
  const targetKey = playerMemoryKey(target);
  /* 回复可能晚到；局面与事件锚点必须以玩家发送消息的这一刻为准。 */
  const sentContext = captureChatContext(_status.event, target);
  const chatMetadata = sentContext.timelineAnchor ? {
    anchorEventId: sentContext.timelineAnchor.anchorEventId,
    anchorSeq: sentContext.timelineAnchor.timelineSeq
  } : {};
  rememberChat("user", targetKey, name, message, chatMetadata);
  try {
    const result = await askChatReply(message, target, sentContext);
    if (!result || !result.reply) throw new Error("模型没有生成有效回复");
    const reply = sanitizeChatReply(String(result.reply).replace(/^["'“”\s]+|["'“”\s]+$/g, "")).slice(0, 180);
    const semanticIntent = normalizeSemanticIntent(result.intent);
    const semanticTarget = resolveSemanticIntentTarget(semanticIntent, target);
    const speedControl = addDecisionSpeedControl(result.control, target, sentContext);
    if (semanticIntent && mayWriteInGameMemory(relation)) {
      if (!semanticTarget) {
        log("模型返回的聊天指令目标无法映射，本条只保留为普通聊天，不写入强制规则");
      } else {
        const storedRule = addMemoryRule(semanticTarget.key, semanticTarget.name, message, {
          explicit: true,
          semantic: semanticIntent,
          scope: semanticIntent.scope,
          anchor: scopeAnchorForChat(semanticIntent.scope, sentContext),
          sentContext
        });
        if (storedRule) {
        const scopeName = semanticIntent.scope === "event" ? "当前事件" : semanticIntent.scope === "turn" ? "当前回合" : "本局";
          log("模型识别玩家明确指令(" + semanticTarget.name + "，" + scopeName + "): " + message.slice(0, 100));
        }
      }
    }
    if (speedControl) {
      const speedScope = speedControl.scope === "event" ? "当前事件" : speedControl.scope === "turn" ? "当前回合" : "本局";
      log("记录决策速度控制(" + speedControl.targetName + "，" + speedScope + "): " + speedControl.mode);
    }
    rememberChat("assistant", targetKey, name, reply, Object.assign({}, chatMetadata, { replyTo: chatMetadata.anchorEventId || null }));
    addChatRecord(name, reply);
    try {
      if (typeof target.chat === "function") target.chat(reply);
      else lib.element.player.chat.call(target, reply);
    } catch (e) { }
    log("AI 回应(" + name + "): " + reply);
  } catch (e) {
    log("AI 聊天失败: " + e.message);
    addChatRecord(name, "这次没能及时接上，请再说一次。");
  }
}

async function askChatReply(message, target, sentContext) {
  if (!skillSourceRuntime || !timelineRuntime) {
    throw new Error("认知运行时模块未完整加载，已停止本次模型聊天");
  }
  const tName = playerDisplayName(target) || "AI";
  const humanRef = makePlayerRef(game.me) || playerDisplayName(game.me) || "真人玩家";
  let targetTrueIdentity = "未知";
  try { targetTrueIdentity = translateIdentity(target && target.identity); } catch (e) { }
  let others = "";
  try {
    const othersList = game.filterPlayer().filter(p => p !== target && isAIPlayer(p) && isAlivePlayer(p))
      .slice(0, 4).map(p => {
        const publicIdentity = visibleIdentity(game.me, p);
        return playerDisplayName(p) + (publicIdentity === "未公开" ? "" : "(" + publicIdentity + ")");
      });
    if (othersList.length) others = " 场上还有：" + othersList.join("、") + "。";
  } catch (e) { }
  const recent = chatHistoryText(target, CHAT_REPLY_HISTORY_LIMIT);
  const system = "你是三国杀对局中的武将「" + tName + "」。像真实牌友一样自然对话：结合上下文具体回应，允许幽默、质疑、解释、追问和表达情绪；不要固定使用‘收到’‘明白’‘抱歉’等套话，不要每次都同一种语气。" +
    "本次聊天沿用扩展设置：服务端推理档位=" + String(reasoningProfile().effort || "关闭") + "，提示词思考深度=" + String(cfg.promptThinkingDepth) + "%；从一开始就按这个百分比深度理解战局和原话，不使用旧版固定low限制。" +
    "对话中的说话者是真人玩家「" + humanRef + "」：玩家说‘我’永远指真人玩家本人，不是你；玩家说‘你’才指你。‘乐我’就是对真人玩家使用乐不思蜀，绝不能理解成乐你自己。" +
    "你知道自己的真实身份是“" + targetTrueIdentity + "”。聊天会公开显示在牌桌上，坦白身份、阵营立场或行动意图可能暴露自己；是否坦白、伪装、试探或保密，由你结合当前战局自主判断，不是硬性禁令。其他角色尚未公开的真实身份仍不是已知事实，不得把猜测说成确定事实。" +
    "你还要把玩家原话做结构化分类，但不要改写或替代原话。明确操作指令令 intent.isDirective=true；普通闲聊、提问和纯速度催促令 intent=null。不要依赖固定关键词，要结合本局战况、聊天历史和原话语义判断。" +
    "intent 必须明确 scope、target 与 decisionTypes，缺一项就返回null。scope只能是event、turn、game；target只能是addressed或all，也可用targetSeat指定某个座位；target指被约束的AI，不是牌的目标。decisionTypes从play、response、discard、card、target、button、all中选择。response还必须给subjects（如wuxie、shan、tao、any_response），避免把‘别闪’错误套到无懈。多阶段命令要列出所有阶段，但不要按牌名硬套固定模板。" +
    "玩家催某个 AI 出牌快点或恢复正常速度时，另输出 control={type:'decision_speed',mode:'fast或normal',scope:'event或turn或game',target:'addressed或all',targetSeat:座位号或null,confidence:0到1}。‘这次/立刻/这一步快点’是当前 event，‘这回合快点’是 turn，‘以后/本局都快点’是 game；纯速度命令的 intent 必须为 null。" +
    "输出严格 JSON：{\"reply\":\"自然回复，10到100字\",\"intent\":null或{\"isDirective\":true,\"scope\":\"event|turn|game\",\"target\":\"addressed|all\",\"targetSeat\":null,\"decisionTypes\":[\"play\"],\"subjects\":[],\"summary\":\"简述\",\"confidence\":0.9},\"control\":null或上述速度控制}。";
  const targetPublicIdentity = visibleIdentity(game.me, target);
  const prompt = "你的真实身份=" + targetTrueIdentity + "；目前在玩家界面中的公开状态=" + targetPublicIdentity + "。是否在回复中暴露，由你结合局势自行处理。" + others +
    "\n已有局内记忆：" + (lessonsText(target) || "无") +
    "\n你被允许读取的聊天框最近内容：\n" + (recent || "无；本次只回应玩家直接对你说的话") +
    "\n【玩家发送消息时的公开战局】\n" + (sentContext && sentContext.worldText || "暂无可用快照") +
    "\n玩家刚说：" + message;
    const publicSkillMessages = battleSkillSourceMessages(target, sentContext && sentContext.event, { publicOnly: true });
    const chatMessages = [{ role: "system", content: system }];
    if (publicSkillMessages.dynamic) chatMessages.push({ role: "system", content: publicSkillMessages.dynamic });
  chatMessages.push({ role: "user", content: prompt });
  const raw = await callLLM(chatMessages, {
    json: true,
    temperature: cfg.temperature,
    topP: cfg.topP,
    thinking: reasoningProfile().thinking,
    explicitThinkingDisabled: reasoningProfile().thinking === false,
    reasoningEffort: reasoningProfile().effort,
    maxTokens: cfg.actionMaxTokens,
    timeoutMs: CHAT_TIMEOUT_MS,
    retryCount: 1
  });
  const parsed = parseJSONObject(raw);
  if (parsed && parsed.reply) {
    return { reply: parsed.reply, intent: parsed.intent || null, control: parsed.control || null };
  }
  return { reply: raw, intent: null, control: null };
}

function sanitizeChatReply(reply) {
  const text = plainText(reply, "");
  return text || "这句我没接住，再说一遍。";
}

const SUIT_MAP = { spade: "♠", heart: "♥", club: "♣", diamond: "♦" };
const IDENTITY_MAP = {
  lord: "主公", loyalist: "忠臣", rebel: "反贼", renegade: "内奸",
  unknown: "未知", ming: "已明", god: "神", zhu: "主公", zhong: "忠臣", fan: "反贼", nei: "内奸"
};
const EVENT_MAP = {
  chooseCard: "选择牌", chooseToRespond: "响应（出闪/桃等）", useCard: "使用牌", useCardToBegin: "牌对目标开始结算",
  chooseToUse: "是否使用牌", chooseTarget: "选择目标", chooseButton: "选择按钮", chooseBool: "确认选择",
  chooseControl: "选择选项", chooseToDiscard: "选择弃牌", chooseCardTarget: "选择牌和目标", choosePlayer: "选择玩家",
  phaseZhunbei: "准备阶段", phaseJudge: "判定阶段", phaseDraw: "摸牌阶段", phaseUse: "出牌阶段",
  phaseDiscard: "弃牌阶段", phaseJieshu: "结束阶段", _wuxie: "无懈结算", respond: "响应牌",
  damage: "伤害结算", dying: "濒死结算", gain: "获得牌", lose: "失去牌", discard: "弃置牌",
  gameStart: "游戏开始", judge: "判定", askForCard: "请求一张牌", askForSkill: "请求技能"
};

function translateIdentity(id) {
  return IDENTITY_MAP[id] || id || "未知";
}

function translateEventName(name) {
  return EVENT_MAP[name] || name || "?";
}

function cardText(card) {
  try {
    const n = String(get.translation(card) || card.name || "牌");
    const s = SUIT_MAP[card.suit] || "";
    const num = card.number !== undefined ? card.number : "";
    if (!s) return n;
    /* get.translation(card) 常已含【花色点数】，不要再拼成“火杀【♥10】(♥10)”。 */
    const normalized = n.replace(/[\s\uFE0E\uFE0F]/g, "");
    return num !== "" && normalized.includes(s + num) ? n : n + "(" + s + num + ")";
  } catch (e) {
    return String(card);
  }
}

function compactRuleText(value) {
  const source = String(value || "").replace(/<noname-poptip\b([^>]*)>(?:<\/noname-poptip>)?/gi, (whole, attributes) => {
    /* get.poptip() 把规则中的技能/卡牌引用渲染成空的界面组件；普通删 HTML 会连
     * “获得〖趋袭〗”里的“趋袭”一起删掉。这里只恢复规则原文已经明确引用的术语，
     * 不枚举技能、不展开隐藏说明，因此不改变信息可见性。 */
    const match = String(attributes || "").match(/\bpoptip\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    const id = String(match && (match[1] || match[2]) || "").trim();
    if (!id) return "";
    let name = id;
    let type = "";
    try {
      if (lib && lib.poptip) {
        if (typeof lib.poptip.getName === "function") name = plainText(lib.poptip.getName(id), id) || id;
        if (typeof lib.poptip.getType === "function") type = String(lib.poptip.getType(id) || "");
      }
    } catch (e) {
      try { name = safeTranslation(id, id); } catch (ignored) { }
    }
    return type === "skill" ? "〖" + name + "〗" : type === "card" ? "【" + name + "】" : "【" + name + "】";
  });
  return plainText(source
    .replace(/<br\s*\/?\s*>/gi, "；")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&"), "");
}

function opaqueCandidateId(value) {
  return value === undefined || value === null || value === "" ? "" : String(value);
}

function candidateCardId(card) {
  return !card || typeof card === "string" ? "" : opaqueCandidateId(card.cardid);
}

function candidateTargetId(target) {
  return !target ? "" : opaqueCandidateId(target.playerid);
}

function candidateButtonId(button) {
  return !button ? "" : opaqueCandidateId(button.buttonid);
}

/* 选择其他角色区域里的牌时，本体会把操作者看不见的牌做成 blank/infohidden 按钮。
 * button.link 仍指向真实 Card，仅供引擎结算；绝不能把它当成模型可见信息。 */
function buttonIsInformationHidden(button) {
  if (!button) return false;
  try {
    const classes = button.classList;
    if (classes && (classes.contains("blank") || classes.contains("infohidden"))) return true;
  } catch (e) { }
  return false;
}

function cardPromptText(card, player, includeRule) {
  if (!card || typeof card === "string") return String(card || "未知牌");
  let name = card.name || "";
  let nature = card.nature || "";
  let suit = card.suit || "";
  let number = card.number;
  let type = "", subtype = "";
  try { if (typeof get.name === "function") name = get.name(card, player) || name; } catch (e) { }
  try { if (typeof get.nature === "function") nature = get.nature(card, player) || nature; } catch (e) { }
  try { if (typeof get.suit === "function") suit = get.suit(card, player) || suit; } catch (e) { }
  try { if (typeof get.number === "function") number = get.number(card, player); } catch (e) { }
  try { type = get.type(card, player) || ""; } catch (e) { }
  try { subtype = typeof get.subtype === "function" ? get.subtype(card, player) || "" : ""; } catch (e) { }
  const values = [];
  const cardId = candidateCardId(card);
  values.push(cardId ? "cardId=" + cardId : "cardId=无（使用 indices）");
  values.push("name=" + (name || "未知"));
  values.push("nature=" + (Array.isArray(nature) ? nature.join("+") : nature || "normal"));
  values.push("display=" + JSON.stringify(cardText(card)));
  values.push("suit=" + (suit || "none"));
  values.push("number=" + (number === undefined || number === null || number === "" ? "none" : number));
  if (type) values.push("type=" + type);
  if (subtype) values.push("subtype=" + subtype);
  if (includeRule !== false) {
    let rule = "";
    try { rule = lib.translate[name + "_info"] || ""; } catch (e) { }
    if (!rule) {
      try {
        const info = get.info(card);
        if (info && typeof info.content === "string") rule = info.content;
      } catch (e) { }
    }
    rule = compactRuleText(rule).slice(0, 320);
    if (rule) values.push("rule=" + JSON.stringify(rule));
  }
  return "[" + values.join(" | ") + "]";
}

function targetPromptText(target) {
  const id = candidateTargetId(target);
  const seat = seatNumber(target);
  return "[targetId=" + (id || "无（使用 targetSeat/indices）") +
    " | targetSeat=" + (seat === 999 ? "未知" : seat) + "] " +
    (makePlayerRef(target) || playerDisplayName(target));
}

const ORDERED_TARGET_PLAN_KEY = "__llmOrderedTargetPlan";

function orderedTargetPlan(candidates) {
  return candidates && candidates[ORDERED_TARGET_PLAN_KEY] || null;
}

function attachOrderedTargetPlan(candidates, plan) {
  if (!Array.isArray(candidates) || !plan) return candidates;
  try {
    Object.defineProperty(candidates, ORDERED_TARGET_PLAN_KEY, {
      value: plan,
      enumerable: false,
      configurable: true,
      writable: true
    });
  } catch (e) { candidates[ORDERED_TARGET_PLAN_KEY] = plan; }
  return candidates;
}

function targetSelectionInfo(event) {
  let card = null;
  try { card = get.card(); } catch (e) { }
  let skillInfo = {}, cardInfo = {};
  try { if (event && event.skill) skillInfo = get.info(event.skill) || {}; } catch (e) { }
  try { if (card) cardInfo = get.info(card) || {}; } catch (e) { }
  return { card, skillInfo, cardInfo };
}

function remainingTargetLimits(range, already) {
  already = Math.max(0, Number(already) || 0);
  const rawMin = Number(range && range[0]);
  const min = Math.max(0, (Number.isFinite(rawMin) ? rawMin : 0) - already);
  let max;
  if (range && range[1] === Infinity) max = Infinity;
  else {
    const rawMax = Number(range && range[1]);
    max = Math.max(0, (Number.isFinite(rawMax) ? rawMax : 0) - already);
  }
  return { min, max };
}

function isOrderedDynamicTargetSelection(event, range) {
  if (!event || !Array.isArray(range) || range[1] < 0) return false;
  let already = 0;
  try { already = ui.selected.targets.length; } catch (e) { }
  const limits = remainingTargetLimits(range, already);
  if (!(limits.max > 1)) return false;
  const info = targetSelectionInfo(event);
  /* complexSelect 还包含跨牌/目标联动与重复目标等更宽语义；这里只接管本体明确的动态目标协议。 */
  return !!(event.complexTarget || info.skillInfo.complexTarget || info.cardInfo.complexTarget);
}

function orderedTargetSlotPrompts(event) {
  const info = targetSelectionInfo(event);
  let prompts = event && event.targetprompt;
  if (prompts === undefined || prompts === null) prompts = info.skillInfo.targetprompt;
  if (prompts === undefined || prompts === null) prompts = info.cardInfo.targetprompt;
  if (!Array.isArray(prompts)) return [];
  return prompts.map(value => {
    try { return compactRuleText(value); } catch (e) { return String(value || ""); }
  });
}

function orderedTargetUniverse(event, initialLegal, baseSelected) {
  const info = targetSelectionInfo(event);
  let all = [];
  try { all = game.players.slice(); } catch (e) { }
  /* 与本体 game.Check.target 的目标集合保持一致；技能需要死者时应由事件写入 deadTarget。 */
  if (event.deadTarget || info.cardInfo.deadTarget) {
    try { all = all.concat(game.dead || []); } catch (e) { }
  }
  (initialLegal || []).forEach(target => { if (!all.includes(target)) all.push(target); });
  const initialSet = new Set(initialLegal || []);
  const selectedSet = new Set(baseSelected || []);
  const unique = [];
  all.forEach(target => {
    if (!target || selectedSet.has(target) || unique.includes(target)) return;
    if (!initialSet.has(target)) {
      try { if (lib.filter.cardAiIncluded(target) === false) return; } catch (e) { }
      try {
        if (game.chess && !(event.chessForceAll || info.cardInfo.chessForceAll) && event.player && get.distance(event.player, target, "pure") > 7) return;
      } catch (e) { }
      try {
        if (target.isOut && target.isOut() && !event.includeOut && !info.skillInfo.includeOut && !info.cardInfo.includeOut) return;
      } catch (e) { }
    }
    unique.push(target);
  });
  return unique.sort((a, b) => {
    const seatDiff = seatNumber(a) - seatNumber(b);
    if (seatDiff) return seatDiff;
    const idDiff = candidateTargetId(a).localeCompare(candidateTargetId(b));
    if (idDiff) return idDiff;
    return playerDisplayName(a).localeCompare(playerDisplayName(b));
  });
}

function buildOrderedTargetPlan(event, range, initialLegal) {
  if (!isOrderedDynamicTargetSelection(event, range)) return null;
  let baseSelected = [];
  try { baseSelected = ui.selected.targets.slice(); } catch (e) { }
  const legal = (initialLegal || []).slice();
  const candidates = orderedTargetUniverse(event, legal, baseSelected);
  const plan = {
    candidates,
    initialLegal: legal,
    baseSelected,
    range: range.slice(),
    slotPrompts: orderedTargetSlotPrompts(event)
  };
  attachOrderedTargetPlan(candidates, plan);
  return plan;
}

function orderedTargetCandidateMarker(plan, target) {
  if (!plan) return "";
  return plan.initialLegal.includes(target) ? " | 当前第一步合法" : " | 后续步骤潜在目标";
}

function orderedTargetInstruction(candidates, range, compact) {
  const plan = orderedTargetPlan(candidates);
  if (!plan) return "";
  const limits = remainingTargetLimits(range, plan.baseSelected.length);
  const maxText = limits.max === Infinity ? "不限" : limits.max;
  const slotCount = limits.max === Infinity ? plan.slotPrompts.length : Math.min(plan.slotPrompts.length, limits.max);
  const slots = slotCount
    ? plan.slotPrompts.slice(0, slotCount).map((name, index) => "第" + (index + 1) + "项=" + (name || "目标")).join("；")
    : "";
  const fixed = limits.min === limits.max;
  let text = (compact ? "【动态有序目标】" : "【动态有序目标选择】") +
    "后继合法目标会随前项改变，但仍属于同一次尚未结算的选择。请一次返回本次新增的完整有序目标数组；targetIds/targetSeats/indices 的数组顺序就是实际点选顺序。" +
    "本次至少新增 " + limits.min + " 项，最多 " + maxText + " 项" +
    (fixed ? "，必须一次给全，不能只返回第一项。" : "；达到最小数量后可以按收益提前结束，不必机械选满。") +
    "标为“当前第一步合法”的角色可作为本次第一项；其余角色只表示可能在选定前项后成为合法目标，不代表能放在任意位置。扩展会按本体规则逐项实时校验，非法顺序将整次回落原版 AI。";
  if (slots) text += (compact ? "【目标顺序】" : "\n【目标顺序】") + slots + "。";
  return text;
}

function buttonPromptText(button) {
  const id = candidateButtonId(button);
  return "[buttonId=" + (id || "无（使用 indices）") + "] " + buttonText(button);
}

/* 技能描述在稳定技能库中只发送一次，因此不再按思考档位截断。 */
function skillInfo(name, maxLen) {
  try {
    const d = lib.translate[name + "_info"];
    if (d && typeof d === "string" && d.length > 1) {
      const text = compactRuleText(d);
      const len = Number(maxLen);
      return Number.isFinite(len) && len > 0 ? text.slice(0, len) : text;
    }
  } catch (e) { }
  return "";
}

function reasoningProfile() {
  const depth = Math.min(100, Math.max(1, Number(cfg.promptThinkingDepth) || DEFAULT_CONFIG.promptThinkingDepth));
  let guide = "检查最关键的合法性、敌我和即时收益后迅速裁决。";
  if (depth >= 80) guide = "尽可能全面复核在场技能联动、牌序、响应风险、身份边界与后续行动。";
  else if (depth >= 55) guide = "较全面检查敌我、关键技能联动、牌序和本轮风险。";
  else if (depth >= 30) guide = "检查敌我、关键技能和即时收益后裁决。";
  const effort = cfg.serverReasoningEffort === "disabled" ? null : cfg.serverReasoningEffort;
  return { thinking: cfg.serverReasoningEffort !== "disabled", effort, depth, guide };
}

function safeTranslation(value, fallback) {
  try { return plainText(get.translation(value), fallback || value || "未知"); } catch (e) { return plainText(fallback || value, "未知"); }
}

function playerSkillNames(player, viewer) {
  if (!cfg.skillInfo || !player || typeof player.getSkills !== "function") return [];
  try {
    /* 只给操作者自己的隐藏/暗置技能；其他角色仅发送公开技能，装备技能也要纳入。 */
    const mode = viewer && player === viewer ? "invisible" : null;
    const skills = player.getSkills(mode, true);
    return (Array.isArray(skills) ? skills : []).filter((name, index, list) =>
      typeof name === "string" && name && list.indexOf(name) === index).sort((a, b) => a.localeCompare(b));
  } catch (e) { return []; }
}

function playerSkillRefsText(player, viewer) {
  const skills = playerSkillNames(player, viewer);
  return skills.length ? skills.join(",") : "-";
}

function gameSkillCatalogText(viewer) {
  if (!cfg.skillInfo) return "【本局技能库】已关闭技能说明。";
  let players = [];
  try { players = (game.filterPlayer ? game.filterPlayer() : []).slice().sort((a, b) => seatNumber(a) - seatNumber(b)); } catch (e) { }
  const owners = [];
  const unique = new Set();
  players.forEach(player => {
    const skills = playerSkillNames(player, viewer);
    skills.forEach(name => unique.add(name));
    owners.push((makePlayerRef(player) || playerDisplayName(player)) + "=[" + (skills.length ? skills.join(",") : "-") + "]");
  });
  const definitions = Array.from(unique).sort((a, b) => a.localeCompare(b)).map(name => {
    const title = safeTranslation(name, name);
    const desc = skillInfo(name, Infinity);
    return "[" + name + "]" + (title === name ? "" : title) + (desc ? ":" + desc : ":无公开说明");
  });
  return "【本局技能归属】\n" + (owners.length ? owners.join("\n") : "无在场武将") +
    "\n【去重技能库】\n" + (definitions.length ? definitions.join("\n") : "无可见技能");
}

function playerDynamicSkillText(player, viewer) {
  const dynamic = lib && lib.dynamicTranslate;
  if (!dynamic || !player) return "";
  const values = [];
  playerSkillNames(player, viewer).forEach(name => {
    const translator = dynamic[name];
    if (typeof translator !== "function") return;
    try {
      const text = compactRuleText(translator(player));
      const base = skillInfo(name, Infinity);
      if (text && text !== base) values.push("[" + name + "]" + text);
    } catch (e) { }
  });
  return values.join("；");
}

function visibleIdentity(viewer, target) {
  try {
    if (target === viewer || target.identityShown || target.isZhu || target.identity === "zhu" || target.identity === "lord") {
      return translateIdentity(target.identity);
    }
  } catch (e) { }
  return "未公开";
}

function cardsAt(player, zone) {
  try { return player && player.getCards ? player.getCards(zone) : []; } catch (e) { return []; }
}

function playerMarksText(player) {
  try {
    const keys = Object.keys(player.marks || {}).filter(name => !name.startsWith("_")).sort((a, b) => a.localeCompare(b));
    const result = [];
    keys.forEach(name => {
      let count = 0;
      try { count = typeof player.countMark === "function" ? player.countMark(name) : 0; } catch (e) { }
      result.push(safeTranslation(name, name) + (count ? "x" + count : ""));
    });
    return result.length ? result.join("、") : "无";
  } catch (e) { return "无"; }
}

function playerHistoryText(player) {
  if (!player || typeof player.getHistory !== "function") return "";
  const names = ["useCard", "respond", "damage", "sourceDamage"];
  const values = [];
  names.forEach(name => {
    try {
      const history = player.getHistory(name);
      if (Array.isArray(history) && history.length) values.push(name + "=" + history.length);
    } catch (e) { }
  });
  return values.join(",");
}

function playerDisabledStateText(player) {
  const values = [];
  try {
    const awakened = Array.isArray(player.awakenedSkills) ? player.awakenedSkills.slice() : [];
    if (awakened.length) values.push("awakened=" + awakened.sort().join(","));
  } catch (e) { }
  try {
    const disabled = Object.keys(player.disabledSkills || {}).sort();
    if (disabled.length) values.push("disabled=" + disabled.join(","));
  } catch (e) { }
  return values.join(";");
}

function playerStateText(viewer, player) {
  const hand = cardsAt(player, "h");
  const equips = cardsAt(player, "e");
  const judges = cardsAt(player, "j");
  let attitude = "?", distance = "?", linked = false, turned = false;
  try { attitude = Number(get.attitude(viewer, player)).toFixed(1); } catch (e) { }
  try { distance = get.distance(viewer, player); } catch (e) { }
  try { linked = !!(player.isLinked && player.isLinked()); } catch (e) { }
  try { turned = !!(player.isTurnedOver && player.isTurnedOver()); } catch (e) { }
  let hujia = 0;
  try { hujia = Number(player.hujia) || 0; } catch (e) { }
  const history = playerHistoryText(player);
  const disabled = playerDisabledStateText(player);
  const dynamic = playerDynamicSkillText(player, viewer);
  let text = (makePlayerRef(player) || playerDisplayName(player)) +
    "|hp=" + player.hp + "/" + (player.maxHp || "?") +
    "|armor=" + hujia +
    "|hand=" + hand.length +
    "|id=" + visibleIdentity(viewer, player) +
    "|att=" + attitude +
    "|distance=" + distance +
    "|equip=[" + (equips.length ? equips.map(cardText).join(",") : "-") + "]" +
    "|judge=[" + (judges.length ? judges.map(cardText).join(",") : "-") + "]" +
    "|mark=[" + playerMarksText(player) + "]" +
    "|state=" + ([linked ? "横置" : "", turned ? "翻面" : ""].filter(Boolean).join(",") || "正常") +
    "|skills=[" + playerSkillRefsText(player, viewer) + "]";
  if (history) text += "|turnHistory=" + history;
  if (disabled) text += "|skillState=" + disabled;
  if (dynamic) text += "|dynamicSkill=" + dynamic;
  return text;
}

function publicPlayerStateText(player) {
  const hand = cardsAt(player, "h");
  const equips = cardsAt(player, "e");
  const judges = cardsAt(player, "j");
  let hujia = 0;
  try { hujia = Number(player.hujia) || 0; } catch (e) { }
  const publicSkills = playerSkillNames(player, null);
  const stableId = publicPlayerId(player);
  let publicName = "";
  try {
    const hidden = typeof player.isUnseen === "function" && player.isUnseen(0);
    if (!hidden) publicName = playerDisplayName(player);
  } catch (e) { }
  const publicRef = "playerId=" + stableId + "|seat=" + (seatNumber(player) === 999 ? "?" : seatNumber(player)) +
    (publicName ? "|name=" + publicName : "|name=未公开");
  return publicRef +
    "|hp=" + player.hp + "/" + (player.maxHp || "?") +
    "|armor=" + hujia + "|hand=" + hand.length +
    "|id=" + visibleIdentity(null, player) +
    "|equip=[" + (equips.length ? equips.map(cardText).join(",") : "-") + "]" +
    "|judge=[" + (judges.length ? judges.map(cardText).join(",") : "-") + "]" +
    "|mark=[" + playerMarksText(player) + "]|skills=[" + (publicSkills.length ? publicSkills.join(",") : "-") + "]";
}

function publicPlayerId(player) {
  const id = candidateTargetId(player);
  if (id) return id;
  const seat = seatNumber(player);
  return seat === 999 ? "unknown-player" : "seat-" + seat;
}

function publicPlayersStateText() {
  try {
    return (game.filterPlayer ? game.filterPlayer() : []).slice().sort((a, b) => seatNumber(a) - seatNumber(b))
      .map(publicPlayerStateText).join("\n");
  } catch (e) { return "读取失败"; }
}

function selfHandText(player) {
  const hand = cardsAt(player, "h");
  return "SELF_HAND=[" + (hand.length ? hand.map(cardText).join(",") : "-") + "]";
}

function allPlayersStateText(viewer) {
  try {
    const players = (game.filterPlayer ? game.filterPlayer() : []).slice().sort((a, b) => seatNumber(a) - seatNumber(b));
    return players.map(player => playerStateText(viewer, player)).join("\n");
  } catch (e) { return "读取失败"; }
}

function eventChainText(event, includeCurrent) {
  const chain = [];
  let current = event;
  if (includeCurrent === false) {
    try { current = typeof event.getParent === "function" ? event.getParent() : event.parent; } catch (e) { current = null; }
  }
  for (let depth = 0; current && depth < 5; depth++) {
    let line = isWuxieDecision(current) ? "无懈响应" : translateEventName(current.name || "?");
    if (current.skill) line += "[技能:" + safeTranslation(current.skill, current.skill) + "]";
    if (current.card) line += "[牌:" + cardText(current.card) + "]";
    if (current.target) line += "[目标:" + (makePlayerRef(current.target) || safeTranslation(current.target)) + "]";
    if (Array.isArray(current.targets) && current.targets.length) line += "[目标们:" + current.targets.map(p => makePlayerRef(p) || safeTranslation(p)).join("、") + "]";
    chain.push(line);
    try { current = typeof current.getParent === "function" ? current.getParent() : current.parent; } catch (e) { current = null; }
    if (current === event) break;
  }
  return chain.length ? chain.join(" <- ") : "无上级事件";
}

function selectedText() {
  const parts = [];
  try { if (ui.selected.cards.length) parts.push("已选牌:" + ui.selected.cards.map(cardText).join("、")); } catch (e) { }
  try { if (ui.selected.targets.length) parts.push("已选目标:" + ui.selected.targets.map(p => safeTranslation(p)).join("、")); } catch (e) { }
  try { if (ui.selected.buttons.length) parts.push("已选按钮:" + ui.selected.buttons.map(buttonText).join("、")); } catch (e) { }
  return parts.length ? parts.join("；") : "无";
}

function buttonText(button) {
  if (buttonIsInformationHidden(button)) return "暗置牌（具体牌面不可知）";
  try {
    const raw = button && (button.link || button.textContent || button.name);
    return safeTranslation(raw, raw || "按钮").replace(/\s+/g, " ").trim().slice(0, 120);
  } catch (e) { return "按钮"; }
}

function evaluateOriginalAIScores(check, candidates) {
  const plan = orderedTargetPlan(candidates);
  const all = plan ? plan.initialLegal.slice() : candidates.slice();
  if (typeof check !== "function") return candidates.map(() => ({ rank: null, commit: null }));
  let cacheReady = false;
  try {
    CacheContext.setCacheContext(new CacheContext({ lib, game, get }));
    CacheContext.setInCacheEnvironment(true);
    cacheReady = true;
  } catch (e) { }
  try {
    return candidates.map(candidate => {
      /* 原版离线 AI 能直接读到 blank 按钮背后的 Card 对象；该分数也可能侧漏暗手牌价值。
       * 对操作者不可见的按钮不计算、不发送逐项评分，由模型在等价匿名选项中自行选择。 */
      if (buttonIsInformationHidden(candidate)) return { rank: null, commit: null };
      /* 后继目标的原版分数依赖前缀；根状态下强行评分会误导模型和安全仲裁。 */
      if (plan && !plan.initialLegal.includes(candidate)) return { rank: null, commit: null };
      let rank = null, commit = null;
      try {
        const value = Number(check(candidate, all));
        if (Number.isFinite(value)) rank = value;
      } catch (e) { }
      try {
        const value = Number(check(candidate));
        if (Number.isFinite(value)) commit = value;
      } catch (e) { }
      return { rank, commit };
    });
  } finally {
    if (cacheReady) {
      try { CacheContext.setInCacheEnvironment(false); } catch (e) { }
      try { CacheContext.removeCacheContext(); } catch (e) { }
    }
  }
}

function potentialTargetPool(event) {
  const result = [];
  const add = player => { if (player && !result.includes(player)) result.push(player); };
  try { (game.players || []).forEach(add); } catch (e) { }
  try {
    const cardInfo = get.info(get.card()) || {};
    if (event && (event.deadTarget || cardInfo.deadTarget)) (game.dead || []).forEach(add);
  } catch (e) { }
  return result.filter(player => {
    try { return !player.isOut || !player.isOut(); } catch (e) { return true; }
  }).sort((left, right) => seatNumber(left) - seatNumber(right) || candidateTargetId(left).localeCompare(candidateTargetId(right)));
}

function cardTargetFlowHint(event, card, player) {
  if (!event || !card || typeof card === "string" || !event.filterTarget) return "";
  const shape = [{ kind: "card" }, { kind: "target" }];
  if (!supportsDeferredSlotSequence(event, shape) || eventHasSelectionHooks(event)) return "";
  if (event.name === "chooseCardTarget") {
    return "目标流程=这是技能/事件定义的联合选牌目标，不按此牌平时的使用方式推断；若后继目标已知，放在紧接的target步骤";
  }
  try {
    const range = get.select(lib.filter.selectTarget(card, player));
    if (!Array.isArray(range) || range.length < 2) return "目标流程=由引擎运行时决定";
    const min = Number(range[0]);
    const max = Number(range[1]);
    if (min < 0 || max < 0) return "目标流程=本体自动选择目标，不要返回target步骤";
    if (max === 0) return "目标流程=无手动目标槽，不要返回target步骤";
    return "目标流程=选牌后手动选择" + min + "到" + (max === Infinity ? "不限" : max) + "名目标，必须在同一steps中返回完整有序target步骤";
  } catch (e) {
    return "目标流程=由引擎运行时决定；若随后要求目标，才返回target步骤";
  }
}

function actionPlanPromptHint(type, event, quick) {
  if (!event || !event.filterTarget || (type !== "card" && type !== "button")) return "";
  const shape = type === "card" ? [{ kind: "card" }, { kind: "target" }] : [{ kind: "button" }, { kind: "target" }];
  if (!supportsDeferredSlotSequence(event, shape) || eventHasSelectionHooks(event)) return "";
  const targets = potentialTargetPool(event);
  if (!targets.length) return "";
  const list = targets.map(target => quick ? targetPromptText(target) : "- " + targetPromptText(target)).join(quick ? "；" : "\n");
  const firstRef = type === "card" ? '"cardIds":["当前牌ID"]' : '"buttonIds":["当前按钮ID"]';
  return "\n【当前动作与本回合连续计划】当前选择后若引擎继续要求目标，不要等下一次请求；先在 steps 写完整的当前牌/按钮→目标。" +
    "例如 {\"action\":\"execute\",\"steps\":[{\"kind\":\"" + type + "\"," + firstRef + "},{\"kind\":\"target\",\"targetIds\":[\"目标ID\"]}],\"reason\":\"...\"}。" +
    (type === "card" && isActivePhaseUseDecision(event)
      ? "在当前动作之后，还可继续把本回合准备依次执行的独立牌/技能写进同一个steps，例如 酒 → 杀 → 杀的目标 → 下一张牌。执行器只会立即执行当前动作，等本体结算完成并按游戏速度留出间隔后，再在后续真实选择事件中逐项续接；每步仍会按当时合法候选校验。"
      : "") +
    "后继步骤禁止使用indices，只能使用稳定ID或targetSeat。数组顺序就是点击顺序；同一张牌需要多个有序目标时，全部放进同一个target步骤的targetIds或targetSeats数组。" +
    "这里列的是后续潜在角色池，不表示每个角色对每个首项都合法；执行器会在选中首项后按本体实时验证，计划不合法会整单撤销并交回原版AI。" +
    "\n【后续潜在角色池】" + (quick ? list : "\n" + list) + "\n";
}

function originalAIScoreAt(scores, index) {
  const value = scores && scores[index];
  if (Number.isFinite(value)) return { rank: value, commit: value };
  if (!value || typeof value !== "object") return { rank: null, commit: null };
  const rank = value.rank === null || value.rank === undefined ? null : Number(value.rank);
  const commit = value.commit === null || value.commit === undefined ? null : Number(value.commit);
  return {
    rank: Number.isFinite(rank) ? rank : null,
    commit: Number.isFinite(commit) ? commit : null
  };
}

function effectiveCommitScore(score) {
  return Number.isFinite(score.commit) ? score.commit : score.rank;
}

function scoreText(scores, index) {
  const score = originalAIScoreAt(scores, index);
  const rank = Number.isFinite(score.rank) ? score.rank.toFixed(2) : "?";
  const commit = Number.isFinite(score.commit) ? score.commit.toFixed(2) : "?";
  return rank === commit ? rank : "排序 " + rank + " / 执行 " + commit;
}

function originalAIReferenceStrength() {
  const value = Number(cfg.originalAIReferenceStrength);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : DEFAULT_CONFIG.originalAIReferenceStrength;
}

function originalAIReferencePercentageText(value) {
  const numeric = Math.min(100, Math.max(0, Number(value) || 0));
  return (Math.round(numeric * 10) / 10).toString().replace(/\.0$/, "") + "%";
}

function originalAIReferenceWeightText() {
  const strength = originalAIReferenceStrength();
  return "原版AI建议=" + originalAIReferencePercentageText(strength) +
    "，完整局面独立判断=" + originalAIReferencePercentageText(100 - strength);
}

function originalAIReferenceMode() {
  const strength = originalAIReferenceStrength();
  return strength <= 0 ? "none" : "exact";
}

function originalAICandidateReference(scores, index, event, range, compact) {
  const mode = originalAIReferenceMode();
  if (mode === "none") return "";
  return compact ? "(原版分" + scoreText(scores, index) + ")" : " | 原版AI分数 " + scoreText(scores, index);
}

function originalAIRecommendation(scores, event) {
  const ranked = (scores || []).map((_, index) => ({ score: originalAIScoreAt(scores, index), index }))
    .filter(item => Number.isFinite(item.score.rank)).sort((a, b) => b.score.rank - a.score.rank);
  if (!ranked.length) return { bestIndex: null, bestRank: null, bestCommit: null, shouldSkip: false, text: "本次原版 AI 无法给出有效评分。" };
  const best = ranked[0];
  const bestCommit = effectiveCommitScore(best.score);
  const shouldSkip = !event.forced && Number.isFinite(bestCommit) && bestCommit <= 0;
  const decision = shouldSkip ? "按原版规则应放弃" : "原版首选序号 " + best.index;
  return {
    bestIndex: best.index,
    bestRank: best.score.rank,
    bestCommit,
    shouldSkip,
    text: decision + "（排序分 " + best.score.rank.toFixed(2) + "，执行分 " + (Number.isFinite(bestCommit) ? bestCommit.toFixed(2) : "?") + "）。这是原版 AI 自己的排序与出手倾向，仅供你理解其建议，不是必须服从的规则。"
  };
}

function originalAIReferenceSummary(scores, event, directiveOverride) {
  const strength = originalAIReferenceStrength();
  if (strength <= 0) return "";
  const advice = originalAIRecommendation(scores, event);
  const weight = originalAIReferenceWeightText();
  if (!Number.isFinite(advice.bestRank)) return weight + "；本次原版 AI 无法给出有效评分，由完整局面信息补足判断。";
  const tendency = advice.shouldSkip ? "倾向放弃" : "倾向候选序号 " + advice.bestIndex;
  return "原版 AI " + tendency + "（排序分 " + advice.bestRank.toFixed(2) +
    "，执行分 " + (Number.isFinite(advice.bestCommit) ? advice.bestCommit.toFixed(2) : "?") +
    "）；连续策略权重为：" + weight + "。" +
    (directiveOverride ? "玩家聊天意图是更高层约束，权重只用于在该意图允许的合法方案内比较策略收益。" : "") +
    "该百分比没有档位或阈值，也不参与模型回答后的执行否决。";
}

function originalAIReferenceHeader(directiveOverride) {
  const strength = originalAIReferenceStrength();
  if (strength <= 0) return "";
  return "【原版 AI 策略参考｜连续权重 " + originalAIReferencePercentageText(strength) +
    (directiveOverride ? "｜聊天意图优先" : "") + "】";
}

function originalAIReferenceInstruction(directiveOverride) {
  const strength = originalAIReferenceStrength();
  if (strength <= 0) {
    return "原版 AI 策略参考权重为 0%：只根据完整局面、技能联动、敌我关系和后续收益独立决策。";
  }
  return "按连续比例综合证据：" + originalAIReferenceWeightText() + "。每增加1个百分点都按相同比例变化，不存在低、中、高档或隐藏阈值；" +
    (directiveOverride ? "当前有玩家聊天意图，先在合法范围内满足该意图，再按此比例比较策略收益；" : "") +
    "原版 AI 分数不是接管命令，扩展不会因最终合法选择与原版 AI 不同而否决或改写。";
}

function shouldUseOriginalAIByProbability(hasActiveDirective) {
  if (hasActiveDirective) return false;
  const probability = Number(cfg.originalAIProbability);
  if (!Number.isFinite(probability) || probability <= 0) return false;
  if (probability >= 100) return true;
  return Math.random() * 100 < probability;
}

function isHumanManualAutoPick(event) {
  if (!event) return false;
  const player = event.player;
  if (player) {
    try { if (player === game.me) return true; } catch (e) { }
    try { if (typeof player.isMe === "function" && player.isMe()) return true; } catch (e) { }
    return false;
  }
  try { return typeof event.isMine === "function" && !!event.isMine(); } catch (e) { return false; }
}

function cardMetrics(card, player) {
  const values = [];
  try { const value = Number(get.useValue(card, player)); if (Number.isFinite(value)) values.push("使用价值 " + value.toFixed(2)); } catch (e) { }
  try { const value = Number(get.value(card, player)); if (Number.isFinite(value)) values.push("保留价值 " + value.toFixed(2)); } catch (e) { }
  try { const value = Number(get.order(card)); if (Number.isFinite(value)) values.push("出牌顺序 " + value.toFixed(2)); } catch (e) { }
  return values.length ? values.join(" | ") : "无额外估值";
}

function candidateEffect(type, event, candidate) {
  if (type !== "target" || !event.player || !event.card) return "?";
  try {
    const effect = Number(get.effect(candidate, event.card, event.player, event.player));
    return Number.isFinite(effect) ? effect.toFixed(2) : "?";
  } catch (e) { return "?"; }
}

function wuxieOriginalEffectText(context, responder) {
  if (!context || !context.originalCard || !context.currentTarget || !responder) return "未知";
  try {
    const source = context.sourceMap && context.sourceMap.isJudge ? context.currentTarget : context.originalPlayer;
    const value = Number(get.effect(context.currentTarget, context.originalCard, source, responder));
    if (!Number.isFinite(value)) return "未知";
    const meaning = value > 0 ? "有利" : value < 0 ? "有害" : "中性";
    return meaning + "（原版AI效果值=" + value.toFixed(2) + "；正数对响应者有利，负数有害）";
  } catch (e) { return "未知"; }
}

function eventFactText(event) {
  if (!event) return "未知事件";
  const values = ["name=" + translateEventName(event.name)];
  try { if (event.skill) values.push("skill=" + safeTranslation(event.skill, event.skill)); } catch (e) { }
  try { if (event.card) values.push("card=" + cardText(event.card)); } catch (e) { }
  try {
    /* chooseToUse(type=wuxie).source is the affected target, not the trick user. */
    if (event.source && !isWuxieDecision(event)) values.push("source=" + (makePlayerRef(event.source) || safeTranslation(event.source)));
  } catch (e) { }
  try { if (event.target && !isWuxieDecision(event)) values.push("target=" + (makePlayerRef(event.target) || safeTranslation(event.target))); } catch (e) { }
  try {
    if (!isWuxieDecision(event) && Array.isArray(event.targets) && event.targets.length) {
      values.push("targets=[" + event.targets.map(target => makePlayerRef(target) || safeTranslation(target)).join(",") + "]");
    }
  } catch (e) { }
  try { if (event.num !== undefined) values.push("num=" + event.num); } catch (e) { }
  if (isWuxieDecision(event)) {
    const context = wuxieChainContext(event);
    const map = context.map;
    const state = context.state;
    const originalCard = context.originalCard;
    const originalPlayer = context.originalPlayer;
    const currentTarget = context.currentTarget;
    const originalTargets = context.originalTargets;
    const isCounterWuxie = directiveCardIdentity(context.immediateCard) === "wuxie";
  const actorRef = makePlayerRef(event.player) || safeTranslation(event.player);
  const originalPlayerRef = originalPlayer ? (makePlayerRef(originalPlayer) || safeTranslation(originalPlayer)) : "未知角色";
  const currentTargetRef = currentTarget ? (makePlayerRef(currentTarget) || safeTranslation(currentTarget)) : "未指定目标";
  const originalCardRef = originalCard ? cardText(originalCard) : "未知锦囊";
    values.push("type=wuxie");
    values.push("wuxieLayer=" + (isCounterWuxie ? "反无懈（直接响应上一张无懈）" : "第一层无懈（直接响应原锦囊）"));
    values.push("wuxieState=" + (state > 0 ? "+1（原锦囊当前将生效）" : "-1（原锦囊当前被上一张无懈抵消）"));
    values.push("wuxieResponder=" + actorRef);
    if (originalCard) values.push("originalTrick=" + originalCardRef);
    if (originalPlayer) values.push("originalUser=" + originalPlayerRef);
    if (currentTarget) values.push("currentAffectedTarget=" + currentTargetRef);
    if (originalTargets.length) values.push("originalTargets=[" + originalTargets.map(target => makePlayerRef(target) || safeTranslation(target)).join(",") + "]");
    if (originalTargets.length > 1) {
      values.push("groupTrickResolution=这是群体锦囊的逐目标结算；本次无懈只改变 currentAffectedTarget 当前目标的效果，不会一次取消全部目标；其他目标仍分别、单独继续结算");
    }
    values.push("originalEffectForResponder=" + wuxieOriginalEffectText(context, event.player));
    values.push("selfNullify=" + (state > 0 && event.player === originalPlayer ? "true" : "false"));
    if (context.previousPlayer && context.immediateCard) {
      values.push("previousWuxie=" + (makePlayerRef(context.previousPlayer) || safeTranslation(context.previousPlayer)) + "/" + cardText(context.immediateCard));
    }
    if (state > 0) {
      values.push("effectIfUse=本次使用无懈可击会令原锦囊失效：取消" + originalPlayerRef + "使用的" + originalCardRef + "对" + currentTargetRef + "的效果");
      values.push("effectIfSkip=跳过无懈：让该锦囊继续对" + currentTargetRef + "生效");
      if (event.player === originalPlayer) values.push("selfUseWarning=你就是原锦囊使用者；使用无懈会取消你自己的锦囊效果，除非你明确想让它失效，否则应跳过");
    } else {
      values.push("effectIfUse=本次使用无懈可击会抵消上一张无懈，使原锦囊恢复生效：让" + originalPlayerRef + "使用的" + originalCardRef + "重新对" + currentTargetRef + "生效");
      values.push("effectIfSkip=跳过反无懈：保留上一张无懈，原锦囊继续失效");
    }
    try { if (event.prompt) values.push("nativePrompt=" + String(event.prompt).replace(/\s+/g, " ").slice(0, 240)); } catch (e) { }
  }
  return values.join("|");
}

function relevantRuleNames(event, candidates) {
  const names = new Set();
  const hasHiddenButtons = (Array.isArray(candidates) ? candidates : []).some(buttonIsInformationHidden);
  let current = event;
  for (let depth = 0; current && depth < 10; depth++) {
    try { if (typeof current.skill === "string" && current.skill) names.add(current.skill); } catch (e) { }
    try {
      if (current.card && current.card.name) names.add("card:" + current.card.name);
      /* 某些第三方事件可能把待选暗牌也暂存在 event.cards；只要当前候选含暗置按钮，
       * 就不从事件数组反向收集牌名，避免绕过按钮隐私层。当前公开使用牌仍由 current.card 提供。 */
      if (!hasHiddenButtons && Array.isArray(current.cards)) current.cards.forEach(card => { if (card && card.name) names.add("card:" + card.name); });
    } catch (e) { }
    current = eventParent(current);
  }
  (Array.isArray(candidates) ? candidates : []).forEach(candidate => {
    if (buttonIsInformationHidden(candidate)) return;
    if (typeof candidate === "string") names.add(candidate);
    else if (candidate && candidate.name) names.add("card:" + candidate.name);
  });
  return Array.from(names);
}

function relevantRuleText(event, candidates) {
  const sections = [];
  relevantRuleNames(event, candidates).forEach(name => {
    if (name.startsWith("card:")) {
      const cardName = name.slice(5);
      let info = null;
      try { info = get.info({ name: cardName }); } catch (e) { }
      let text = "[牌:" + cardName + "]" + safeTranslation(cardName, cardName);
      try {
        const translated = lib.translate[cardName + "_info"];
        if (translated) text += "：" + compactRuleText(translated);
      } catch (e) { }
      if (info) {
        const facts = [];
        try { if (info.selectTarget !== undefined) facts.push("selectTarget=" + String(info.selectTarget)); } catch (e) { }
        try { if (info.multitarget) facts.push("multitarget=true"); } catch (e) { }
        if (facts.length) text += "（" + facts.join("；") + "）";
      }
      sections.push(text);
      return;
    }
    const title = safeTranslation(name, name);
    const description = skillInfo(name, Infinity);
    let text = "[技能:" + name + "]" + (title === name ? "" : title) + (description ? "：" + description : "：公开说明不可用");
    sections.push(text);
  });
  return sections.length ? sections.join("\n") : "无可识别的当前相关技能或卡牌规则";
}

function immediateConsequenceText(type, event, candidates, scores) {
  const values = [];
  const advice = originalAIRecommendation(scores, event);
  if (!event.forced && Number.isFinite(advice.bestCommit)) {
    values.push("原版AI对当前最佳候选的即时执行分=" + advice.bestCommit.toFixed(2) +
      (advice.bestCommit > 0 ? "，说明现在执行通常比放弃更有利" : "，说明现在放弃通常更合理"));
  }
  if (directiveIsResponseDecision(event)) {
    values.push("这是响应窗口：skip不是‘保留牌但继续当前效果’，而是明确放弃本次响应，当前牌/伤害/技能将按未响应继续结算。比较的是现在避免的损失与保留候选牌的未来价值。");
    const source = (() => { try { return event.source || event.getParent && event.getParent().player; } catch (e) { return null; } })();
    if (source) values.push("当前效果来源=" + (makePlayerRef(source) || safeTranslation(source)));
  }
  if (type === "card" && isActivePhaseUseDecision(event) && event.player) {
    try {
      const hand = event.player.countCards("h");
      const limit = typeof event.player.getHandcardLimit === "function" ? Number(event.player.getHandcardLimit()) : Number(event.player.hp);
      if (Number.isFinite(limit) && hand > limit) values.push("若现在结束出牌阶段，按当前状态至少需要在弃牌阶段弃置" + (hand - limit) + "张手牌；不能把即将被迫弃置的牌当成长久保留收益。");
    } catch (e) { }
  }
  return values.length ? values.join("\n") : "无额外确定性即时后果；仍以当前合法候选和规则为准。";
}

const STABLE_ACTION_PROTOCOL_PROMPT = [
  "【无名杀大模型AI固定行动协议 v2】你是无名杀三国杀的行动规划器，不是聊天助手。引擎提供的局面、事件规则、候选和稳定ID是事实边界。",
  "只能选择当前合法候选，遵守强制选择、数量范围、目标顺序和事件时序；不得虚构牌、技能、目标、按钮或已经发生的结果。",
  "身份字段只代表当前界面可见信息，att只是原版AI的关系估计，不是身份事实。聊天可能暴露说话者立场，应由你结合模式与语境自行处理。",
  "引用优先级：实体牌用cardId/cardIds，技能用skillName，目标用targetId/targetIds或targetSeat/targetSeats，按钮用buttonId/buttonIds；只有确实没有稳定ID时才用本次候选indices。indices不是手牌位置，唯一候选的序号只能是0。",
  "action是选择协议：当前步骤选中任何实体牌统一用action=use，即使事件语义是交给、弃置、展示或置牌；不得把give、discard、show等事件描述词当作action。目标用action=target，发动技能用action=skill，放弃用action=skip。",
  "需要一次规划多个连续槽位或本回合后续动作时使用action=execute和有序steps。后续步骤只能使用稳定ID或座位号，禁止使用未来indices；同一target步骤中targetIds的数组顺序就是点击顺序。",
  "扩展只会立即执行当前可逆选择；后续步骤会等待本体真实结算并按游戏速度续接，每一步仍由当时的引擎合法候选裁决。计划失配会撤销仍未结算的本次选择并回原版AI，不代表能够回滚已经结算的游戏状态。",
  "若提供原版AI参考百分比，它是0%到100%的连续策略证据权重，每1个百分点等幅变化，不存在低中高档或隐藏阈值，也不会在回答后强制否决合法选择。",
  "最终只输出一个JSON对象，不要在JSON外输出分析过程。"
].join("\n");

function buildActionSystemPrompt(mode, profile, viewer) {
  const depth = Math.min(100, Math.max(1, Number(profile && profile.depth) || Number(cfg.promptThinkingDepth) || DEFAULT_CONFIG.promptThinkingDepth));
  const effort = profile && profile.thinking === false ? "关闭" : String(profile && profile.effort || cfg.serverReasoningEffort || "关闭");
  let s = mode === "speed"
    ? "【聊天催促快速决策】仅由玩家在聊天中要求“快点”触发，与绝对超时无关；本次关闭推理并立即输出最短合法 JSON。"
    : "【首要思考控制】服务端推理档位=" + effort + "；提示词思考深度=" + depth + "%；两项是相互独立的设置。" +
      "必须从分析的第一步起按该数字深度控制检查范围和推理长度；不得先按更高深度或完整深度全面分析，再在事后收缩。" +
      "必须预留最终 JSON 的输出预算，禁止只思考不下结论。";
  if (mode === "speed") {
    /* 这里只处理聊天“快点”控制；绝对超时会直接回落原版 AI，不会进入此路径。 */
    s += "\n【本次模式】聊天催促快速决策：不复核、不等待，依据紧凑局面立刻输出；reason 可省略。";
  } else {
    s += "\n【本次模式】" + ((profile && profile.guide) || "结合局面完整权衡后裁决。");
    s += "若提示中有本回合近期行动方针且当前候选仍支持，应直接延续，只检查足以改变结论的新差异；不要从头复盘、逐项反复自问或复述整份技能说明和整局历史。结论明确后立即输出 JSON。";
    if (cfg.decisionLog) {
      s += "最终 JSON 必须含 reason 字段，用一到两句自然、具体、可读的中文概括关键判断；不要只写‘综合考虑’、重复候选编号或展开完整推理。reason 是结论性理由，不要在 JSON 外输出分析过程。";
    }
  }
  return s;
}

function characterRoleplayText(player) {
  if (!player) return "";
  const names = [];
  try { [player.name, player.name1, player.name2].forEach(name => { if (name && !names.includes(name)) names.push(name); }); } catch (e) { }
  const lines = [];
  names.forEach(name => {
    let intro = "";
    try { intro = plainText(get.characterIntro(name), "").replace(/\s+/g, " ").trim().slice(0, 500); } catch (e) { }
    lines.push(safeTranslation(name, name) + "[" + name + "]" + (intro ? "：" + intro : ""));
  });
  return lines.join("；");
}

function actionSpeechInstruction(player, requested) {
  if (!requested) return "\n【拟人发言】本次不要返回speech字段。";
  return "\n【拟人发言】本次概率已命中。除决策字段外，额外返回 speech（1到45个汉字）。你就是当前武将，不是旁白或AI助手；根据武将知识、人物简介、技能与当前战况cosplay其性格和口吻，自然说一句当下会说的话。" +
    "不要复述完整决策理由，不要泄露隐藏身份/手牌/思考过程，不要照抄长段官方台词。当前武将资料=" + (characterRoleplayText(player) || playerDisplayName(player));
}

function buildPrompt(type, event, candidates, scores, range, directiveText, world) {
  const player = event.player;
  world = world || captureWorldContext(event, player, { audience: "actor_decision" });
  const targetPlan = type === "target" ? orderedTargetPlan(candidates) : null;
  let s = "【决策任务】替当前 AI 完成本次真实操作；" +
    (targetPlan ? "按动态目标规则从下方目标池规划完整有序选择。" : "只能从合法候选中选择。") +
    "\n【思考控制提醒】从第一步起按用户设定的 " + cfg.promptThinkingDepth + "% 思考深度权衡，结论明确后立即给出完整最终 JSON。";
  try { s += "\n【指代】玩家说的‘我’始终是真人玩家 " + makePlayerRef(game.me) + "；‘你’=当前操作者 " + makePlayerRef(player) + "。"; } catch (e) { }
  if (directiveText) {
    s += "\n【当前有效聊天指令】\n" + directiveText +
      "\n结合本次事件理解并在合法流程内优先执行；不要机械扩大到其他牌或时机。‘攻击/打某人’通常涵盖伤害、拆、顺、乐、兵及负面技能，但‘打出杀’只是使用牌。";
    if (originalAIReferenceStrength() > 0) s += "此时原版 AI 参考只是专业建议，不得否决与玩家意图一致的合法选择。";
  }
  const recentChat = decisionChatContextText(player, ACTION_CHAT_CONTEXT_LIMIT, directiveText);
  if (recentChat) s += "\n【最近相关聊天（仅作语境）】\n" + recentChat;
  s += "\n【原版 AI 参考规则】" + originalAIReferenceInstruction(!!directiveText);
  const referenceSummary = originalAIReferenceSummary(scores, event, !!directiveText);
  if (referenceSummary) s += "\n" + originalAIReferenceHeader(!!directiveText) + referenceSummary;
  s += "\n【上下文快照】schema=v" + world.schemaVersion + "；stateHash=" + world.fingerprint;
  s += actionSpeechInstruction(player, !!world.speechRequested);
  s += "\n【当前游戏模式】" + world.modeText;
  s += "\n【当前事件最相关规则（优先于旧行动理由和名字猜测）】\n" + relevantRuleText(event, candidates);
  s += "\n【立即后果与机会成本】\n" + immediateConsequenceText(type, event, candidates, scores);
  s += "\n【全场动态状态（每名武将一行）】\n" + world.boardText;
  s += "\n【操作者手牌】" + world.handText;
  s += "\n【当前事件】" + world.eventText;
  s += "\n【事件链（当前 <- 上级）】" + world.eventChainText;
  s += "\n【本局事件时间线（按当前操作者已知信息）】\n" + world.timelineText;
  s += "\n【已选择对象】" + world.selectedText + "\n";
  s += "【选择数量】本次总范围 " + range[0] + " 到 " + (range[1] === Infinity ? "不限" : range[1]) +
    "；当前事件" + (event.forced ? "强制选择，不允许 skip" : "允许主动放弃") + "。\n";
  if (targetPlan) s += orderedTargetInstruction(candidates, range, false) + "\n";
  if (type === "card") {
    s += actionPlanPromptHint(type, event, false);
    s += "【合法候选牌/技能】\n";
    candidates.forEach((candidate, index) => {
      if (typeof candidate === "string") {
        s += index + ". [技能:" + candidate + "] " + safeTranslation(candidate, candidate) + originalAICandidateReference(scores, index, event, range, false) + "\n";
      } else {
        const metrics = originalAIReferenceMode() === "exact" ? " | " + cardMetrics(candidate, player) : "";
        const targetFlow = cardTargetFlowHint(event, candidate, player);
        s += index + ". [牌] " + cardPromptText(candidate, player, true) + metrics +
          (targetFlow ? " | " + targetFlow : "") + originalAICandidateReference(scores, index, event, range, false) + "\n";
      }
    });
    if (event.name === "chooseToDiscard") {
      s += "这是弃牌选择：实体牌优先输出 {\"action\":\"use\",\"cardIds\":[\"牌的cardId\"]}；没有 cardId 的特殊牌才使用 indices。这里 use 表示选中并弃置，不是使用卡牌；必须选满要求数量，不能回复拒绝或 skip。";
    } else {
        s += "没有后续目标槽时不要虚构 target 步骤；活动出牌阶段仍可把结算后的独立牌/技能继续写入 steps。若当前牌会继续选择目标，须按上面的同事件协议一次返回完整 target 步骤。" +
        "name=sha 且 nature=fire 才是火杀。发动技能用 action=skill 且返回 skillName；若技能随后会弹出按钮且当前尚未提供按钮候选，可额外返回简短 nextIntent 说明下一步想选的效果/牌名/目的，不要虚构 buttonId；无稳定 ID 的特殊候选才使用 indices" +
        (event.forced ? "；这是强制选择，不得 skip。" : "；放弃用 {\"action\":\"skip\"}。") + "";
    }
  } else if (type === "target") {
    s += targetPlan ? "【潜在完整目标池】\n" : "【合法候选目标】\n";
    candidates.forEach((target, index) => {
      const initiallyLegal = !targetPlan || targetPlan.initialLegal.includes(target);
      const effect = originalAIReferenceMode() === "exact"
        ? initiallyLegal ? " | 当前牌效果估值 " + candidateEffect(type, event, target) : " | 后续步骤暂不估值"
        : "";
      s += index + ". " + targetPromptText(target) + orderedTargetCandidateMarker(targetPlan, target) +
        originalAICandidateReference(scores, index, event, range, false) + effect + "\n";
    });
    s += "本步骤只选择目标，不要返回 cardId、cardName 等牌字段。" +
      (targetPlan
        ? "必须一次输出完整有序计划，例如 {\"action\":\"target\",\"targetIds\":[\"第1项目标ID\",\"第2项目标ID\"]}；数组顺序不可调换，也可使用 targetSeats；无稳定 ID 时才使用 indices"
        : "优先输出 {\"action\":\"target\",\"targetIds\":[\"目标的targetId\"]}，也可使用 targetSeat/targetSeats；无稳定 ID 时才使用 indices") +
      (event.forced ? "；这是强制选择，不得 skip。" : "；放弃用 {\"action\":\"skip\"}。") + "";
  } else {
    s += actionPlanPromptHint(type, event, false);
    s += "【合法候选按钮】\n";
    candidates.forEach((button, index) => {
      s += index + ". " + buttonPromptText(button) + originalAICandidateReference(scores, index, event, range, false) + "\n";
    });
    s += "本步骤只选择按钮。优先输出 {\"action\":\"use\",\"buttonIds\":[\"按钮的buttonId\"]}；无稳定 ID 时才使用 indices 或 buttonText/buttonTexts" +
      (event.forced ? "；这是强制选择，不得 skip。" : "；放弃用 {\"action\":\"skip\"}。") + "";
  }
  return s;
}

function buildQuickPrompt(type, event, candidates, scores, range, directiveText, world) {
  const player = event.player;
  world = world || captureWorldContext(event, player, { audience: "actor_decision", timelineLimit: 10 });
  const targetPlan = type === "target" ? orderedTargetPlan(candidates) : null;
  const labels = candidates.map((candidate, index) => {
    let label = "";
    if (type === "card") {
      label = typeof candidate === "string" ? "技能:" + candidate + "/" + safeTranslation(candidate, candidate) : cardPromptText(candidate, player, false);
      if (typeof candidate !== "string") {
        const targetFlow = cardTargetFlowHint(event, candidate, player);
        if (targetFlow) label += "|" + targetFlow;
      }
    }
    else if (type === "target") label = targetPromptText(candidate) + orderedTargetCandidateMarker(targetPlan, candidate);
    else label = buttonPromptText(candidate);
    return index + "." + label + originalAICandidateReference(scores, index, event, range, true);
  });
  const action = type === "target" ? "target" : "use";
  const directive = directiveText ? "\n【当前有效聊天指令】" + directiveText : "";
  const recentChat = decisionChatContextText(player, ACTION_CHAT_CONTEXT_LIMIT, directiveText);
  let pronouns = "";
  try { pronouns = "【指代】‘我’=真人玩家" + makePlayerRef(game.me) + "；‘你’=操作者" + makePlayerRef(player); } catch (e) { }
  const discard = type === "card" && event.name === "chooseToDiscard"
    ? "\n【弃牌】action=use表示选中弃置，必须选满，不得拒绝或skip" : "";
  const referenceSummary = originalAIReferenceSummary(scores, event, !!directiveText);
  return "立即完成合法选择，不解释、不复核。\n" + pronouns + directive + actionSpeechInstruction(player, !!world.speechRequested) +
    (recentChat ? "\n【最近相关聊天】\n" + recentChat : "") +
    "\n【上下文】v" + world.schemaVersion + "/" + world.fingerprint +
    "\n【当前游戏模式】" + world.modeText +
    "\n【当前相关规则】" + relevantRuleText(event, candidates) +
    "\n【立即后果】" + immediateConsequenceText(type, event, candidates, scores) +
    "\n【全场动态状态】\n" + world.boardText +
    "\n【操作者手牌】" + world.handText +
    "\n【当前事件】" + world.eventText +
    "\n【事件链】" + world.eventChainText +
    "\n【最近战局事件】\n" + world.timelineText +
    "\n【已选择】" + world.selectedText +
    "\n【范围】" + range[0] + "-" + (range[1] === Infinity ? candidates.length : range[1]) + "；" + (event.forced ? "强制，不可skip" : "可skip") +
    (targetPlan ? "\n" + orderedTargetInstruction(candidates, range, true) : "") +
    actionPlanPromptHint(type, event, true) + discard +
    (referenceSummary ? "\n" + originalAIReferenceHeader(!!directiveText) + referenceSummary : "\n【原版AI】提示参考程度=0%，独立决策") +
    "\n【本次补充】候选标明需要后续手动目标时须一次返回完整steps；标明本体自动选择或无手动目标槽时不得添加target步骤" +
    "\n" + (targetPlan ? "【潜在完整目标池】" : "【合法候选】") + labels.join("；") +
    "\n【输出】" + (targetPlan
      ? "{\"action\":\"target\",\"targetIds\":[\"第1项ID\",\"第2项ID\"]}；一次返回完整有序计划"
      : "{\"action\":\"" + action + "\",\"indices\":[序号]}") +
    (type === "card" ? "；实体牌改用cardId/cardIds，技能用skillName；技能后续按钮尚未知时可附简短nextIntent" : type === "target" ? "；优先用targetId/targetIds，也可用targetSeat" : "；优先用buttonId/buttonIds，也可用buttonText") + "。";
}

function semanticReferenceText(value) {
  return normalizeDirectiveText(value && typeof value === "object" ?
    (value.name || value.text || value.label || value.value || "") : value);
}

function semanticCandidateValues(type, candidate) {
  const values = new Set();
  const add = value => { const clean = semanticReferenceText(value); if (clean) values.add(clean); };
  add(directiveCandidateLabel(type, candidate));
  if (type === "card") {
    if (typeof candidate === "string") {
      add(candidate);
      add(safeTranslation(candidate, candidate));
    } else {
      add(candidate && candidate.name);
      add(safeTranslation(candidate && candidate.name, ""));
      add(cardText(candidate));
      add(directiveCardIdentity(candidate));
    }
  } else if (type === "target") {
    add(playerDisplayName(candidate));
    add(makePlayerRef(candidate));
    const seat = seatNumber(candidate);
    if (seat > 0) { add(String(seat)); add(seat + "号"); add(seat + "号位"); add("第" + seat + "号"); add("第" + seat + "号位"); }
  } else {
    add(buttonText(candidate));
    if (buttonIsInformationHidden(candidate)) return values;
    try {
      const link = candidate && candidate.link;
      add(link && link.name || link);
      add(safeTranslation(link && link.name || link, ""));
    } catch (e) { }
  }
  if (type !== "target") {
    if (!(type === "button" && buttonIsInformationHidden(candidate))) {
      try { candidateDirectiveAliases(type, candidate).forEach(add); } catch (e) { }
    }
  }
  return values;
}

function resolveSemanticCandidate(type, reference, candidates, scores, kind, usedIndices) {
  usedIndices = usedIndices || new Set();
  const stableIdAccessor = {
    cardId: candidateCardId,
    targetId: candidateTargetId,
    buttonId: candidateButtonId
  }[kind];
  if (stableIdAccessor) {
    const wantedId = opaqueCandidateId(reference);
    if (!wantedId) return { error: { code: "semantic_not_found", message: kind + " 不能为空" } };
    const allMatches = candidates.map((candidate, index) => stableIdAccessor(candidate) === wantedId ? index : -1)
      .filter(index => index >= 0);
    if (allMatches.some(index => usedIndices.has(index))) {
      return { error: { code: "duplicate_selection", message: kind + "=" + wantedId + " 被重复选择" } };
    }
    const matches = allMatches.filter(index => !usedIndices.has(index));
    if (!matches.length) return { error: { code: "semantic_not_found", message: "合法候选中没有 " + kind + "=" + wantedId } };
    if (matches.length > 1) return { error: { code: "semantic_ambiguous", message: kind + "=" + wantedId + " 对应多个合法候选" } };
    return { index: matches[0] };
  }
  if (kind === "targetName") {
    const seatMatch = String(reference || "").match(/(?:第)?(\d{1,2})号(?:位)?/);
    if (!seatMatch) return { error: { code: "target_seat_required", message: "目标引用必须明确写出座位号" } };
    return resolveSemanticCandidate(type, Number(seatMatch[1]), candidates, scores, "targetSeat", usedIndices);
  }
  if (kind === "targetSeat") {
    const seat = parseSeatReference(reference);
    if (!Number.isInteger(seat) || seat <= 0) {
      return { error: { code: "target_seat_required", message: "targetSeat 必须是座位数字或“3号”格式" } };
    }
    const matches = candidates.map((candidate, index) => seatNumber(candidate) === seat ? index : -1)
      .filter(index => index >= 0 && !usedIndices.has(index));
    if (!matches.length) return { error: { code: "semantic_not_found", message: "合法目标中没有 " + seat + " 号" } };
    if (matches.length > 1) return { error: { code: "semantic_ambiguous", message: seat + " 号对应多个目标" } };
    return { index: matches[0] };
  }
  const wanted = semanticReferenceText(reference);
  if (!wanted) return { error: { code: "semantic_not_found", message: "语义候选引用为空" } };
  let matches = candidates.map((candidate, index) => {
    if (usedIndices.has(index)) return -1;
    if (kind === "cardName" && (type !== "card" || typeof candidate === "string")) return -1;
    if (kind === "skillName" && (type !== "card" || typeof candidate !== "string")) return -1;
    if (kind === "buttonText" && type !== "button") return -1;
    return semanticCandidateValues(type, candidate).has(wanted) ? index : -1;
  }).filter(index => index >= 0);
  if (!matches.length) return { error: { code: "semantic_not_found", message: "合法候选中找不到“" + String(reference) + "”" } };
  if (matches.length > 1 && kind !== "cardName") {
    return { error: { code: "semantic_ambiguous", message: "“" + String(reference) + "”对应多个合法候选，请改用座位号或序号" } };
  }
  if (matches.length > 1) {
    matches = matches.map(index => ({ index, score: effectiveCommitScore(originalAIScoreAt(scores, index)) }))
      .sort((left, right) => {
        const a = Number.isFinite(left.score) ? left.score : -Infinity;
        const b = Number.isFinite(right.score) ? right.score : -Infinity;
        return b - a || left.index - right.index;
      }).map(item => item.index);
  }
  return { index: matches[0] };
}

function choiceError(code, message) {
  return { choice: null, error: { code, message } };
}

function choiceFieldValues(res, plural, singular) {
  const value = res[plural] !== undefined ? res[plural] : res[singular];
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value.slice() : [value];
}

function normalizePlanStepKind(value) {
  const kind = String(value || "").toLowerCase().trim();
  if (["card", "cards", "牌", "选牌"].includes(kind)) return "card";
  if (["target", "targets", "目标", "选目标"].includes(kind)) return "target";
  if (["button", "buttons", "按钮", "选项"].includes(kind)) return "button";
  if (["skill", "ability", "技能"].includes(kind)) return "skill";
  if (["control", "choice", "控制项"].includes(kind)) return "control";
  return "";
}

function stablePlanRefs(step, kind) {
  /* 兼容旧版行动记忆曾暴露给模型的内部 {field,values} 形状；只接受该 kind
   * 对应的正式字段名，后续仍会映射到当前实时合法候选，绝不直接执行 values。 */
  if (step && typeof step === "object" && typeof step.field === "string" && step.values !== undefined) {
    const canonical = canonicalPlanRefField(kind, step.field);
    const allowed = kind === "card" ? ["cardIds", "cardNames", "indices"] :
      kind === "target" ? ["targetIds", "targetSeats", "indices"] :
        kind === "button" ? ["buttonIds", "buttonTexts", "indices"] :
          kind === "skill" ? ["skillNames"] : ["controls"];
    if (allowed.includes(canonical)) {
      const values = Array.isArray(step.values) ? step.values.slice() : [step.values];
      return { field: canonical, values };
    }
  }
  const fields = kind === "card" ? ["cardIds", "cardId", "cardNames", "cardName", "indices", "index"] :
    kind === "target" ? ["targetIds", "targetId", "targetSeats", "targetSeat", "indices", "index"] :
      kind === "button" ? ["buttonIds", "buttonId", "buttonTexts", "buttonText", "indices", "index"] :
        kind === "skill" ? ["skillNames", "skillName"] : ["controls", "controlText", "control"];
  for (const field of fields) {
    if (step[field] === undefined || step[field] === null || step[field] === "") continue;
    const value = step[field];
    return { field, values: Array.isArray(value) ? value.slice() : [value] };
  }
  return { field: "", values: [] };
}

function canonicalPlanRefField(kind, field) {
  if (kind === "card") {
    if (field === "cardId" || field === "cardIds") return "cardIds";
    if (field === "cardName" || field === "cardNames") return "cardNames";
  } else if (kind === "target") {
    if (field === "targetId" || field === "targetIds") return "targetIds";
    if (field === "targetSeat" || field === "targetSeats") return "targetSeats";
  } else if (kind === "button") {
    if (field === "buttonId" || field === "buttonIds") return "buttonIds";
    if (field === "buttonText" || field === "buttonTexts") return "buttonTexts";
  } else if (kind === "skill" && (field === "skillName" || field === "skillNames")) return "skillNames";
  if (field === "index" || field === "indices") return "indices";
  return field;
}

function normalizeActionPlanResponse(response, currentType, event) {
  if (!response || typeof response !== "object" || !Array.isArray(response.steps)) return null;
  if (!response.steps.length || response.steps.length > 16) return null;
  const rawSteps = [];
  for (let stepIndex = 0; stepIndex < response.steps.length; stepIndex++) {
    const raw = response.steps[stepIndex];
    if (!raw || typeof raw !== "object") return null;
    const kind = normalizePlanStepKind(raw.kind || raw.type || raw.slot);
    if (!kind) return null;
    const refs = stablePlanRefs(raw, kind);
    if (!refs.values.length) return null;
    if (stepIndex > 0 && (refs.field === "indices" || refs.field === "index")) return null;
    rawSteps.push({ kind, field: canonicalPlanRefField(kind, refs.field), values: refs.values });
  }
  /* 模型有时把一个有序多目标数组写成多个连续 target 步骤；二者语义相同，通用合并。 */
  const steps = [];
  for (const step of rawSteps) {
    const previous = steps[steps.length - 1];
    if (previous && previous.kind === "target" && step.kind === "target") {
      if (previous.field !== step.field) return null;
      previous.values.push(...step.values);
    } else {
      steps.push({ kind: step.kind, field: step.field, values: step.values.slice() });
    }
  }
  if (!steps.length || steps.length > 16) return null;
  const firstSelectable = steps.find(step => ["card", "target", "button", "skill"].includes(step.kind));
  if (!firstSelectable || !(firstSelectable.kind === currentType || currentType === "card" && firstSelectable.kind === "skill")) return null;
  /* 第一个行动立即交给当前事件；其后的 card/skill/button 是本回合软续接计划。
   * target 只和它前面的首项绑定，不把多张独立牌硬塞进同一个 UI 选择事件。 */
  let immediateCount = 1;
  if (steps[1] && steps[1].kind === "target" &&
    supportsDeferredSlotSequence(event, [steps[0], steps[1]]) && !eventHasSelectionHooks(event)) immediateCount = 2;
  const immediateSteps = steps.slice(0, immediateCount).map(step => ({ kind: step.kind, field: step.field, values: step.values.slice() }));
  const rollingSteps = steps.slice(immediateCount).map(step => ({ kind: step.kind, field: step.field, values: step.values.slice() }));
  /* 只有技能入口后的 target 可能由 backup/技能流程在下一事件才生成；
   * 普通牌/按钮的 target 若不能和当前槽安全绑定，就不能冒充跨事件独立动作。 */
  if (rollingSteps[0] && rollingSteps[0].kind === "target" && steps[0].kind !== "skill") return null;
  return {
    action: "execute",
    steps: immediateSteps,
    rollingSteps,
    allSteps: steps,
    nextIndex: 0,
    reason: String(response.reason || "").slice(0, 1000)
  };
}

function normalizeLegacyStableStepResponse(response, currentType) {
  if (!response || typeof response !== "object" || Array.isArray(response) || !response.stableStep) return response;
  const source = response.stableStep;
  if (!source || typeof source !== "object") return response;
  const kind = normalizePlanStepKind(source.kind || source.type || source.slot || currentType);
  if (!(kind === currentType || currentType === "card" && kind === "skill")) return response;
  const refs = stablePlanRefs(source, kind);
  const field = canonicalPlanRefField(kind, refs.field);
  if (!field || !refs.values.length) return response;
  const normalized = Object.assign({}, response);
  normalized[field] = refs.values.length === 1 ? refs.values[0] : refs.values.slice();
  delete normalized.stableStep;
  return normalized;
}

function supportsDeferredSlotSequence(event, steps) {
  if (!event || !Array.isArray(steps) || steps.length !== 2) return false;
  const kinds = steps.map(step => step.kind).join("->");
  if (kinds === "card->target") return ["chooseToUse", "chooseToRespond", "chooseCardTarget"].includes(event.name);
  if (kinds === "button->target") return event.name === "chooseButtonTarget";
  return false;
}

function eventHasSelectionHooks(event) {
  try {
    const add = event && event.custom && event.custom.add;
    return !!(add && (typeof add.card === "function" || typeof add.target === "function" || typeof add.button === "function"));
  } catch (e) { return true; }
}

function stepResponseForParser(step) {
  const response = { action: step.kind === "target" ? "target" : step.kind === "skill" ? "skill" : "use" };
  response[step.field] = step.values.length === 1 ? step.values[0] : step.values.slice();
  return response;
}

function currentPlanStep(plan) {
  if (!plan) return null;
  while (plan.nextIndex < plan.steps.length && plan.steps[plan.nextIndex].kind === "control") plan.nextIndex++;
  return plan.steps[plan.nextIndex] || null;
}

function planChoiceForCurrentSlot(plan, type, candidates, event, range, scores) {
  const step = currentPlanStep(plan);
  if (!step || !(step.kind === type || type === "card" && step.kind === "skill")) {
    return choiceError("plan_step_mismatch", "元计划下一步是 " + (step && step.kind || "结束") + "，当前引擎需要 " + type);
  }
  const detail = parseChoiceDetailed(stepResponseForParser(step), type, candidates, event, range, scores);
  if (detail.choice) plan.nextIndex++;
  return detail;
}

function attachActionPlan(choice, plan) {
  if (!choice || !plan) return choice;
  try { Object.defineProperty(choice, "__llmActionPlan", { value: plan, enumerable: false, configurable: true }); } catch (e) { choice.__llmActionPlan = plan; }
  return choice;
}

function attachRollingPlanAdvance(choice, plan, consumeCount) {
  if (!choice || !plan || !(consumeCount > 0)) return choice;
  const value = { plan, consumeCount };
  try { Object.defineProperty(choice, "__llmRollingAdvance", { value, enumerable: false, configurable: true }); }
  catch (e) { choice.__llmRollingAdvance = value; }
  return choice;
}

function attachSupersededRollingPlan(choice, plan) {
  if (!choice || !plan) return choice;
  try { Object.defineProperty(choice, "__llmSupersededRollingPlan", { value: plan, enumerable: false, configurable: true }); }
  catch (e) { choice.__llmSupersededRollingPlan = plan; }
  return choice;
}

function attachDecisionReason(choice, reason) {
  if (!choice) return choice;
  const text = String(reason || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  try { Object.defineProperty(choice, "__llmReason", { value: text, enumerable: false, configurable: true }); } catch (e) { choice.__llmReason = text; }
  return choice;
}

function attachDecisionContinuationIntent(choice, response) {
  if (!choice || !response || typeof response !== "object") return choice;
  const value = response.nextIntent !== undefined ? response.nextIntent :
    response.followupIntent !== undefined ? response.followupIntent : response.actionGuidance;
  const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return choice;
  try { Object.defineProperty(choice, "__llmNextIntent", { value: text, enumerable: false, configurable: true }); }
  catch (e) { choice.__llmNextIntent = text; }
  return choice;
}

function attachDecisionSpeech(choice, response, allowed) {
  if (!choice || !allowed || !response || typeof response !== "object") return choice;
  const text = sanitizeChatReply(String(response.speech || response.say || "")).replace(/\s+/g, " ").trim().slice(0, 100);
  if (!text) return choice;
  try { Object.defineProperty(choice, "__llmSpeech", { value: text, enumerable: false, configurable: true }); }
  catch (e) { choice.__llmSpeech = text; }
  return choice;
}

function parseChoiceDetailed(res, type, candidates, event, range, scores) {
  if (Number.isInteger(res)) res = { index: res };
  if (typeof res === "string" && /^\d+$/.test(res.trim())) res = { index: Number(res.trim()) };
  if (Array.isArray(res)) res = { indices: res };
  if (!res || typeof res !== "object") return choiceError("invalid_json", "没有返回可解析的 JSON 选择对象");
  for (const key of ["choice", "decision", "result", "selection"]) {
    if (res[key] && typeof res[key] === "object" && !Array.isArray(res[key])) {
      res = res[key];
      break;
    }
  }
  res = normalizeLegacyStableStepResponse(res, type);
  let action = res.action;
  if (action === undefined && res.skip === true) action = "skip";
  let rawIndices = res.indices !== undefined ? res.indices :
    res.index !== undefined ? res.index :
      res.selected !== undefined ? res.selected :
        res.choice_index !== undefined ? res.choice_index :
          res.target !== undefined ? res.target : res.card;
  const values = Array.isArray(rawIndices) ? rawIndices.slice() : (rawIndices !== undefined ? [rawIndices] : []);
  if (typeof action === "number") { values.unshift(action); action = undefined; }

  let semanticRefs = [];
  const setSemanticRefs = (values, kind) => {
    semanticRefs = values.map(reference => ({ kind, reference }));
  };
  /* 每次本体只询问一种对象。模型提前附带的下一步字段必须忽略，不能推翻本步骤正确的 ID/indices。 */
  if (type === "card") {
    const cardIds = choiceFieldValues(res, "cardIds", "cardId");
    const skillNames = choiceFieldValues(res, "skillNames", "skillName");
    const legacyCardNames = choiceFieldValues(res, "cardNames", "cardName");
    const actionHint = String(res.action || "").toLowerCase().trim();
    const explicitlySkill = ["skill", "ability", "activate", "发动", "技能"].some(k => actionHint === k || actionHint.includes(k));
    /* 技能回答可能顺便附带未来代价 cardIds；当前槽明确 action=skill 时，skillName
     * 才是本步骤对象，未来牌字段必须忽略。 */
    if (skillNames.length && explicitlySkill) setSemanticRefs(skillNames, "skillName");
    else if (cardIds.length) setSemanticRefs(cardIds, "cardId");
    else if (skillNames.length) setSemanticRefs(skillNames, "skillName");
    else if (!values.length && legacyCardNames.length) setSemanticRefs(legacyCardNames, "cardName");
  } else if (type === "target") {
    const targetIds = choiceFieldValues(res, "targetIds", "targetId");
    const targetSeats = choiceFieldValues(res, "targetSeats", "targetSeat");
    if (targetIds.length) setSemanticRefs(targetIds, "targetId");
    else if (targetSeats.length) setSemanticRefs(targetSeats, "targetSeat");
  } else {
    const buttonIds = choiceFieldValues(res, "buttonIds", "buttonId");
    const buttonTexts = choiceFieldValues(res, "buttonTexts", "buttonText");
    if (buttonIds.length) setSemanticRefs(buttonIds, "buttonId");
    else if (!values.length && buttonTexts.length) setSemanticRefs(buttonTexts, "buttonText");
  }
  if (action === undefined && (values.length || semanticRefs.length)) action = type === "target" ? "target" : "use";
  if (typeof action !== "string") return choiceError("unknown_action", "缺少 action，且无法从选择字段推断动作");
  const a = action.toLowerCase().trim();
  if (["use", "play", "use_card", "card", "打出", "使用", "出牌", "选牌"].some(k => a === k || a.includes(k))) action = "use";
  else if (["skill", "ability", "activate", "发动", "技能"].some(k => a === k || a.includes(k))) action = "skill";
  else if (["skip", "pass", "cancel", "none", "null", "跳过", "放弃", "不出", "不选", "结束", "过"].some(k => a === k || a.includes(k))) action = "skip";
  else if (["target", "choose", "select", "选择", "指定", "选"].some(k => a === k || a.includes(k))) action = "target";
  else if (type === "card" && (semanticRefs.length || values.length) && ["give", "give_card", "givecard", "discard", "throw", "show", "reveal", "place", "put", "交给", "给", "弃置", "弃牌", "展示", "亮出", "置入", "放置"].includes(a)) {
    /* 动作词只是自然语言用途；稳定 cardId 已明确本步骤对象时，按选牌协议归一化为 use。 */
    action = "use";
  }
  else return choiceError("unknown_action", "无法识别 action: " + action);

  if (action === "skip") return event.forced ? choiceError("forced_skip", "当前是强制选择，不能 skip") : { choice: { action: "skip", indices: [] }, error: null };
  const indices = [];
  const used = new Set();
  /* 稳定 ID/当前步骤稳定语义优先，其次是本次序号；旧显示文字仅在没有序号时兼容。 */
  for (const value of (semanticRefs.length ? [] : values)) {
    if ((typeof value === "number" && Number.isInteger(value)) || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
      const index = Number(value);
      if (index < 0 || index >= candidates.length) return choiceError("index_out_of_range", "候选序号 " + index + " 超出 0 到 " + (candidates.length - 1));
      if (used.has(index)) return choiceError("duplicate_selection", "候选序号 " + index + " 被重复选择");
      used.add(index); indices.push(index);
      continue;
    }
    const inferredKind = type === "target" ? "targetName" : type === "button" ? "buttonText" : "cardName";
    const resolved = resolveSemanticCandidate(type, value, candidates, scores, inferredKind, used);
    if (resolved.error) return { choice: null, error: resolved.error };
    used.add(resolved.index); indices.push(resolved.index);
  }
  for (const item of semanticRefs) {
    const resolved = resolveSemanticCandidate(type, item.reference, candidates, scores, item.kind, used);
    if (resolved.error) return { choice: null, error: resolved.error };
    used.add(resolved.index); indices.push(resolved.index);
  }
  if (!indices.length) return choiceError("missing_selection", "动作不是 skip，但没有提供本步骤可用的稳定 ID、语义字段或候选序号");

  const targetPlan = type === "target" ? orderedTargetPlan(candidates) : null;
  const already = targetPlan ? targetPlan.baseSelected.length :
    type === "card" ? ui.selected.cards.length : type === "target" ? ui.selected.targets.length : ui.selected.buttons.length;
  const limits = remainingTargetLimits(range, already);
  const minNeeded = limits.min;
  const maxAllowed = limits.max === Infinity ? candidates.length : limits.max;
  if (indices.length < minNeeded) {
    const missing = minNeeded - indices.length;
    return choiceError("too_few", targetPlan
      ? "完整有序目标序列还缺 " + missing + " 项（本次至少需要 " + minNeeded + " 项，当前只返回 " + indices.length + " 项）"
      : "本次至少需要选择 " + minNeeded + " 项，当前只选了 " + indices.length + " 项");
  }
  if (indices.length > maxAllowed) return choiceError("too_many", "本次最多允许选择 " + maxAllowed + " 项，当前选了 " + indices.length + " 项");

  if (type === "target") action = "target";
  else if (type === "button") action = "use";
  else {
    const skills = indices.filter(index => typeof candidates[index] === "string");
    if (skills.length && skills.length !== indices.length) return choiceError("mixed_card_skill", "同一次选择不能混合实体牌和技能");
    if (skills.length) {
      if (indices.length !== 1) return choiceError("too_many", "一次只能发动一个技能");
      action = "skill";
    } else action = "use";
  }
  const choice = { action, indices };
  if (action === "skill" && indices.length && typeof candidates[indices[0]] === "string") choice.skillName = candidates[indices[0]];
  return { choice, error: null };
}

function parseChoice(res, type, candidates, event, range, scores) {
  return parseChoiceDetailed(res, type, candidates, event, range, scores).choice;
}

function refreshDecisionSnapshot(type, event, candidates, check, range) {
  try {
    const previousPlan = type === "target" ? orderedTargetPlan(candidates) : null;
    let live = selectableNow(type);
    if (type === "card" && event && event.player && !event.player._noSkill) {
      try { live = live.concat(get.skills()); } catch (e) { }
    }
    let unique = [];
    if (Array.isArray(live)) {
      live.forEach(candidate => { if (!unique.includes(candidate)) unique.push(candidate); });
    }
    const selectValue = type === "card" ? event.selectCard : type === "target" ? event.selectTarget : event.selectButton;
    const freshRange = get.select(selectValue);
    if (Array.isArray(freshRange) && freshRange.length >= 2) {
      range[0] = freshRange[0];
      range[1] = freshRange[1];
    }
    if (previousPlan) {
      const rebuilt = buildOrderedTargetPlan(event, range, unique);
      if (rebuilt) {
        candidates.splice(0, candidates.length, ...rebuilt.candidates);
        rebuilt.candidates = candidates;
        attachOrderedTargetPlan(candidates, rebuilt);
      } else {
        candidates.splice(0, candidates.length, ...unique);
        try { delete candidates[ORDERED_TARGET_PLAN_KEY]; } catch (e) { }
      }
    } else if (Array.isArray(live)) {
      candidates.splice(0, candidates.length, ...unique);
    }
  } catch (e) {
    log("API 重试前刷新合法候选失败，继续使用当前快照: " + e.message);
  }
  return evaluateOriginalAIScores(check, candidates);
}

function completeVariableTargets(choice) {
  /* 多目标数量由模型按通用事件 range/filterOk 决定，不再按某张牌补目标。 */
  return choice;
}

let activeDecision = null;

function cancelActiveDecisionForLifecycle(detail) {
  const token = activeDecision;
  if (!token) return;
  token.cancelledByNewEvent = true;
  finishDecisionJournal(token.journal, {
    outcome: "stale",
    choice: token.journalChoice || null,
    detail: detail || "当前模型请求已取消，旧结果不会执行"
  });
  try { if (token.controller) token.controller.abort(); } catch (e) { }
  if (activeDecision === token) activeDecision = null;
}

function captureDecisionContext(event) {
  return {
    event: event,
    player: event && event.player,
    currentPhase: _status.currentPhase,
    phaseNumber: game.phaseNumber,
    roundNumber: game.roundNumber
  };
}

function decisionContextValid(context) {
  if (!context || _status.event !== context.event || context.event.player !== context.player) return false;
  if (_status.currentPhase !== context.currentPhase) return false;
  if (game.phaseNumber !== context.phaseNumber || game.roundNumber !== context.roundNumber) return false;
  return true;
}

function staleDecisionError() {
  const error = new Error("决策返回时原事件已结束，已拒绝旧结果");
  error.name = "StaleDecisionError";
  return error;
}

async function requestSpeedControlledChoice(type, event, candidates, scores, range, directiveText, context, token) {
  /* 兼容内部函数名：本路径只由聊天“快点”控制触发；它不是超时后的第二次裁决。 */
  if (!decisionContextValid(context) || activeDecision !== token) throw staleDecisionError();
  const state = directiveStateForDecision(event.player, type, event, candidates);
  directiveText = state.text;
  const controller = new AbortController();
  token.controller = controller;
  token.requestMode = "speed";
  try {
    const requestMessages = [
      { role: "system", content: STABLE_ACTION_PROTOCOL_PROMPT },
      { role: "system", content: buildActionSystemPrompt("speed", reasoningProfile(), event.player) }
    ];
    if (token.skillOwnershipPrompt) requestMessages.push({ role: "system", content: token.skillOwnershipPrompt });
    const memoryMessage = actionMemorySystemMessage(event.player, event, type);
    if (memoryMessage) requestMessages.push(memoryMessage);
    requestMessages.push({ role: "user", content: buildQuickPrompt(type, event, candidates, scores, range, directiveText, token.world) });
    const raw = await callLLM(requestMessages, {
      json: true,
      temperature: cfg.temperature,
      topP: cfg.topP,
      thinking: false,
      explicitThinkingDisabled: true,
      timeoutMs: Math.min(cfg.timeout * 1000, 1500),
      retryCount: 0,
      compatibilityFallback: false,
      maxTokens: Math.min(cfg.actionMaxTokens, 256),
      actionDecision: true,
      requestMode: "speed",
      decisionType: type,
      controller,
      journal: token.journal,
      httpAttempt: 1
    });
    if (!decisionContextValid(context) || activeDecision !== token) throw staleDecisionError();
    if (token.cancelledBySpeedControl) {
      finishDecisionJournal(token.journal, { outcome: "fallback", detail: "聊天催促快速决策期间速度要求发生变化，旧结果已丢弃并交给原版 AI" });
      return null;
    }
    const latest = directiveStateForDecision(event.player, type, event, candidates);
    if (latest.signature !== state.signature) {
      finishDecisionJournal(token.journal, { outcome: "fallback", detail: "聊天催促快速决策期间聊天指令发生变化，旧结果已丢弃并交给原版 AI" });
      return null;
    }
    const response = parseJSONObject(raw);
    const actionPlan = normalizeActionPlanResponse(response, type, event);
    const detail = actionPlan
      ? planChoiceForCurrentSlot(actionPlan, type, candidates, event, range, scores)
      : parseChoiceDetailed(response, type, candidates, event, range, scores);
    let parsed = completeVariableTargets(detail.choice, type, event, candidates, scores, range, !!directiveText);
    if (parsed && actionPlan) attachActionPlan(parsed, actionPlan);
    if (parsed) {
      attachDecisionReason(parsed, response && response.reason);
      attachDecisionContinuationIntent(parsed, response);
      attachDecisionSpeech(parsed, response, !!token.world.speechRequested);
    }
        if (!parsed) {
      attachDecisionJournalResponse(token.journal, { httpAttempt: 1, status: detail.error && detail.error.code || "invalid_choice", raw, parsed: response, reason: response && response.reason || detail.error && detail.error.message });
      finishDecisionJournal(token.journal, { outcome: "fallback", detail: "聊天催促快速决策没有返回合法选择，已交给原版 AI：" + (detail.error && detail.error.message || "未知格式错误") });
      log("聊天“快点”触发的快速决策无效，立即回落原版 AI: " + (detail.error && detail.error.message || "未知格式错误"));
      return null;
        }
        const supersededRolling = rollingPhasePlanFor(event.player);
        if (parsed && supersededRolling && supersededRolling.suspendedEvent === event) attachSupersededRollingPlan(parsed, supersededRolling);
    attachDecisionJournalResponse(token.journal, { httpAttempt: 1, status: "valid", raw, parsed: response, choice: parsed, reason: response && response.reason });
    token.journalChoice = parsed;
    if (token.journal) {
      try { Object.defineProperty(parsed, "__llmJournal", { value: token.journal, enumerable: false, configurable: true }); } catch (e) { }
    }
    return parsed;
  } catch (e) {
    if (token.cancelledByNewEvent || e.name === "StaleDecisionError") {
      finishDecisionJournal(token.journal, { outcome: "stale", detail: "聊天催促快速决策返回时原游戏事件已结束，旧结果没有执行" });
      throw e;
    }
    if (isOriginalAIControlled(event.player) || token.cancelledByFastMode || token.cancelledBySpeedControl || e && e.expectedCancellation) {
      if (token.cancelReason === "player_original_ai_control") log("聊天快速请求因该角色切换原版 AI 而正常取消，不计为报错");
      finishDecisionJournal(token.journal, { outcome: "fallback", detail: "控制权或速度要求变化，聊天快速请求已正常取消并交给原版 AI" });
      return null;
    }
    finishDecisionJournal(token.journal, { outcome: "fallback", detail: "聊天催促快速决策请求未完成，已交给原版 AI：" + String(e && e.message || e) });
    log("聊天“快点”触发的快速决策未完成，立即回落原版 AI: " + e.message);
    return null;
  }
}

/* 所有失败重试共享同一个绝对截止时间；超时后只回落原版 AI，绝不进入上面的聊天“快点”路径。 */
async function askLLM(type, event, candidates, check, range) {
  if (!skillSourceRuntime || !timelineRuntime) {
    log("认知运行时模块未完整加载，本次不调用模型并交给原版 AI");
    return null;
  }
  if (isOriginalAIControlled(event && event.player)) return null;
  /* 事件类别托管是完整边界：命中后，聊天指令和本地无懈快路也不能绕过。 */
  if (logOriginalAITakeover(event, type, range, candidates)) return null;
  const wuxieState = explicitWuxieDirectiveState(event && event.player, type, event);
  let directiveState = isWuxieDecision(event) ? wuxieState : directiveStateForDecision(event.player, type, event, candidates);
  let directiveText = directiveState.text;
  /* 有结构化无懈指令时交给行动模型理解原话；本地保护快路只处理无指令局面。 */
  const friendlyCounterSkip = directiveText ? null : wuxieFriendlyCounterGuard(event);
  if (friendlyCounterSkip) {
    log("上一张无懈来自友方，本地跳过反无懈以避免抵消队友；本次不调用模型");
    return { action: friendlyCounterSkip.action, indices: friendlyCounterSkip.indices };
  }
  let scores = directiveText ? evaluateOriginalAIScores(check, candidates) : null;
  if (isWuxieDecision(event) && !directiveText) {
    if (!scores) scores = evaluateOriginalAIScores(check, candidates);
    const friendlyOriginalSkip = wuxieFriendlyOriginalGuard(event, scores);
    if (friendlyOriginalSkip) {
      log("原锦囊来自自己或友方，且原版无懈评分不建议抵消；本地跳过以避免取消己方有利效果，本次不调用模型");
      return friendlyOriginalSkip;
    }
  }
  let bindingDirectiveText = directiveText;
  if (shouldUseOriginalAIByProbability(!!bindingDirectiveText)) {
    log("原版 AI 概率分流命中（设置 " + cfg.originalAIProbability + "%），本次不调用模型");
    return null;
  }
  if (!cfg.apiKey) { log("未配置 API Key，使用原版 AI"); return null; }
  if (!scores) scores = evaluateOriginalAIScores(check, candidates);
  const speedMode = decisionSpeedMode(event.player, event);
  if (activeDecision && activeDecision.controller) {
    activeDecision.cancelledByNewEvent = true;
    try { activeDecision.controller.abort(); } catch (e) { }
  }
  const context = captureDecisionContext(event);
  const world = decisionWorldWithSpeechRequest(
    captureWorldContext(event, event.player, { audience: "actor_decision" }),
    Math.random() * 100 < cfg.aiSpeechProbability
  );
  const skillSourceMessages = battleSkillSourceMessages(event.player, event);
  const token = {
    id: ++decisionSessionSequence,
    context,
    world,
    worldRevision: 1,
    skillOwnershipPrompt: skillSourceMessages.dynamic,
    skillCatalogHash: skillSourceMessages.catalogHash,
    controller: new AbortController(),
    requestMode: null,
    state: "requesting",
    cancelledByNewEvent: false,
    cancelledByFastMode: false,
    cancelledBySpeedControl: false
  };
  activeDecision = token;
  const journal = beginDecisionJournal(event, type, candidates, token);
  token.journal = journal;
  const deadlineAt = Date.now() + cfg.timeout * 1000;
  const maxAttempts = cfg.retryCount + 1;
  let attemptsSent = 0;

  /* 思考期间给当前玩家加 llm-thinking 标记，屏蔽十周年UI的黑色蒙版 */
  let thinkingMarked = null;
  try {
    if (event.player && event.player.classList) {
      thinkingMarked = event.player;
      thinkingMarked.classList.add("llm-thinking");
    }
  } catch (e) { }

  /* UI 诊断：AI 思考期间定时快照当前玩家武将牌状态 */
  let uiTimer = null;
  if (cfg.debugUI) {
    try {
      const p = event.player;
      if (p && p.node && p.node.avatar) {
        let lastKey = "";
        uiTimer = setInterval(() => {
          try {
            const el = p;
            const f = el.style.filter || p.node.avatar.style.filter || p.node.avatar.getAttribute("style") || "";
            const cls = Array.from(el.classList).filter((c) => c !== "player" && c !== "action").join(",");
            const key = f + "|" + cls;
            if (key !== lastKey) {
              lastKey = key;
              log("[UI监控] filter='" + f + "' class='" + cls + "'");
            }
          } catch (e) { }
        }, 200);
      }
    } catch (e) { }
  }

  try {
    if (speedMode === "fast") {
      log("聊天“快点”速度控制生效：当前选择使用 1.5 秒单次快速决策（与绝对超时无关）");
      return await requestSpeedControlledChoice(type, event, candidates, scores, range, bindingDirectiveText, context, token);
    }
    const profile = reasoningProfile();
    directiveState = isWuxieDecision(event)
      ? explicitWuxieDirectiveState(event.player, type, event)
      : directiveStateForDecision(event.player, type, event, candidates);
    directiveText = directiveState.text;
    bindingDirectiveText = directiveText;
    const instructionMode = !!bindingDirectiveText;
    let lastFailure = "未知失败";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!decisionContextValid(context) || activeDecision !== token) throw staleDecisionError();
      if (isOriginalAIControlled(event.player) || token.cancelledByFastMode) {
        finishDecisionJournal(journal, { outcome: "fallback", detail: "控制权已切换，当前选择交给原版 AI" });
        return null;
      }
      if (token.cancelledBySpeedControl) {
        finishDecisionJournal(journal, { outcome: "fallback", detail: "玩家更新了速度要求，旧请求失效并交给原版 AI" });
        return null;
      }
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        lastFailure = "达到绝对时间上限 " + cfg.timeout + " 秒";
        break;
      }
      const latestState = isWuxieDecision(event)
        ? explicitWuxieDirectiveState(event.player, type, event)
        : directiveStateForDecision(event.player, type, event, candidates);
      if (latestState.signature !== directiveState.signature) {
        finishDecisionJournal(journal, { outcome: "fallback", detail: "请求期间聊天指令发生变化，旧结果作废并交给原版 AI" });
        return null;
      }
      if (attempt > 1) {
        const speechRequested = !!token.world.speechRequested;
        scores = refreshDecisionSnapshot(type, event, candidates, check, range);
        token.world = decisionWorldWithSpeechRequest(
          captureWorldContext(event, event.player, { audience: "actor_decision" }),
          speechRequested
        );
        token.worldRevision++;
      }
      const currentPrompt = buildPrompt(type, event, candidates, scores, range, bindingDirectiveText, token.world);
      token.controller = new AbortController();
      token.requestMode = "normal";
      try {
        attemptsSent = attempt;
        const requestMessages = [
          { role: "system", content: STABLE_ACTION_PROTOCOL_PROMPT },
          { role: "system", content: buildActionSystemPrompt("normal", profile, event.player) }
        ];
        if (token.skillOwnershipPrompt) requestMessages.push({ role: "system", content: token.skillOwnershipPrompt });
        const memoryMessage = actionMemorySystemMessage(event.player, event, type);
        if (memoryMessage) requestMessages.push(memoryMessage);
        requestMessages.push({ role: "user", content: currentPrompt });
        const raw = await callLLM(requestMessages, {
          json: true,
          actionDecision: true,
          temperature: cfg.temperature,
          topP: cfg.topP,
          thinking: profile.thinking,
          explicitThinkingDisabled: profile.thinking === false,
          reasoningEffort: profile.effort,
          timeoutMs: remaining,
          absoluteDeadline: deadlineAt,
          retryCount: 0,
          compatibilityFallback: false,
          requestMode: "normal",
          decisionType: type,
          controller: token.controller,
          journal,
          httpAttempt: attempt
        });
        if (!decisionContextValid(context) || activeDecision !== token) throw staleDecisionError();
        const response = parseJSONObject(raw);
        const actionPlan = normalizeActionPlanResponse(response, type, event);
        const detail = actionPlan
          ? planChoiceForCurrentSlot(actionPlan, type, candidates, event, range, scores)
          : parseChoiceDetailed(response, type, candidates, event, range, scores);
        let parsed = completeVariableTargets(detail.choice, type, event, candidates, scores, range, !!bindingDirectiveText);
        if (parsed && actionPlan) attachActionPlan(parsed, actionPlan);
        if (parsed) {
          attachDecisionReason(parsed, response && response.reason);
          attachDecisionContinuationIntent(parsed, response);
          attachDecisionSpeech(parsed, response, !!token.world.speechRequested);
        }
        if (parsed) {
          const supersededRolling = rollingPhasePlanFor(event.player);
          if (supersededRolling && supersededRolling.suspendedEvent === event) attachSupersededRollingPlan(parsed, supersededRolling);
          attachDecisionJournalResponse(journal, {
            httpAttempt: attempt,
            status: "valid",
            raw,
            parsed: response,
            choice: parsed,
            reason: response && response.reason
          });
          token.journalChoice = parsed;
          if (journal) {
            try { Object.defineProperty(parsed, "__llmJournal", { value: journal, enumerable: false, configurable: true }); } catch (e) { }
          }
          return parsed;
        }
        const invalidChoice = detail.error || { code: "invalid_choice", message: "模型没有返回合法选择" };
        attachDecisionJournalResponse(journal, {
          httpAttempt: attempt,
          status: invalidChoice.code || "invalid_choice",
          raw,
          parsed: response,
          choice: null,
          reason: response && response.reason || invalidChoice.message
        });
        finishDecisionJournal(journal, { outcome: "fallback", detail: "模型返回无法映射的选择，已直接交给原版 AI：" + invalidChoice.message });
        log("模型返回无法映射的选择，直接回落原版 AI（不会消耗 API 失败重试次数）: " + invalidChoice.message);
        return null;
      } catch (e) {
        if (token.cancelledByNewEvent || e.name === "StaleDecisionError") {
          finishDecisionJournal(journal, { outcome: "stale", detail: "模型返回前原游戏事件已结束，旧结果没有执行" });
          throw staleDecisionError();
        }
        if (isOriginalAIControlled(event.player) || token.cancelledByFastMode || token.cancelledBySpeedControl || e && e.expectedCancellation) {
          if (token.cancelReason === "player_original_ai_control") log("模型请求因该角色切换原版 AI 而正常取消，不计为报错");
          finishDecisionJournal(journal, { outcome: "fallback", detail: "控制权或速度要求变化，交给原版 AI" });
          return null;
        }
        lastFailure = e && e.llmTimedOut ? "达到绝对时间上限 " + cfg.timeout + " 秒" : String(e && e.message || e);
        if (!retryableLLMError(e)) {
          log("模型请求为不可重试错误，立即回落原版 AI: " + lastFailure);
          break;
        }
        log("模型第 " + attempt + "/" + maxAttempts + " 次请求失败: " + lastFailure);
      }
      if (attempt < maxAttempts && Date.now() < deadlineAt) {
        log("仍在同一绝对时间预算内，准备第 " + (attempt + 1) + " 次完整模型请求");
      }
    }
    const timeoutFailure = Date.now() >= deadlineAt;
    const fallbackDetail = timeoutFailure
      ? "达到绝对时间上限 " + cfg.timeout + " 秒，已取消模型请求并交给原版 AI"
      : "模型累计失败 " + attemptsSent + " 次（含首次请求），已停止重试并交给原版 AI；最后原因：" + lastFailure;
    finishDecisionJournal(journal, { outcome: "fallback", detail: fallbackDetail });
    log(fallbackDetail);
    return null;
  } finally {
    if (activeDecision === token) activeDecision = null;
    if (uiTimer) clearInterval(uiTimer);
    try { if (thinkingMarked) thinkingMarked.classList.remove("llm-thinking"); } catch (e) { }
  }
}

function selectionContains(collection, item) {
  try { return collection.includes(item) || (typeof collection.contains === "function" && collection.contains(item)); } catch (e) { return false; }
}

function doSelectCard(card) {
  card.classList.add("selected");
  ui.selected.cards.add(card);
  const checked = game.check();
  return { selected: selectionContains(ui.selected.cards, card), checked };
}

function doSelectTarget(t) {
  t.classList.add("selected");
  ui.selected.targets.add(t);
  const checked = game.check();
  return { selected: selectionContains(ui.selected.targets, t), checked };
}

function doSelectButton(b) {
  b.classList.add("selected");
  ui.selected.buttons.add(b);
  const checked = game.check();
  return { selected: selectionContains(ui.selected.buttons, b), checked };
}

function selectionCollection(type) {
  return type === "card" ? ui.selected.cards : type === "target" ? ui.selected.targets : ui.selected.buttons;
}

function restoreSelectionBaseline(type, baseline, touched) {
  const collection = selectionCollection(type);
  const affected = new Set([].concat(baseline || [], touched || [], Array.from(collection || [])));
  affected.forEach(item => { try { item.classList.remove("selected"); } catch (e) { } });
  try { collection.splice(0, collection.length); } catch (e) {
    try { collection.length = 0; } catch (ignored) { }
  }
  (baseline || []).forEach(item => {
    try { item.classList.add("selected"); } catch (e) { }
    try {
      if (typeof collection.add === "function") collection.add(item);
      else collection.push(item);
    } catch (e) { }
  });
  try { game.check(); } catch (e) { }
}

function captureSelectionTransaction() {
  return {
    card: Array.from(ui.selected.cards || []),
    target: Array.from(ui.selected.targets || []),
    button: Array.from(ui.selected.buttons || []),
    touched: []
  };
}

function restoreSelectionTransaction(transaction) {
  if (!transaction) return;
  const types = ["card", "target", "button"];
  const affected = new Set(transaction.touched || []);
  types.forEach(type => {
    const collection = selectionCollection(type);
    (transaction[type] || []).forEach(item => affected.add(item));
    Array.from(collection || []).forEach(item => affected.add(item));
  });
  affected.forEach(item => { try { item.classList.remove("selected"); } catch (e) { } });
  types.forEach(type => {
    const collection = selectionCollection(type);
    try { collection.splice(0, collection.length); } catch (e) { try { collection.length = 0; } catch (ignored) { } }
    (transaction[type] || []).forEach(item => {
      try { item.classList.add("selected"); } catch (e) { }
      try { typeof collection.add === "function" ? collection.add(item) : collection.push(item); } catch (e) { }
    });
  });
  try { game.check(); } catch (e) { }
}

function cardCompletionFor(event) {
  try { return event && pendingCardCompletions.get(event) || null; } catch (e) { return null; }
}

function deferCardCompletion(event, choice, journal) {
  if (!event || !["chooseToUse", "chooseToRespond", "chooseCardTarget"].includes(event.name)) return false;
  /* 只有确实存在后继目标槽时才延后结算。响应南蛮的一张杀、无目标牌以及技能入口
   * 不会再进入目标桥；过去在这里挂起会留下未完成日志和行动记忆。 */
  if (!event.filterTarget || !choice || choice.action === "skill") return false;
  const previous = cardCompletionFor(event);
  if (previous) settleCardCompletion(previous, "stale", "同一事件重新进入选牌槽，旧的未确认选择已作废");
  const receipt = { event, player: event.player, choice, journal, finished: false };
  pendingCardCompletions.set(event, receipt);
  livePendingCardCompletions.add(receipt);
  return true;
}

function settleCardCompletion(receipt, outcome, detail) {
  if (!receipt || receipt.finished) return;
  receipt.finished = true;
  try { pendingCardCompletions.delete(receipt.event); } catch (e) { }
  livePendingCardCompletions.delete(receipt);
  if (outcome === "applied") {
    rememberSuccessfulModelDecision(receipt.player, receipt.event, receipt.choice,
      receipt.choice && receipt.choice.__llmReason, receipt.journal);
    completeChoiceContinuations(receipt.player, receipt.event, receipt.choice);
  }
  finishDecisionJournal(receipt.journal, { outcome, detail, choice: receipt.choice });
}

function targetSelectionAlreadyComplete(event) {
  if (!event || !event.filterTarget) return false;
  try { return game.check() === true && (!event.filterOk || event.filterOk()); } catch (e) { return false; }
}

function emitDecisionSpeech(player, choice) {
  const speech = String(choice && choice.__llmSpeech || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!player || !speech) return;
  const name = makePlayerRef(player) || playerDisplayName(player) || "AI";
  rememberChat("assistant", playerMemoryKey(player), name, speech, {});
  addChatRecord(name, speech);
  try {
    if (typeof player.chat === "function") player.chat(speech);
    else lib.element.player.chat.call(player, speech);
  } catch (e) { }
}

function completeChoiceContinuations(player, event, choice) {
  if (!choice) return;
  if (choice.__llmSupersededRollingPlan) clearRollingPhasePlan(choice.__llmSupersededRollingPlan, "模型已根据当前合法候选修正剩余计划");
  const advance = choice.__llmRollingAdvance;
  if (advance && advance.plan) {
    let consumeCount = advance.consumeCount;
    /* 直接 viewAs/主动技能若同步让原版选择了代价牌，按稳定引用确认后一起消费，
     * 避免下一事件误把已经支付的代价再次当作独立牌。 */
    if (choice.action === "skill") {
      const costStep = advance.plan.steps[advance.plan.nextIndex + consumeCount];
      if (costStep && costStep.kind === "card") {
        const selected = Array.from(ui.selected.cards || []);
        const matched = selected.some(card => costStep.field === "cardIds"
          ? costStep.values.map(String).includes(candidateCardId(card))
          : costStep.field === "cardNames" && costStep.values.map(String).includes(String(card && card.name || "")));
        if (matched) consumeCount++;
      }
    }
    advanceRollingPhasePlan(advance.plan, consumeCount);
  }
  const actionPlan = choice.__llmActionPlan;
  if (actionPlan && Array.isArray(actionPlan.rollingSteps) && actionPlan.rollingSteps.length) {
    installRollingPhasePlan(player, event, actionPlan, choice,
      !!directiveStateForDecision(player,
        choice.action === "skill" || choice.action === "use" ? "card" : choice.action === "target" ? "target" : "button",
        event, []).text);
  }
  emitDecisionSpeech(player, choice);
}

async function plannedChoiceFromRollingPhase(type, event, candidates, check, range) {
  const plan = rollingPhasePlanFor(event && event.player);
  if (!plan || plan.suspendedEvent === event || !isActivePhaseUseDecision(event)) return null;
  while (plan.steps[plan.nextIndex] && plan.steps[plan.nextIndex].kind === "control") plan.nextIndex++;
  const first = plan.steps[plan.nextIndex];
  if (!first || !(first.kind === type || type === "card" && first.kind === "skill")) return null;
  let consumeCount = 1;
  const immediateSteps = [first];
  const next = plan.steps[plan.nextIndex + 1];
  if (next && next.kind === "target" && supportsDeferredSlotSequence(event, [first, next]) && !eventHasSelectionHooks(event)) {
    immediateSteps.push(next);
    consumeCount = 2;
  }
  const draft = { action: "execute", steps: immediateSteps, rollingSteps: [], allSteps: immediateSteps, nextIndex: 0, reason: plan.intent };
  const scores = evaluateOriginalAIScores(check, candidates);
  const detail = planChoiceForCurrentSlot(draft, type, candidates, event, range, scores);
  if (!detail.choice) {
    plan.lastFailure = detail.error && detail.error.message || "当前候选无法映射下一计划步骤";
    plan.suspendedEvent = event;
    return null;
  }
  if (immediateSteps.length > 1) attachActionPlan(detail.choice, draft);
  attachDecisionReason(detail.choice, "延续本回合既定行动方针");
  attachRollingPlanAdvance(detail.choice, plan, consumeCount);
  await waitForNaturalPlanPace();
  if (_status.event !== event || rollingPhasePlanFor(event.player) !== plan) throw staleDecisionError();
  log("按本体游戏速度间隔后续接本回合计划：" + immediateSteps.map(rollingStepText).join(" -> "));
  return detail.choice;
}

function pendingPlanFor(event) {
  try { return event && pendingActionPlans.get(event) || null; } catch (e) { return null; }
}

function clearPendingPlan(plan, outcome, detail, choice) {
  if (!plan || plan.finished) return;
  plan.finished = true;
  try { pendingActionPlans.delete(plan.event); } catch (e) { }
  livePendingActionPlans.delete(plan);
  finishDecisionJournal(plan.journal, { outcome, detail, choice: choice || plan.firstChoice || null });
}

function compositePendingPlanChoice(plan) {
  if (!plan) return null;
  const steps = [];
  if (plan.firstChoice) steps.push({
    kind: plan.firstType,
    action: plan.firstChoice.action,
    indices: Array.isArray(plan.firstChoice.indices) ? plan.firstChoice.indices.slice() : [],
    stableStep: plan.draft && plan.draft.steps && plan.draft.steps[0] || null
  });
  if (plan.finalChoice) steps.push({
    kind: "target",
    action: plan.finalChoice.action,
    indices: Array.isArray(plan.finalChoice.indices) ? plan.finalChoice.indices.slice() : [],
    stableStep: plan.finalStep || null
  });
  return { action: "execute", steps };
}

function createPendingPlan(event, type, check, choice, candidates, directiveOverride) {
  const draft = choice && choice.__llmActionPlan;
  if (!draft || !supportsDeferredSlotSequence(event, draft.steps) || eventHasSelectionHooks(event)) return null;
  if (type === "card" && choice.action === "skill") return null;
  const plan = {
    event,
    player: event.player,
    firstType: type,
    firstCheck: check,
    firstChoice: choice,
    draft,
    transaction: captureSelectionTransaction(),
    journal: choice.__llmJournal || null,
    directiveOverride: !!directiveOverride,
    finished: false
  };
  pendingActionPlans.set(event, plan);
  livePendingActionPlans.add(plan);
  return plan;
}

function liveCandidatesForSlot(type, event) {
  let candidates = selectableNow(type);
  const range = get.select(type === "card" ? event.selectCard : type === "target" ? event.selectTarget : event.selectButton);
  if (type === "target") {
    const ordered = buildOrderedTargetPlan(event, range, candidates);
    if (ordered) candidates = ordered.candidates;
  }
  return { candidates, range };
}

function plannedTargetStepMatchesAutoSelection(plan, step) {
  if (!plan || !step || step.kind !== "target") return false;
  const baseline = plan.transaction && plan.transaction.target || [];
  const selected = Array.from(ui.selected.targets || []).filter(target => !baseline.includes(target));
  if (selected.length !== step.values.length || !selected.length) return false;
  if (step.field === "targetIds") {
    return selected.every((target, index) => candidateTargetId(target) === String(step.values[index]));
  }
  if (step.field === "targetSeats") {
    return selected.every((target, index) => seatNumber(target) === Number(step.values[index]));
  }
  return false;
}

function consumePendingPlan(plan, type, check) {
  if (!plan || plan.finished || plan.event !== _status.event || plan.player !== plan.event.player) {
    return { ok: false, reason: "元计划事件已变化" };
  }
  const plannedStep = currentPlanStep(plan.draft);
  /* 部分牌由本体在选牌后自动选中目标。此时目标不再出现在 selectable 中，但计划已经满足。 */
  if (type === "target" && plannedTargetStepMatchesAutoSelection(plan, plannedStep)) {
    let finalOk = false;
    try { finalOk = game.check() === true && (!plan.event.filterOk || plan.event.filterOk()); } catch (e) { }
    if (finalOk) {
      plan.draft.nextIndex++;
      plan.finalChoice = { action: "target", indices: [], autoSelected: true };
      plan.finalStep = plannedStep;
      return { ok: true, choice: plan.finalChoice, autoSelected: true };
    }
  }
  const live = liveCandidatesForSlot(type, plan.event);
  const scores = evaluateOriginalAIScores(check, live.candidates);
  const detail = planChoiceForCurrentSlot(plan.draft, type, live.candidates, plan.event, live.range, scores);
  if (!detail.choice) return { ok: false, reason: detail.error && detail.error.message || "后继步骤无法映射" };
  const applied = applyChoice(type, detail.choice, live.candidates);
  if (applied !== true) return { ok: false, reason: "后继步骤在实时局面下不可执行" };
  let finalOk = false;
  try { finalOk = game.check() === true && (!plan.event.filterOk || plan.event.filterOk()); } catch (e) { }
  if (!finalOk) return { ok: false, reason: "完整计划未通过最终数量或filterOk校验" };
  plan.finalChoice = detail.choice;
  plan.finalStep = plannedStep || null;
  return { ok: true, choice: detail.choice };
}

function selectableNow(type) {
  try {
    if (type === "card") return get.selectableCards();
    if (type === "target") return get.selectableTargets();
    return get.selectableButtons();
  } catch (e) { return []; }
}

function applyChoice(type, choice, candidates) {
  if (!choice || choice.action === "skip") return choice && choice.action === "skip" ? false : null;
  if (choice.action === "skill") {
    try {
      ui.click.skill(candidates[choice.indices[0]]);
      return "skill";
    } catch (e) { return null; }
  }
  const baseline = Array.from(selectionCollection(type) || []);
  const touched = [];
  const orderedTarget = type === "target" && !!orderedTargetPlan(candidates);
  let lastCheckOk = null;
  try {
    for (let step = 0; step < choice.indices.length; step++) {
      const index = choice.indices[step];
      const item = candidates[index];
      const currentlyLegal = selectableNow(type);
      if (!selectionContains(currentlyLegal, item)) {
        if (orderedTarget) log("模型有序目标计划第 " + (step + 1) + " 项在此前缀下不可选，已撤销本次新增目标并回落原版 AI");
        restoreSelectionBaseline(type, baseline, touched);
        return null;
      }
      touched.push(item);
      const result = type === "card" ? doSelectCard(item) : type === "target" ? doSelectTarget(item) : doSelectButton(item);
      lastCheckOk = result && result.checked;
      if (!result || !result.selected) {
        restoreSelectionBaseline(type, baseline, touched);
        return null;
      }
    }
    /* 最后一项的 game.check() 同时验证动态数量范围与 event.filterOk；未通过时整单撤销。 */
    if (orderedTarget && lastCheckOk !== true) {
      log("模型有序目标计划尚未形成可确认的完整选择，已撤销本次新增目标并回落原版 AI");
      restoreSelectionBaseline(type, baseline, touched);
      return null;
    }
    return true;
  } catch (e) {
    restoreSelectionBaseline(type, baseline, touched);
    log("应用模型选择时发生异常，已恢复选择前状态并回落原版 AI: " + String(e && e.message || e));
    return null;
  }
}

function editableElementFromEvent(event) {
  try {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    for (const node of path) {
      if (!node || node === document || node === window) continue;
      const tag = String(node.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable) return node;
    }
  } catch (e) { }
  return null;
}

function clearPointerResidueForTextInput() {
  let dirty = false;
  const clearValue = key => {
    try {
      if (_status[key]) dirty = true;
      _status[key] = false;
    } catch (e) { }
  };
  ["mousedown", "clicked", "dragged", "mouseleft"].forEach(clearValue);
  ["mousedragging", "mousedragorigin", "dragstatuschanged"].forEach(key => {
    try {
      if (_status[key]) dirty = true;
      _status[key] = null;
    } catch (e) { }
  });
  ["selectionfull", "touchnocheck"].forEach(clearValue);
  ["draggingdialog", "draggingtouchdialog", "draggingroundmenu"].forEach(key => {
    try {
      if (_status[key]) dirty = true;
      delete _status[key];
    } catch (e) { }
  });
  try {
    if (ui.arena && ui.arena.classList.contains("dragging")) dirty = true;
    if (ui.arena) ui.arena.classList.remove("dragging");
  } catch (e) { }
  try {
    if (Array.isArray(_status.lastdragchange) && _status.lastdragchange.length) dirty = true;
    if (Array.isArray(_status.lastdragchange)) _status.lastdragchange.length = 0;
  } catch (e) { }
  try {
    if (Array.isArray(ui.touchlines) && ui.touchlines.length) dirty = true;
    while (Array.isArray(ui.touchlines) && ui.touchlines.length) {
      const line = ui.touchlines.shift();
      try { if (line && typeof line.delete === "function") line.delete(); } catch (e) { }
    }
  } catch (e) { }
  try {
    [document.documentElement, document.body].forEach(node => {
      if (node && node.classList) node.classList.remove("dragging");
    });
  } catch (e) { }
  ["force", "clicked2", "justdragged", "clickedplayer", "_swipeorigin"].forEach(key => {
    try {
      if (_status[key]) dirty = true;
      delete _status[key];
    } catch (e) {
      try { _status[key] = null; } catch (e2) { }
    }
  });
  return dirty;
}

function isEditableNode(node) {
  if (!node || node === document || node === window) return false;
  const tag = String(node.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || !!node.isContentEditable;
}

function focusEditableNode(node) {
  if (!isEditableNode(node) || !document.contains(node) || typeof node.focus !== "function") return;
  try { node.focus({ preventScroll: true }); } catch (e) { try { node.focus(); } catch (e2) { } }
}

function scheduleTextInputRecovery(preferred) {
  const editable = isEditableNode(preferred) ? preferred : null;
  [0, 40, 160].forEach((delay, index) => {
    setTimeout(() => {
      clearPointerResidueForTextInput();
      scanEditableElements(document);
      if (index === 0 && editable) focusEditableNode(editable);
    }, delay);
  });
}

function showExtensionNotice(message, kind, durationMs) {
  try {
    clearPointerResidueForTextInput();
    const parent = document.body || document.documentElement;
    if (!parent) {
      console.log("[大模型AI] " + String(message || ""));
      return null;
    }
    let host = document.getElementById("llm-ai-notice-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "llm-ai-notice-host";
      host.style.cssText = "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:1000002;width:min(520px,90vw);display:flex;flex-direction:column;gap:6px;pointer-events:none;";
      parent.appendChild(host);
    }
    const notice = document.createElement("div");
    const color = kind === "error" ? "#b43a35" : kind === "warning" ? "#a36b16" : kind === "success" ? "#2f7a4f" : "#3d4652";
    notice.style.cssText = "position:relative;width:100%;padding:9px 34px 9px 12px;background:" + color + ";color:#fff;border:1px solid rgba(255,255,255,.32);border-radius:4px;box-shadow:0 3px 12px rgba(0,0,0,.35);font:13px/1.45 sans-serif;white-space:pre-wrap;word-break:break-word;pointer-events:auto;";
    notice.textContent = String(message || "");
    const close = document.createElement("button");
    close.type = "button";
    close.title = "关闭";
    close.textContent = "×";
    close.style.cssText = "position:absolute;right:7px;top:5px;width:22px;height:22px;padding:0;border:0;background:transparent;color:#fff;font:18px/22px sans-serif;cursor:pointer;";
    const remove = () => { try { notice.remove(); if (!host.childNodes.length) host.remove(); } catch (e) { } };
    close.onclick = event => { event.stopPropagation(); clearPointerResidueForTextInput(); remove(); };
    ["mousedown", "mouseup", "touchstart", "touchend"].forEach(name => notice.addEventListener(name, event => {
      clearPointerResidueForTextInput();
      event.stopPropagation();
    }, name.startsWith("touch") ? { passive: true } : false));
    notice.appendChild(close);
    host.appendChild(notice);
    setTimeout(remove, Math.max(1800, Number(durationMs) || (kind === "error" || kind === "warning" ? 9000 : 4200)));
    scheduleTextInputRecovery(document.activeElement);
    return notice;
  } catch (e) {
    console.log("[大模型AI] 提示显示失败: " + e.message + "；原消息: " + message);
    return null;
  }
}

function showExtensionConfirm(message, onConfirm) {
  try {
    const old = document.getElementById("llm-ai-confirm-dialog");
    if (old && typeof old._llmClose === "function") old._llmClose(false);
    const previousActive = isEditableNode(document.activeElement) ? document.activeElement : null;
    clearPointerResidueForTextInput();
    const overlay = document.createElement("div");
    overlay.id = "llm-ai-confirm-dialog";
    overlay.tabIndex = -1;
    overlay.style.cssText = "position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;";
    const panel = document.createElement("div");
    panel.style.cssText = "position:relative;width:min(420px,88vw);padding:16px;background:#222;color:#eee;border:1px solid #777;border-radius:6px;font:14px/1.5 sans-serif;";
    const text = document.createElement("div");
    text.style.cssText = "position:relative;white-space:pre-wrap;word-break:break-word;";
    text.textContent = String(message || "");
    const row = document.createElement("div");
    row.style.cssText = "position:relative;display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.textContent = "确认";
    [cancel, confirmButton].forEach(button => {
      button.style.cssText = "position:relative;min-width:64px;height:32px;padding:0 12px;border:1px solid #777;border-radius:4px;background:#333;color:#fff;cursor:pointer;";
    });
    confirmButton.style.background = "#9f332f";
    let closed = false;
    const close = confirmed => {
      if (closed) return;
      closed = true;
      try { overlay.remove(); } catch (e) { }
      clearPointerResidueForTextInput();
      if (confirmed && typeof onConfirm === "function") {
        try { onConfirm(); } catch (e) { log("确认操作失败: " + e.message); showExtensionNotice("操作失败\n" + e.message, "error"); }
      }
      scheduleTextInputRecovery(previousActive);
    };
    overlay._llmClose = close;
    cancel.onclick = event => { event.stopPropagation(); close(false); };
    confirmButton.onclick = event => { event.stopPropagation(); close(true); };
    overlay.onclick = event => { event.stopPropagation(); if (event.target === overlay) close(false); };
    overlay.onkeydown = event => {
      event.stopPropagation();
      if (event.key === "Escape") close(false);
      else if (event.key === "Enter") close(true);
    };
    ["mousedown", "mouseup", "touchstart", "touchend"].forEach(name => overlay.addEventListener(name, event => {
      clearPointerResidueForTextInput();
      event.stopPropagation();
    }, name.startsWith("touch") ? { passive: true } : false));
    row.appendChild(cancel);
    row.appendChild(confirmButton);
    panel.appendChild(text);
    panel.appendChild(row);
    overlay.appendChild(panel);
    (document.body || document.documentElement).appendChild(overlay);
    try { overlay.focus({ preventScroll: true }); } catch (e) { overlay.focus(); }
    return overlay;
  } catch (e) {
    log("自定义确认框创建失败: " + e.message);
    showExtensionNotice("无法打开确认框\n" + e.message, "error");
    return null;
  }
}

function installNativeModalFocusGuard() {
  if (window._llmNativeModalFocusGuard) return;
  const guard = {};
  ["alert", "confirm", "prompt"].forEach(name => {
    try {
      const original = window[name];
      if (typeof original !== "function") return;
      const wrapped = function (...args) {
        const preferred = isEditableNode(document.activeElement) ? document.activeElement : null;
        try { return original.apply(this, args); }
        finally { scheduleTextInputRecovery(preferred); }
      };
      window[name] = wrapped;
      guard[name] = { original, wrapped };
    } catch (e) { }
  });
  window._llmNativeModalFocusGuard = guard;
}

function uninstallNativeModalFocusGuard() {
  const guard = window._llmNativeModalFocusGuard;
  if (!guard) return;
  Object.keys(guard).forEach(name => {
    try { if (window[name] === guard[name].wrapped) window[name] = guard[name].original; } catch (e) { }
  });
  window._llmNativeModalFocusGuard = null;
}

function installCoreEditableEventGuard() {
  if (window._llmCoreEditableEventGuard || !ui.click) return;
  const guard = { touchscreen: !!lib.config.touchscreen, originals: {}, wrappers: {} };
  const wrap = name => {
    const original = ui.click[name];
    if (typeof original !== "function") return;
    const wrapped = function (event) {
      const editable = editableElementFromEvent(event);
      if (editable) {
        clearPointerResidueForTextInput();
        protectEditableElement(editable);
        return;
      }
      return original.call(ui.click, event);
    };
    guard.originals[name] = original;
    guard.wrappers[name] = wrapped;
    document.removeEventListener(name === "windowmousedown" ? "mousedown" : name === "windowmouseup" ? "mouseup" : name === "windowtouchstart" ? "touchstart" : name === "windowtouchmove" ? "touchmove" : "touchend", original);
    document.addEventListener(name === "windowmousedown" ? "mousedown" : name === "windowmouseup" ? "mouseup" : name === "windowtouchstart" ? "touchstart" : name === "windowtouchmove" ? "touchmove" : "touchend", wrapped);
  };
  if (guard.touchscreen) {
    wrap("windowtouchstart");
    wrap("windowtouchmove");
    wrap("windowtouchend");
  } else {
    wrap("windowmousedown");
    wrap("windowmouseup");
  }
  window._llmCoreEditableEventGuard = guard;
}

function uninstallCoreEditableEventGuard() {
  const guard = window._llmCoreEditableEventGuard;
  if (!guard) return;
  const eventName = name => name === "windowmousedown" ? "mousedown" : name === "windowmouseup" ? "mouseup" : name === "windowtouchstart" ? "touchstart" : name === "windowtouchmove" ? "touchmove" : "touchend";
  Object.keys(guard.wrappers).forEach(name => {
    try { document.removeEventListener(eventName(name), guard.wrappers[name]); } catch (e) { }
    try { document.addEventListener(eventName(name), guard.originals[name]); } catch (e) { }
  });
  window._llmCoreEditableEventGuard = null;
}

/* 游戏把 document 的 mousedown 当作拖牌/拖动弹窗入口。文本控件绕过该入口，
 * 防止 AI 异步选择留下的鼠标状态吞掉焦点；不阻止 click、input 和 keydown。 */
function protectEditableElement(node) {
  if (!node || node._llmEditableGuard) return;
  const tag = String(node.tagName || "").toLowerCase();
  if (tag !== "input" && tag !== "textarea" && tag !== "select" && !node.isContentEditable) return;
  const stopPointer = event => {
    clearPointerResidueForTextInput();
    event.stopPropagation();
  };
  const stopKey = event => event.stopPropagation();
  const onFocus = () => clearPointerResidueForTextInput();
  node.addEventListener("mousedown", stopPointer);
  node.addEventListener("mouseup", stopPointer);
  node.addEventListener("click", stopPointer);
  node.addEventListener("touchstart", stopPointer, { passive: true });
  node.addEventListener("touchend", stopPointer, { passive: true });
  node.addEventListener("keydown", stopKey);
  node.addEventListener("keyup", stopKey);
  node.addEventListener("focus", onFocus);
  node._llmEditableGuard = { stopPointer, stopKey, onFocus };
}

function scanEditableElements(root) {
  try {
    if (root && root.nodeType === 1) protectEditableElement(root);
    const nodes = (root || document).querySelectorAll("input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only']");
    nodes.forEach(protectEditableElement);
  } catch (e) { }
}

function installEditableFocusGuard() {
  if (window._llmEditableFocusGuard) return;
  scanEditableElements(document);
  const observer = new MutationObserver(records => {
    records.forEach(record => {
      if (record.type === "attributes") scanEditableElements(record.target);
      else record.addedNodes.forEach(node => scanEditableElements(node));
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["contenteditable"] });
  const onFocusIn = event => {
    const editable = editableElementFromEvent(event);
    if (!editable) return;
    clearPointerResidueForTextInput();
    protectEditableElement(editable);
  };
  const onWindowFocus = () => scheduleTextInputRecovery(document.activeElement);
  const onVisibility = () => { if (!document.hidden) scheduleTextInputRecovery(document.activeElement); };
  document.addEventListener("focusin", onFocusIn, true);
  window.addEventListener("focus", onWindowFocus, true);
  document.addEventListener("visibilitychange", onVisibility, true);
  installNativeModalFocusGuard();
  window._llmEditableFocusGuard = { observer, onFocusIn, onWindowFocus, onVisibility };
}

function uninstallEditableFocusGuard() {
  const guard = window._llmEditableFocusGuard;
  if (!guard) return;
  try { guard.observer.disconnect(); } catch (e) { }
  try { document.removeEventListener("focusin", guard.onFocusIn, true); } catch (e) { }
  try { window.removeEventListener("focus", guard.onWindowFocus, true); } catch (e) { }
  try { document.removeEventListener("visibilitychange", guard.onVisibility, true); } catch (e) { }
  try {
    document.querySelectorAll("input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only']").forEach(node => {
      const handlers = node._llmEditableGuard;
      if (!handlers) return;
      node.removeEventListener("mousedown", handlers.stopPointer);
      node.removeEventListener("mouseup", handlers.stopPointer);
      node.removeEventListener("click", handlers.stopPointer);
      node.removeEventListener("touchstart", handlers.stopPointer);
      node.removeEventListener("touchend", handlers.stopPointer);
      node.removeEventListener("keydown", handlers.stopKey);
      node.removeEventListener("keyup", handlers.stopKey);
      node.removeEventListener("focus", handlers.onFocus);
      delete node._llmEditableGuard;
    });
  } catch (e) { }
  uninstallNativeModalFocusGuard();
  window._llmEditableFocusGuard = null;
}

function beginAIDecisionUI(event) {
  const state = { event: event, ended: false, tries: 0, thinkingPlayer: null, thinkingLabel: null, thinkingTimer: null, thinkingStartedAt: Date.now() };
  /* 思考提示只说明请求仍在运行，不改变本体武将、牌、按钮的高光或视觉特效。 */
  try {
    const player = event && event.player;
    if (player && player.classList) {
      const previous = activeThinkingUIByPlayer.get(player);
      if (previous && previous !== state) {
        try { if (previous.thinkingTimer) clearInterval(previous.thinkingTimer); } catch (e) { }
        previous.thinkingTimer = null;
        try { if (previous.thinkingLabel) previous.thinkingLabel.remove(); } catch (e) { }
        previous.thinkingLabel = null;
      }
      state.thinkingPlayer = player;
      activeThinkingUIByPlayer.set(player, state);
      player.classList.add("llm-ai-thinking");
      if (player.querySelectorAll) player.querySelectorAll(":scope > .llm-ai-thinking-label").forEach(old => old.remove());
      const label = document.createElement("div");
      label.className = "llm-ai-thinking-label";
      label.setAttribute("aria-label", "大模型 AI 正在思考");
      const text = document.createElement("span");
      text.className = "llm-ai-thinking-text";
      text.textContent = "AI 思考中 0秒";
      const dots = document.createElement("span");
      dots.className = "llm-ai-thinking-dots";
      dots.textContent = "···";
      label.appendChild(text);
      label.appendChild(dots);
      player.appendChild(label);
      state.thinkingLabel = label;
      let dotStep = 0;
      state.thinkingTimer = setInterval(() => {
        try {
          if (state.ended || !label.isConnected) return;
          const seconds = Math.max(0, Math.floor((Date.now() - state.thinkingStartedAt) / 1000));
          text.textContent = "AI 思考中 " + seconds + "秒";
          dotStep = (dotStep + 1) % 4;
          dots.textContent = "·".repeat(dotStep || 3);
        } catch (e) { }
      }, 500);
    }
  } catch (e) { }
  return state;
}

function finishAIDecisionUI(state) {
  if (!state || state.ended) return;
  const finish = () => {
    if (state.ended) return;
    /* await 返回后核心还要执行 ui.click.ok/cancel；只延后思考标签收尾，
     * 不添加任何遮罩，也不改写本体的 selected/selectable/高光样式。 */
    if (_status.event === state.event && state.event && state.event.result === "ai" && state.tries++ < 60) {
      setTimeout(finish, 16);
      return;
    }
    state.ended = true;
    const thinkingPlayer = state.thinkingPlayer || state.event && state.event.player;
    let ownsCurrentPlayerUI = false;
    try { ownsCurrentPlayerUI = !!thinkingPlayer && activeThinkingUIByPlayer.get(thinkingPlayer) === state; } catch (e) { }
    if (ownsCurrentPlayerUI) {
      try { activeThinkingUIByPlayer.delete(thinkingPlayer); } catch (e) { }
      try { thinkingPlayer.classList.remove("llm-ai-thinking"); } catch (e) { }
    }
    try { if (state.thinkingTimer) clearInterval(state.thinkingTimer); } catch (e) { }
    state.thinkingTimer = null;
    try { if (state.thinkingLabel) state.thinkingLabel.remove(); } catch (e) { }
    state.thinkingLabel = null;
    let mine = false;
    try { mine = !!(_status.event && _status.event.isMine && _status.event.isMine()); } catch (e) { }
    if (!mine && clearPointerResidueForTextInput()) {
      log("[决策收尾] 已清除 AI 事件后的鼠标拖动残留");
    }
  };
  setTimeout(finish, 0);
}

function injectCSS() {
  try {
    try { document.getElementById("llm-ai-css")?.remove(); } catch (e) { }
    /* 清理由旧版特效屏蔽留下的标记，不触碰本体自身的 selected/selectable/glow_phase。 */
    try {
      document.documentElement.classList.remove("llm-ai-deciding", "llm-ai-phase");
      if (ui.arena) ui.arena.classList.remove("llm-ai-deciding", "llm-ai-phase");
      document.querySelectorAll(".llm-ai-actor,.llm-ai-phase-actor,.llm-ai-no-fx").forEach(node =>
        node.classList.remove("llm-ai-actor", "llm-ai-phase-actor", "llm-ai-no-fx"));
    } catch (e) { }
    const style = document.createElement("style");
    style.id = "llm-ai-css";
    style.textContent =
      "#arena .player>.llm-ai-thinking-label{position:absolute!important;left:50%!important;top:-22px!important;transform:translateX(-50%)!important;z-index:99!important;display:flex!important;align-items:center!important;justify-content:center!important;flex-wrap:nowrap!important;width:max-content!important;min-width:116px!important;max-width:none!important;height:20px!important;padding:0 8px!important;box-sizing:border-box!important;overflow:visible!important;border:1px solid rgba(255,222,126,.9)!important;border-radius:10px!important;background:linear-gradient(180deg,rgba(68,45,20,.97),rgba(35,24,13,.97))!important;box-shadow:0 0 9px rgba(255,190,70,.72),inset 0 0 4px rgba(255,245,205,.18)!important;color:#ffe8a3!important;text-shadow:0 1px 1px #000!important;text-align:center!important;white-space:nowrap!important;word-break:keep-all!important;pointer-events:none!important;font:bold 11px/18px 'Microsoft YaHei',sans-serif!important;opacity:1!important;filter:none!important;animation:none!important;transition:none!important;}" +
      "#arena .player>.llm-ai-thinking-label .llm-ai-thinking-text,#arena .player>.llm-ai-thinking-label .llm-ai-thinking-dots{display:block!important;position:static!important;flex:0 0 auto!important;white-space:nowrap!important;word-break:keep-all!important;color:#ffe8a3!important;background:none!important;opacity:1!important;filter:none!important;transform:none!important;animation:none!important;transition:none!important;vertical-align:middle!important;}" +
      "#arena .player>.llm-ai-thinking-label .llm-ai-thinking-dots{width:18px!important;text-align:left!important;margin-left:2px!important;}" +
      "input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only']{pointer-events:auto!important;user-select:text!important;-webkit-user-select:text!important;caret-color:currentColor!important;}" +
      "#llm-ai-chatbox,#llm-ai-chatbox *{box-sizing:border-box;}" +
      "#llm-ai-chatbox{overflow:visible;transition:none !important;}" +
      "#llm-ai-chatbox div{position:relative;display:block;transition:none;}";
    document.head.appendChild(style);
  } catch (e) {
    log("注入CSS失败: " + e);
  }
}

function savedRuntimeConfig() {
  const result = {};
  CONFIG_KEYS.forEach(key => {
    try {
      const value = game.getExtensionConfig(EXT_NAME, key);
      if (value !== undefined) result[key] = value;
    } catch (e) { }
  });
  return result;
}

function saveTextSetting(key, event, fallback) {
  const node = event && event.target;
  const value = String(node && (node.innerText || node.textContent) || fallback || "").trim();
  if (node) node.innerText = value;
  game.saveExtensionConfig(EXT_NAME, key, value);
  loadConfig(savedRuntimeConfig());
}

function saveBoundedNumberSetting(key, event, fallback, min, max) {
  const node = event && event.target;
  const raw = String(node && (node.innerText || node.textContent) || "").trim();
  const parsed = Number(raw);
  const fallbackNumber = Number(fallback);
  const value = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallbackNumber;
  const normalized = String(value);
  if (node) node.innerText = normalized;
  game.saveExtensionConfig(EXT_NAME, key, normalized);
  loadConfig(savedRuntimeConfig());
}

function saveDecisionLogRetentionSetting(event) {
  const node = event && event.target;
  const raw = String(node && (node.innerText || node.textContent) || "").trim();
  const parsed = Number(raw);
  const value = Math.min(9999, Math.max(1, Math.floor(Number.isFinite(parsed) ? parsed : DEFAULT_CONFIG.decisionLogRetention)));
  if (node) node.innerText = String(value);
  game.saveExtensionConfig(EXT_NAME, "decisionLogRetention", String(value));
  loadConfig(savedRuntimeConfig());
  pruneDecisionJournalArchives(cfg.decisionLogRetention);
}

function serializableExtensionSettings() {
  const result = {};
  const before = cfg;
  try {
    /* 游戏菜单可能刚保存了新值、但运行时 cfg 尚未重载；以游戏存储为优先，
     * 再复用 coerceConfig 把 contenteditable 保存的数值字符串规范成数字。 */
    cfg = Object.assign({}, DEFAULT_CONFIG, before || {}, savedRuntimeConfig());
    coerceConfig();
    CONFIG_EXPORT_KEYS.forEach(key => {
      const value = cfg[key] !== undefined ? cfg[key] : DEFAULT_CONFIG[key];
      if (["string", "number", "boolean"].includes(typeof value)) result[key] = value;
    });
  } finally {
    cfg = before;
  }
  return result;
}

function configExportDocument() {
  return {
    schema: CONFIG_EXPORT_SCHEMA,
    schemaVersion: CONFIG_EXPORT_SCHEMA_VERSION,
    extensionVersion: EXT_VERSION,
    exportedAt: new Date().toISOString(),
    containsSecrets: false,
    note: "API Key、聊天、局内记忆、角色托管状态和日志均未导出",
    settings: serializableExtensionSettings()
  };
}

function safeConfigFilename() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
  return "大模型AI设置-" + stamp + ".json";
}

function exportExtensionSettings() {
  try {
    const data = JSON.stringify(configExportDocument(), null, 2) + "\n";
    const filename = safeConfigFilename();
    let savedPath = "";
    try {
      const electron = require("electron");
      let dialog = electron && electron.dialog;
      if (!dialog) {
        try { dialog = require("@electron/remote").dialog; } catch (e) { }
      }
      if (dialog && typeof dialog.showSaveDialogSync === "function") {
        savedPath = dialog.showSaveDialogSync({
          title: "导出大模型AI设置",
          defaultPath: path.join(DIR, filename),
          filters: [{ name: "JSON 配置", extensions: ["json"] }]
        }) || "";
        if (!savedPath) return;
        fs.writeFileSync(savedPath, data, "utf8");
      }
    } catch (e) { savedPath = ""; }
    if (!savedPath) {
      const blob = new Blob([data], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    showExtensionNotice("设置已导出。API Key、聊天、局内记忆和日志未包含在文件中。" +
      (savedPath ? "\n" + savedPath : ""), "success", 8000);
  } catch (e) {
    log("导出设置失败: " + e.message);
    showExtensionNotice("导出设置失败\n" + e.message, "error");
  }
}

function importedSettingsFromDocument(documentValue) {
  if (!documentValue || typeof documentValue !== "object" || Array.isArray(documentValue)) {
    throw new Error("配置文件顶层必须是 JSON 对象");
  }
  const wrapped = documentValue.schema !== undefined || documentValue.settings !== undefined;
  if (wrapped && documentValue.schema !== CONFIG_EXPORT_SCHEMA) throw new Error("不是大模型AI设置文件");
  if (wrapped && Number(documentValue.schemaVersion) > CONFIG_EXPORT_SCHEMA_VERSION) {
    throw new Error("配置版本过新，请先更新扩展");
  }
  const source = wrapped ? documentValue.settings : documentValue;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("settings 必须是 JSON 对象");
  const accepted = {};
  const ignored = [];
  Object.keys(source).forEach(key => {
    if (key === "apiKey") { ignored.push("apiKey（安全原因）"); return; }
    if (!CONFIG_EXPORT_KEYS.includes(key)) { ignored.push(key); return; }
    const expected = typeof DEFAULT_CONFIG[key];
    const value = source[key];
    if (expected === "boolean") {
      if (typeof value !== "boolean") { ignored.push(key + "（类型错误）"); return; }
    } else if (expected === "number") {
      if ((typeof value !== "number" && typeof value !== "string") || !Number.isFinite(Number(value))) {
        ignored.push(key + "（类型错误）"); return;
      }
    } else if (expected === "string" && typeof value !== "string") {
      ignored.push(key + "（类型错误）"); return;
    }
    accepted[key] = value;
  });
  if (!Object.keys(accepted).length) throw new Error("文件中没有可导入的有效设置");
  /* 复用现有 coerceConfig 做范围与枚举校验，但不让文件里的缺省值覆盖当前设置。 */
  const current = savedRuntimeConfig();
  const normalized = {};
  const before = cfg;
  try {
    cfg = Object.assign({}, DEFAULT_CONFIG, current, accepted);
    coerceConfig();
    Object.keys(accepted).forEach(key => { normalized[key] = cfg[key]; });
  } finally {
    cfg = before;
  }
  return { settings: normalized, ignored };
}

function applyImportedExtensionSettings(result) {
  const entries = Object.entries(result.settings || {});
  entries.forEach(([key, value]) => game.saveExtensionConfig(EXT_NAME, key, value));
  loadConfig(savedRuntimeConfig());
  const ignoredText = result.ignored && result.ignored.length ? "\n已忽略：" + result.ignored.join("、") : "";
  showExtensionNotice("已导入 " + entries.length + " 项设置，API Key 保持不变。游戏将重新加载以应用全部设置。" + ignoredText, "success", 9000);
  setTimeout(() => game.reload(), 500);
}

function readImportedSettingsFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const result = importedSettingsFromDocument(JSON.parse(String(reader.result || "")));
      const names = Object.keys(result.settings);
      const preview = names.slice(0, 12).join("、") + (names.length > 12 ? " 等" : "");
      showExtensionConfirm("将导入 " + names.length + " 项设置并重新加载游戏。\nAPI Key 不会被导入、删除或覆盖。\n\n设置：" + preview +
        (result.ignored.length ? "\n\n将忽略：" + result.ignored.join("、") : ""), () => applyImportedExtensionSettings(result));
    } catch (e) {
      log("解析导入设置失败: " + e.message);
      showExtensionNotice("导入设置失败\n" + e.message, "error");
    }
  };
  reader.onerror = () => showExtensionNotice("无法读取所选配置文件", "error");
  reader.readAsText(file, "utf-8");
}

function importExtensionSettings() {
  try {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files && input.files[0];
      input.remove();
      if (file) readImportedSettingsFile(file);
    };
    input.oncancel = () => input.remove();
    document.body.appendChild(input);
    input.click();
  } catch (e) {
    log("打开配置文件选择器失败: " + e.message);
    showExtensionNotice("无法打开配置文件选择器\n" + e.message, "error");
  }
}

function openAPIKeyDialog() {
  const old = document.getElementById("llm-ai-key-dialog");
  if (old && typeof old._llmClose === "function") old._llmClose();
  else if (old) old.remove();
  const previousActive = isEditableNode(document.activeElement) ? document.activeElement : null;
  clearPointerResidueForTextInput();
  const overlay = document.createElement("div");
  overlay.id = "llm-ai-key-dialog";
  overlay.style.cssText = "position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.68);display:flex;align-items:center;justify-content:center;";
  const panel = document.createElement("div");
  panel.style.cssText = "position:relative;display:block;width:min(440px,88vw);padding:18px;background:#222;color:#eee;border:1px solid #777;border-radius:6px;font:14px/1.5 sans-serif;";
  const title = document.createElement("div");
  title.style.cssText = "position:relative;display:block;font-weight:bold;margin-bottom:12px;";
  title.textContent = "API Key";
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "输入 API Key";
  try { input.value = String(game.getExtensionConfig(EXT_NAME, "apiKey") || ""); } catch (e) { }
  input.style.cssText = "position:relative;display:block;width:100%;height:36px;padding:6px 9px;background:#111;color:#fff;border:1px solid #666;border-radius:4px;outline:none;";
  const row = document.createElement("div");
  row.style.cssText = "position:relative;display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "保存";
  [cancel, save].forEach(button => { button.style.cssText = "position:relative;padding:6px 14px;border:1px solid #777;border-radius:4px;background:#333;color:#fff;cursor:pointer;"; });
  const close = () => {
    try { overlay.remove(); } catch (e) { }
    clearPointerResidueForTextInput();
    scheduleTextInputRecovery(previousActive);
  };
  overlay._llmClose = close;
  cancel.onclick = event => { event.stopPropagation(); close(); };
  save.onclick = () => {
    const hasKey = !!input.value.trim();
    game.saveExtensionConfig(EXT_NAME, "apiKey", input.value.trim());
    loadConfig(savedRuntimeConfig());
    close();
    showExtensionNotice(hasKey ? "API Key 已保存" : "API Key 已清空", "success");
  };
  overlay.onclick = event => { event.stopPropagation(); if (event.target === overlay) close(); };
  ["mousedown", "mouseup", "touchstart", "touchend"].forEach(name => overlay.addEventListener(name, event => {
    clearPointerResidueForTextInput();
    event.stopPropagation();
  }, name.startsWith("touch") ? { passive: true } : false));
  input.onkeydown = event => {
    event.stopPropagation();
    if (event.key === "Enter") save.click();
    if (event.key === "Escape") cancel.click();
  };
  row.appendChild(cancel);
  row.appendChild(save);
  panel.appendChild(title);
  panel.appendChild(input);
  panel.appendChild(row);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  protectEditableElement(input);
  input.focus();
}

async function testConnection() {
  loadConfig(savedRuntimeConfig());
  try {
    const raw = await callLLM([
      { role: "system", content: "只输出严格 JSON。" },
      { role: "user", content: "这是连接测试。请输出 {\"ok\":true,\"message\":\"连接正常\"}" }
    ], { json: true, temperature: 0, thinking: false, explicitThinkingDisabled: true, timeoutMs: 30000, retryCount: 1 });
    const result = parseJSONObject(raw);
    if (!result || result.ok !== true) throw new Error("接口可访问，但返回格式不符合预期: " + String(raw).slice(0, 100));
    showExtensionNotice("连接成功\n模型：" + cfg.model + "\n地址：" + chatCompletionURL(), "success", 6000);
  } catch (e) {
    showExtensionNotice("连接失败\n" + e.message + "\n\n请检查 API Key、URL、模型名及中转站兼容性。", "error");
  }
}

function patchRequiredCoreFiles() {
  let bridge;
  let animation;
  try {
    bridge = patchCoreForAsyncAI();
  } catch (e) {
    bridge = { ready: false, changed: false, warning: true, message: "检查决策桥接补丁失败: " + e.message };
  }
  try {
    animation = patchLineAnimationCleanup();
  } catch (e) {
    animation = { ready: false, changed: false, warning: true, message: "检查指示线兼容补丁失败: " + e.message };
  }
  return {
    bridge,
    animation,
    ready: !!bridge.ready,
    changed: !!(bridge.changed || animation.changed),
    warning: !!(bridge.warning || animation.warning || !bridge.ready && !bridge.changed),
    message: "决策桥接：" + bridge.message + "\n指示线兼容：" + animation.message
  };
}

function showCorePatchStatus() {
  const status = patchRequiredCoreFiles();
  corePatchReady = status.ready;
  if (status.changed) {
    console.log("[大模型AI] " + status.message.replace(/\n/g, "；") + "，正在自动重新加载");
    game.reload();
  } else {
    showExtensionNotice(status.message, status.warning ? "warning" : "success");
  }
}

function teardownExtensionRuntime() {
  cancelActiveDecisionForLifecycle("大模型AI已关闭或卸载，尚未完成的模型请求已取消，当前事件交还原版 AI");
  resetOriginalAIControl({ silent: true });
  try { delete globalThis[CORE_BRIDGE]; } catch (e) { globalThis[CORE_BRIDGE] = null; }
  uninstallCoreEditableEventGuard();
  uninstallEditableFocusGuard();
  try { document.getElementById("llm-ai-css")?.remove(); } catch (e) { }
  try {
    document.documentElement.classList.remove("llm-ai-deciding", "llm-ai-phase");
    if (ui.arena) ui.arena.classList.remove("llm-ai-deciding", "llm-ai-phase");
    document.querySelectorAll(".llm-ai-actor,.llm-ai-phase-actor,.llm-ai-no-fx").forEach(node =>
      node.classList.remove("llm-ai-actor", "llm-ai-phase-actor", "llm-ai-no-fx"));
  } catch (e) { }
  try {
    document.querySelectorAll("#arena .player.llm-ai-thinking").forEach(player => player.classList.remove("llm-ai-thinking"));
    document.querySelectorAll("#arena .llm-ai-thinking-label").forEach(label => label.remove());
  } catch (e) { }
  try { if (window._llmChatBox) window._llmChatBox.remove(); } catch (e) { }
  try { document.getElementById("llm-ai-key-dialog")?.remove(); } catch (e) { }
  try { document.getElementById("llm-ai-confirm-dialog")?.remove(); } catch (e) { }
  try { document.getElementById("llm-ai-notice-host")?.remove(); } catch (e) { }
  try {
    if (Array.isArray(lib.onover) && window._llmInGameMemoryReset) {
      const index = lib.onover.indexOf(window._llmInGameMemoryReset);
      if (index >= 0) lib.onover.splice(index, 1);
    }
    window._llmInGameMemoryReset = null;
  } catch (e) { }
  clearMemory();
}

function deactivateAndRestoreCore(action) {
  const results = [];
  try {
    try {
      results.push(restoreCoreOnRemove());
    } catch (e) {
      results.push({ restored: false, warning: true, message: "读取或还原 content.js 失败: " + e.message });
    }
    try {
      results.push(restoreLineAnimationOnRemove());
    } catch (e) {
      results.push({ restored: false, warning: true, message: "读取或还原 game/index.js 失败: " + e.message });
    }
  } finally {
    teardownExtensionRuntime();
  }
  const result = {
    restored: results.some(item => item && item.restored),
    warning: results.some(item => item && item.warning),
    message: results.map(item => item && item.message).filter(Boolean).join("\n")
  };
  if (result.warning) {
    showExtensionNotice("大模型AI已" + action + "，但本体源码未自动还原：\n" + result.message + "\n\n为避免覆盖更新后的本体，请根据备份手动核对。", "warning", 12000);
  } else if (result.restored) {
    showExtensionNotice(result.message + "。大模型接管已停止，当前游戏会立即回落原版AI。", "success", 7000);
  } else {
    console.log("[大模型AI] " + result.message);
  }
  return result;
}

game.import("extension", function () {
  return {
    name: EXT_NAME,
    editable: false,
    onremove: function () {
      deactivateAndRestoreCore("删除");
    },
    precontent: function (config) {
      loadConfig(config, {
        applyCapturedOriginalAITakeoverMigration: true,
        persistCapturedOriginalAITakeoverMigration: true,
        applyCapturedReasoningMigration: true,
        persistCapturedReasoningMigration: true
      });
      recoverStaleDecisionJournal();
      pruneDecisionJournalArchives(cfg.decisionLogRetention);
      const status = patchRequiredCoreFiles();
      corePatchReady = status.ready;
      log("本体补丁检查: " + status.message);
      if (status.changed) {
        setTimeout(() => {
          console.log("[大模型AI] 本体补丁已完成，正在自动重新加载");
          game.reload();
        }, 200);
      } else if (!status.ready && !window._llmCorePatchAlerted) {
        window._llmCorePatchAlerted = true;
        setTimeout(() => showExtensionNotice("大模型AI未接管游戏操作：\n" + status.message + "\n\n为避免卡局，当前会继续使用原版 AI。", "warning", 12000), 200);
      } else if (status.animation.warning && !window._llmAnimationPatchAlerted) {
        window._llmAnimationPatchAlerted = true;
        setTimeout(() => showExtensionNotice("大模型AI操作接管可用，但指示线兼容补丁未启用：\n" + status.animation.message, "warning", 10000), 200);
      }
    },
    content: function (config, pack) {
      loadConfig(config, { applyCapturedOriginalAITakeoverMigration: true, applyCapturedReasoningMigration: true });
      resetCognitiveRuntime();
      registerInGameMemoryReset();
      injectCSS();
      installCoreEditableEventGuard();
      installEditableFocusGuard();
      setupChatBox();
      log("扩展加载 v" + EXT_VERSION + "，原版AI事件托管=" + originalAITakeoverSummary(cfg) + "，model=" + cfg.model + "，局内记忆=" + memoryData.rules.length);
      log("聊天框已启用（@武将名·N号 可指定AI）");

      log("CSS 与输入保护已启用（保留本体武将、牌和按钮特效）");

      const origChooseCard = ai.basic.chooseCard;
      const origChooseTarget = ai.basic.chooseTarget;
      const origChooseButton = ai.basic.chooseButton;

      if (!corePatchReady) {
        try { delete globalThis[CORE_BRIDGE]; } catch (e) { globalThis[CORE_BRIDGE] = null; }
        log("本体补丁未就绪，未安装安全桥接，继续使用原版 AI");
        return;
      }

      const originals = { card: origChooseCard, target: origChooseTarget, button: origChooseButton };
      globalThis[CORE_BRIDGE] = async function (type, check, expectedEvent) {
        const original = originals[type];
        if (typeof original !== "function") throw new Error("未知 AI 选择类型: " + type);
        const event = expectedEvent;
        if (!event || _status.event !== event) throw staleDecisionError();
        const cardCompletion = cardCompletionFor(event);
        Array.from(livePendingCardCompletions).forEach(receipt => {
          if (!receipt || receipt.finished || receipt.event === event) return;
          settleCardCompletion(receipt, "stale", "原选择事件未进入预期的最终目标确认槽，未记为成功");
        });
        Array.from(livePendingActionPlans).forEach(oldPlan => {
          if (!oldPlan || oldPlan.finished || oldPlan.event === event) return;
          clearPendingPlan(oldPlan, "stale", "原事件在下一槽出现前已经结束，未完成的元计划已清理");
        });
        const pending = pendingPlanFor(event);
        if (pending && (isOriginalAIControlled(event.player) || shouldUseOriginalAIByEventCategory(event, type) || isHumanManualAutoPick(event))) {
          restoreSelectionTransaction(pending.transaction);
          clearPendingPlan(pending, "fallback", "两槽之间控制权发生变化，已撤销元计划并交回当前控制方式");
          const firstOriginal = originals[pending.firstType];
          const firstOk = typeof firstOriginal === "function" ? firstOriginal.call(ai.basic, pending.firstCheck) : false;
          if (!(firstOk || event.forced)) return false;
          return original.call(ai.basic, check);
        }
        if (pending) {
          const step = currentPlanStep(pending.draft);
          if (!step || step.kind !== type) {
            restoreSelectionTransaction(pending.transaction);
            clearPendingPlan(pending, "fallback", "引擎下一槽与元计划不一致，已撤销完整前缀并交回原版AI");
            const firstOriginal = originals[pending.firstType];
            const firstOk = typeof firstOriginal === "function" ? firstOriginal.call(ai.basic, pending.firstCheck) : false;
            if (!(firstOk || event.forced)) return false;
            return original.call(ai.basic, check);
          } else {
            const plannedTargetStep = step;
            const consumed = consumePendingPlan(pending, type, check);
            if (consumed.ok) {
              const compositeChoice = compositePendingPlanChoice(pending);
              rememberSuccessfulModelDecision(event.player, event, compositeChoice, pending.firstChoice && pending.firstChoice.__llmReason, pending.journal);
              completeChoiceContinuations(event.player, event, pending.firstChoice);
              clearPendingPlan(pending, "applied", "同一事件的牌/按钮与目标元计划已一次思考、逐槽校验并完整应用；目标步骤=" + JSON.stringify(plannedTargetStep), compositeChoice);
              return true;
            }
            restoreSelectionTransaction(pending.transaction);
            clearPendingPlan(pending, "fallback", "后继步骤失败，已撤销整次元计划并由原版AI从首槽重选：" + consumed.reason);
            const firstOriginal = originals[pending.firstType];
            const firstOk = typeof firstOriginal === "function" ? firstOriginal.call(ai.basic, pending.firstCheck) : false;
            if (!(firstOk || event.forced)) return false;
            return original.call(ai.basic, check);
          }
        }
        if (isOriginalAIControlled(event.player) || logOriginalAITakeover(event, type)) return original.call(ai.basic, check);
        if (isHumanManualAutoPick(event)) {
          log("真人角色或玩家界面 AI 代选立即使用同步原版 AI，避免托管切换产生过期异步选择");
          return original.call(ai.basic, check);
        }
        const decisionUI = beginAIDecisionUI(event);
        const fallback = () => {
          if (_status.event !== event) throw staleDecisionError();
          return original.call(ai.basic, check);
        };
        const finishAppliedChoice = applied => {
          if (applied === "skill") {
            const info = get.info(event.skill);
            if (info && info.filterCard) {
              const nestedCheck = info.check || get.unuseful2;
              log("已发动技能 " + safeTranslation(event.skill, event.skill) + "，交给原版 AI 完成技能所需选牌");
              return { handled: true, value: origChooseCard.call(ai.basic, nestedCheck) };
            }
            return { handled: true, value: true };
          }
          if (applied === true) return { handled: true, value: true };
          if (applied === false) return { handled: true, value: event.forced ? fallback() : false };
          return { handled: false, value: null };
        };
        let range = null;
        let candidates = null;
        let journal = null;
        let journalChoice = null;
        const finishJournal = (outcome, detail, choice) => {
          if (typeof finishDecisionJournal === "function") finishDecisionJournal(journal, {
            outcome,
            detail,
            choice: choice || journalChoice || null
          });
        };
        try {
          try {
            if (type === "card") {
              if (event.filterCard == void 0) return check() > 0;
              range = get.select(event.selectCard);
              candidates = get.selectableCards();
              if (!event.player._noSkill) {
                try { candidates = candidates.concat(get.skills()); } catch (e) { }
              }
            } else if (type === "target") {
              if (event.filterTarget == void 0) return check() > 0;
              range = get.select(event.selectTarget);
              candidates = get.selectableTargets();
              const targetPlan = buildOrderedTargetPlan(event, range, candidates);
              if (targetPlan) candidates = targetPlan.candidates;
            } else {
              range = get.select(event.selectButton);
              candidates = get.selectableButtons();
            }
            /* 选牌后由本体自动补齐目标（群体锦囊、装备自己等）时，目标桥无需再问模型或原AI。 */
            if (type === "target" && !candidates.length && targetSelectionAlreadyComplete(event)) {
              if (cardCompletion) settleCardCompletion(cardCompletion, "applied", "选牌后本体已自动完成目标并通过最终校验");
              return true;
            }
            if (!candidates.length) {
              if (cardCompletion) settleCardCompletion(cardCompletion, "fallback", "选牌后的目标槽没有形成可确认选择，已交回原版AI");
              return fallback();
            }
            /* 强制且无需战略判断的选择需要实际候选数才能识别，放在候选采集后再做一次分类。 */
            if (logOriginalAITakeover(event, type, range, candidates)) return fallback();
            let choice = await plannedChoiceFromRollingPhase(type, event, candidates, check, range);
            const rollingChoice = !!choice;
            if (!choice) choice = await askLLM(type, event, candidates, check, range);
            journalChoice = choice;
            journal = choice && choice.__llmJournal || null;
            if (_status.event !== event) throw staleDecisionError();
            if (isHumanManualAutoPick(event)) {
              log("等待期间真人控制状态已改变，丢弃模型结果并由同步原版 AI 完成本次选择");
              finishJournal("fallback", "模型返回前控制权已变为真人/托管流程，本次由原版 AI 完成");
              return fallback();
            }
            if (isOriginalAIControlled(event.player) || shouldUseOriginalAIByEventCategory(event, type, range, candidates)) {
              finishJournal("fallback", "等待期间控制方式切换为原版 AI 接管，模型结果已丢弃");
              return fallback();
            }
            const pendingDraft = choice && choice.__llmActionPlan;
            const pendingPlan = pendingDraft ? createPendingPlan(event, type, check, choice, candidates,
              !!directiveStateForDecision(event.player, type, event, candidates).text) : null;
            if (pendingDraft && !pendingPlan && pendingDraft.steps.length > 1) {
              finishJournal("fallback", "当前事件的多步元计划不属于可安全回滚的同事件原语，已交给原版AI");
              return fallback();
            }
            const applied = applyChoice(type, choice, candidates);
            if (pendingPlan) {
              if (applied === true) {
                (choice.indices || []).forEach(index => pendingPlan.transaction.touched.push(candidates[index]));
                log("已应用元计划首槽，等待同一事件的下一选择槽；不会再次请求模型");
                return true;
              }
              restoreSelectionTransaction(pendingPlan.transaction);
              clearPendingPlan(pendingPlan, "fallback", "元计划首槽未能执行，已恢复选择并交回原版AI");
              return fallback();
            }
            const finished = finishAppliedChoice(applied);
            if (finished.handled) {
              const skillCompleted = applied !== "skill" || finished.value === true || !!event.forced;
              const outcome = applied === false ? "skipped" : skillCompleted ? "applied" : "fallback";
              const detail = applied === "skill"
                ? skillCompleted ? "模型选择的技能及其同步代价选择已完成" : "技能入口已选择，但原版 AI 未能完成其同步代价，因此未记为成功"
                : applied === false ? "模型决定跳过本次可选操作" : "模型选择已成功应用到当前游戏事件";
              if (outcome === "applied" && type === "card" && deferCardCompletion(event, choice, journal)) {
                log("牌选择已应用，等待同一事件的目标槽及本体最终确认后再写入成功记忆");
                return finished.value;
              }
              if (outcome === "applied") {
                rememberSuccessfulModelDecision(event.player, event, choice, choice && choice.__llmReason, journal);
                if (type === "target" && cardCompletion) {
                  if (choice.__llmSpeech) {
                    try { Object.defineProperty(cardCompletion.choice, "__llmSpeech", { value: choice.__llmSpeech, enumerable: false, configurable: true }); }
                    catch (e) { cardCompletion.choice.__llmSpeech = choice.__llmSpeech; }
                  }
                  settleCardCompletion(cardCompletion, "applied", "牌与目标均已通过本体最终校验");
                } else {
                  completeChoiceContinuations(event.player, event, choice);
                }
              } else if (type === "target" && cardCompletion) {
                settleCardCompletion(cardCompletion, "fallback", "模型放弃或未完成目标，首槽不记为成功");
              }
              if (!rollingChoice || journal) finishJournal(outcome, detail, choice);
              return finished.value;
            }
            if (choice) log("LLM 选择未能落到当前事件，回落原版: " + JSON.stringify(choice) + " 事件:" + translateEventName(event.name));
            else log("LLM 决策不可用，回落原版 (" + translateEventName(event.name) + ")");
            finishJournal("fallback", choice ? "模型选择在执行前已不再合法，改由原版 AI" : "模型请求未取得可用结果，改由原版 AI");
            if (type === "target" && cardCompletion) settleCardCompletion(cardCompletion, "fallback", "目标选择未能应用，首槽不记为成功");
          } catch (e) {
            if (e && e.name === "StaleDecisionError") {
              log("已丢弃过期决策，禁止它操作后续事件");
              finishJournal("stale", "原游戏事件已结束，旧模型结果未执行");
              throw e;
            }
            log("LLM " + type + " 决策异常: " + e);
            finishJournal("fallback", "执行模型选择时发生异常，改由原版 AI：" + String(e && e.message || e));
          }
          return fallback();
        } finally {
          finishAIDecisionUI(decisionUI);
        }
      };
      log("AI 安全决策桥已启用 v" + EXT_VERSION + "；原版 ai.basic 保持同步，避免武将技能错位");
    },
    config: {
      enable: {
        name: "开启",
        init: true,
        restart: true,
        onswitch: function (enabled) {
          if (!enabled) deactivateAndRestoreCore("关闭");
        }
      },
      status: { name: "大模型AI v" + EXT_VERSION + "（所有设置均保存在游戏内）", clear: true, nopointer: true },
      apiKey: { name: "API Key（点击填写/更换，输入内容会隐藏）", clear: true, onclick: openAPIKeyDialog },
      configExport: { name: "<u>导出设置配置（不含 API Key）</u>", clear: true, onclick: exportExtensionSettings },
      configImport: { name: "<u>导入设置配置（不会覆盖 API Key）</u>", clear: true, onclick: importExtensionSettings },
      baseURL: {
        name: "API Base URL",
        init: DEFAULT_CONFIG.baseURL,
        input: true,
        onblur: function (event) { saveTextSetting("baseURL", event, DEFAULT_CONFIG.baseURL); }
      },
      model: {
        name: "模型名称",
        init: DEFAULT_CONFIG.model,
        input: true,
        onblur: function (event) { saveTextSetting("model", event, DEFAULT_CONFIG.model); }
      },
      temperature: {
        name: "Temperature（0-2，越高越随机）",
        init: String(DEFAULT_CONFIG.temperature),
        input: true,
        onblur: function (event) { saveBoundedNumberSetting("temperature", event, DEFAULT_CONFIG.temperature, 0, 2); }
      },
      topP: {
        name: "Top P（0.01-1，越低候选范围越集中）",
        init: String(DEFAULT_CONFIG.topP),
        input: true,
        onblur: function (event) { saveBoundedNumberSetting("topP", event, DEFAULT_CONFIG.topP, 0.01, 1); }
      },
      serverReasoningEffort: {
        name: "服务端推理档位",
        init: DEFAULT_CONFIG.serverReasoningEffort,
        item: { disabled: "关闭", low: "低", high: "高", max: "最高" }
      },
      promptThinkingDepth: {
        name: "提示词思考深度百分比（填写 1-100）",
        init: String(DEFAULT_CONFIG.promptThinkingDepth),
        input: true,
        onblur: function (event) { saveBoundedNumberSetting("promptThinkingDepth", event, DEFAULT_CONFIG.promptThinkingDepth, 1, 100); }
      },
      actionMaxTokens: {
        name: "行动决策最大输出 token（64-65536）",
        init: String(DEFAULT_CONFIG.actionMaxTokens),
        input: true,
        onblur: function (event) { saveBoundedNumberSetting("actionMaxTokens", event, DEFAULT_CONFIG.actionMaxTokens, 64, 65536); }
      },
      retryCount: {
        name: "失败后额外重试次数（0=只请求一次）",
        init: String(DEFAULT_CONFIG.retryCount),
        input: true,
        onblur: function (event) { saveBoundedNumberSetting("retryCount", event, DEFAULT_CONFIG.retryCount, 0, 100); }
      },
      decisionLog: {
        name: "自动记录并按局归档 AI 思考与决策日志",
        init: DEFAULT_CONFIG.decisionLog
      },
      decisionLogRetention: {
        name: "最多保留已归档对局日志份数（1-9999）",
        init: String(DEFAULT_CONFIG.decisionLogRetention),
        input: true,
        onblur: saveDecisionLogRetentionSetting
      },
      timelineMaxRecords: {
        name: "战局时间线最多保留条数（0=关闭，1-10000）",
        init: String(DEFAULT_CONFIG.timelineMaxRecords),
        input: true,
        onblur: function (event) {
          saveBoundedNumberSetting("timelineMaxRecords", event, DEFAULT_CONFIG.timelineMaxRecords, 0, 10000);
          try {
            if (gameTimelineStore && timelineRuntime) timelineRuntime.trimTimeline(gameTimelineStore, cfg.timelineMaxRecords);
          } catch (e) { }
        }
      },
      decisionLogOpen: { name: "<u>打开 AI 决策日志文件夹</u>", clear: true, onclick: openDecisionJournalFile },
      decisionLogClear: { name: "<u>清空当前及全部归档日志</u>", clear: true, onclick: clearDecisionJournalFile },
      timeout: {
        name: "单次行动绝对时间上限（秒，可填小数；到时交给原版 AI）",
        init: String(DEFAULT_CONFIG.timeout),
        input: true,
        onblur: function (event) { saveTextSetting("timeout", event, String(DEFAULT_CONFIG.timeout)); }
      },
      memoryPolicy: {
        name: "局内聊天允许",
        init: DEFAULT_CONFIG.memoryPolicy,
        item: { all: "所有 AI", friends: "仅友方 AI", enemies: "仅敌方 AI" }
      },
      originalAIProbability: {
        name: "普通选择交给原版 AI 的概率（0-100%，有聊天指令时不抽签）",
        init: String(DEFAULT_CONFIG.originalAIProbability),
        input: true,
        onblur: function (event) { saveBoundedNumberSetting("originalAIProbability", event, DEFAULT_CONFIG.originalAIProbability, 0, 100); }
      },
      aiSpeechProbability: {
        name: "AI 主动拟人发言概率（0-100%；仅操作成功后发言）",
        init: String(DEFAULT_CONFIG.aiSpeechProbability),
        input: true,
        onblur: function (event) { saveBoundedNumberSetting("aiSpeechProbability", event, DEFAULT_CONFIG.aiSpeechProbability, 0, 100); }
      },
      originalAIReferenceStrength: {
        name: "原版 AI 提示参考程度（0-100%；连续权重，无档位；不否决模型决定）",
        init: String(DEFAULT_CONFIG.originalAIReferenceStrength),
        input: true,
        onblur: function (event) { saveBoundedNumberSetting("originalAIReferenceStrength", event, DEFAULT_CONFIG.originalAIReferenceStrength, 0, 100); }
      },
      originalAITakeoverPlayPlan: {
        name: "原版 AI 托管：出牌规划（自己主动使用牌/技能及其目标链）",
        init: DEFAULT_CONFIG.originalAITakeoverPlayPlan,
        restart: true
      },
      originalAITakeoverTactical: {
        name: "原版 AI 托管：技能与战术选择（未归入其他类别的按钮/牌/目标）",
        init: DEFAULT_CONFIG.originalAITakeoverTactical,
        restart: true
      },
      originalAITakeoverResponse: {
        name: "原版 AI 托管：响应与救援（闪、无懈、濒死救援、被要求用牌等）",
        init: DEFAULT_CONFIG.originalAITakeoverResponse,
        restart: true
      },
      originalAITakeoverResource: {
        name: "原版 AI 托管：手牌与资源整理（弃牌、给牌、获得/弃置他人牌、移动牌）",
        init: DEFAULT_CONFIG.originalAITakeoverResource,
        restart: true
      },
      originalAITakeoverMechanical: {
        name: "原版 AI 托管：强制或机械选择（强制弃牌、唯一合法项、必须全选）",
        init: DEFAULT_CONFIG.originalAITakeoverMechanical,
        restart: true
      },
      chatBox: { name: "<u>打开/找回聊天框</u>", clear: true, onclick: openOrRestoreChatBox },
      test: { name: "<u>测试 API 连接</u>", clear: true, onclick: testConnection },
      memoryClear: {
        name: "<u>清空本局聊天与记忆</u>",
        clear: true,
        onclick: function () {
          showExtensionConfirm("确定清空全部局内记忆和最近对话吗？", () => {
            cancelActiveDecisionForLifecycle("玩家清空了局内认知，旧请求不会继续执行");
            clearMemory();
            showExtensionNotice("局内记忆已清空", "success");
          });
        }
      }
    },
    package: {
      intro: "<br><font color=cyan>扩展QQ群:122979614</font><br><img style=\"width:200px\" src=\"" + lib.assetURL + "extension/大模型AI/wdyd_QQqun.jpg\">",
      author: "千里南鲟 / Codex",
      version: EXT_VERSION
    }
  };
});
