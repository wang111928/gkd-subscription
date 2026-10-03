import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const WORKSPACE = 'D:\\Antighhh';
const CACHE_DIR = path.join(WORKSPACE, '.cache_rules');
const DIST_DIR = path.join(WORKSPACE, 'dist');
const OUTPUT_FILE = path.join(DIST_DIR, 'gkd.json5');
const PACKAGES_CACHE_FILE = path.join(CACHE_DIR, 'installed_packages.json');
const DEVICE_ID = '10AD7C01B9001FF';
const REMOTE_TARGET_PATH = '/sdcard/Download/custom_gkd.json5';

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

/**
 * Safe parser for JSON5 using an isolated V8 vm context with frozen null prototype.
 * Prevents code injection, arbitrary prototype pollution, and context escapes.
 */
function safeParseJSON5(content, contextName = 'data') {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`Cannot parse empty content for ${contextName}`);
  }
  try {
    const sandbox = Object.freeze(Object.create(null));
    const result = vm.runInNewContext('(' + content + ')', sandbox, {
      timeout: 10000,
      breakOnSigint: true,
      contextCodeGeneration: { strings: false, wasm: false }
    });
    if (!result || typeof result !== 'object') {
      throw new Error(`Parsed result for ${contextName} is not a valid object`);
    }
    return result;
  } catch (err) {
    throw new Error(`Failed to safely parse ${contextName}: ${err.message}`);
  }
}

/**
 * Validate subscription data structure before caching or finalizing.
 */
function validateSubscriptionData(data, sourceName = 'Subscription') {
  if (!data || typeof data !== 'object') {
    throw new Error(`[Validation Failed] ${sourceName}: data must be an object`);
  }
  const hasApps = Array.isArray(data.apps) && data.apps.length > 0;
  const hasGlobalGroups = Array.isArray(data.globalGroups) && data.globalGroups.length > 0;
  if (!hasApps && !hasGlobalGroups) {
    throw new Error(`[Validation Failed] ${sourceName}: must contain non-empty 'apps' or 'globalGroups' array`);
  }
  return true;
}

/**
 * 1. Fetch installed packages with ADB failure fallback protection
 */
function getInstalledPackages() {
  console.log(`[1/6] Fetching installed packages from device ${DEVICE_ID}...`);
  try {
    const pkgsRaw = execSync(`adb -s ${DEVICE_ID} shell pm list packages`, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const pkgs = pkgsRaw.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith('package:'))
      .map(line => line.replace('package:', '').trim())
      .filter(Boolean);

    if (pkgs.length > 0) {
      fs.writeFileSync(PACKAGES_CACHE_FILE, JSON.stringify(pkgs, null, 2), 'utf8');
      console.log(`Successfully fetched and cached ${pkgs.length} installed packages from device.`);
      return new Set(pkgs);
    }
  } catch (err) {
    console.warn(`[WARN] ADB query failed or device offline (${err.message.trim()}). Attempting fallback to local cache...`);
  }

  // Fallback to local cached package list
  if (fs.existsSync(PACKAGES_CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(PACKAGES_CACHE_FILE, 'utf8'));
      if (Array.isArray(cached) && cached.length > 0) {
        console.log(`[INFO] Fallback successful: Loaded ${cached.length} packages from local cache (${PACKAGES_CACHE_FILE}).`);
        return new Set(cached);
      }
    } catch (e) {
      console.warn(`[WARN] Failed to read packages cache: ${e.message}`);
    }
  }

  throw new Error(`Failed to obtain installed packages: ADB command failed and no valid package cache available at ${PACKAGES_CACHE_FILE}.`);
}

// 2. Upstream rule pools
const SOURCES = [
  {
    name: 'Lin-arm',
    urls: [
      'https://cdn.jsdelivr.net/gh/Lin-arm/GKD_subscription@main/dist/gkd.json5',
      'https://jsd.admincdn.com/gh/Lin-arm/GKD_subscription@main/dist/gkd.json5',
      'https://ghproxy.net/https://raw.githubusercontent.com/Lin-arm/GKD_subscription/main/dist/gkd.json5'
    ],
    cacheFile: path.join(CACHE_DIR, 'lin_arm.json5')
  },
  {
    name: 'Meng',
    urls: [
      'https://registry.npmmirror.com/gkd-subscription/latest/files/dist/gkd.json5'
    ],
    cacheFile: path.join(CACHE_DIR, 'meng.json5')
  },
  {
    name: 'Adpro',
    urls: [
      'https://registry.npmmirror.com/@adpro/gkd_subscription/latest/files/dist/Adpro_gkd.json5'
    ],
    cacheFile: path.join(CACHE_DIR, 'adpro.json5')
  }
];

async function fetchWithFallback(src) {
  // Check if valid local cache already exists
  if (fs.existsSync(src.cacheFile) && fs.statSync(src.cacheFile).size > 1000) {
    try {
      console.log(`Loading cached source: ${src.name}`);
      const text = fs.readFileSync(src.cacheFile, 'utf8');
      const data = safeParseJSON5(text, `local cache for ${src.name}`);
      validateSubscriptionData(data, src.name);
      return { name: src.name, data };
    } catch (err) {
      console.warn(`Local cache for ${src.name} is corrupted (${err.message}). Re-fetching from remote...`);
    }
  }

  for (const url of src.urls) {
    console.log(`Fetching ${src.name} from ${url}...`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      // Safe parse first
      const data = safeParseJSON5(text, `${src.name} from ${url}`);
      // Validate structure before writing to disk to prevent cache poisoning
      validateSubscriptionData(data, src.name);

      // Only write to cache when verified healthy and compliant
      fs.writeFileSync(src.cacheFile, text, 'utf8');
      console.log(`Successfully verified and cached ${src.name}`);
      return { name: src.name, data };
    } catch (err) {
      console.warn(`URL failed (${url}): ${err.message}, trying next...`);
    }
  }

  // Last-resort fallback to existing cache file if present
  if (fs.existsSync(src.cacheFile)) {
    try {
      console.log(`Fallback to existing local cache for ${src.name}`);
      const text = fs.readFileSync(src.cacheFile, 'utf8');
      const data = safeParseJSON5(text, `fallback cache for ${src.name}`);
      validateSubscriptionData(data, src.name);
      return { name: src.name, data };
    } catch (err) {
      console.warn(`Fallback cache also failed: ${err.message}`);
    }
  }

  throw new Error(`All URLs failed and no valid cache available for ${src.name}`);
}

async function main() {
  const installedPkgs = getInstalledPackages();
  console.log(`Active package count in scope: ${installedPkgs.size}`);

  console.log('[2/6] Fetching upstream rule pools...');
  const poolResults = await Promise.all(SOURCES.map(fetchWithFallback));
  const poolMap = {};
  for (const p of poolResults) {
    poolMap[p.name] = p.data;
  }

  const linArm = poolMap['Lin-arm'];
  const meng = poolMap['Meng'];
  const adpro = poolMap['Adpro'];

  console.log('[3/6] Filtering and pruning rules for installed apps...');
  const appMap = new Map();

  // Primary: Lin-arm rules for installed apps
  for (const app of linArm.apps || []) {
    if (installedPkgs.has(app.id)) {
      appMap.set(app.id, JSON.parse(JSON.stringify(app)));
    }
  }

  // Supplement 1: Meng rules for installed apps not in Lin-arm
  for (const app of meng.apps || []) {
    if (installedPkgs.has(app.id) && !appMap.has(app.id)) {
      console.log(`+ Supplemented from Meng: ${app.id} (${app.name})`);
      appMap.set(app.id, JSON.parse(JSON.stringify(app)));
    }
  }

  // Supplement 2: Adpro rules for installed apps not in Lin-arm or Meng
  for (const app of adpro.apps || []) {
    if (installedPkgs.has(app.id) && !appMap.has(app.id)) {
      console.log(`+ Supplemented from Adpro: ${app.id} (${app.name})`);
      appMap.set(app.id, JSON.parse(JSON.stringify(app)));
    }
  }

  // Supplement 3: Custom tailor rules with visibleToUser=true and explicit rule key: 0
  const extraTailoredApps = [
    {
      id: 'com.dragon.read',
      name: '番茄免费小说',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, anyMatches: ['[id$="tt_splash_skip_btn" || vid="tt_splash_skip_btn"][visibleToUser=true]', '[text*="跳过" || desc*="跳过"][text.length<=10 || desc.length<=10][visibleToUser=true]'] }
          ]
        }
      ]
    },
    {
      id: 'com.kmxs.reader',
      name: '七猫免费小说',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, anyMatches: ['[id$="jad_splash_skip_btn" || vid="jad_splash_skip_btn"][visibleToUser=true]', '[id$="ksad_splash_skip_right_view" || vid="ksad_splash_skip_right_view"][visibleToUser=true]', '[id$="hiad_btn_skip" || vid="hiad_btn_skip"][visibleToUser=true]', '[id$="km_splash_skip_space" || vid="km_splash_skip_space"][visibleToUser=true]', '[text*="跳过"][text.length<=10][visibleToUser=true]'] }
          ]
        }
      ]
    },
    {
      id: 'com.taobao.idlefish',
      name: '闲鱼',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, anyMatches: ['[id$="tv_skip" || vid="tv_skip"][visibleToUser=true]', '[text*="跳过" || desc*="跳过"][text.length<=10 || desc.length<=10][visibleToUser=true]'] }
          ]
        }
      ]
    },
    {
      id: 'com.cainiao.wireless',
      name: '菜鸟',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, anyMatches: ['[id$="tt_skip_btn" || vid="tt_skip_btn" || id$="tv_skip" || vid="tv_skip"][visibleToUser=true]', '[text*="跳过" || desc*="跳过"][text.length<=10 || desc.length<=10][visibleToUser=true]'] }
          ]
        }
      ]
    },
    {
      id: 'com.zzw.october',
      name: '志愿汇',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, anyMatches: ['[id$="cj_splash_skip_ll" || vid="cj_splash_skip_ll"][visibleToUser=true]', '[id$="cj_splash_skip_text" || vid="cj_splash_skip_text"][visibleToUser=true]', '[id$="jad_splash_skip_btn" || vid="jad_splash_skip_btn"][visibleToUser=true]', '[id$="anythink_myoffer_splash_skip" || vid="anythink_myoffer_splash_skip"][visibleToUser=true]', '[id$="ksad_splash_skip_left_view" || vid="ksad_splash_skip_left_view"][visibleToUser=true]', '[text*="跳过"][text.length<=10][visibleToUser=true]'] }
          ]
        },
        {
          key: 2,
          name: '第三方营销弹窗',
          quickFind: true,
          rules: [
            { key: 0, matches: '[id$="close" || id$="close_btn" || id$="btn_close" || id$="iv_close" || id$="ksad_close_btn" || id$="dialog_close" || id$="ad_sdk_icon_insert_close" || id$="beizi_complaint_dialog_close"][visibleToUser=true][width<300 && height<300]', actionCd: 2000 }
          ]
        }
      ]
    },
    {
      id: 'com.zmzx.college.search',
      name: '大学搜题酱',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, anyMatches: ['[id$="stv_skip" || vid="stv_skip"][visibleToUser=true]', '[id$="ksad_skip_view" || vid="ksad_skip_view"][visibleToUser=true]', '[id$="fanti_splash_ad_skip_container" || vid="fanti_splash_ad_skip_container"][visibleToUser=true]'] }
          ]
        },
        {
          key: 1,
          name: 'VIP弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[vid="iv_vip_recall_close" || vid="ad_dialog_close" || vid="siv_close" || vid="siv_dialog_close" || vid="reward_ad_dialog_close"][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.netease.edu.ucmooc',
      name: '中国大学MOOC',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.uu898.uuhavequality',
      name: '悠悠有品',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '全局营销/弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.tcl.tclplus',
      name: 'TCL',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.netease.buff',
      name: '网易BUFF',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.fiveplay',
      name: '5E电竞',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '通用弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.pwrd.steam.esports',
      name: '完美电竞',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.achievo.vipshop',
      name: '唯品会',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.sf.activity',
      name: '顺丰速运',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.taptap',
      name: 'TapTap',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.cctv.yangshipin.app.androidp',
      name: '央视频',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.duowan.kiwi',
      name: '虎牙直播',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        },
        {
          key: 1,
          name: '弹窗关闭',
          quickFind: true,
          rules: [
            { key: 0, matches: '[text*="关闭"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    },
    {
      id: 'com.netease.uu',
      name: 'UU加速器',
      groups: [
        {
          key: 0,
          name: '开屏广告',
          quickFind: true,
          matchTime: 10000,
          actionMaximum: 1,
          resetMatch: 'app',
          actionCdKey: 0,
          actionMaximumKey: 0,
          order: -10,
          rules: [
            { key: 0, matches: '[text*="跳过"][text.length<=10][visibleToUser=true]' }
          ]
        }
      ]
    }
  ];

  for (const extraApp of extraTailoredApps) {
    if (!installedPkgs.has(extraApp.id)) continue;
    if (!appMap.has(extraApp.id)) {
      console.log(`+ Added tailored rule for installed app: ${extraApp.id} (${extraApp.name})`);
      appMap.set(extraApp.id, extraApp);
    } else {
      const existing = appMap.get(extraApp.id);
      existing.groups = existing.groups || [];
      
      const hasTailoredSplash = (extraApp.groups || []).some(g => g.key === 0 || (g.name && g.name.includes('开屏')));
      if (hasTailoredSplash) {
        const originalCount = existing.groups.length;
        existing.groups = existing.groups.filter(g => !(g.key === 0 || g.key === -1 || (g.name && g.name.includes('开屏'))));
        if (existing.groups.length < originalCount) {
          console.log(`- Evicted upstream old splash groups for ${extraApp.id}`);
        }
      }

      let maxKey = existing.groups.reduce((max, g) => (typeof g.key === 'number' && g.key > max ? g.key : max), 0);
      let mergedCount = 0;
      for (const extraGroup of extraApp.groups || []) {
        const isSplash = extraGroup.key === 0 || (extraGroup.name && extraGroup.name.includes('开屏'));
        if (isSplash) {
          existing.groups.unshift(JSON.parse(JSON.stringify(extraGroup)));
          mergedCount++;
        } else {
          const hasSimilar = existing.groups.some(g => g.name === extraGroup.name);
          if (!hasSimilar) {
            maxKey++;
            const cloned = JSON.parse(JSON.stringify(extraGroup));
            cloned.key = maxKey;
            existing.groups.push(cloned);
            mergedCount++;
          }
        }
      }
      if (mergedCount > 0) {
        console.log(`+ Merged ${mergedCount} tailored rules into existing app: ${extraApp.id} (${existing.name})`);
      }
    }
  }

  // Ensure GKD specification completeness across all rules
  function optimizeSplashRules(groups) {
    for (const group of groups || []) {
      if (group.name && group.name.includes('开屏')) {
        group.matchRoot = true;
        group.fastQuery = true;
        group.priorityTime = 5000;
        group.forcedTime = 5000;
        group.order = -10;
        
        delete group.actionDelay;

        let existingRules = [];
        if (group.rules) {
          existingRules = Array.isArray(group.rules) ? group.rules : [group.rules];
        }
        
        let maxRuleKey = -1;
        for (const r of existingRules) {
          delete r.actionDelay;
          if (typeof r.matches === 'string') {
            r.matches = r.matches.replace(/\[childCount=0\]/g, '');
          }
          if (Array.isArray(r.anyMatches)) {
            r.anyMatches = r.anyMatches.map(m => typeof m === 'string' ? m.replace(/\[childCount=0\]/g, '') : m);
          }
          if (r.key !== undefined && r.key > maxRuleKey) {
            maxRuleKey = r.key;
          }
        }
        
        const combinedMatch = '[visibleToUser=true][width<500 && height<300][id$="tt_splash_skip_btn" || id$="splash_skip" || id$="ksad_splash_skip_view" || id$="btn_skip" || id$="tv_skip" || id$="ll_skip" || id$="rl_skip" || id$="skip_btn" || vid="tt_splash_skip_btn" || vid="splash_skip" || vid="ksad_splash_skip_view" || vid="btn_skip" || vid="tv_skip" || vid="ll_skip" || vid="rl_skip" || vid="skip_btn"]';
        
        const newRule = {
          key: Math.max(existingRules.length, maxRuleKey + 1),
          matches: combinedMatch,
          actionCd: 2000
        };
        
        group.rules = [...existingRules, newRule];
      }
    }
  }

  function normalizeRuleKeys(groups) {
    for (const group of groups || []) {
      const referencedKeys = new Set();
      if (group.actionCdKey !== undefined) referencedKeys.add(group.actionCdKey);
      if (group.actionMaximumKey !== undefined) referencedKeys.add(group.actionMaximumKey);

      if (referencedKeys.size > 0 && group.rules) {
        const rules = Array.isArray(group.rules) ? group.rules : [group.rules];
        for (const refKey of referencedKeys) {
          const hasKey = rules.some(r => typeof r === 'object' && r.key === refKey);
          if (!hasKey) {
            const ruleWithoutKey = rules.find(r => typeof r === 'object' && r.key === undefined);
            if (ruleWithoutKey) {
              ruleWithoutKey.key = refKey;
            } else if (rules.length > 0 && typeof rules[0] === 'object' && rules[0].key === undefined) {
              rules[0].key = refKey;
            }
          }
        }
      }
    }
  }

  for (const app of appMap.values()) {
    optimizeSplashRules(app.groups);
    normalizeRuleKeys(app.groups);
  }

  // Sort apps alphabetically by package id
  const sortedApps = Array.from(appMap.values()).sort((a, b) => a.id.localeCompare(b.id));

  // Global groups: Preserve complete blacklists of protected apps (banking, payment, password manager, etc.)
  // Never prune or filter apps in globalGroups, preventing newly installed sensitive apps from unintended triggers.
  const intactGlobalGroups = JSON.parse(JSON.stringify(linArm.globalGroups || []));
  optimizeSplashRules(intactGlobalGroups);
  normalizeRuleKeys(intactGlobalGroups);

  // Calculate statistics
  let totalAppRuleGroups = 0;
  let totalRules = 0;
  for (const app of sortedApps) {
    totalAppRuleGroups += (app.groups || []).length;
    for (const group of app.groups || []) {
      if (Array.isArray(group.rules)) {
        totalRules += group.rules.length;
      } else if (group.rules) {
        totalRules += 1;
      }
    }
  }

  console.log(`Total matched apps: ${sortedApps.length}`);
  console.log(`Total app rule groups: ${totalAppRuleGroups}`);
  console.log(`Total app rules: ${totalRules}`);
  console.log(`Global groups count: ${intactGlobalGroups.length} (Blacklist fully preserved)`);

  // Build final subscription structure
  const customSubscription = {
    id: 88888,
    name: 'vivo X100 Pro 本机专属定制',
    version: 3,
    author: 'wang111928',
    supportUri: 'https://github.com/wang111928/gkd-subscription',
    checkUpdateUrl: 'https://cdn.jsdelivr.net/gh/wang111928/gkd-subscription@main/dist/gkd.version.json5',
    categories: linArm.categories || [],
    globalGroups: intactGlobalGroups,
    apps: sortedApps
  };

  console.log('[4/6] Serializing and writing dist/gkd.json5 & gkd.version.json5...');
  const json5Content = JSON.stringify(customSubscription, null, 2);
  fs.writeFileSync(OUTPUT_FILE, json5Content, 'utf8');

  const versionFile = path.join(DIST_DIR, 'gkd.version.json5');
  const versionData = {
    id: 88888,
    version: 3,
    date: new Date().toISOString().split('T')[0]
  };
  fs.writeFileSync(versionFile, JSON.stringify(versionData, null, 2), 'utf8');

  const stat = fs.statSync(OUTPUT_FILE);
  console.log(`Subscription written to: ${OUTPUT_FILE}`);
  console.log(`Version info written to: ${versionFile}`);
  console.log(`File size: ${(stat.size / 1024).toFixed(2)} KB`);

  // Verification test
  console.log('[5/6] Verifying output file validity...');
  const verifyText = fs.readFileSync(OUTPUT_FILE, 'utf8');
  const verifyObj = safeParseJSON5(verifyText, 'output dist/gkd.json5');

  if (verifyObj.id !== 88888 || verifyObj.name !== 'vivo X100 Pro 本机专属定制') {
    throw new Error('Verification failed: Metadata mismatch');
  }
  if (!Array.isArray(verifyObj.apps) || verifyObj.apps.length !== sortedApps.length) {
    throw new Error('Verification failed: Apps count mismatch');
  }

  // Ensure every app in verifyObj.apps is installed on the phone
  for (const a of verifyObj.apps) {
    if (!installedPkgs.has(a.id)) {
      throw new Error(`Verification failed: Non-installed app ${a.id} found in subscription!`);
    }
  }

  // Ensure globalGroups retains complete blacklists (> 100 apps each)
  for (const gg of verifyObj.globalGroups || []) {
    if (Array.isArray(gg.apps) && gg.apps.length < 100) {
      throw new Error(`Verification failed: Global group ${gg.name} blacklist appears truncated (${gg.apps.length} items)!`);
    }
  }

  // Ensure all referenced actionCdKey / actionMaximumKey have matching rule keys for apps and globalGroups
  const allTargets = [...verifyObj.apps, { id: 'Global', groups: verifyObj.globalGroups || [] }];
  for (const target of allTargets) {
    for (const group of target.groups || []) {
      const referencedKeys = [];
      if (group.actionCdKey !== undefined) referencedKeys.push(group.actionCdKey);
      if (group.actionMaximumKey !== undefined) referencedKeys.push(group.actionMaximumKey);
      const rules = Array.isArray(group.rules) ? group.rules : (group.rules ? [group.rules] : []);
      for (const k of referencedKeys) {
        const found = rules.some(r => typeof r === 'object' && r.key === k);
        if (!found) {
          throw new Error(`Verification failed: ${target.id} group "${group.name}" references key ${k} but no matching rule has that key`);
        }
      }
    }
  }

  console.log('Verification PASSED! All apps and global rules strictly comply with GKD specification.');

  // Push to device via ADB
  console.log('[6/6] Pushing subscription to device via ADB...');
  
  if (fs.statSync(OUTPUT_FILE).size === 0) {
    throw new Error('OUTPUT_FILE size is 0 before pushing. Aborting.');
  }

  try {
    const pushOutput = execSync(`adb -s ${DEVICE_ID} push "${OUTPUT_FILE}" ${REMOTE_TARGET_PATH}`, {
      encoding: 'utf8',
      timeout: 20000
    });
    console.log(`ADB push success: ${pushOutput.trim()}`);
    // Verify file exists on remote device
    const lsOutput = execSync(`adb -s ${DEVICE_ID} shell ls -l ${REMOTE_TARGET_PATH}`, {
      encoding: 'utf8',
      timeout: 10000
    });
    console.log(`Remote file verified: ${lsOutput.trim()}`);

    // MD5 Validation
    const localMd5 = crypto.createHash('md5').update(fs.readFileSync(OUTPUT_FILE)).digest('hex');
    const remoteMd5Output = execSync(`adb -s ${DEVICE_ID} shell md5sum ${REMOTE_TARGET_PATH}`, { encoding: 'utf8', timeout: 10000 }).trim();
    const remoteMd5 = remoteMd5Output.split(/\s+/)[0];
    
    if (localMd5 !== remoteMd5) {
      throw new Error(`MD5 mismatch! Local: ${localMd5}, Remote: ${remoteMd5}`);
    }
    console.log(`MD5 Validation PASSED: ${localMd5} == ${remoteMd5}`);
  } catch (err) {
    console.error(`[WARN] Failed to push to device via ADB: ${err.message}`);
    throw err;
  }
}

main().catch(err => {
  console.error('Build script error:', err);
  process.exit(1);
});
