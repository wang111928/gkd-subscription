const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const targetApps = [
  { name: '完美电竞平台', id: 'com.pwrd.steam.esports' },
  { name: '5E电竞平台', id: 'com.fiveplay' },
  { name: '菜鸟', id: 'com.cainiao.wireless' },
  { name: '淘宝', id: 'com.taobao.taobao' },
  { name: '志愿汇', id: 'com.zzw.october' },
  { name: '中国大学MOOC', id: 'com.netease.edu.ucmooc' },
  { name: 'WPS', id: 'cn.wps.moffice_eng' },
  { name: '支付宝', id: 'com.eg.android.AlipayGphone' },
  { name: '央视频', id: 'com.cctv.yangshipin.app.androidp' },
  { name: 'B站', id: 'tv.danmaku.bili' },
  { name: '高德地图', id: 'com.autonavi.minimap' },
  { name: '夸克', id: 'com.quark.browser' },
  { name: '百度网盘', id: 'com.baidu.netdisk' },
  { name: '闲鱼', id: 'com.taobao.idlefish' },
  { name: 'TCL', id: 'com.tcl.tclplus' },
  { name: '美团', id: 'com.sankuai.meituan' },
  { name: '京东', id: 'com.jingdong.app.mall' },
  { name: 'vivo钱包', id: 'com.vivo.wallet' },
  { name: '唯品会', id: 'com.achievo.vipshop' },
  { name: '顺丰', id: 'com.sf.activity' },
  { name: 'U净', id: 'com.midea.vm.washer' },
  { name: '七猫', id: 'com.kmxs.reader' },
  { name: '番茄', id: 'com.dragon.read' },
  { name: '虎牙', id: 'com.duowan.kiwi' },
  { name: '网易BUFF', id: 'com.netease.buff' },
  { name: '悠悠有品', id: 'com.uu898.uuhavequality' },
  { name: 'TapTap', id: 'com.taptap' },
  { name: '大学搜题酱', id: 'com.zmzx.college.search' }
];

console.log(`Starting reverse engineering on ${targetApps.length} installed apps...`);
const results = {};

for (let i = 0; i < targetApps.length; i++) {
  const app = targetApps[i];
  console.log(`[${i + 1}/${targetApps.length}] Reversing ${app.name} (${app.id})...`);
  try {
    const pmOut = cp.execSync(`adb -s 10AD7C01B9001FF shell pm path ${app.id}`, { encoding: 'utf8' }).trim();
    const apkPath = pmOut.split('\n')[0].replace('package:', '').trim();
    if (!apkPath) {
      console.warn(`  Warning: APK path not found for ${app.id}`);
      continue;
    }

    // Extract resources.arsc string IDs
    const cmd = `adb -s 10AD7C01B9001FF shell "unzip -p '${apkPath}' resources.arsc | strings | grep -iE 'skip|close|banner|dislike|dialog_close|float_close|ad_close|ad_btn' | sort -u"`;
    let rawStrings = '';
    try {
      rawStrings = cp.execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
      rawStrings = e.stdout ? e.stdout.toString() : '';
    }

    const lines = rawStrings.split('\n').map(s => s.trim()).filter(Boolean);
    
    // Classify
    const splashIds = new Set();
    const bannerIds = new Set();
    const popupCloseIds = new Set();

    for (const line of lines) {
      // Filter out long sentences, invalid identifier names
      if (!/^[a-zA-Z0-9_]+$/.test(line) || line.length > 50 || line.length < 3) continue;

      const lower = line.toLowerCase();
      if (lower.includes('splash') || lower.includes('skip') || lower.includes('jump')) {
        splashIds.add(line);
      } else if (lower.includes('banner') || lower.includes('dislike') || lower.includes('card_close') || lower.includes('feed_close')) {
        bannerIds.add(line);
      } else if (lower.includes('close') || lower.includes('dialog')) {
        popupCloseIds.add(line);
      }
    }

    results[app.id] = {
      name: app.name,
      id: app.id,
      apkPath,
      splashIds: Array.from(splashIds),
      bannerIds: Array.from(bannerIds),
      popupCloseIds: Array.from(popupCloseIds)
    };

    console.log(`  -> Found ${splashIds.size} splash IDs, ${bannerIds.size} banner IDs, ${popupCloseIds.size} popup close IDs.`);
  } catch (err) {
    console.error(`  Error reversing ${app.id}:`, err.message);
  }
}

const outDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'reverse_28_apps.json'), JSON.stringify(results, null, 2), 'utf8');
console.log(`Reverse engineering complete. Results saved to data/reverse_28_apps.json`);
