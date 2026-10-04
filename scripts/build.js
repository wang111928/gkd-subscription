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

  // GKD fastQuery compliant selector for splash skip buttons (首位必须为精确 vid 聚集)
  const FAST_ID_SELECTOR = '[vid="tt_splash_skip_btn" || vid="splash_skip" || vid="ksad_splash_skip_view" || vid="ksad_splash_skip_left_view" || vid="ksad_splash_skip_right_view" || vid="ksad_skip_text" || vid="ksad_skip_view_area" || vid="ksad_splash_circle_skip_view" || vid="ksad_splash_endcard_close" || vid="btn_skip" || vid="tv_skip" || vid="tvSkip" || vid="ll_skip" || vid="rl_skip" || vid="skip_btn" || vid="id_skip_layout" || vid="id_skip_button" || vid="id_skip_text" || vid="stv_skip" || vid="sll_skip" || vid="flash_screen_skip" || vid="flash_screen_countdown_skip" || vid="prologue_splash_skip_text" || vid="skip_ad_btn" || vid="cj_splash_skip_ll" || vid="cj_splash_skip_text" || vid="anythink_myoffer_splash_skip" || vid="adky_myoffer_splash_skip" || vid="bootimage_ad_pop_skip" || vid="public_skip" || vid="boot_skip" || vid="tb_bg_ad_skip" || vid="noah_native_splash_skip" || vid="oper_skip" || vid="km_splash_skip_space" || vid="background_splash_skip" || vid="skip_view" || vid="count_down" || vid="fanti_ad_count_and_skip_container_ex" || vid="fanti_ad_count_and_skip_container" || vid="fanti_ad_txt_skip" || vid="ms_skipView" || vid="ms_skipView_container" || vid="beizi_skip_ad" || vid="octopus_skip_ad" || vid="ptgSkipLayout" || vid="ptgSplashSkipFl" || vid="tianmu_widget_skip_view" || vid="tianmu_library_iv_skip" || vid="jad_splash_skip_btn" || vid="common_skip" || vid="btn_splash_skip" || vid="skip" || vid="fl_gdt_splash_skip" || vid="tv_gdt_splash_skip" || vid="kcfw_splash_skip_view" || vid="kcfw_skip_view" || vid="kcfw_skip_view_area" || vid="kcfw_detainment_skip" || vid="behavior_skipCollapsed" || vid="skipCollapsed" || vid="skipped" || vid="sdm_myoffer_splash_skip" || vid="yf_splash_close_v1" || vid="yf_skip_des"][visibleToUser=true][width<600 && height<400]';

  const FAST_TEXT_SELECTOR = '[text*="跳过" || text*="跳 过" || text*="跳過" || text*="Skip" || text*="SKIP"][text.length<=10][visibleToUser=true][width<600 && height<400]';

  // Supplement 3: Custom tailor rules with visibleToUser=true and explicit rule key: 0
  const extraTailoredApps = [
  {
    id: "com.zmzx.college.search",
    name: "大学搜题酱",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          },
          {
            key: 2,
            matches: '@FrameLayout[vid="fanti_ad_count_and_skip_container_ex"] > [vid="fanti_ad_txt_skip"]',
            actionCd: 2000
          }
        ]
      },
      {
        name: "局部广告-卡片广告",
        replaceNames: [
          "局部广告-卡片广告"
        ],
        rules: [
          {
            key: 0,
            anyMatches: [
              "[vid=\"banner_close_icon\"][visibleToUser=true]",
              "[vid=\"close_search_middle\"][visibleToUser=true]",
              "[vid=\"id_floating_close\"][visibleToUser=true]",
              "[vid=\"common_banner_close\"][visibleToUser=true]",
              "[vid=\"iv_close_ad\"][visibleToUser=true]",
              "[vid=\"close\" || vid=\"iv_close\" || vid=\"ad_close\" || vid=\"close_icon\" || vid=\"close_m_image_left_text_right_app_compliance\"][visibleToUser=true]",
              "[vid=\"tt_dislike_icon\" || vid=\"ksad_ad_dislike\"][visibleToUser=true]",
              "@ImageView[clickable=true][visibleToUser=true] - [text=\"广告\"]"
            ],
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "VIP弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[vid=\"iv_vip_recall_close\" || vid=\"close_exit_reward\" || vid=\"close_floating\" || vid=\"siv_close\" || vid=\"siv_dialog_close\" || vid=\"ad_dialog_close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.baidu.netdisk",
    name: "百度网盘",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        name: "局部广告-卡片广告",
        replaceNames: [
          "局部广告-卡片广告"
        ],
        rules: [
          {
            key: 0,
            anyMatches: [
              "[vid=\"banner_item_close\"][visibleToUser=true]",
              "[vid=\"ic_operation_banner_close\"][visibleToUser=true]",
              "[vid=\"ad_card_close\"][visibleToUser=true]",
              "[vid=\"all_tool_banner_close\"][visibleToUser=true]",
              "[vid=\"business_operate_close\"][visibleToUser=true]",
              "[vid=\"close_btn\"][visibleToUser=true]",
              "[vid=\"ad_close\"][visibleToUser=true]",
              "[vid=\"iv_close\"][visibleToUser=true]",
              "@ImageView[clickable=true][visibleToUser=true] - [text=\"广告\"]"
            ],
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.zzw.october",
    name: "志愿汇",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        priorityTime: 3000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "第三方营销弹窗",
        quickFind: true,
        replaceNames: [
          "全屏广告-弹窗广告",
          "第三方营销弹窗"
        ],
        rules: [
          {
            key: 0,
            matches: '[vid="beizi_interstitial_ad_close_iv" || vid="beizi_complaint_dialog_close" || vid="cj_interstitial_close_ll" || vid="channel_insert_close_iv" || vid="close" || vid="dialog_close" || vid="iv_close" || vid="close_iv"][visibleToUser=true][width<600 && height<600]',
            actionCd: 2000
          }
        ]
      },
      {
        name: "局部广告-浮标广告",
        quickFind: true,
        replaceNames: [
          "局部广告-浮标广告"
        ],
        rules: [
          {
            key: 0,
            anyMatches: [
              "[vid=\"beizi_banner_close_iv\"][visibleToUser=true]",
              "[vid=\"beizi_banner_da_close\"][visibleToUser=true]",
              "[vid=\"channel_banner_close_iv\"][visibleToUser=true]",
              "[vid=\"iv_banner_close\"][visibleToUser=true]"
            ],
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.taobao.taobao",
    name: "淘宝",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.cainiao.wireless",
    name: "菜鸟",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.taobao.idlefish",
    name: "闲鱼",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.sankuai.meituan",
    name: "美团",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.jingdong.app.mall",
    name: "京东",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.autonavi.minimap",
    name: "高德地图",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "cn.wps.moffice_eng",
    name: "WPS",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "tv.danmaku.bili",
    name: "B站",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.quark.browser",
    name: "夸克",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.netease.edu.ucmooc",
    name: "中国大学MOOC",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.uu898.uuhavequality",
    name: "悠悠有品",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.fiveplay",
    name: "5E电竞",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.pwrd.steam.esports",
    name: "完美电竞",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.netease.buff",
    name: "网易BUFF",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.kmxs.reader",
    name: "七猫免费小说",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.dragon.read",
    name: "番茄免费小说",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.duowan.kiwi",
    name: "虎牙直播",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.achievo.vipshop",
    name: "唯品会",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.sf.activity",
    name: "顺丰速运",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.midea.vm.washer",
    name: "U净",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"banner_close_img\" || vid=\"banner_close_img1\" || vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[vid=\"float_image_close\" || vid=\"close_black_icon\" || vid=\"close_circle\" || text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.tcl.tclplus",
    name: "TCL",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.cctv.yangshipin.app.androidp",
    name: "央视频",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
        ]
      }
    ]
  },
  {
    id: "com.taptap",
    name: "TapTap",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: "app",
        actionCdKey: 0,
        actionMaximumKey: 0,
        order: -10,
        rules: [
          {
            key: 0,
            matches: FAST_ID_SELECTOR,
            actionCd: 2000
          },
          {
            key: 1,
            matches: FAST_TEXT_SELECTOR,
            actionCd: 2000
          }
        ]
      },
      {
        key: 1,
        name: "横幅卡片广告关闭",
        rules: [
          {
            key: 0,
            matches: "[vid=\"close\"][visibleToUser=true]",
            actionCd: 2000
          }
        ]
      },
      {
        key: 2,
        name: "弹窗关闭",
        quickFind: true,
        rules: [
          {
            key: 0,
            matches: "[text*=\"关闭\" || vid=\"close\"][visibleToUser=true][width<500 && height<500]",
            actionCd: 2000
          }
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
        if (extraGroup.enable === undefined) {
          extraGroup.enable = true;
        }
        const isSplash = extraGroup.key === 0 || (extraGroup.name && extraGroup.name.includes('开屏'));
        if (isSplash) {
          existing.groups.unshift(JSON.parse(JSON.stringify(extraGroup)));
          mergedCount++;
        } else {
          let replaced = false;
          if (extraGroup.replaceNames && extraGroup.replaceNames.length > 0) {
            for (let i = 0; i < existing.groups.length; i++) {
              if (existing.groups[i].name && extraGroup.replaceNames.includes(existing.groups[i].name)) {
                const cloned = JSON.parse(JSON.stringify(extraGroup));
                delete cloned.replaceNames;
                cloned.key = existing.groups[i].key;
                existing.groups[i] = cloned;
                replaced = true;
                mergedCount++;
                console.log(`* Replaced upstream group "${existing.groups[i].name}" with "${cloned.name}" for ${extraApp.id}`);
                break;
              }
            }
          }
          if (!replaced) {
            const hasSimilar = existing.groups.some(g => g.name === extraGroup.name);
            if (!hasSimilar) {
              maxKey++;
              const cloned = JSON.parse(JSON.stringify(extraGroup));
              delete cloned.replaceNames;
              cloned.key = maxKey;
              existing.groups.push(cloned);
              mergedCount++;
            }
          }
        }
      }
      if (mergedCount > 0) {
        console.log(`+ Merged ${mergedCount} tailored rules into existing app: ${extraApp.id} (${existing.name})`);
      }
    }
  }

  // Ensure GKD specification completeness across all rules
  function optimizeSplashRules(groups, appId) {
    for (const group of groups || []) {
      if (group.name && group.name.includes('开屏')) {
        group.matchRoot = true;
        delete group.fastQuery;
        group.matchTime = 10000;
        group.priorityTime = 10000;
        group.forcedTime = 10000;
        group.actionMaximum = 2;
        group.order = -10;
        
        delete group.actionDelay;
        delete group.actionCdKey;
        delete group.actionMaximumKey;

        let existingRules = [];
        if (group.rules) {
          existingRules = Array.isArray(group.rules) ? group.rules : [group.rules];
        }
        
        function cleanSelector(val) {
          if (typeof val === 'string') {
            return val
              .replace(/\[childCount=0\]/g, '')
              .replace(/id\$="([^"]+)"\s*\|\|\s*vid="\1"/g, 'vid="$1"')
              .replace(/vid="([^"]+)"\s*\|\|\s*id\$="\1"/g, 'vid="$1"')
              .replace(/id\$="/g, 'vid="')
              .replace(/id\$='/g, "vid='")
              .replace(/id\$=/g, 'vid=')
              .replace(/vid="([^"]+)"\s*\|\|\s*vid="\1"/g, 'vid="$1"');
          }
          if (Array.isArray(val)) return val.map(cleanSelector);
          return val;
        }

        function cleanRule(r) {
          const cloned = JSON.parse(JSON.stringify(r));
          delete cloned.actionDelay;
          if (cloned.action !== 'back') {
            cloned.action = 'clickCenter';
          }
          if (cloned.actionCd === undefined || cloned.actionCd > 1000) {
            cloned.actionCd = 1000;
          }
          if (cloned.matches !== undefined) cloned.matches = cleanSelector(cloned.matches);
          if (cloned.anyMatches !== undefined) cloned.anyMatches = cleanSelector(cloned.anyMatches);
          if (cloned.excludeMatches !== undefined) cloned.excludeMatches = cleanSelector(cloned.excludeMatches);
          if (cloned.excludeAnyMatches !== undefined) cloned.excludeAnyMatches = cleanSelector(cloned.excludeAnyMatches);
          return cloned;
        }

        function isRedundant(r) {
          const str = JSON.stringify(r);
          // Old combined rule from v5
          if (str.includes('km_splash_skip_space') && str.includes('tt_splash_skip_btn')) return true;
          // Duplicate of rule 0
          if (r.matches === FAST_ID_SELECTOR) return true;
          // Duplicate of rule 1
          if (r.matches === FAST_TEXT_SELECTOR) return true;
          // Redundant simple text skip without extra filters or special hierarchy
          if (typeof r.matches === 'string') {
            const m = r.matches;
            const isSimpleText = m.startsWith('[text*="跳过"') &&
              !m.includes('<') && !m.includes('>') && !m.includes('+') && !m.includes('-') &&
              !m.includes('vid=') && !m.includes('id=') && !m.includes('desc=') && !m.includes('name=');
            const hasExtra = r.position || (r.action && r.action !== 'clickCenter') || r.excludeActivityIds || r.activityIds;
            if (isSimpleText && !hasExtra) return true;
          }
          return false;
        }

        const extraRules = existingRules
          .map(cleanRule)
          .filter(r => !isRedundant(r));

        const rule0 = {
          key: 0,
          fastQuery: true,
          action: 'clickCenter',
          matches: FAST_ID_SELECTOR,
          actionCd: 1000
        };

        const rule1 = {
          key: 1,
          action: 'clickCenter',
          matches: FAST_TEXT_SELECTOR,
          actionCd: 1000
        };

        const reKeyedExtra = extraRules.map((r, idx) => {
          r.key = idx + 2;
          if (r.action !== 'back') {
            r.action = 'clickCenter';
          }
          if (r.actionCd === undefined || r.actionCd > 1000) {
            r.actionCd = 1000;
          }
          return r;
        });

        group.rules = [rule0, rule1, ...reKeyedExtra];

        // Ensure absolutely no id$= remains anywhere in the group
        const cleanedStr = JSON.stringify(group).replace(/id\$=/g, 'vid=');
        const cleanedGroup = JSON.parse(cleanedStr);
        Object.assign(group, cleanedGroup);
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
    optimizeSplashRules(app.groups, app.id);
    normalizeRuleKeys(app.groups);
  }

  // Sort apps alphabetically by package id
  const sortedApps = Array.from(appMap.values()).sort((a, b) => a.id.localeCompare(b.id));

  // Global groups: Preserve complete blacklists of protected apps (banking, payment, password manager, etc.)
  // Never prune or filter apps in globalGroups, preventing newly installed sensitive apps from unintended triggers.
  const intactGlobalGroups = JSON.parse(JSON.stringify(linArm.globalGroups || []));
  optimizeSplashRules(intactGlobalGroups, 'Global');
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
  const modifiedCategories = (linArm.categories || []).map(c => {
    if (c.key === 6 || c.key === 7) {
      return { ...c, enable: true };
    }
    return c;
  });

  const customSubscription = {
    id: 88888,
    name: 'vivo X100 Pro 本机专属定制',
    version: 10,
    author: 'wang111928',
    supportUri: 'https://github.com/wang111928/gkd-subscription',
    checkUpdateUrl: 'https://cdn.jsdelivr.net/gh/wang111928/gkd-subscription@main/dist/gkd.version.json5',
    categories: modifiedCategories,
    globalGroups: intactGlobalGroups,
    apps: sortedApps
  };

  console.log('[4/6] Serializing and writing dist/gkd.json5 & gkd.version.json5...');
  const json5Content = JSON.stringify(customSubscription, null, 2);
  fs.writeFileSync(OUTPUT_FILE, json5Content, 'utf8');

  const versionFile = path.join(DIST_DIR, 'gkd.version.json5');
  const versionData = {
    id: 88888,
    version: 10,
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

  // Ensure childCount=0 is 100% absent across all splash groups
  for (const target of allTargets) {
    for (const group of target.groups || []) {
      if (group.name && group.name.includes('开屏')) {
        const groupStr = JSON.stringify(group);
        if (groupStr.includes('childCount=0')) {
          throw new Error(`Verification failed: childCount=0 detected in splash group "${group.name}" of ${target.id}`);
        }
      }
    }
  }

  // Ensure splash groups comply with strict fastQuery specification:
  // 1. Rule 0 must start with '[vid='
  // 2. Absolutely 0 residue of 'id$=' in any splash group
  for (const target of allTargets) {
    for (const group of target.groups || []) {
      if (group.name && group.name.includes('开屏')) {
        const rules = Array.isArray(group.rules) ? group.rules : (group.rules ? [group.rules] : []);
        if (rules.length === 0) {
          throw new Error(`Verification failed: Splash group "${group.name}" in ${target.id} has no rules`);
        }
        const rule0 = rules[0];
        const rule0Selector = typeof rule0.matches === 'string' ? rule0.matches : (Array.isArray(rule0.matches) ? rule0.matches[0] : '');
        if (!rule0Selector.startsWith('[vid=')) {
          throw new Error(`Verification failed: Splash group "${group.name}" in ${target.id} rule 0 does not start with '[vid=' (got: "${rule0Selector.substring(0, 30)}...")`);
        }

        const groupStr = JSON.stringify(group);
        if (groupStr.includes('id$=')) {
          throw new Error(`Verification failed: Residue of 'id$=' detected in splash group "${group.name}" of ${target.id}`);
        }

        // Verify action: 'clickCenter' on all splash rules
        for (let i = 0; i < rules.length; i++) {
          const r = rules[i];
          if (r.action !== 'clickCenter' && r.action !== 'back') {
            throw new Error(`Verification failed: Splash rule ${i} in "${group.name}" of ${target.id} does not have action: 'clickCenter' (got: "${r.action}")`);
          }
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
