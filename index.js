import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from "../../../../script.js";

// 扩展配置：按实际安装文件夹自动识别，避免仓库名改了以后找不到 example.html
const extensionFolderPath = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const extensionName = decodeURIComponent(extensionFolderPath.split("/").pop() || "ST-sound-forest-TTS");
const extensionVersion = "2.0.7";

// 全局状态管理
const audioState = {
  isPlaying: false,
  currentAudio: null,      // 当前播放的音频对象，用于随时停止
  playingButton: null,     // 当前发亮的喇叭按钮
  lastProcessedMessageId: null,
  lastProcessedUserMessageId: null,
  processingTimeout: null,
  audioQueue: []
};

// TTS 音频缓存：同一段文字只生成一次，之后“再听一次”直接放缓存，不再请求 API（不扣费）
const ttsAudioCache = new Map();

// ===== 屏幕日志面板：每步都打出来，方便排查 =====
function ttsLog(msg) {
  const t = new Date().toLocaleTimeString();
  const line = "[" + t + "] " + msg;
  try { console.log("[TTS]", line); } catch (e) {}
  let panel = document.getElementById("tts-log-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "tts-log-panel";
    panel.style.cssText =
      "position:fixed;left:8px;top:8px;z-index:100500;width:min(300px,calc(100vw - 16px));max-width:calc(100vw - 16px);max-height:min(170px,32vh);overflow-y:auto;" +
      "background:rgba(0,0,0,0.88);color:#00ff7f;font-size:10px;line-height:1.45;padding:0;border-radius:8px;" +
      "font-family:monospace;white-space:pre-wrap;display:none;box-shadow:0 2px 12px rgba(0,0,0,0.6);";
    const head = document.createElement("div");
    head.style.cssText = "position:sticky;top:0;background:#111;color:#fff;padding:4px 8px;display:flex;justify-content:space-between;align-items:center;border-radius:8px 8px 0 0;";
    const title = document.createElement("span");
    title.textContent = "TTS 日志";
    const btns = document.createElement("span");
    const clr = document.createElement("span");
    clr.textContent = "清空";
    clr.style.cssText = "cursor:pointer;margin-right:14px;color:#ffd54a;";
    clr.onclick = () => { const b = document.getElementById("tts-log-body"); if (b) b.innerHTML = ""; };
    const cls = document.createElement("span");
    cls.textContent = "✕";
    cls.style.cssText = "cursor:pointer;color:#fff;";
    cls.onclick = () => { panel.style.display = "none"; };
    btns.appendChild(clr); btns.appendChild(cls);
    head.appendChild(title); head.appendChild(btns);
    const body = document.createElement("div");
    body.id = "tts-log-body";
    body.style.cssText = "padding:6px 8px;";
    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);
  }
  // 不再自动弹出，只静默记录；用播放条上的「日志」按钮打开/收起
  // 同时写入悬浮日志和设置面板里的「日志」页
  ["tts-log-body", "sf_settings_log_body"].forEach((id) => {
    const body = document.getElementById(id);
    if (!body) return;
    const div = document.createElement("div");
    div.textContent = line;
    body.appendChild(div);
    while (body.childNodes.length > 200) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  });
}



// 默认设置
const DEFAULT_TTS_MAX_CHARS = 1000;

const defaultSettings = {
  apiKey: "",
  apiUrl: "https://api.siliconflow.cn/v1",
  ttsModel: "FunAudioLLM/CosyVoice2-0.5B",
  ttsVoice: "alex",
  ttsSpeed: 1.0,
  ttsGain: 0,
  responseFormat: "mp3",
  sampleRate: 32000,
  imageModel: "",
  imageSize: "512",
  textStart: "\"",
  textEnd: "\"",
  symbolReadInside: true,
  symbolReadOutside: true,
  symbolOutsideStart: "（ 【",
  symbolOutsideEnd: "） 】",
  extraTextRulesEnabled: false,
  skipTagPairs: [],
  readTagPairs: [],
  readUntaggedWithRequired: false,
  ttsMaxReadChars: DEFAULT_TTS_MAX_CHARS,
  generationFrequency: 5,
  autoPlay: true,
  autoPlayUser: false,
  barPersistent: true,
  playerBarSize: "small",
  ttsPlaybackRate: 1.0,
  roleVoiceMap: {},
  customVoices: [], // 存储自定义音色列表
  // ===== 引擎切换与火山引擎配置 =====
  engine: "siliconflow", // siliconflow | volcano
  volcAppId: "",
  volcAccessKey: "",
  volcSpeaker: "zh_female_vv_uranus_bigtts",
  volcCustomSpeaker: "", // 旧版单个自定义音色ID（已并入 volcClonedVoices，保留兼容）
  volcClonedVoices: [], // 「我的复刻音色」列表：[{id, name}]
  volcSpeed: 1.0,
  roleVoiceMapVolc: {}, // 火山引擎单独的多人角色音色映射
  // ===== MiniMax 配置 =====
  minimaxApiKey: "",
  minimaxGroupId: "",
  minimaxApiHost: "https://api.minimaxi.com",
  minimaxModel: "speech-02-hd",
  minimaxVoice: "female-shaonv",
  minimaxCustomVoice: "", // MiniMax 声音复刻音色ID，填写后优先
  minimaxSpeed: 1.0,
  roleVoiceMapMinimax: {} // MiniMax 单独的多人角色音色映射
};

// TTS模型和音色配置
const TTS_MODELS = {
  "FunAudioLLM/CosyVoice2-0.5B": {
    name: "CosyVoice2-0.5B",
    voices: {
      "alex": "Alex (男声)",
      "anna": "Anna (女声)",
      "bella": "Bella (女声)",
      "benjamin": "Benjamin (男声)",
      "charles": "Charles (男声)",
      "claire": "Claire (女声)",
      "david": "David (男声)",
      "diana": "Diana (女声)"
    }
  }
};

// ============ 火山引擎 ============
const VOLC_V3_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const VOLC_GET_VOICE_URL = "https://openspeech.bytedance.com/api/v3/tts/get_voice";

// 向火山官方查询复刻音色的训练状态（status 2/4 = 可用于合成）
async function verifyVolcCloneVoice(speakerId) {
  const s = extension_settings[extensionName] || {};
  const appId = String(s.volcAppId || "").trim();
  const accessKey = String(s.volcAccessKey || "").trim();
  if (!appId || !accessKey) {
    throw new Error("请先在上方填写火山引擎的 AppID 和 Access Token");
  }
  // get_voice 的鉴权与 TTS 合成不同：旧版控制台用 X-Api-App-Key（不是 -App-Id）+ 必填 X-Api-Request-Id
  const requestId = (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  }));
  const resp = await fetch("/proxy/" + encodeURIComponent(VOLC_GET_VOICE_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-App-Key": appId,
      "X-Api-Access-Key": accessKey,
      "X-Api-Request-Id": requestId,
    },
    body: JSON.stringify({ speaker_id: speakerId }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.message ? `${data.message}（HTTP ${resp.status}）` : `HTTP ${resp.status}`);
  }
  const status = Number(data.status);
  if (status === 2 || status === 4) return { ok: true, text: "✅ 可用" };
  if (status === 1) return { ok: false, text: "⏳ 训练中" };
  if (status === 3) return { ok: false, text: "❌ 训练失败" };
  return { ok: false, text: "❓ 未找到该音色" };
}

// 渲染「我的复刻音色」列表
function renderVolcCloneList() {
  const box = $("#volc_clone_list");
  if (!box.length) return;
  const list = extension_settings[extensionName]?.volcClonedVoices || [];
  if (!list.length) {
    box.html("<small>还没有复刻音色。去火山官网「声音复刻」做好后，把音色ID填到上面。</small>");
    return;
  }
  box.html(list.map((v, i) => `
    <div class="sf-clone-row" data-idx="${i}">
      <span class="sf-clone-name">${escapeHtml(v.name || v.id)}</span>
      <small class="sf-clone-id">${escapeHtml(v.id)}</small>
      <span class="sf-clone-status" id="sf_clone_status_${i}"></span>
      <button type="button" class="menu_button sf-clone-verify" data-idx="${i}" title="向火山官方查询这个音色的训练状态">验证</button>
      <button type="button" class="menu_button sf-clone-del" data-idx="${i}" title="从列表移除（不影响火山官网的音色）">✕</button>
    </div>`).join(""));
}

// 火山引擎音色表（大模型语音合成，场景分组）
const VOLC_VOICES = [
  // ===== TTS 2.0 =====
  { value: "zh_female_vv_uranus_bigtts", name: "Vivi 2.0", scene: "通用场景 2.0" },
  { value: "zh_female_xiaohe_uranus_bigtts", name: "小何", scene: "通用场景 2.0" },
  { value: "zh_male_m191_uranus_bigtts", name: "云舟", scene: "通用场景 2.0" },
  { value: "zh_male_taocheng_uranus_bigtts", name: "小天", scene: "通用场景 2.0" },
  { value: "zh_male_dayi_saturn_bigtts", name: "大壹", scene: "视频配音 2.0" },
  { value: "zh_female_mizai_saturn_bigtts", name: "黑猫侦探社咪仔", scene: "视频配音 2.0" },
  { value: "zh_female_jitangnv_saturn_bigtts", name: "鸡汤女", scene: "视频配音 2.0" },
  { value: "zh_female_meilinvyou_saturn_bigtts", name: "魅力女友", scene: "视频配音 2.0" },
  { value: "zh_female_santongyongns_saturn_bigtts", name: "流畅女声", scene: "视频配音 2.0" },
  { value: "zh_male_ruyayichen_saturn_bigtts", name: "儒雅逸辰", scene: "视频配音 2.0" },
  { value: "zh_female_xueayi_saturn_bigtts", name: "儿童绘本", scene: "有声阅读 2.0" },
  // ===== 通用场景 =====
  { value: "zh_male_shaonianzixin_moon_bigtts", name: "少年梓辛/Brayan", scene: "通用场景" },
  { value: "zh_female_linjianvhai_moon_bigtts", name: "邻家女孩", scene: "通用场景" },
  { value: "zh_male_yuanboxiaoshu_moon_bigtts", name: "渊博小叔", scene: "通用场景" },
  { value: "zh_male_yangguangqingnian_moon_bigtts", name: "阳光青年", scene: "通用场景" },
  { value: "zh_female_shuangkuaisisi_moon_bigtts", name: "爽快思思/Skye", scene: "通用场景" },
  { value: "zh_male_wennuanahu_moon_bigtts", name: "温暖阿虎/Alvin", scene: "通用场景" },
  { value: "zh_female_tianmeixiaoyuan_moon_bigtts", name: "甜美小源", scene: "通用场景" },
  { value: "zh_female_qingchezizi_moon_bigtts", name: "清澈梓梓", scene: "通用场景" },
  { value: "zh_male_jieshuoxiaoming_moon_bigtts", name: "解说小明", scene: "通用场景" },
  { value: "zh_female_kailangjiejie_moon_bigtts", name: "开朗姐姐", scene: "通用场景" },
  { value: "zh_male_linjiananhai_moon_bigtts", name: "邻家男孩", scene: "通用场景" },
  { value: "zh_female_tianmeiyueyue_moon_bigtts", name: "甜美悦悦", scene: "通用场景" },
  { value: "zh_female_xinlingjitang_moon_bigtts", name: "心灵鸡汤", scene: "通用场景" },
  { value: "zh_female_qinqienvsheng_moon_bigtts", name: "亲切女声", scene: "通用场景" },
  { value: "zh_female_cancan_mars_bigtts", name: "灿灿", scene: "通用场景" },
  { value: "zh_female_zhixingnvsheng_mars_bigtts", name: "知性女声", scene: "通用场景" },
  { value: "zh_female_qingxinnvsheng_mars_bigtts", name: "清新女声", scene: "通用场景" },
  { value: "zh_female_linjia_mars_bigtts", name: "邻家小妹", scene: "通用场景" },
  { value: "zh_male_qingshuangnanda_mars_bigtts", name: "清爽男大", scene: "通用场景" },
  { value: "zh_female_tiexinnvsheng_mars_bigtts", name: "贴心女声", scene: "通用场景" },
  { value: "zh_male_wenrouxiaoge_mars_bigtts", name: "温柔小哥", scene: "通用场景" },
  { value: "zh_female_tianmeitaozi_mars_bigtts", name: "甜美桃子", scene: "通用场景" },
  { value: "zh_female_kefunvsheng_mars_bigtts", name: "暖阳女声", scene: "通用场景" },
  { value: "zh_male_qingyiyuxuan_mars_bigtts", name: "阳光阿辰", scene: "通用场景" },
  { value: "zh_female_vv_mars_bigtts", name: "Vivi", scene: "通用场景" },
  { value: "zh_male_ruyayichen_emo_v2_mars_bigtts", name: "儒雅男友", scene: "通用场景" },
  { value: "zh_female_maomao_conversation_wvae_bigtts", name: "文静毛毛", scene: "通用场景" },
  { value: "en_male_jason_conversation_wvae_bigtts", name: "开朗学长", scene: "通用场景" },
  // ===== 角色扮演 =====
  { value: "zh_female_meilinvyou_moon_bigtts", name: "魅力女友", scene: "角色扮演" },
  { value: "zh_male_shenyeboke_moon_bigtts", name: "深夜播客", scene: "角色扮演" },
  { value: "zh_female_sajiaonvyou_moon_bigtts", name: "柔美女友", scene: "角色扮演" },
  { value: "zh_female_yuanqinvyou_moon_bigtts", name: "撒娇学妹", scene: "角色扮演" },
  { value: "zh_female_gaolengyujie_moon_bigtts", name: "高冷御姐", scene: "角色扮演" },
  { value: "zh_male_aojiaobazong_moon_bigtts", name: "傲娇霸总", scene: "角色扮演" },
  { value: "zh_female_wenrouxiaoya_moon_bigtts", name: "温柔小雅", scene: "角色扮演" },
  { value: "zh_male_dongfanghaoran_moon_bigtts", name: "东方浩然", scene: "角色扮演" },
  { value: "zh_male_tiancaitongsheng_mars_bigtts", name: "天才童声", scene: "角色扮演" },
  { value: "zh_male_naiqimengwa_mars_bigtts", name: "奶气萌娃", scene: "角色扮演" },
  { value: "zh_male_sunwukong_mars_bigtts", name: "猴哥", scene: "角色扮演" },
  { value: "zh_male_xionger_mars_bigtts", name: "熊二", scene: "角色扮演" },
  { value: "zh_female_peiqi_mars_bigtts", name: "佩奇猪", scene: "角色扮演" },
  { value: "zh_female_popo_mars_bigtts", name: "婆婆", scene: "角色扮演" },
  { value: "zh_female_wuzetian_mars_bigtts", name: "武则天", scene: "角色扮演" },
  { value: "zh_female_shaoergushi_mars_bigtts", name: "少儿故事", scene: "角色扮演" },
  { value: "zh_male_silang_mars_bigtts", name: "四郎", scene: "角色扮演" },
  { value: "zh_female_gujie_mars_bigtts", name: "顾姐", scene: "角色扮演" },
  { value: "zh_female_yingtaowanzi_mars_bigtts", name: "樱桃丸子", scene: "角色扮演" },
  { value: "zh_female_qiaopinvsheng_mars_bigtts", name: "俏皮女声", scene: "角色扮演" },
  { value: "zh_female_mengyatou_mars_bigtts", name: "萌丫头", scene: "角色扮演" },
  { value: "zh_male_zhoujielun_emo_v2_mars_bigtts", name: "双节棍小哥", scene: "角色扮演" },
  { value: "zh_female_jiaochuan_mars_bigtts", name: "娇喘女声", scene: "角色扮演" },
  { value: "zh_male_livelybro_mars_bigtts", name: "开朗弟弟", scene: "角色扮演" },
  { value: "zh_female_flattery_mars_bigtts", name: "谄媚女声", scene: "角色扮演" },
  // ===== 趣味方言 =====
  { value: "zh_female_wanqudashu_moon_bigtts", name: "湾区大叔", scene: "趣味方言" },
  { value: "zh_female_daimengchuanmei_moon_bigtts", name: "呆萌川妹", scene: "趣味方言" },
  { value: "zh_male_guozhoudege_moon_bigtts", name: "广州德哥", scene: "趣味方言" },
  { value: "zh_male_beijingxiaoye_moon_bigtts", name: "北京小爷", scene: "趣味方言" },
  { value: "zh_male_haoyuxiaoge_moon_bigtts", name: "浩宇小哥", scene: "趣味方言" },
  { value: "zh_male_guangxiyuanzhou_moon_bigtts", name: "广西远舟", scene: "趣味方言" },
  { value: "zh_female_meituojieer_moon_bigtts", name: "妹坨洁儿", scene: "趣味方言" },
  { value: "zh_male_yuzhouzixuan_moon_bigtts", name: "豫州子轩", scene: "趣味方言" },
  { value: "zh_male_jingqiangkanye_moon_bigtts", name: "京腔侃爷/Harmony", scene: "趣味方言" },
  { value: "zh_female_wanwanxiaohe_moon_bigtts", name: "湾湾小何", scene: "趣味方言" },
  // ===== 播报解说 =====
  { value: "en_female_anna_mars_bigtts", name: "Anna", scene: "播报解说" },
  { value: "zh_male_changtianyi_mars_bigtts", name: "悬疑解说", scene: "播报解说" },
  { value: "zh_male_jieshuonansheng_mars_bigtts", name: "磁性解说男声", scene: "播报解说" },
  { value: "zh_female_jitangmeimei_mars_bigtts", name: "鸡汤妹妹", scene: "播报解说" },
  { value: "zh_male_chunhui_mars_bigtts", name: "广告解说", scene: "播报解说" },
  // ===== 有声阅读 =====
  { value: "zh_male_ruyaqingnian_mars_bigtts", name: "儒雅青年", scene: "有声阅读" },
  { value: "zh_male_baqiqingshu_mars_bigtts", name: "霸气青叔", scene: "有声阅读" },
  { value: "zh_male_qingcang_mars_bigtts", name: "擎苍", scene: "有声阅读" },
  { value: "zh_male_yangguangqingnian_mars_bigtts", name: "活力小哥", scene: "有声阅读" },
  { value: "zh_female_gufengshaoyu_mars_bigtts", name: "古风少御", scene: "有声阅读" },
  { value: "zh_female_wenroushunv_mars_bigtts", name: "温柔淑女", scene: "有声阅读" },
  { value: "zh_male_fanjuanqingnian_mars_bigtts", name: "反卷青年", scene: "有声阅读" },
  // ===== 视频配音 =====
  { value: "zh_male_dongmanhaimian_mars_bigtts", name: "亮嗓萌仔", scene: "视频配音" },
  { value: "zh_male_lanxiaoyang_mars_bigtts", name: "懒音绵宝", scene: "视频配音" },
  // ===== 教育场景 =====
  { value: "zh_female_yingyujiaoyu_mars_bigtts", name: "Tina老师", scene: "教育场景" },
  // ===== 趣味口音 =====
  { value: "zh_male_hupunan_mars_bigtts", name: "沪普男", scene: "趣味口音" },
  { value: "zh_male_lubanqihao_mars_bigtts", name: "鲁班七号", scene: "趣味口音" },
  { value: "zh_female_yangmi_mars_bigtts", name: "林潇", scene: "趣味口音" },
  { value: "zh_female_linzhiling_mars_bigtts", name: "玲玲姐姐", scene: "趣味口音" },
  { value: "zh_female_jiyejizi2_mars_bigtts", name: "春日部姐姐", scene: "趣味口音" },
  { value: "zh_male_tangseng_mars_bigtts", name: "唐僧", scene: "趣味口音" },
  { value: "zh_male_zhuangzhou_mars_bigtts", name: "庄周", scene: "趣味口音" },
  { value: "zh_male_zhubajie_mars_bigtts", name: "猪八戒", scene: "趣味口音" },
  { value: "zh_female_ganmaodianyin_mars_bigtts", name: "感冒电音姐姐", scene: "趣味口音" },
  { value: "zh_female_naying_mars_bigtts", name: "直率英子", scene: "趣味口音" },
  { value: "zh_female_leidian_mars_bigtts", name: "女雷神", scene: "趣味口音" },
  { value: "zh_female_yueyunv_mars_bigtts", name: "粤语小溏", scene: "趣味口音" },
  // ===== 多情感 =====
  { value: "zh_male_beijingxiaoye_emo_v2_mars_bigtts", name: "北京小爷（多情感）", scene: "多情感" },
  { value: "zh_female_roumeinvyou_emo_v2_mars_bigtts", name: "柔美女友（多情感）", scene: "多情感" },
  { value: "zh_male_yangguangqingnian_emo_v2_mars_bigtts", name: "阳光青年（多情感）", scene: "多情感" },
  { value: "zh_female_meilinvyou_emo_v2_mars_bigtts", name: "魅力女友（多情感）", scene: "多情感" },
  { value: "zh_female_shuangkuaisisi_emo_v2_mars_bigtts", name: "爽快思思（多情感）", scene: "多情感" },
  { value: "zh_male_junlangnanyou_emo_v2_mars_bigtts", name: "俊朗男友（多情感）", scene: "多情感" },
  { value: "zh_male_yourougongzi_emo_v2_mars_bigtts", name: "优柔公子（多情感）", scene: "多情感" },
  { value: "zh_female_linjuayi_emo_v2_mars_bigtts", name: "邻居阿姨（多情感）", scene: "多情感" },
  { value: "zh_male_jingqiangkanye_emo_mars_bigtts", name: "京腔侃爷（多情感）", scene: "多情感" },
  { value: "zh_male_guangzhoudege_emo_mars_bigtts", name: "广州德哥（多情感）", scene: "多情感" },
  { value: "zh_male_aojiaobazong_emo_v2_mars_bigtts", name: "傲娇霸总（多情感）", scene: "多情感" },
  { value: "zh_female_tianxinxiaomei_emo_v2_mars_bigtts", name: "甜心小美（多情感）", scene: "多情感" },
  { value: "zh_female_gaolengyujie_emo_v2_mars_bigtts", name: "高冷御姐（多情感）", scene: "多情感" },
  { value: "zh_male_lengkugege_emo_v2_mars_bigtts", name: "冷酷哥哥（多情感）", scene: "多情感" },
  { value: "zh_male_shenyeboke_emo_v2_mars_bigtts", name: "深夜播客（多情感）", scene: "多情感" },
  // ===== 多语种 =====
  { value: "multi_female_shuangkuaisisi_moon_bigtts", name: "はるこ/Esmeralda", scene: "多语种" },
  { value: "multi_male_jingqiangkanye_moon_bigtts", name: "かずね/Javier", scene: "多语种" },
  { value: "multi_female_gaolengyujie_moon_bigtts", name: "あけみ", scene: "多语种" },
  { value: "multi_male_wanqudashu_moon_bigtts", name: "ひろし/Roberto", scene: "多语种" },
  { value: "en_male_adam_mars_bigtts", name: "Adam", scene: "多语种" },
  { value: "en_female_sarah_mars_bigtts", name: "Sarah", scene: "多语种" },
  { value: "en_male_dryw_mars_bigtts", name: "Dryw", scene: "多语种" },
  { value: "en_male_smith_mars_bigtts", name: "Smith", scene: "多语种" },
  { value: "en_male_jackson_mars_bigtts", name: "Jackson", scene: "多语种" },
  { value: "en_female_amanda_mars_bigtts", name: "Amanda", scene: "多语种" },
  { value: "en_female_emily_mars_bigtts", name: "Emily", scene: "多语种" },
  { value: "multi_male_xudong_conversation_wvae_bigtts", name: "まさお/Daníel", scene: "多语种" },
  { value: "multi_female_sophie_conversation_wvae_bigtts", name: "さとみ/Sofía", scene: "多语种" },
  { value: "zh_male_M100_conversation_wvae_bigtts", name: "悠悠君子/Lucas", scene: "多语种" },
  { value: "zh_male_xudong_conversation_wvae_bigtts", name: "快乐小东/Daniel", scene: "多语种" },
  { value: "zh_female_sophie_conversation_wvae_bigtts", name: "魅力苏菲/Sophie", scene: "多语种" },
  { value: "multi_zh_male_youyoujunzi_moon_bigtts", name: "ひかる（光）", scene: "多语种" },
  { value: "en_male_charlie_conversation_wvae_bigtts", name: "Owen", scene: "多语种" },
  { value: "en_female_sarah_new_conversation_wvae_bigtts", name: "Luna", scene: "多语种" },
  { value: "en_female_dacey_conversation_wvae_bigtts", name: "Daisy", scene: "多语种" },
  { value: "multi_female_maomao_conversation_wvae_bigtts", name: "つき/Diana", scene: "多语种" },
  { value: "multi_male_M100_conversation_wvae_bigtts", name: "Lucía", scene: "多语种" },
  { value: "en_male_campaign_jamal_moon_bigtts", name: "Energetic Male II", scene: "多语种" },
  { value: "en_male_chris_moon_bigtts", name: "Gotham Hero", scene: "多语种" },
  { value: "en_female_daisy_moon_bigtts", name: "Delicate Girl", scene: "多语种" },
  { value: "en_female_product_darcie_moon_bigtts", name: "Flirty Female", scene: "多语种" },
  { value: "en_female_emotional_moon_bigtts", name: "Peaceful Female", scene: "多语种" },
  { value: "en_male_bruce_moon_bigtts", name: "Bruce", scene: "多语种" },
  { value: "en_male_dave_moon_bigtts", name: "Dave", scene: "多语种" },
  { value: "en_male_hades_moon_bigtts", name: "Hades", scene: "多语种" },
  { value: "en_male_michael_moon_bigtts", name: "Michael", scene: "多语种" },
  { value: "en_female_onez_moon_bigtts", name: "Onez", scene: "多语种" },
  { value: "en_female_nara_moon_bigtts", name: "Nara", scene: "多语种" },
  { value: "en_female_lauren_moon_bigtts", name: "Lauren", scene: "多语种" },
  { value: "en_female_candice_emo_v2_mars_bigtts", name: "Candice", scene: "多语种" },
  { value: "en_male_corey_emo_v2_mars_bigtts", name: "Corey", scene: "多语种" },
  { value: "en_male_glen_emo_v2_mars_bigtts", name: "Glen", scene: "多语种" },
  { value: "en_female_nadia_tips_emo_v2_mars_bigtts", name: "Nadia1", scene: "多语种" },
  { value: "en_female_nadia_poetry_emo_v2_mars_bigtts", name: "Nadia2", scene: "多语种" },
  { value: "en_male_sylus_emo_v2_mars_bigtts", name: "Sylus", scene: "多语种" },
  { value: "en_female_skye_emo_v2_mars_bigtts", name: "Serena", scene: "多语种" }
];

// 当前引擎：siliconflow | volcano | minimax
function getEngine() {
  const e = extension_settings[extensionName]?.engine;
  return e === "volcano" || e === "minimax" ? e : "siliconflow";
}

// 火山当前音色：自定义（ICL 复刻）优先
function getVolcSpeaker() {
  const s = extension_settings[extensionName] || {};
  const custom = String(s.volcCustomSpeaker || "").trim();
  return custom || s.volcSpeaker || defaultSettings.volcSpeaker;
}

// 按音色名推断火山 Resource-Id（对应不同大模型版本）
function inferVolcResourceId(speaker) {
  const v = String(speaker || "").trim();
  const lower = v.toLowerCase();
  if (lower.startsWith("icl_") || lower.startsWith("s_")) return "seed-icl-2.0";
  if (v.includes("_uranus_") || v.includes("_saturn_") || v.includes("_moon_")) return "seed-tts-2.0";
  return "seed-tts-1.0";
}

// 语速 0.5~2.0 → 火山 speech_rate（-50~100）
function volcSpeedToSpeechRate(speed) {
  let s = Number(speed);
  if (!Number.isFinite(s)) s = 1.0;
  s = Math.min(2.0, Math.max(0.5, s));
  return Math.round((s - 1) * 100);
}

// 火山引擎 V3 单向流式合成（经酒馆 /proxy 中转解决跨域），返回 mp3 Blob
async function synthesizeVolcano(text, speaker, speed) {
  const s = extension_settings[extensionName] || {};
  const appId = String(s.volcAppId || "").trim();
  const accessKey = String(s.volcAccessKey || "").trim();
  if (!appId || !accessKey) {
    throw new Error("请先在 API 页填写火山引擎的 AppID 和 Access Key");
  }
  if (!text || !speaker) {
    throw new Error("缺少必要参数: text/speaker");
  }

  const resourceId = inferVolcResourceId(speaker);
  const body = {
    user: { uid: "st_user" },
    req_params: {
      text,
      speaker,
      audio_params: {
        format: "mp3",
        sample_rate: 24000,
        speech_rate: volcSpeedToSpeechRate(speed),
        loudness_rate: 0,
      },
    },
  };
  if (resourceId === "seed-tts-1.0") body.req_params.model = "seed-tts-1.1";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  let resp;
  try {
    resp = await fetch("/proxy/" + encodeURIComponent(VOLC_V3_URL), {
      method: "POST",
      headers: {
        ...(typeof getRequestHeaders === "function" ? getRequestHeaders() : {}),
        "Content-Type": "application/json",
        "X-Api-App-Id": appId,
        "X-Api-Access-Key": accessKey,
        "X-Api-Resource-Id": resourceId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error("请求超时（45秒）。可能文本太长或网络问题，换短一点的内容试试。");
    }
    throw new Error("火山引擎请求失败：" + (e && e.message ? e.message : e) + "（需要酒馆服务端支持 /proxy 中转）");
  }

  const logid = resp.headers.get("X-Tt-Logid") || "";
  if (!resp.ok) {
    clearTimeout(timeoutId);
    const errText = await resp.text().catch(() => "");
    throw new Error(`火山引擎 HTTP ${resp.status}: ${String(errText).slice(0, 200)}${logid ? ` (logid: ${logid})` : ""}`);
  }

  // V3 单向流式：逐行 JSON，data 字段是 base64 音频分片
  const audioChunks = [];
  try {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let json;
        try { json = JSON.parse(t); } catch (e) { continue; }
        if (json.data) {
          const bin = atob(json.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          audioChunks.push(bytes);
        } else if (json.code && json.code !== 20000000) {
          throw new Error(`火山引擎错误 ${json.code}: ${json.message || "合成失败"}`);
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("请求超时（45秒）。可能文本太长或网络问题，换短一点的内容试试。");
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  if (audioChunks.length === 0) {
    throw new Error(`火山引擎未返回音频数据${logid ? ` (logid: ${logid})` : ""}`);
  }
  return new Blob(audioChunks, { type: "audio/mpeg" });
}

// ============ MiniMax ============
// MiniMax 系统音色（T2A v2）
const MINIMAX_VOICES = [
  // ===== 中文·男声 =====
  { value: "male-qn-qingse", name: "青涩青年", scene: "中文·男声" },
  { value: "male-qn-jingying", name: "精英青年", scene: "中文·男声" },
  { value: "male-qn-badao", name: "霸道青年", scene: "中文·男声" },
  { value: "male-qn-daxuesheng", name: "青年大学生", scene: "中文·男声" },
  { value: "presenter_male", name: "男性主持人", scene: "中文·男声" },
  { value: "audiobook_male_1", name: "男性有声书1", scene: "中文·男声" },
  { value: "audiobook_male_2", name: "男性有声书2", scene: "中文·男声" },
  // ===== 中文·女声 =====
  { value: "female-shaonv", name: "少女", scene: "中文·女声" },
  { value: "female-yujie", name: "御姐", scene: "中文·女声" },
  { value: "female-chengshu", name: "成熟女性", scene: "中文·女声" },
  { value: "female-tianmei", name: "甜美女性", scene: "中文·女声" },
  { value: "presenter_female", name: "女性主持人", scene: "中文·女声" },
  { value: "audiobook_female_1", name: "女性有声书1", scene: "中文·女声" },
  { value: "audiobook_female_2", name: "女性有声书2", scene: "中文·女声" },
  // ===== 新版音色 =====
  { value: "Chinese (Mandarin)_Unrestrained_Young_Man", name: "不羁青年（普通话）", scene: "新版音色" },
  { value: "Calm_Woman", name: "沉稳女性", scene: "新版音色" },
  { value: "Energetic_Man", name: "活力男性", scene: "新版音色" },
  { value: "Gentle_Man", name: "温和男性", scene: "新版音色" },
  { value: "Cute_Girl", name: "可爱女孩", scene: "新版音色" },
  { value: "Deep_Voice_Man", name: "低沉男性", scene: "新版音色" },
  { value: "English_Graceful_Lady", name: "优雅女士（英语）", scene: "新版音色" },
  { value: "English_Persuasive_Man", name: "说服男声（英语）", scene: "新版音色" }
];

// MiniMax 当前音色：自定义（复刻）优先
function getMinimaxVoice() {
  const s = extension_settings[extensionName] || {};
  const custom = String(s.minimaxCustomVoice || "").trim();
  return custom || s.minimaxVoice || defaultSettings.minimaxVoice;
}

// MiniMax T2A v2 合成（经酒馆 /proxy 中转解决跨域），返回 mp3 Blob
async function synthesizeMinimax(text, voiceId, speed) {
  const s = extension_settings[extensionName] || {};
  const apiKey = String(s.minimaxApiKey || "").trim();
  const groupId = String(s.minimaxGroupId || "").trim();
  if (!apiKey || !groupId) {
    throw new Error("请先在 API 页填写 MiniMax 的 API Key 和 GroupID");
  }
  if (!text || !voiceId) {
    throw new Error("缺少必要参数: text/voice_id");
  }

  let spd = Number(speed);
  if (!Number.isFinite(spd)) spd = 1.0;
  spd = Math.min(2.0, Math.max(0.5, spd));

  const host = String(s.minimaxApiHost || "https://api.minimaxi.com").replace(/\/+$/, "");
  const url = `${host}/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;
  const body = {
    model: s.minimaxModel || "speech-02-hd",
    text,
    stream: false,
    voice_setting: { voice_id: voiceId, speed: spd, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    subtitle_enable: false,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  let resp;
  try {
    resp = await fetch("/proxy/" + encodeURIComponent(url), {
      method: "POST",
      headers: {
        ...(typeof getRequestHeaders === "function" ? getRequestHeaders() : {}),
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error("请求超时（45秒）。可能文本太长或网络问题，换短一点的内容试试。");
    }
    throw new Error("MiniMax 请求失败：" + (e && e.message ? e.message : e) + "（需要酒馆服务端支持 /proxy 中转）");
  }
  clearTimeout(timeoutId);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`MiniMax HTTP ${resp.status}: ${String(errText).slice(0, 200)}`);
  }

  const data = await resp.json().catch(() => null);
  if (!data) throw new Error("MiniMax 返回的不是有效 JSON");
  if (data.base_resp && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${data.base_resp.status_code}: ${data.base_resp.status_msg || "合成失败"}`);
  }

  const audioField = data?.data?.audio;
  if (!audioField) throw new Error("MiniMax 未返回音频数据");

  // 官方返回 hex 编码；个别网关返回 base64，两种都兼容
  let bytes;
  if (/^[0-9a-fA-F]+$/.test(audioField) && audioField.length % 2 === 0) {
    bytes = new Uint8Array(audioField.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(audioField.substr(i * 2, 2), 16);
  } else {
    const bin = atob(audioField);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: "audio/mpeg" });
}

function normalizeTagPairs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(pair => ({
      start: String(pair?.start || "").trim(),
      end: String(pair?.end || "").trim(),
      enabled: pair?.enabled !== false,
    }))
    .filter(pair => pair.start && pair.end);
}

function getTtsMaxReadChars() {
  const uiValue = $("#tts_max_read_chars").length ? Number.parseInt($("#tts_max_read_chars").val(), 10) : NaN;
  const savedValue = Number.parseInt(extension_settings[extensionName]?.ttsMaxReadChars, 10);
  const candidate = Number.isFinite(uiValue) && uiValue > 0 ? uiValue
    : Number.isFinite(savedValue) && savedValue > 0 ? savedValue
      : DEFAULT_TTS_MAX_CHARS;
  return Math.max(1, candidate);
}

function getEnabledTagPairs(value) {
  return normalizeTagPairs(value).filter(pair => pair.enabled !== false);
}

function makeEndTagFromStart(startTag) {
  const tag = String(startTag || "").trim();
  if (!tag) return "";
  const match = tag.match(/^<\s*([^\s>/]+)[^>]*>$/);
  if (match) return `</${match[1]}>`;
  if (tag.startsWith("<") && !tag.startsWith("</")) return tag.replace(/^<\s*/, "</");
  return "";
}

function getTagPairSettingKey(kind) {
  return kind === "skip" ? "skipTagPairs" : "readTagPairs";
}

function collectTagPairSettings(kind) {
  const pairs = [];
  $(`.tts-tag-pair-row[data-kind="${kind}"]`).each(function () {
    const start = $(this).find(".tts-tag-start").val().trim();
    const end = $(this).find(".tts-tag-end").val().trim();
    const enabled = $(this).find(".tts-tag-enabled").prop("checked") !== false;
    if (start || end) pairs.push({ start, end: end || makeEndTagFromStart(start), enabled });
  });
  return normalizeTagPairs(pairs);
}

function addTagPairRow(kind, pair = {}) {
  const container = $(`#tts_${kind}_tag_pairs`);
  if (container.length === 0) return;
  const row = $(`
    <div class="setting-item button-group tts-tag-pair-row" data-kind="${kind}">
      <span class="tts-tag-status ${kind === "skip" ? "tts-tag-skip" : "tts-tag-read"}">${kind === "skip" ? "×" : "✓"}</span>
      <label class="tts-tag-enabled-label"><input type="checkbox" class="tts-tag-enabled" title="启用这一组" checked><span>启用</span></label>
      <label>开始:<input type="text" class="tts-tag-start" placeholder="<think>"></label>
      <label>结束:<input type="text" class="tts-tag-end" placeholder="</think>"></label>
      <span class="tts-tag-preview"></span>
      <button type="button" class="menu_button tts-tag-remove" title="删除这一组">-</button>
    </div>
  `);
  row.find(".tts-tag-start").val(pair.start || "");
  row.find(".tts-tag-end").val(pair.end || makeEndTagFromStart(pair.start));
  row.find(".tts-tag-enabled").prop("checked", pair.enabled !== false);
  row.attr("data-auto-end", makeEndTagFromStart(pair.start));
  container.append(row);
  updateTagPairPreview(row);
}

function updateTagPairPreview(row) {
  const start = row.find(".tts-tag-start").val().trim();
  const end = row.find(".tts-tag-end").val().trim();
  row.find(".tts-tag-preview").text(start && end ? `${start}  ${end}` : "");
}

function renderTagPairSettings(kind) {
  const container = $(`#tts_${kind}_tag_pairs`);
  if (container.length === 0) return;
  container.empty();
  const pairs = normalizeTagPairs(extension_settings[extensionName][getTagPairSettingKey(kind)]);
  pairs.forEach(pair => addTagPairRow(kind, pair));
}

function updateExtraTextRulesUI(enabled = extension_settings[extensionName]?.extraTextRulesEnabled === true) {
  $("#tts_enable_extra_text_rules").prop("checked", !!enabled);
  $(".sf-extra-text-rules-body").toggle(!!enabled);
}

// 加载设置
// 旧版扩展文件夹名（设置曾保存在这些 key 下），用于一次性迁移
const legacySettingKeys = [
  "硅基流动语音",
  "硅基流动语音2",
  "声林语音2",
  "sillytavern-siliconflow-tts",
  "st-siliconflow-tts",
  "ST-sound-forest-TTS",
  "st-sound-forest-tts",
];

async function loadSettings() {
  extension_settings[extensionName] = extension_settings[extensionName] || {};

  // 一次性迁移：把旧 key 下已有的字段拷到当前 key（只补缺，不覆盖）
  let migrated = false;
  for (const legacyKey of legacySettingKeys) {
    if (legacyKey === extensionName) continue;
    const legacy = extension_settings[legacyKey];
    if (!legacy || typeof legacy !== "object") continue;
    for (const [key, value] of Object.entries(legacy)) {
      const current = extension_settings[extensionName][key];
      const hasDefault = Object.prototype.hasOwnProperty.call(defaultSettings, key);
      const isUntouchedDefault = hasDefault && JSON.stringify(current) === JSON.stringify(defaultSettings[key]);
      const legacyIsCustom = !hasDefault || JSON.stringify(value) !== JSON.stringify(defaultSettings[key]);
      // 当前缺失，或当前还是默认值（没动过）而旧值是自定义的，都搬过来
      if (current === undefined || (isUntouchedDefault && legacyIsCustom)) {
        extension_settings[extensionName][key] = value;
        migrated = true;
      }
    }
  }
  if (migrated) {
    saveSettingsDebounced();
    console.log(`[${extensionName}] 已从旧版扩展迁移设置`);
  }

  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }
  Object.keys(defaultSettings).forEach((key) => {
    if (extension_settings[extensionName][key] === undefined) {
      extension_settings[extensionName][key] = defaultSettings[key];
    }
  });
  if (extension_settings[extensionName].textStart === "（") {
    extension_settings[extensionName].textStart = defaultSettings.textStart;
  }
  if (extension_settings[extensionName].textEnd === "）") {
    extension_settings[extensionName].textEnd = defaultSettings.textEnd;
  }
  if (extension_settings[extensionName].textStart === "（ 【 \"" && extension_settings[extensionName].textEnd === "） 】 \"") {
    extension_settings[extensionName].textStart = defaultSettings.textStart;
    extension_settings[extensionName].textEnd = defaultSettings.textEnd;
    extension_settings[extensionName].symbolReadOutside = true;
    extension_settings[extensionName].symbolOutsideStart = defaultSettings.symbolOutsideStart;
    extension_settings[extensionName].symbolOutsideEnd = defaultSettings.symbolOutsideEnd;
  }

  // 更新UI
  $("#siliconflow_api_key").val(extension_settings[extensionName].apiKey || "");
  $("#siliconflow_api_url").val(extension_settings[extensionName].apiUrl || defaultSettings.apiUrl);
  $("#tts_model").val(extension_settings[extensionName].ttsModel || defaultSettings.ttsModel);
  $("#tts_voice").val(extension_settings[extensionName].ttsVoice || defaultSettings.ttsVoice);
  $("#tts_speed").val(extension_settings[extensionName].ttsSpeed || defaultSettings.ttsSpeed);
  $("#tts_speed_value").text(extension_settings[extensionName].ttsSpeed || defaultSettings.ttsSpeed);
  $("#tts_gain").val(extension_settings[extensionName].ttsGain || defaultSettings.ttsGain);
  $("#tts_gain_value").text(extension_settings[extensionName].ttsGain || defaultSettings.ttsGain);
  $("#response_format").val(extension_settings[extensionName].responseFormat || defaultSettings.responseFormat);
  $("#sample_rate").val(extension_settings[extensionName].sampleRate || defaultSettings.sampleRate);
  $("#image_size").val(extension_settings[extensionName].imageSize || defaultSettings.imageSize);
  $("#image_text_start").val(extension_settings[extensionName].textStart || defaultSettings.textStart);
  $("#image_text_end").val(extension_settings[extensionName].textEnd || defaultSettings.textEnd);
  $("#tts_read_symbol_inside").prop("checked", extension_settings[extensionName].symbolReadInside !== false);
  $("#tts_read_symbol_outside").prop("checked", extension_settings[extensionName].symbolReadOutside === true);
  $("#tts_symbol_outside_start").val(extension_settings[extensionName].symbolOutsideStart || defaultSettings.symbolOutsideStart);
  $("#tts_symbol_outside_end").val(extension_settings[extensionName].symbolOutsideEnd || defaultSettings.symbolOutsideEnd);
  $("#tts_max_read_chars").val(extension_settings[extensionName].ttsMaxReadChars || defaultSettings.ttsMaxReadChars);
  $("#generation_frequency").val(extension_settings[extensionName].generationFrequency || defaultSettings.generationFrequency);
  $("#auto_play_audio").prop("checked", extension_settings[extensionName].autoPlay !== false);
  $("#auto_play_user").prop("checked", extension_settings[extensionName].autoPlayUser === true);
  $("#tts_enable_extra_text_rules").prop("checked", extension_settings[extensionName].extraTextRulesEnabled === true);
  $("#tts_read_untagged_with_required").prop("checked", extension_settings[extensionName].readUntaggedWithRequired === true);
  renderTagPairSettings("skip");
  renderTagPairSettings("read");
  updateExtraTextRulesUI();
  updateSymbolConflictUI();

  // 引擎与火山设置回显
  $("#volc_app_id").val(extension_settings[extensionName].volcAppId || "");
  $("#volc_access_key").val(extension_settings[extensionName].volcAccessKey || "");
  $("#volc_speed").val(extension_settings[extensionName].volcSpeed || defaultSettings.volcSpeed);
  $("#volc_speed_value").text(extension_settings[extensionName].volcSpeed || defaultSettings.volcSpeed);
  // 旧版单个自定义音色ID → 自动收进「我的复刻音色」列表
  const legacyVolcCustom = String(extension_settings[extensionName].volcCustomSpeaker || "").trim();
  if (legacyVolcCustom) {
    const list = Array.isArray(extension_settings[extensionName].volcClonedVoices)
      ? extension_settings[extensionName].volcClonedVoices
      : (extension_settings[extensionName].volcClonedVoices = []);
    if (!list.some(v => v && v.id === legacyVolcCustom)) {
      list.push({ id: legacyVolcCustom, name: legacyVolcCustom });
      saveSettingsDebounced();
    }
  }
  buildVolcSpeakerOptions();
  renderVolcCloneList();
  // MiniMax 设置回显
  $("#minimax_api_key").val(extension_settings[extensionName].minimaxApiKey || "");
  $("#minimax_group_id").val(extension_settings[extensionName].minimaxGroupId || "");
  $("#minimax_api_host").val(extension_settings[extensionName].minimaxApiHost || defaultSettings.minimaxApiHost);
  $("#minimax_model").val(extension_settings[extensionName].minimaxModel || defaultSettings.minimaxModel);
  $("#minimax_custom_voice").val(extension_settings[extensionName].minimaxCustomVoice || "");
  $("#minimax_speed").val(extension_settings[extensionName].minimaxSpeed || defaultSettings.minimaxSpeed);
  $("#minimax_speed_value").text(extension_settings[extensionName].minimaxSpeed || defaultSettings.minimaxSpeed);
  buildMinimaxVoiceOptions();
  updateEngineUI();

  updateVoiceOptions();
}

// 更新音色选项
function updateVoiceOptions() {
  const model = $("#tts_model").val();
  const voiceSelect = $("#tts_voice");
  const currentValue = voiceSelect.val();
  voiceSelect.empty();
  
  // 添加预设音色
  if (TTS_MODELS[model] && TTS_MODELS[model].voices) {
    voiceSelect.append('<optgroup label="预设音色">');
    Object.entries(TTS_MODELS[model].voices).forEach(([value, name]) => {
      voiceSelect.append(`<option value="${value}">${name}</option>`);
    });
    voiceSelect.append('</optgroup>');
  }
  
  // 添加自定义音色
  const customVoices = extension_settings[extensionName].customVoices || [];
  console.log(`更新音色选项，自定义音色数量: ${customVoices.length}`);
  
  if (customVoices.length > 0) {
    voiceSelect.append('<optgroup label="自定义音色">');
    customVoices.forEach(voice => {
      // 尝试不同的字段名称
      const voiceName = voice.name || voice.customName || voice.custom_name || "未命名";
      const voiceUri = voice.uri || voice.id || voice.voice_id;
      console.log(`添加自定义音色: ${voiceName} -> ${voiceUri}`);
      voiceSelect.append(`<option value="${voiceUri}">${voiceName} (自定义)</option>`);
    });
    voiceSelect.append('</optgroup>');
  }
  
  // 恢复之前的选择或设置默认值
  if (currentValue && voiceSelect.find(`option[value="${currentValue}"]`).length > 0) {
    voiceSelect.val(currentValue);
  } else {
    voiceSelect.val(extension_settings[extensionName].ttsVoice || Object.keys(TTS_MODELS[model]?.voices || {})[0]);
  }
  renderRoleVoiceMap();
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function getAllVoiceOptions() {
  const model = $("#tts_model").val() || extension_settings[extensionName]?.ttsModel || defaultSettings.ttsModel;
  const options = [];
  if (TTS_MODELS[model]?.voices) {
    Object.entries(TTS_MODELS[model].voices).forEach(([value, label]) => options.push({ value, label }));
  }
  (extension_settings[extensionName]?.customVoices || []).forEach(voice => {
    const label = voice.name || voice.customName || voice.custom_name || "未命名";
    const value = voice.uri || voice.id || voice.voice_id;
    if (value) options.push({ value, label: `${label} (自定义)` });
  });
  return options;
}

function isTemplateSpeakerName(name) {
  const text = String(name || "").trim();
  return /^\$\{[^}]+\}$/.test(text);
}

function collectCurrentChatSpeakers() {
  const context = getContext();
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  const names = [];
  chat.forEach(message => {
    if (!message || message.is_user) return;
    const name = String(message.name || message.extra?.display_name || "").trim();
    if (name && !isTemplateSpeakerName(name) && !names.includes(name)) names.push(name);
  });
  $(".mes").each(function () {
    const name = $(this).find(".name_text").first().text().trim();
    if (name && !isTemplateSpeakerName(name) && !names.includes(name)) names.push(name);
  });
  return names;
}

// 当前引擎下的默认音色
function getDefaultVoice() {
  const engine = getEngine();
  if (engine === "volcano") return getVolcSpeaker();
  if (engine === "minimax") return getMinimaxVoice();
  return $("#tts_voice").val() || extension_settings[extensionName].ttsVoice || defaultSettings.ttsVoice;
}

// 当前引擎下的多人角色音色映射（硅基 / 火山 / MiniMax 分开存）
function getRoleVoiceMap() {
  const s = extension_settings[extensionName];
  const engine = getEngine();
  if (engine === "volcano") {
    s.roleVoiceMapVolc = s.roleVoiceMapVolc || {};
    return s.roleVoiceMapVolc;
  }
  if (engine === "minimax") {
    s.roleVoiceMapMinimax = s.roleVoiceMapMinimax || {};
    return s.roleVoiceMapMinimax;
  }
  s.roleVoiceMap = s.roleVoiceMap || {};
  return s.roleVoiceMap;
}

// 当前引擎下可选的音色列表（角色音色映射用）
function getEngineVoiceOptions() {
  const engine = getEngine();
  if (engine === "volcano") {
    const options = VOLC_VOICES.map(v => ({ value: v.value, label: `${v.name}（${v.scene}）` }));
    const custom = String(extension_settings[extensionName]?.volcCustomSpeaker || "").trim();
    if (custom) options.unshift({ value: custom, label: `${custom}（自定义/复刻）` });
    (extension_settings[extensionName]?.volcClonedVoices || []).forEach(v => {
      if (v && v.id) options.unshift({ value: v.id, label: `${v.name || v.id}（我的复刻）` });
    });
    return options;
  }
  if (engine === "minimax") {
    const options = MINIMAX_VOICES.map(v => ({ value: v.value, label: `${v.name}（${v.scene}）` }));
    const custom = String(extension_settings[extensionName]?.minimaxCustomVoice || "").trim();
    if (custom) options.unshift({ value: custom, label: `${custom}（自定义/复刻）` });
    return options;
  }
  return getAllVoiceOptions();
}

function renderRoleVoiceMap(names = collectCurrentChatSpeakers()) {
  const container = $("#tts_role_voice_map");
  if (container.length === 0) return;
  const roleVoiceMap = getRoleVoiceMap();
  const voiceOptions = getEngineVoiceOptions();
  if (!names.length) {
    container.html('<small>当前聊天还没有读到角色消息。打开角色聊天页后点“刷新当前聊天角色”。</small>');
    return;
  }
  const optionHtml = (selected) => [
    '<option value="">使用默认语音角色</option>',
    ...voiceOptions.map(opt => `<option value="${escapeHtml(opt.value)}"${opt.value === selected ? " selected" : ""}>${escapeHtml(opt.label)}</option>`),
  ].join("");
  container.html(names.map(name => `
    <div class="setting-item button-group sf-role-voice-row" data-role-name="${escapeHtml(name)}">
      <span class="sf-role-name">${escapeHtml(name)}</span>
      <select class="tts-role-voice-select">${optionHtml(roleVoiceMap[name] || "")}</select>
    </div>
  `).join(""));
}

function getMessageSpeakerName(messageElement) {
  const mesId = Number.parseInt(messageElement.attr("mesid"), 10);
  const context = getContext();
  const message = Number.isFinite(mesId) ? context?.chat?.[mesId] : null;
  return String(message?.name || message?.extra?.display_name || messageElement.find(".name_text").first().text() || "").trim();
}

function getVoiceForSpeaker(speakerName) {
  const fallback = getDefaultVoice();
  if (!speakerName || isTemplateSpeakerName(speakerName)) return fallback;
  const mapped = getRoleVoiceMap()[speakerName];
  return mapped || fallback;
}

// 保存三引擎 API 资料（按钮触发，带反馈）
function saveApiSettings() {
  const s = extension_settings[extensionName];
  s.apiKey = String($("#siliconflow_api_key").val() || "").trim();
  s.apiUrl = String($("#siliconflow_api_url").val() || "").trim() || defaultSettings.apiUrl;
  s.volcAppId = String($("#volc_app_id").val() || "").trim();
  s.volcAccessKey = String($("#volc_access_key").val() || "").trim();
  s.minimaxApiKey = String($("#minimax_api_key").val() || "").trim();
  s.minimaxGroupId = String($("#minimax_group_id").val() || "").trim();
  saveSettingsDebounced();
  toastr.success("API 设置已保存，刷新后自动恢复", "声林");
  ttsLog("💾 API 设置已保存");
}

// 保存设置
function saveSettings() {
  extension_settings[extensionName].apiKey = $("#siliconflow_api_key").val();
  extension_settings[extensionName].apiUrl = $("#siliconflow_api_url").val();
  extension_settings[extensionName].ttsModel = $("#tts_model").val();
  extension_settings[extensionName].ttsVoice = $("#tts_voice").val();
  extension_settings[extensionName].ttsSpeed = parseFloat($("#tts_speed").val());
  extension_settings[extensionName].ttsGain = parseFloat($("#tts_gain").val());
  extension_settings[extensionName].responseFormat = $("#response_format").val();
  extension_settings[extensionName].sampleRate = parseInt($("#sample_rate").val());
  extension_settings[extensionName].imageSize = $("#image_size").val();
  extension_settings[extensionName].textStart = $("#image_text_start").val();
  extension_settings[extensionName].textEnd = $("#image_text_end").val();
  extension_settings[extensionName].symbolReadInside = $("#tts_read_symbol_inside").prop("checked") === true;
  extension_settings[extensionName].symbolReadOutside = $("#tts_read_symbol_outside").prop("checked") === true;
  extension_settings[extensionName].symbolOutsideStart = $("#tts_symbol_outside_start").val();
  extension_settings[extensionName].symbolOutsideEnd = $("#tts_symbol_outside_end").val();
  extension_settings[extensionName].ttsMaxReadChars = getTtsMaxReadChars();
  extension_settings[extensionName].extraTextRulesEnabled = $("#tts_enable_extra_text_rules").prop("checked") === true;
  extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
  extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
  extension_settings[extensionName].readUntaggedWithRequired = $("#tts_read_untagged_with_required").prop("checked") === true;
  extension_settings[extensionName].generationFrequency = parseInt($("#generation_frequency").val());
  extension_settings[extensionName].autoPlay = $("#auto_play_audio").prop("checked");
  extension_settings[extensionName].autoPlayUser = $("#auto_play_user").prop("checked");
  // 引擎与火山设置
  extension_settings[extensionName].engine = $("#tts_engine").val() === "volcano" ? "volcano" : ($("#tts_engine").val() === "minimax" ? "minimax" : "siliconflow");
  extension_settings[extensionName].volcAppId = String($("#volc_app_id").val() || "").trim();
  extension_settings[extensionName].volcAccessKey = String($("#volc_access_key").val() || "").trim();
  extension_settings[extensionName].volcSpeaker = $("#volc_speaker").val() || defaultSettings.volcSpeaker;
  extension_settings[extensionName].volcSpeed = parseFloat($("#volc_speed").val()) || defaultSettings.volcSpeed;
  // MiniMax 设置
  extension_settings[extensionName].minimaxApiKey = String($("#minimax_api_key").val() || "").trim();
  extension_settings[extensionName].minimaxGroupId = String($("#minimax_group_id").val() || "").trim();
  extension_settings[extensionName].minimaxApiHost = $("#minimax_api_host").val() || defaultSettings.minimaxApiHost;
  extension_settings[extensionName].minimaxModel = $("#minimax_model").val() || defaultSettings.minimaxModel;
  extension_settings[extensionName].minimaxVoice = $("#minimax_voice").val() || defaultSettings.minimaxVoice;
  extension_settings[extensionName].minimaxCustomVoice = String($("#minimax_custom_voice").val() || "").trim();
  extension_settings[extensionName].minimaxSpeed = parseFloat($("#minimax_speed").val()) || defaultSettings.minimaxSpeed;
  
  saveSettingsDebounced();
  // 移除弹窗提示，改为控制台日志
  console.log("设置已保存");
}

// 测试连接
async function testConnection() {
  const apiKey = $("#siliconflow_api_key").val();
  
  if (!apiKey) {
    toastr.error("请先输入API密钥", "连接失败");
    return;
  }
  
  try {
    // 获取音色列表作为连接测试
    const response = await fetch(`${extension_settings[extensionName].apiUrl}/audio/voice/list`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      // 只更新状态，不显示弹窗
      $("#connection_status").text("已连接").css("color", "green");
      console.log("API连接成功");
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    toastr.error(`连接失败: ${error.message}`, "硅基流动插件");
    $("#connection_status").text("未连接").css("color", "red");
  }
}

// TTS功能
async function generateTTS(text, buttonElement = null, voiceOverride = null) {
  const engine = getEngine();
  const settings = extension_settings[extensionName];

  if (engine === "siliconflow" && !settings.apiKey) {
    ttsLog("❌ 没有配置硅基 API 密钥");
    toastr.error("请先配置API密钥", "TTS错误");
    return;
  }
  if (engine === "volcano") {
    const hasVolcAuth = String(settings.volcAppId || "").trim() && String(settings.volcAccessKey || "").trim();
    if (!hasVolcAuth) {
      ttsLog("❌ 没有配置火山引擎 AppID / Access Key");
      toastr.error("请先在 API 页配置火山引擎 AppID 和 Access Key", "TTS错误");
      return;
    }
  }
  if (engine === "minimax") {
    const hasMmAuth = String(settings.minimaxApiKey || "").trim() && String(settings.minimaxGroupId || "").trim();
    if (!hasMmAuth) {
      ttsLog("❌ 没有配置 MiniMax API Key / GroupID");
      toastr.error("请先在 API 页配置 MiniMax API Key 和 GroupID", "TTS错误");
      return;
    }
  }

  if (!text) {
    ttsLog("❌ 文本为空，不请求");
    toastr.error("文本不能为空", "TTS错误");
    return;
  }

  const engineLabel = { siliconflow: "硅基流动", volcano: "火山引擎", minimax: "MiniMax" }[engine] || engine;
  ttsLog("① 进入生成（" + engineLabel + "），文本长度 " + text.length + "：「" + text.substring(0, 30) + "」");

  // 先熄灭其它按钮，再把当前按钮立刻点亮成“生成中（黄）”——任何一次点击都能马上看到反馈
  $(".tts-manual-play-btn").removeClass("tts-loading tts-playing");
  if (buttonElement && buttonElement.length > 0) {
    audioState.playingButton = buttonElement;
    setButtonState(buttonElement, "loading");
  }

  const voiceValue = voiceOverride || getDefaultVoice();
  const speed = engine === "volcano"
    ? (parseFloat($("#volc_speed").val()) || settings.volcSpeed || 1.0)
    : engine === "minimax"
      ? (parseFloat($("#minimax_speed").val()) || settings.minimaxSpeed || 1.0)
      : (parseFloat($("#tts_speed").val()) || 1.0);
  const gain = engine === "siliconflow" ? (parseFloat($("#tts_gain").val()) || 0) : 0;
  const cacheKey = JSON.stringify({ engine, text, voice: voiceValue, speed, gain });

  // 命中缓存：同一段文字 + 同一音色 + 同一语速音量，直接播放，不再请求 API（不扣费）
  const cachedEntry = ttsAudioCache.get(cacheKey);
  if (cachedEntry) {
    ttsLog("② 命中缓存，直接播放（不扣费）");
    playAudioUrl(cachedEntry.url, buttonElement);
    return cachedEntry.url;
  }

  try {
    console.log("正在生成语音...");

    // 安全上限：默认 1000 字；用户在「全文发送上限」填写更高/更低数字时，以用户填写为准
    const MAX_LEN = getTtsMaxReadChars();
    if (text.length > MAX_LEN) {
      console.warn(`文本过长(${text.length})，已截断到 ${MAX_LEN} 字`);
      text = text.substring(0, MAX_LEN);
      ttsLog(`✂ 文本超过全文发送上限，已按 ${MAX_LEN} 字截断`);
      toastr.info(`文本较长，已按全文发送上限 ${MAX_LEN} 字朗读`, "TTS");
    }

    let audioBlob;

    if (engine === "volcano") {
      // ---------- 火山引擎分支 ----------
      ttsLog("③ 请求火山引擎 API 中… 音色=" + voiceValue);
      audioBlob = await synthesizeVolcano(text, voiceValue, speed);
      ttsLog("④ 火山引擎合成完成");
    } else if (engine === "minimax") {
      // ---------- MiniMax 分支 ----------
      ttsLog("③ 请求 MiniMax API 中… 音色=" + voiceValue);
      audioBlob = await synthesizeMinimax(text, voiceValue, speed);
      ttsLog("④ MiniMax 合成完成");
    } else {
      // ---------- 硅基流动分支 ----------
      let voiceParam;
      if (voiceValue.startsWith("speech:")) {
        voiceParam = voiceValue;
      } else {
        voiceParam = `FunAudioLLM/CosyVoice2-0.5B:${voiceValue}`;
      }

      const requestBody = {
        model: "FunAudioLLM/CosyVoice2-0.5B",
        input: text,
        voice: voiceParam,
        response_format: "mp3",
        speed: speed,
        gain: gain
      };
      ttsLog("③ 请求 API 中… 音色=" + voiceParam);

      // 45 秒超时，避免无限卡在“生成中”
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);

      let response;
      try {
        response = await fetch(`${settings.apiUrl}/audio/speech`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
          throw new Error('请求超时（45秒）。可能文本太长或网络问题，换短一点的内容试试。');
        }
        throw e;
      }
      clearTimeout(timeoutId);

      ttsLog("④ API 返回 HTTP " + response.status);

      if (!response.ok) {
        const errText = await response.text();
        ttsLog("❌ API 报错：" + errText.substring(0, 120));
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      audioBlob = await response.blob();
    }

    const audioUrl = URL.createObjectURL(audioBlob);
    ttsLog("⑤ 拿到音频 " + (audioBlob.size / 1024).toFixed(1) + " KB");

    // 存入缓存（带引擎/文本/音色元数据，供「缓存」面板管理），下次同一段文字直接放，不再扣费
    ttsAudioCache.set(cacheKey, {
      url: audioUrl,
      engine,
      text: text.slice(0, 60),
      voice: voiceValue,
      size: audioBlob.size || 0,
      time: Date.now()
    });
    renderCachePanel();

    playAudioUrl(audioUrl, buttonElement);

    const fmt = engine === "siliconflow" ? (settings.responseFormat || "mp3") : "mp3";
    const downloadLink = $(`<a href="${audioUrl}" download="tts_output.${fmt}">下载音频</a>`);
    $("#tts_output").empty().append(downloadLink);

    console.log("语音生成成功！");
    return audioUrl;
  } catch (error) {
    resetPlayState();
    ttsLog("❌ 出错：" + (error && error.message ? error.message : error));
    console.error("TTS Error:", error);
    toastr.error(`语音生成失败: ${error.message}`, "TTS错误");
  }
}

// ===== 缓存面板：硅基 / 火山 并列显示，可播放 / 下载 / 删除 =====
// 缓存面板各引擎列的展开状态（默认收起）
const cachePanelExpanded = { siliconflow: false, volcano: false, minimax: false };

function formatCacheSize(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

function renderCachePanel() {
  const lists = {
    siliconflow: $("#sf_cache_list_siliconflow"),
    volcano: $("#sf_cache_list_volcano"),
    minimax: $("#sf_cache_list_minimax"),
  };
  if (!lists.siliconflow.length) return;

  const buckets = { siliconflow: [], volcano: [], minimax: [] };
  ttsAudioCache.forEach((entry, key) => {
    if (!entry || typeof entry !== "object") return;
    const engine = entry.engine === "volcano" || entry.engine === "minimax" ? entry.engine : "siliconflow";
    buckets[engine].push({ key, entry });
  });

  Object.entries(lists).forEach(([engine, container]) => {
    const items = buckets[engine].sort((a, b) => b.entry.time - a.entry.time);
    // 公司名旁边的小字统计：条数 + 占用
    const totalBytes = items.reduce((sum, it) => sum + (Number(it.entry.size) || 0), 0);
    const statsEl = $("#sf_cache_stats_" + engine);
    statsEl.text(items.length ? `${items.length} 条 · ${formatCacheSize(totalBytes)}` : "暂无缓存");
    // 保持展开/收起状态
    container.toggle(cachePanelExpanded[engine] === true);
    $("#sf_cache_arrow_" + engine).text(cachePanelExpanded[engine] ? "▾" : "▸");
    if (!items.length) {
      container.html("<small>暂无缓存</small>");
      return;
    }
    container.html(items.map(({ key, entry }) => {
      const time = new Date(entry.time).toLocaleTimeString();
      const fullText = String(entry.text || "");
      const snippet = escapeHtml(fullText.slice(0, 18)) + (fullText.length > 18 ? "…" : "");
      const sizeText = entry.size ? " · " + formatCacheSize(entry.size) : "";
      return `<div class="sf-cache-row" data-key="${escapeHtml(key)}">
        <div class="sf-cache-info" title="${escapeHtml(fullText)}">
          <span class="sf-cache-text">${snippet}</span>
          <small>${escapeHtml(entry.voice || "")} · ${time}${sizeText}</small>
        </div>
        <div class="sf-cache-actions">
          <button type="button" class="menu_button sf-cache-play" title="播放（不扣费）">▶</button>
          <button type="button" class="menu_button sf-cache-download" title="下载 mp3">⬇</button>
          <button type="button" class="menu_button sf-cache-delete" title="删除">✕</button>
        </div>
      </div>`;
    }).join(""));
  });
}

// 构建火山音色下拉（按场景分组）
function buildVolcSpeakerOptions() {
  const select = $("#volc_speaker");
  if (!select.length) return;
  const current = extension_settings[extensionName]?.volcSpeaker || defaultSettings.volcSpeaker;
  select.empty();
  const groups = new Map();
  VOLC_VOICES.forEach((v) => {
    if (!groups.has(v.scene)) groups.set(v.scene, []);
    groups.get(v.scene).push(v);
  });
  groups.forEach((voices, scene) => {
    const og = $("<optgroup>").attr("label", scene);
    voices.forEach((v) => og.append($("<option>").attr("value", v.value).text(v.name)));
    select.append(og);
  });
  // 「我的复刻音色」追加到下拉里
  const clones = extension_settings[extensionName]?.volcClonedVoices || [];
  if (clones.length) {
    const og = $("<optgroup>").attr("label", "我的复刻音色");
    clones.forEach((v) => og.append($("<option>").attr("value", v.id).text((v.name || v.id) + "（复刻）")));
    select.append(og);
  }
  select.val(current);
}

// 构建 MiniMax 音色下拉（按场景分组）
function buildMinimaxVoiceOptions() {
  const select = $("#minimax_voice");
  if (!select.length) return;
  const current = extension_settings[extensionName]?.minimaxVoice || defaultSettings.minimaxVoice;
  select.empty();
  const groups = new Map();
  MINIMAX_VOICES.forEach((v) => {
    if (!groups.has(v.scene)) groups.set(v.scene, []);
    groups.get(v.scene).push(v);
  });
  groups.forEach((voices, scene) => {
    const og = $("<optgroup>").attr("label", scene);
    voices.forEach((v) => og.append($("<option>").attr("value", v.value).text(v.name)));
    select.append(og);
  });
  select.val(current);
}

// 引擎切换时：显示对应配置组，刷新角色音色映射
function updateEngineUI() {
  const engine = getEngine();
  $("#tts_engine").val(engine);
  $("#sf_engine_silicon").toggle(engine === "siliconflow");
  $("#sf_engine_volcano").toggle(engine === "volcano");
  $("#sf_engine_minimax").toggle(engine === "minimax");
  renderRoleVoiceMap();
}

// 实际播放一个音频URL（缓存和新生成共用）
// ===== 移动端音频解锁 + 底部“一定能出声”播放条 =====
let ttsAudioEl = null;
let audioPrimed = false;
let silentAudioUrl = null;
let lastTtsAudioUrl = "";
let lastTtsDownloadName = "tts_output.mp3";
let playerBarDragged = false;
let playerBarAnchorElement = null;

function shouldKeepPlayerBarVisible() {
  return extension_settings[extensionName]?.barPersistent !== false;
}

function isLargePlayerBarMode() {
  return extension_settings[extensionName]?.playerBarSize === "large";
}

function updatePlayerBarSizeMenuText() {
  const item = document.getElementById("tts-player-size-toggle");
  if (item) item.textContent = isLargePlayerBarMode() ? "小进度条" : "大进度条";
}

function setPlayerBarSizeMode(size) {
  extension_settings[extensionName].playerBarSize = size === "large" ? "large" : "small";
  saveSettingsDebounced();
  playerBarDragged = false;
  updatePlayerBarSizeMenuText();
  const bar = document.getElementById("tts-player-bar");
  if (bar) applyResponsivePlayerBarLayout(bar);
}

function getSilentAudioUrl() {
  if (!silentAudioUrl) silentAudioUrl = makeSilentWavUrl();
  return silentAudioUrl;
}

function formatTtsTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateFloatingPlayerUI() {
  const audio = ttsAudioEl;
  const playBtn = document.getElementById("tts-player-play");
  const timeText = document.getElementById("tts-player-time");
  const fill = document.getElementById("tts-player-progress-fill");
  if (!audio) return;

  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const percent = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;

  if (playBtn) playBtn.textContent = audio.paused ? "▶" : "❚❚";
  if (timeText) timeText.textContent = `${formatTtsTime(current)} / ${formatTtsTime(duration)}`;
  if (fill) fill.style.width = `${percent}%`;
}

function setTtsPlaybackRate(rate) {
  const safeRate = Number(rate) || 1;
  extension_settings[extensionName].ttsPlaybackRate = safeRate;
  saveSettingsDebounced();
  if (ttsAudioEl) ttsAudioEl.playbackRate = safeRate;
  document.querySelectorAll(".tts-speed-item").forEach((item) => {
    item.style.color = Number(item.dataset.rate) === safeRate ? "#ffd54a" : "#fff";
  });
  const speedRange = document.getElementById("tts-player-speed-range");
  const speedValue = document.getElementById("tts-player-speed-value");
  if (speedRange) speedRange.value = String(safeRate);
  if (speedValue) speedValue.textContent = `${safeRate.toFixed(2)}x`;
}

function downloadLastTtsAudio() {
  if (!lastTtsAudioUrl) {
    toastr.info("还没有可下载的语音，先生成或播放一次。", "TTS");
    return;
  }
  const link = document.createElement("a");
  link.href = lastTtsAudioUrl;
  link.download = lastTtsDownloadName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openSiliconflowSettingsPanel() {
  const openCandidates = [
    "#extensions_button",
    "#extensions_settings_button",
    "#rm_extensions_block .drawer-toggle",
    ".drawer-icon[data-drawer='extensions']",
    ".drawer-toggle[data-drawer='extensions']",
    "[title='扩展程序']",
    "[title='Extensions']",
  ];
  for (const selector of openCandidates) {
    const button = document.querySelector(selector);
    if (button && button.offsetParent !== null) {
      button.click();
      break;
    }
  }

  const root = $(".siliconflow-extension-settings").first();
  if (root.length === 0) {
    toastr.warning("还没有找到硅基语音设置面板。", "TTS");
    return;
  }
  const reveal = () => {
    const drawer = root.find(".inline-drawer-content").first();
    const icon = root.find(".inline-drawer-icon").first();
    root.show();
    root.parents().each(function () {
      const el = this;
      if (el && el.style && getComputedStyle(el).display === "none") el.style.display = "";
    });
    drawer.data("open", true).show();
    icon.addClass("down");
    root[0].scrollIntoView({ behavior: "smooth", block: "start" });
  };
  reveal();
  setTimeout(reveal, 250);
  setTimeout(reveal, 700);
}

function forceShowPlayerBarElement(bar) {
  if (!bar) return;
  bar.style.setProperty("display", "flex", "important");
  bar.style.setProperty("visibility", "visible", "important");
  bar.style.setProperty("opacity", "1", "important");
  bar.style.setProperty("pointer-events", "auto", "important");
  applyResponsivePlayerBarLayout(bar);
}

function forceHidePlayerBarElement(bar) {
  if (!bar) return;
  bar.style.setProperty("display", "none", "important");
}

function positionPlayerBarNearAnchor(bar, anchorElement) {
  if (!bar || !anchorElement || !document.body.contains(anchorElement)) return false;
  const anchorRect = anchorElement.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  const gap = 8;
  const margin = 8;
  const barWidth = barRect.width || bar.offsetWidth || 180;
  const barHeight = barRect.height || bar.offsetHeight || 36;
  let x = anchorRect.left;
  let y = anchorRect.bottom + gap;

  if (y + barHeight > window.innerHeight - margin) {
    y = anchorRect.top - barHeight - gap;
  }

  x = Math.max(margin, Math.min(x, window.innerWidth - barWidth - margin));
  y = Math.max(margin, Math.min(y, window.innerHeight - barHeight - margin));

  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
  bar.style.right = "auto";
  bar.style.bottom = "auto";
  bar.style.transform = "none";
  return true;
}

function applyResponsivePlayerBarLayout(bar) {
  if (!bar) return;

  const isMobileWidth = window.innerWidth <= 720;
  const largeMobile = isMobileWidth && isLargePlayerBarMode();
  const compact = isMobileWidth && !largeMobile;
  const progress = document.getElementById("tts-player-progress");
  const timeText = document.getElementById("tts-player-time");
  const dragLabel = document.getElementById("tts-player-drag-label");
  const versionTag = document.getElementById("tts-player-version");
  const playBtn = document.getElementById("tts-player-play");
  const menuBtn = document.getElementById("tts-player-menu");
  const closeBtn = document.getElementById("tts-player-close");
  if (dragLabel) dragLabel.style.display = compact ? "none" : "inline";
  if (versionTag) versionTag.style.display = isMobileWidth ? "none" : "inline";
  if (!playerBarDragged) {
    bar.style.top = isMobileWidth ? "60%" : "auto";
    bar.style.left = isMobileWidth ? "10px" : "20px";
    bar.style.right = "auto";
    bar.style.bottom = isMobileWidth ? "auto" : "calc(92px + env(safe-area-inset-bottom, 0px))";
    bar.style.transform = isMobileWidth ? "translateY(-50%)" : "none";
    bar.style.width = largeMobile ? "calc(100vw - 20px)" : "auto";
    bar.style.maxWidth = isMobileWidth ? "calc(100vw - 20px)" : "calc(100vw - 40px)";
    bar.style.boxSizing = "border-box";
    bar.style.justifyContent = "flex-start";
    bar.style.gap = compact ? "4px" : "8px";
    bar.style.padding = compact ? "4px 6px" : "6px 10px";
    if (playBtn) {
      playBtn.style.width = compact ? "24px" : "36px";
      playBtn.style.height = compact ? "24px" : "34px";
      playBtn.style.borderRadius = compact ? "12px" : "17px";
      playBtn.style.lineHeight = compact ? "24px" : "34px";
      playBtn.style.fontSize = compact ? "12px" : "16px";
      playBtn.style.cursor = compact ? "move" : "pointer";
      playBtn.title = compact ? "轻点播放/暂停，按住拖动" : "播放/暂停";
    }
    if (progress) {
      progress.style.width = compact ? "auto" : "150px";
      progress.style.maxWidth = compact ? "none" : "30vw";
      progress.style.flex = compact ? "0 1 42px" : (largeMobile ? "1 1 96px" : "1 1 110px");
      progress.style.minWidth = compact ? "0" : (largeMobile ? "76px" : "90px");
      progress.style.height = compact ? "4px" : "6px";
    }
    if (timeText) {
      timeText.style.minWidth = compact ? "42px" : (largeMobile ? "66px" : "76px");
      timeText.style.fontSize = compact ? "10px" : (largeMobile ? "12px" : "13px");
    }
    if (menuBtn) {
      menuBtn.style.padding = compact ? "0 4px" : "0 8px";
      menuBtn.style.fontSize = compact ? "18px" : "22px";
    }
    if (closeBtn) {
      closeBtn.style.padding = compact ? "0 2px" : "0 4px";
      closeBtn.style.fontSize = compact ? "14px" : "16px";
    }
    if (playerBarAnchorElement && positionPlayerBarNearAnchor(bar, playerBarAnchorElement)) {
      return;
    }
    return;
  }

  const rect = bar.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
  bar.style.right = "auto";
  bar.style.bottom = "auto";
  bar.style.transform = "none";
}

function getTtsAudioEl() {
  if (!ttsAudioEl) {
    // 底部播放条容器
    const bar = document.createElement("div");
    bar.id = "tts-player-bar";
    bar.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:90px;z-index:99999;" +
      "display:none;align-items:center;gap:8px;padding:6px 10px;border-radius:12px;" +
      "background:rgba(0,0,0,0.8);box-shadow:0 2px 10px rgba(0,0,0,0.5);max-width:92vw;" +
      "box-sizing:border-box;";

    const label = document.createElement("span");
    label.id = "tts-player-drag-label";
    label.textContent = "🔊";
    label.title = "按住拖动";
    label.style.cssText = "font-size:16px;line-height:1;flex:0 0 auto;cursor:move;touch-action:none;padding:0 2px;";

    // 按住 🔊 可把整条播放条拖到屏幕任意位置（悬浮，不挡视线）
    let drag = null;
    let playButtonWasDragged = false;
    const startPlayerBarDrag = (e, target, fromPlayButton = false) => {
      const rect = bar.getBoundingClientRect();
      drag = {
        dx: e.clientX - rect.left,
        dy: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        fromPlayButton,
        moved: false,
        wasDraggedBefore: playerBarDragged,
      };
      playerBarDragged = true;
      bar.style.transform = "none";
      bar.style.left = rect.left + "px";
      bar.style.top = rect.top + "px";
      bar.style.bottom = "auto";
      bar.style.right = "auto";
      bar.style.width = bar.offsetWidth + "px";
      try { target.setPointerCapture(e.pointerId); } catch (err) {}
      if (!fromPlayButton) e.preventDefault();
    };
    const movePlayerBarDrag = (e) => {
      if (!drag) return;
      const movedEnough = Math.abs(e.clientX - drag.startX) > 4 || Math.abs(e.clientY - drag.startY) > 4;
      if (movedEnough) {
        drag.moved = true;
        playerBarAnchorElement = null;
        if (drag.fromPlayButton) playButtonWasDragged = true;
        e.preventDefault();
      }
      let x = e.clientX - drag.dx;
      let y = e.clientY - drag.dy;
      x = Math.max(0, Math.min(x, window.innerWidth - bar.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - bar.offsetHeight));
      bar.style.left = x + "px";
      bar.style.top = y + "px";
    };
    const endDrag = () => {
      if (drag && drag.fromPlayButton && !drag.moved && !drag.wasDraggedBefore) {
        playerBarDragged = false;
        applyResponsivePlayerBarLayout(bar);
      }
      drag = null;
    };
    label.addEventListener("pointerdown", (e) => startPlayerBarDrag(e, label));
    label.addEventListener("pointermove", movePlayerBarDrag);
    label.addEventListener("pointerup", endDrag);
    label.addEventListener("pointercancel", endDrag);

    ttsAudioEl = document.createElement("audio");
    ttsAudioEl.id = "tts-native-player";
    ttsAudioEl.removeAttribute("controls");
    ttsAudioEl.setAttribute("playsinline", "");
    ttsAudioEl.setAttribute("webkit-playsinline", "");
    ttsAudioEl.preload = "metadata";
    ttsAudioEl.style.cssText = "display:none;width:0;height:0;";
    ttsAudioEl.src = getSilentAudioUrl();
    ttsAudioEl.playbackRate = extension_settings[extensionName].ttsPlaybackRate || 1;

    const playBtn = document.createElement("button");
    playBtn.id = "tts-player-play";
    playBtn.type = "button";
    playBtn.textContent = "▶";
    playBtn.title = "播放/暂停";
    playBtn.style.cssText =
      "width:36px;height:34px;border:0;border-radius:17px;background:#fff;color:#000;" +
      "font-size:16px;line-height:34px;padding:0;cursor:pointer;flex:0 0 auto;";
    playBtn.addEventListener("pointerdown", (e) => {
      if (window.innerWidth <= 720) startPlayerBarDrag(e, playBtn, true);
    });
    playBtn.addEventListener("pointermove", movePlayerBarDrag);
    playBtn.addEventListener("pointerup", endDrag);
    playBtn.addEventListener("pointercancel", endDrag);
    playBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (playButtonWasDragged) {
        playButtonWasDragged = false;
        return;
      }
      const audio = getTtsAudioEl();
      if (audio.paused) {
        try {
          await audio.play();
        } catch (err) {
          toastr.info("还没有可播放的语音，先点消息旁边的播放三角形生成一次。", "TTS");
        }
      } else {
        audio.pause();
      }
      updateFloatingPlayerUI();
    });

    const timeText = document.createElement("span");
    timeText.id = "tts-player-time";
    timeText.textContent = "0:00 / --:--";
    timeText.style.cssText = "color:#fff;font-size:13px;white-space:nowrap;min-width:76px;text-align:center;flex:0 0 auto;";

    const progress = document.createElement("div");
    progress.id = "tts-player-progress";
    progress.title = "点击跳转进度";
    progress.style.cssText =
      "width:150px;max-width:30vw;height:6px;border-radius:999px;background:rgba(255,255,255,0.35);" +
      "overflow:hidden;cursor:pointer;flex:1 1 110px;";
    const progressFill = document.createElement("div");
    progressFill.id = "tts-player-progress-fill";
    progressFill.style.cssText = "height:100%;width:0%;background:#fff;border-radius:999px;";
    progress.appendChild(progressFill);
    progress.addEventListener("click", (e) => {
      const audio = getTtsAudioEl();
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const rect = progress.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * audio.duration;
      updateFloatingPlayerUI();
    });

    ["loadedmetadata", "durationchange", "timeupdate", "play", "playing", "pause", "ended", "emptied"].forEach((eventName) => {
      ttsAudioEl.addEventListener(eventName, updateFloatingPlayerUI);
    });

    // 我自己的「⋮」菜单按钮，点开里面有「TTS日志」
    const menuBtn = document.createElement("span");
    menuBtn.id = "tts-player-menu";
    menuBtn.textContent = "⋮";
    menuBtn.title = "更多";
    menuBtn.style.cssText = "color:#fff;cursor:pointer;padding:0 8px;font-size:22px;font-weight:bold;line-height:1;flex:0 0 auto;";

    const versionTag = document.createElement("span");
    versionTag.id = "tts-player-version";
    versionTag.textContent = "v" + extensionVersion;
    versionTag.title = "悬浮进度条版本";
    versionTag.style.cssText = "color:rgba(255,255,255,0.45);font-size:10px;line-height:1;flex:0 0 auto;";

    const menu = document.createElement("div");
    menu.id = "tts-bar-menu";
    menu.style.cssText = "position:absolute;bottom:110%;right:6px;background:#222;border:1px solid #555;border-radius:8px;padding:6px 0;display:none;min-width:150px;box-shadow:0 2px 12px rgba(0,0,0,0.7);z-index:100001;";
    menu.addEventListener("click", (e) => e.stopPropagation());
    const makeMenuItem = (text, onClick, className = "") => {
      const item = document.createElement("div");
      item.textContent = text;
      if (className) item.className = className;
      item.style.cssText = "color:#fff;padding:9px 14px;cursor:pointer;font-size:14px;white-space:nowrap;";
      item.addEventListener("mouseenter", () => { item.style.background = "rgba(255,255,255,0.12)"; });
      item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      return item;
    };
    const logItem = document.createElement("div");
    logItem.textContent = "TTS日志";
    logItem.style.cssText = "color:#00ff7f;padding:10px 16px;cursor:pointer;font-size:14px;white-space:nowrap;";
    logItem.addEventListener("click", () => {
      ttsLog("（打开日志）"); // 确保面板已创建
      const panel = document.getElementById("tts-log-panel");
      if (panel) {
        const hidden = (panel.style.display === "none" || !panel.style.display);
        if (hidden) {
          const rect = bar.getBoundingClientRect();
          panel.style.display = "block";
          const panelRect = panel.getBoundingClientRect();
          const gap = 8;
          const left = Math.max(gap, Math.min(rect.left, window.innerWidth - panelRect.width - gap));
          let top = rect.top - panelRect.height - gap;
          if (top < gap) top = Math.min(rect.bottom + gap, window.innerHeight - panelRect.height - gap);
          panel.style.left = `${left}px`;
          panel.style.top = `${Math.max(gap, top)}px`;
          panel.style.bottom = "auto";
          panel.style.zIndex = "100500";
        }
        panel.style.display = hidden ? "block" : "none";
      }
      menu.style.display = "none";
    });
    menu.appendChild(logItem);

    const downloadItem = makeMenuItem("下载音频", () => {
      downloadLastTtsAudio();
      menu.style.display = "none";
    });
    menu.appendChild(downloadItem);

    const resetPositionItem = makeMenuItem("重置位置", () => {
      playerBarDragged = false;
      applyResponsivePlayerBarLayout(bar);
      updatePlayerBarSizeMenuText();
      menu.style.display = "none";
    });
    menu.appendChild(resetPositionItem);

    const sizeToggleItem = makeMenuItem(isLargePlayerBarMode() ? "小进度条" : "大进度条", () => {
      setPlayerBarSizeMode(isLargePlayerBarMode() ? "small" : "large");
      menu.style.display = "none";
    });
    sizeToggleItem.id = "tts-player-size-toggle";
    menu.appendChild(sizeToggleItem);

    const settingsItem = makeMenuItem("设置", () => {
      openSiliconflowSettingsPanel();
      menu.style.display = "none";
    });
    menu.appendChild(settingsItem);

    const speedTitle = document.createElement("div");
    speedTitle.style.cssText = "color:#aaa;padding:8px 14px 4px;font-size:12px;white-space:nowrap;border-top:1px solid rgba(255,255,255,0.14);margin-top:4px;";
    speedTitle.innerHTML = '播放速度 <span id="tts-player-speed-value" style="color:#fff;">1.00x</span>';
    menu.appendChild(speedTitle);

    const speedControl = document.createElement("div");
    speedControl.style.cssText = "padding:4px 14px 12px;";
    const speedRange = document.createElement("input");
    speedRange.id = "tts-player-speed-range";
    speedRange.type = "range";
    speedRange.min = "0.5";
    speedRange.max = "2";
    speedRange.step = "0.01";
    speedRange.value = String(extension_settings[extensionName].ttsPlaybackRate || 1);
    speedRange.style.cssText = "width:160px;margin:0;";
    speedRange.addEventListener("input", () => setTtsPlaybackRate(parseFloat(speedRange.value)));
    speedControl.appendChild(speedRange);
    menu.appendChild(speedControl);
    setTtsPlaybackRate(extension_settings[extensionName].ttsPlaybackRate || 1);

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.style.display = (menu.style.display === "none") ? "block" : "none";
    });
    // 点别处收起菜单
    document.addEventListener("click", (e) => {
      if (menu.style.display === "block" && e.target !== menuBtn && !menu.contains(e.target)) {
        menu.style.display = "none";
      }
    });
    window.addEventListener("resize", () => applyResponsivePlayerBarLayout(bar));
    window.addEventListener("orientationchange", () => setTimeout(() => applyResponsivePlayerBarLayout(bar), 250));

    const closeBtn = document.createElement("span");
    closeBtn.id = "tts-player-close";
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "color:#fff;cursor:pointer;padding:0 4px;font-size:16px;flex:0 0 auto;";
    closeBtn.addEventListener("click", () => {
      try { ttsAudioEl.pause(); } catch (e) {}
      resetPlayState();
      setPersistentPlayerBarEnabled(false);
    });

    bar.appendChild(label);
    bar.appendChild(playBtn);
    bar.appendChild(timeText);
    bar.appendChild(progress);
    bar.appendChild(ttsAudioEl);
    bar.appendChild(versionTag);
    bar.appendChild(menuBtn);
    bar.appendChild(menu);
    bar.appendChild(closeBtn);
    document.body.appendChild(bar);
    updateFloatingPlayerUI();
  }
  return ttsAudioEl;
}

let barClosedByUser = false;
function showPlayerBar() {
  const el = getTtsAudioEl();
  const bar = document.getElementById("tts-player-bar");
  if (bar) {
    barClosedByUser = false; // 主动调用显示时，取消“已关闭”状态
    forceShowPlayerBarElement(bar);
    updateFloatingPlayerUI();
  }
  return el;
}

function ensurePersistentPlayerBar() {
  if (!shouldKeepPlayerBarVisible()) return;
  const el = getTtsAudioEl();
  if (el && !el.getAttribute("src") && !el.src) {
    el.src = getSilentAudioUrl();
  }
  const bar = document.getElementById("tts-player-bar");
  if (bar) {
    barClosedByUser = false;
    forceShowPlayerBarElement(bar);
    updateFloatingPlayerUI();
  }
}

// 在设置面板里加「语音进度条 开/关」滑动开关
function setBarToggleUI(on) {
  const track = document.getElementById("tts-bar-toggle");
  const knob = document.getElementById("tts-bar-knob");
  const state = document.getElementById("tts-bar-toggle-state");
  if (track) {
    track.style.background = on ? "#3ba55d" : "#777";
    if (knob) knob.style.left = on ? "22px" : "2px";
    if (state) state.textContent = on ? "开" : "关";
  }
  updateInlineBarControlsUI(on);
}

function updateInlineBarControlsUI(on = shouldKeepPlayerBarVisible()) {
  $(".tts-bar-toggle-inline-btn")
    .text(on ? "-" : "+")
    .attr("title", on ? "隐藏语音进度条" : "显示语音进度条")
    .toggleClass("tts-inline-active", !!on);
}

function setPersistentPlayerBarEnabled(on, anchorElement = null) {
  extension_settings[extensionName].barPersistent = !!on;
  saveSettingsDebounced();
  setBarToggleUI(!!on);

  const bar = document.getElementById("tts-player-bar");
  if (on) {
    barClosedByUser = false;
    playerBarDragged = false;
    playerBarAnchorElement = anchorElement || playerBarAnchorElement;
    ensurePersistentPlayerBar();
  } else {
    barClosedByUser = true;
    playerBarAnchorElement = null;
    forceHidePlayerBarElement(bar);
  }
}

function createBarToggle() {
  if (document.getElementById("tts-bar-toggle")) return;
  const on = shouldKeepPlayerBarVisible(); // 默认开
  const section = $(
    '<div class="sub-section" style="flex-basis:100%;width:100%;margin-top:10px;">' +
    '<div style="display:flex;align-items:center;gap:12px;">' +
    '<b>🔊 语音进度条</b>' +
    '<span id="tts-bar-toggle" style="position:relative;display:inline-block;width:44px;height:24px;border-radius:12px;background:#777;cursor:pointer;transition:background .2s;flex:0 0 auto;">' +
    '<span id="tts-bar-knob" style="position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></span>' +
    '</span>' +
    '<span id="tts-bar-toggle-state" style="opacity:0.85;"></span>' +
    '</div>' +
    '<div style="font-size:12px;opacity:0.7;margin-top:4px;">开：进度条常驻显示；关：平时隐藏（朗读时仍会自动弹出，方便点播放）。</div>' +
    '</div>'
  );
  // 放在「文本截取设置 / TTS测试」这一块前面，醒目
  const flexC = $(".siliconflow-extension-settings .inline-drawer-content .flex-container").first();
  if (flexC.length > 0) flexC.prepend(section);
  else $("#extensions_settings").append(section);

  setBarToggleUI(on);
  let lastToggleAt = 0;
  $("#tts-bar-toggle").on("pointerup touchend click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastToggleAt < 350) return;
    lastToggleAt = now;
    setPersistentPlayerBarEnabled(!shouldKeepPlayerBarVisible());
  });
}

// 生成一段极短的静音 WAV，用于在用户手势内“解锁”音频元素
function makeSilentWavUrl() {
  const sampleRate = 8000, numSamples = 400; // 0.05s
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + numSamples, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  writeStr(36, "data"); view.setUint32(40, numSamples, true);
  for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([view], { type: "audio/wav" }));
}

// 用户手势内调用一次即可解锁移动端音频（播放条保持隐藏）
function primeAudioOnce() {
  if (audioPrimed) return;
  const el = getTtsAudioEl();
  try {
    el.src = getSilentAudioUrl();
    const p = el.play();
    if (p && p.then) {
      p.then(() => { audioPrimed = true; }).catch(() => {});
    } else {
      audioPrimed = true;
    }
  } catch (e) {}
}

// 实际播放一个音频URL：头像旁 ▶ 只负责播放，不主动弹出进度条；需要进度条时点消息旁的 +。
function playAudioUrl(audioUrl, buttonElement) {
  ttsLog("⑥ 尝试播放音频");
  const audio = getTtsAudioEl();
  try { audio.pause(); } catch (e) {}

  lastTtsAudioUrl = audioUrl;
  lastTtsDownloadName = `tts_output.${extension_settings[extensionName].responseFormat || "mp3"}`;
  audio.volume = 1.0;
  audio.playbackRate = extension_settings[extensionName].ttsPlaybackRate || 1;
  audioState.currentAudio = audio;
  audioState.isPlaying = true;

  const btn = buttonElement && buttonElement.length > 0 ? buttonElement : audioState.playingButton;
  if (btn && btn.length > 0) {
    audioState.playingButton = btn;
    setButtonState(btn, "loading"); // 出声前保持黄
  }

  audio.onplaying = () => {
    if (audioState.playingButton) setButtonState(audioState.playingButton, "playing"); // 出声转绿
  };
  audio.onended = () => {
    console.log('音频播放完成');
    resetPlayState();
  };
  audio.onerror = () => {
    ttsLog("❌ 音频元素报错（解码失败？）");
    resetPlayState();
    toastr.error('音频解码/播放失败，可能返回的不是有效音频。', 'TTS');
  };

  audio.src = audioUrl;
  audio.load();
  updateFloatingPlayerUI();
  audio.play().then(() => {
    ttsLog("✅ 自动播放成功，应该有声音了");
    if (audioState.playingButton) setButtonState(audioState.playingButton, "playing");
  }).catch(err => {
    ttsLog("⚠️ 自动播放被拦，请点消息旁的 + 打开进度条，再点进度条里的 ▶。原因：" + (err && err.message ? err.message : err));
    if (audioState.playingButton) setButtonState(audioState.playingButton, "playing");
    toastr.info('如未出声，点消息旁的 + 打开进度条，再点进度条里的 ▶', 'TTS', { timeOut: 5000 });
  });
}

// ============ 喇叭按钮辅助函数（新增） ============

// 把所有按钮恢复到待机，并清空播放状态
function resetPlayState() {
  audioState.isPlaying = false;
  audioState.currentAudio = null;
  $(".tts-manual-play-btn").removeClass("tts-loading tts-playing");
  audioState.playingButton = null;
}

// 三种外观：idle 待机 / loading 加载中 / playing 播放中
// 注入一次性的高优先级样式（带 !important，确保一定可见）
function injectTTSStyle() {
  if (document.getElementById("tts-btn-style")) return;
  const style = document.createElement("style");
  style.id = "tts-btn-style";
  style.textContent = `
    @keyframes ttsGlowPulse {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.3); }
    }
    .tts-manual-play-btn {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      min-width: 1.35em;
      height: 1.35em;
      margin: 0;
      font-size: 1.05em;
      font-weight: bold;
      line-height: 1;
      cursor: pointer;
      vertical-align: middle;
      user-select: none;
      color: #9aa0a6;
      position: relative;
      z-index: 60;
      pointer-events: auto !important;
      padding: 0 2px;
      transition: color 0.15s, text-shadow 0.15s, transform 0.15s;
    }
    .tts-voice-control-group {
      display: inline-flex !important;
      align-items: center;
      gap: 2px;
      margin-left: 5px;
      vertical-align: middle;
      position: relative;
      z-index: 60;
      pointer-events: auto !important;
    }
    .tts-bar-inline-btn {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      min-width: 1.15em;
      height: 1.15em;
      border-radius: 4px;
      padding: 0 2px;
      color: #9aa0a6;
      font-size: 0.95em;
      font-weight: 800;
      line-height: 1;
      cursor: pointer;
      user-select: none;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.18);
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .tts-bar-inline-btn:hover {
      color: #fff;
      background: rgba(255,255,255,0.16);
    }
    .tts-bar-inline-btn.tts-inline-active {
      color: #00ffae !important;
      border-color: rgba(0,255,174,0.75);
      background: rgba(0,255,174,0.16);
      text-shadow: 0 0 6px rgba(0,255,174,0.75);
    }
    .tts-manual-play-btn:hover { color: #e0e0e0; }
    /* 生成中：荧光黄，符号本身发光 + 跳动 */
    .tts-manual-play-btn.tts-loading {
      color: #f6ff00 !important;
      text-shadow: 0 0 6px #f6ff00, 0 0 14px #f6ff00, 0 0 2px #ffffff;
      animation: ttsGlowPulse 0.8s infinite;
    }
    /* 播放中：荧光青绿，符号发光 + 放大 */
    .tts-manual-play-btn.tts-playing {
      color: #00ffae !important;
      text-shadow: 0 0 6px #00ffae, 0 0 16px #00ffae, 0 0 2px #ffffff;
      transform: scale(1.2);
    }
  `;
  document.head.appendChild(style);
}

// 切换状态：idle 待机 / loading 生成中(黄,跳动) / playing 播放中(蓝)。只换颜色，emoji 始终是 🔊
function setButtonState(button, state) {
  if (!button || button.length === 0) return;
  button.removeClass("tts-loading tts-playing");
  if (state === "loading") {
    button.addClass("tts-loading");
  } else if (state === "playing") {
    button.addClass("tts-playing");
  }
}

// 给每条消息注入“朗读/停止”按钮（点击逻辑用事件委托，见 bindPlayButtonDelegation）
function injectPlayButton() {
  $(".mes").each(function () {
    const messageElement = $(this);
    if (messageElement.find(".tts-voice-control-group").length > 0) return;
    messageElement.find(".tts-manual-play-btn").not(".tts-voice-control-group .tts-manual-play-btn").remove();

    const controls = $(
      '<span class="tts-voice-control-group" title="语音控制">' +
      '<span class="tts-manual-play-btn" title="朗读 / 停止" role="button">▶</span>' +
      '<span class="tts-bar-inline-btn tts-bar-toggle-inline-btn" title="显示语音进度条" role="button">+</span>' +
      '</span>'
    );

    // 放到角色名字「右边」：避开左侧的翻页箭头，避免被它盖住点不到
    const nameText = messageElement.find(".name_text").first();
    if (nameText.length > 0) {
      nameText.after(controls);
    } else {
      let target = messageElement.find(".ch_name").first();
      if (target.length === 0) target = messageElement.find(".mes_block").first();
      if (target.length === 0) target = messageElement;
      target.append(controls);
    }
    updateInlineBarControlsUI();
  });
}

// 事件委托：只绑定一次，消息怎么重绘都能接住点击
let playDelegationBound = false;
function bindPlayButtonDelegation() {
  if (playDelegationBound) return;
  playDelegationBound = true;

  $(document).on("click", ".tts-bar-toggle-inline-btn", function (e) {
    e.preventDefault();
    e.stopPropagation();
    const nextOn = !shouldKeepPlayerBarVisible();
    setPersistentPlayerBarEnabled(nextOn, nextOn ? this : null);
  });

  $(document).on("click", ".tts-manual-play-btn", async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const playBtn = $(this);
    const messageElement = playBtn.closest(".mes");
    try {
      ttsLog("👆 点击 ▶");
      primeAudioOnce();

      // 再点正在播放的按钮 = 停止
      if (audioState.playingButton && audioState.playingButton[0] === playBtn[0]) {
        ttsLog("⏹ 再次点击 → 停止");
        if (audioState.currentAudio) audioState.currentAudio.pause();
        resetPlayState();
        return;
      }

      let messageText = getMessageSourceText(messageElement);
      if (!messageText) {
        ttsLog("❌ 这条消息读不到文字（空/折叠块）");
        toastr.warning("这条消息没有可朗读的文字，换一条角色回复试试。", "TTS");
        return;
      }
      ttsLog("原文长度 " + messageText.length);

      let textToRead = prepareTextForTts(messageText);
      if (!textToRead) {
        ttsLog("⚠ 额外提取规则过滤后没有可朗读文字");
        toastr.warning("这条消息按当前标签规则没有可朗读内容。", "TTS");
        return;
      }
      ttsLog("✂ 最终朗读文本 " + textToRead.length + " 字");

      const speakerName = getMessageSpeakerName(messageElement);
      const voiceForSpeaker = getVoiceForSpeaker(speakerName);
      if (speakerName) ttsLog("🎭 说话人：" + speakerName + "，音色=" + voiceForSpeaker);
      await generateTTS(textToRead, playBtn, voiceForSpeaker);
    } catch (err) {
      ttsLog("❌ 点击处理异常：" + (err && err.message ? err.message : err));
      resetPlayState();
    }
  });
}

// 按设置里的开始/结束符号提取文本；提取不到返回空串
// 把各种弯引号、全角引号统一成直引号，这样无论标记设直/弯都能匹配
function normalizeQuotes(s) {
  if (!s) return s;
  return s
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u3003\uFF02]/g, '"')   // “ ” „ ‟ ″ 〃 ＂ → "
    .replace(/[\u2018\u2019\u201A\u201B\u2032\uFF07]/g, "'");        // ‘ ’ ‚ ‛ ′ ＇ → '
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTagBlocks(message, pairs) {
  const blocks = [];
  getEnabledTagPairs(pairs).forEach(pair => {
    let cursor = 0;
    let literalMatched = false;
    while (pair.start && pair.end) {
      const startIndex = message.indexOf(pair.start, cursor);
      if (startIndex === -1) break;
      const contentStart = startIndex + pair.start.length;
      const endIndex = message.indexOf(pair.end, contentStart);
      if (endIndex === -1) break;
      literalMatched = true;
      blocks.push({
        start: startIndex,
        end: endIndex + pair.end.length,
        text: message.slice(contentStart, endIndex).trim(),
      });
      cursor = endIndex + pair.end.length;
    }
    if (literalMatched) return;

    const startMatch = pair.start.match(/^<\s*([^\s>/]+)[^>]*>$/);
    const endMatch = pair.end.match(/^<\s*\/\s*([^\s>]+)\s*>$/);
    const startPattern = startMatch ? `<\\s*${escapeRegex(startMatch[1])}(?:\\s[^>]*)?>` : escapeRegex(pair.start);
    const endPattern = endMatch ? `<\\s*\\/\\s*${escapeRegex(endMatch[1])}\\s*>` : escapeRegex(pair.end);
    const re = new RegExp(startPattern + "([\\s\\S]*?)" + endPattern, "gi");
    let match;
    while ((match = re.exec(message)) !== null) {
      blocks.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[1].trim(),
      });
    }
  });
  return blocks.sort((a, b) => a.start - b.start);
}

function removeRanges(message, ranges) {
  if (!ranges.length) return message;
  let result = "";
  let cursor = 0;
  ranges.sort((a, b) => a.start - b.start).forEach(range => {
    if (range.start < cursor) return;
    result += message.slice(cursor, range.start);
    cursor = range.end;
  });
  result += message.slice(cursor);
  return result;
}

function textOutsideRanges(message, ranges) {
  return removeRanges(message, ranges)
    .replace(/<[^>]+>/g, " ")
    .trim();
}

function stripAllTagBlocks(message) {
  return String(message || "")
    .replace(/<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .trim();
}

function getAllConfiguredTagBlocks(message) {
  const allPairs = [
    ...(extension_settings[extensionName].skipTagPairs || []),
    ...(extension_settings[extensionName].readTagPairs || []),
  ].filter(pair => pair?.start && pair?.end);
  return findTagBlocks(message, allPairs);
}

function getConfiguredReadTagBlocks(message) {
  const readPairs = (extension_settings[extensionName].readTagPairs || [])
    .filter(pair => pair?.start && pair?.end);
  return findTagBlocks(message, readPairs);
}

function normalizeTtsWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(text || "");
  return textarea.value;
}

function getMessageSourceText(messageElement) {
  const mesId = Number.parseInt(messageElement.attr("mesid"), 10);
  const context = getContext();
  const rawMessage = Number.isFinite(mesId) ? context?.chat?.[mesId]?.mes : "";
  if (extension_settings[extensionName].extraTextRulesEnabled === true && rawMessage) {
    return String(rawMessage).trim();
  }

  const mainText = messageElement.find(".mes_text").first();
  if (extension_settings[extensionName].extraTextRulesEnabled === true && mainText.length > 0) {
    const html = mainText.html() || "";
    return decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, "\n")).trim();
  }
  let text = mainText.text().trim();
  if (!text) {
    text = messageElement.find(".mes_reasoning_content, .mes_reasoning, .mes_block").text().trim();
  }
  return text;
}

function prepareTextForTts(message) {
  if (extension_settings[extensionName].extraTextRulesEnabled === true) {
    const skipPairs = getEnabledTagPairs(extension_settings[extensionName].skipTagPairs);
    const readPairs = getEnabledTagPairs(extension_settings[extensionName].readTagPairs);
    const includeUntagged = extension_settings[extensionName].readUntaggedWithRequired === true;
    let working = String(message || "");

    const skipBlocks = findTagBlocks(working, skipPairs);
    if (skipBlocks.length > 0) {
      working = removeRanges(working, skipBlocks);
    }

    const parts = [];

    let readBlocks = [];
    if (readPairs.length > 0) {
      readBlocks = findTagBlocks(working, readPairs);
      ttsLog("🏷 只读范围：启用 " + readPairs.length + " 组，命中 " + readBlocks.length + " 段");
      for (const block of readBlocks) {
        const marked = extractMarkedText(block.text);
        if (marked) {
          ttsLog("🏷 只读范围片段：提取到 " + marked.length + " 字");
          parts.push(marked);
        } else {
          ttsLog("⚠ 只读范围片段：命中了标签，但里面没有命中当前符号规则");
        }
      }
    }

    if (parts.length > 0) {
      return normalizeTtsWhitespace(parts.join("，"));
    }

    if (readPairs.length > 0 && readBlocks.length === 0 && includeUntagged) {
      const ordinaryText = textOutsideRanges(working, getAllConfiguredTagBlocks(working));
      const markedText = extractMarkedText(ordinaryText);
      return normalizeTtsWhitespace(markedText || ordinaryText);
    }

    if (readPairs.length === 0) {
      const configuredReadBlocks = getConfiguredReadTagBlocks(working);
      const ordinaryText = includeUntagged ? removeRanges(working, configuredReadBlocks) : working;
      const markedText = extractMarkedText(ordinaryText);
      return normalizeTtsWhitespace(markedText || ordinaryText);
    }

    return "";
  }

  const fullText = normalizeTtsWhitespace(message);
  if (!fullText) return "";
  const markedText = extractMarkedText(fullText);
  return normalizeTtsWhitespace(markedText || fullText);
}

function parseSymbolPairs(startRaw, endRaw) {
  const starts = normalizeQuotes(startRaw).split(/\s+/).filter(Boolean);
  const ends = normalizeQuotes(endRaw).split(/\s+/).filter(Boolean);
  const pairCount = Math.min(starts.length, ends.length);
  if (pairCount === 0) return [];
  return Array.from({ length: pairCount }, (_, index) => ({
    start: starts[index],
    end: ends[index],
    key: `${starts[index]}→${ends[index]}`,
  }));
}

function getSymbolConflictKeys(insidePairs, outsidePairs) {
  const outsideKeys = new Set(outsidePairs.map(pair => pair.key));
  return new Set(insidePairs.filter(pair => outsideKeys.has(pair.key)).map(pair => pair.key));
}

function getCurrentSymbolPairs() {
  const getSymbolValue = (selector, settingKey, defaultKey) => {
    const uiValue = $(selector).length ? $(selector).val() : "";
    const savedValue = extension_settings[extensionName]?.[settingKey];
    const defaultValue = defaultSettings[defaultKey];
    return String(uiValue || savedValue || defaultValue || "");
  };
  const insidePairs = parseSymbolPairs(getSymbolValue("#image_text_start", "textStart", "textStart"), getSymbolValue("#image_text_end", "textEnd", "textEnd"));
  const outsidePairs = parseSymbolPairs(getSymbolValue("#tts_symbol_outside_start", "symbolOutsideStart", "symbolOutsideStart"), getSymbolValue("#tts_symbol_outside_end", "symbolOutsideEnd", "symbolOutsideEnd"));
  return { insidePairs, outsidePairs, conflictKeys: getSymbolConflictKeys(insidePairs, outsidePairs) };
}

function updateSymbolConflictUI() {
  const readInside = $("#tts_read_symbol_inside").prop("checked") === true;
  const readOutside = $("#tts_read_symbol_outside").prop("checked") === true;
  const conflictCount = readInside && readOutside ? getCurrentSymbolPairs().conflictKeys.size : 0;
  const hasConflict = conflictCount > 0;
  $("#image_text_start, #image_text_end, #tts_symbol_outside_start, #tts_symbol_outside_end")
    .toggleClass("sf-symbol-conflict", hasConflict);
  $("#tts_symbol_conflict_hint").toggle(hasConflict);
}

function collectSymbolMatches(message, pairs) {
  if (!pairs.length) return [];

  // 引号通用化：消息和符号都规整一遍，直/弯引号互通
  message = normalizeQuotes(message);

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerPattern = (symbol) => {
    if (symbol === "（" || symbol === "(") return "[（(]";
    if (symbol === "）" || symbol === ")") return "[）)]";
    return esc(symbol);
  };
  const found = []; // {start, pos, end, text}

  for (const pair of pairs) {
    const s = pair.start, e = pair.end;
    const quoteLike = (s === '"' || e === '"' || s === "'" || e === "'");
    if (quoteLike || s === e) {
      // 起止相同（如引号）：用配对算法
      let inside = false, cur = "", startPos = -1;
      for (let i = 0; i < message.length; i++) {
        const ch = message[i];
        const isMarker = quoteLike ? (ch === s || ch === e) : ch === s;
        if (isMarker) {
          if (!inside) { inside = true; cur = ""; startPos = i; }
          else {
            if (cur.trim()) found.push({ start: startPos, pos: startPos, end: i + ch.length, text: cur.trim() });
            inside = false;
            cur = "";
          }
        } else if (inside) { cur += ch; }
      }
    } else {
      // 起止不同（如 【】（））：用正则
      const re = new RegExp(markerPattern(s) + "([\\s\\S]*?)" + markerPattern(e), "g");
      let m;
      while ((m = re.exec(message)) !== null) {
        if (m[1].trim()) found.push({ start: m.index, pos: m.index, end: m.index + m[0].length, text: m[1].trim() });
      }
    }
  }

  return found;
}

function extractTextInsideSymbols(message, pairs) {
  const found = collectSymbolMatches(message, pairs);
  if (found.length === 0) return "";
  // 按在消息里出现的先后顺序合并，读起来顺
  found.sort((a, b) => a.pos - b.pos);
  return found.map(f => f.text).join("，");
}

function extractTextOutsideSymbols(message, pairs) {
  const normalizedMessage = normalizeQuotes(message);
  const found = collectSymbolMatches(normalizedMessage, pairs)
    .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end));
  if (found.length === 0) return "";
  ttsLog("✂ 不读此符内：已剔除 " + found.length + " 段");
  return normalizeTtsWhitespace(removeRanges(normalizedMessage, found)) || " ";
}

function extractMarkedText(message) {
  const readInside = $("#tts_read_symbol_inside").length
    ? $("#tts_read_symbol_inside").prop("checked") === true
    : extension_settings[extensionName].symbolReadInside !== false;
  const readOutside = $("#tts_read_symbol_outside").length
    ? $("#tts_read_symbol_outside").prop("checked") === true
    : extension_settings[extensionName].symbolReadOutside === true;

  const { insidePairs, outsidePairs, conflictKeys } = getCurrentSymbolPairs();
  const usableInsidePairs = readInside ? insidePairs.filter(pair => !conflictKeys.has(pair.key)) : [];
  const usableOutsidePairs = readOutside ? outsidePairs.filter(pair => !conflictKeys.has(pair.key)) : [];
  if (readInside && readOutside && conflictKeys.size > 0) {
    ttsLog("⚠ 符号打架：" + Array.from(conflictKeys).join("、") + "，打架的符号已跳过");
    console.warn("符号打架：", Array.from(conflictKeys));
  }

  let working = String(message || "");
  if (usableOutsidePairs.length > 0) {
    const outsideText = extractTextOutsideSymbols(working, usableOutsidePairs);
    if (outsideText) {
      working = outsideText;
    } else {
      ttsLog("⚠ 不读此符内：没有匹配到可排除的符号");
    }
  }

  if (usableInsidePairs.length > 0) {
    const insideText = extractTextInsideSymbols(working, usableInsidePairs);
    if (insideText) return insideText;
    return working !== String(message || "") ? working : "";
  }

  return working !== String(message || "") ? working : "";
}

// 监听消息事件，自动提取文本并生成语音
function setupMessageListener() {
  console.log('设置消息监听器');
  console.log('事件类型:', event_types);
  console.log('eventSource 对象:', eventSource);
  
  // 测试事件是否正常触发
  try {
    // 测试监听所有消息事件
    console.log('尝试监听所有消息相关事件...');
    
    // 监听消息添加事件
    if (event_types.MESSAGE_SENT) {
      eventSource.on(event_types.MESSAGE_SENT, () => {
        console.log('检测到MESSAGE_SENT事件');
      });
    }
    
    // 监听消息接收事件
    if (event_types.MESSAGE_RECEIVED) {
      eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        console.log('检测到MESSAGE_RECEIVED事件');
      });
    }
    
    // 监听聊天更新事件  
    if (event_types.CHAT_CHANGED) {
      eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('检测到CHAT_CHANGED事件');
      });
    }
  } catch (error) {
    console.error('设置测试监听器出错:', error);
  }
  
  // 监听SillyTavern的消息事件
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
    console.log('角色消息渲染:', messageId);
    
    // 防止重复处理同一条消息
    if (audioState.lastProcessedMessageId === messageId) {
      console.log('消息已处理，跳过:', messageId);
      return;
    }
    
    console.log('新消息，准备处理:', messageId);
    
    // 检查是否开启自动朗读
    const autoPlay = $("#auto_play_audio").prop("checked");
    if (!autoPlay) {
      console.log('自动朗读未开启');
      return;
    }
    
    // 清除之前的延时器
    if (audioState.processingTimeout) {
      clearTimeout(audioState.processingTimeout);
    }
    
    // 使用防抖处理，等待消息完全渲染
    audioState.processingTimeout = setTimeout(() => {
      console.log('延时处理开始:', messageId);
      // 再次检查是否已处理
      if (audioState.lastProcessedMessageId === messageId) {
        console.log('消息在延迟期间已被处理，跳过');
        return;
      }
      
      // 标记为已处理
      audioState.lastProcessedMessageId = messageId;
      console.log('处理消息:', messageId);
      const messageElement = $(`.mes[mesid="${messageId}"]`);
      console.log('查找消息元素:', messageElement.length > 0 ? '找到' : '未找到');
      
      const message = getMessageSourceText(messageElement);
      console.log('消息内容长度:', message ? message.length : 0);
      
      if (!message) {
        console.log('消息内容为空');
        return;
      }

      const textToRead = prepareTextForTts(message);
      if (!textToRead) {
        console.log('按当前标签/符号规则没有可朗读内容，跳过自动朗读');
        return;
      }
      console.log('自动朗读最终文本:', textToRead.substring(0, 100));
      const speakerName = getMessageSpeakerName(messageElement);
      const voiceForSpeaker = getVoiceForSpeaker(speakerName);
      if (speakerName) ttsLog("🎭 自动朗读说话人：" + speakerName + "，音色=" + voiceForSpeaker);
      generateTTS(textToRead, null, voiceForSpeaker);
      return;
      
      const textStart = $("#image_text_start").val();
      const textEnd = $("#image_text_end").val();
      
      console.log('检查标记:', { textStart, textEnd, 消息内容: message.substring(0, 100) });
      
      if (textStart && textEnd) {
        let extractedTexts = [];
        
        // 添加调试日志
        console.log('原始消息:', message);
        console.log('消息中的引号位置:');
        for (let i = 0; i < message.length; i++) {
          if (message[i] === '"' || message[i] === '"' || message[i] === '"' || message[i] === '"') {
            console.log(`位置${i}: "${message[i]}" (字符码: ${message[i].charCodeAt(0)})`);
          }
        }
        
        // 判断开始和结束符号是否相同（如英文引号）
        if (textStart === textEnd) {
          // 相同标记：使用更智能的配对算法
          let insideQuote = false;
          let currentText = '';
          let pairCount = 0;
          
          for (let i = 0; i < message.length; i++) {
            const char = message[i];
            
            if (char === textStart) {
              if (!insideQuote) {
                // 开始引号
                console.log(`位置${i}: 开始第${pairCount + 1}对引号`);
                insideQuote = true;
                currentText = '';
              } else {
                // 结束引号
                console.log(`位置${i}: 结束第${pairCount + 1}对引号，内容: "${currentText}"`);
                if (currentText.trim()) {
                  extractedTexts.push(currentText.trim());
                  pairCount++;
                  console.log(`提取第${pairCount}对引号内容:`, currentText.trim());
                }
                insideQuote = false;
                currentText = '';
              }
            } else if (insideQuote) {
              currentText += char;
            }
          }
        } else {
          // 不同标记：使用正则表达式
          const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const escapedStart = escapeRegex(textStart);
          const escapedEnd = escapeRegex(textEnd);
          
          const regex = new RegExp(`${escapedStart}(.*?)${escapedEnd}`, 'g');
          const matches = message.match(regex);
          
          if (matches && matches.length > 0) {
            console.log(`找到${matches.length}个标记内容`);
            
            matches.forEach(match => {
              const cleanText = match.replace(textStart, '').replace(textEnd, '').trim();
              if (cleanText) {
                extractedTexts.push(cleanText);
              }
            });
          }
        }
        
        if (extractedTexts.length > 0) {
          const finalText = extractedTexts.join(' ');
          console.log('自动朗读标记内文本:', finalText);
          generateTTS(finalText);
          return; // 重要：找到标记就不读全文
        }
        
        // 设置了标记但没找到匹配内容，不朗读
        console.log('设置了标记但未找到匹配内容，跳过朗读');
      } else {
        // 没有设置标记，朗读全文
        console.log('未设置标记，自动朗读全文:', message.substring(0, 100));
        console.log('开始生成TTS...');
        generateTTS(message);
      }
    }, 1000); // 延迟1000ms等待DOM完全更新，包括世界书和COT
  });
  
  // 用户消息监听
  eventSource.on(event_types.USER_MESSAGE_RENDERED, async (messageId) => {
    console.log('用户消息渲染:', messageId);
    
    // 防止重复处理同一条用户消息
    if (audioState.lastProcessedUserMessageId === messageId) {
      console.log('用户消息已处理，跳过:', messageId);
      return;
    }
    
    const autoPlayUser = $("#auto_play_user").prop("checked");
    if (!autoPlayUser) {
      console.log('用户消息自动朗读未开启');
      return;
    }
    console.log('用户消息自动朗读已开启');
    
    // 标记为已处理
    audioState.lastProcessedUserMessageId = messageId;
    
    setTimeout(() => {
      console.log('用户消息延时处理开始:', messageId);
      const messageElement = $(`.mes[mesid="${messageId}"]`);
      console.log('用户消息元素:', messageElement.length > 0 ? '找到' : '未找到');
      
      const message = getMessageSourceText(messageElement);
      console.log('用户消息内容长度:', message ? message.length : 0);
      if (!message) {
        console.log('用户消息内容为空');
        return;
      }

      const textToRead = prepareTextForTts(message);
      if (!textToRead) {
        console.log('用户消息按当前标签/符号规则没有可朗读内容，跳过自动朗读');
        return;
      }
      console.log('用户消息自动朗读最终文本:', textToRead.substring(0, 100));
      generateTTS(textToRead);
      return;
      
      const textStart = $("#image_text_start").val();
      const textEnd = $("#image_text_end").val();
      
      console.log('用户消息 - 检查标记:', { textStart, textEnd, 消息内容: message.substring(0, 100) });
      
      if (textStart && textEnd) {
        let extractedTexts = [];
        
        // 添加调试日志
        console.log('用户原始消息:', message);
        console.log('用户消息中的引号位置:');
        for (let i = 0; i < message.length; i++) {
          if (message[i] === '"' || message[i] === '"' || message[i] === '"' || message[i] === '"') {
            console.log(`位置${i}: "${message[i]}" (字符码: ${message[i].charCodeAt(0)})`);
          }
        }
        
        // 判断开始和结束符号是否相同（如英文引号）
        if (textStart === textEnd) {
          // 相同标记：使用更智能的配对算法
          let insideQuote = false;
          let currentText = '';
          let pairCount = 0;
          
          for (let i = 0; i < message.length; i++) {
            const char = message[i];
            
            if (char === textStart) {
              if (!insideQuote) {
                // 开始引号
                console.log(`用户消息 - 位置${i}: 开始第${pairCount + 1}对引号`);
                insideQuote = true;
                currentText = '';
              } else {
                // 结束引号
                console.log(`用户消息 - 位置${i}: 结束第${pairCount + 1}对引号，内容: "${currentText}"`);
                if (currentText.trim()) {
                  extractedTexts.push(currentText.trim());
                  pairCount++;
                  console.log(`用户消息 - 提取第${pairCount}对引号内容:`, currentText.trim());
                }
                insideQuote = false;
                currentText = '';
              }
            } else if (insideQuote) {
              currentText += char;
            }
          }
        } else {
          // 不同标记：使用正则表达式
          const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const escapedStart = escapeRegex(textStart);
          const escapedEnd = escapeRegex(textEnd);
          
          const regex = new RegExp(`${escapedStart}(.*?)${escapedEnd}`, 'g');
          const matches = message.match(regex);
          
          if (matches && matches.length > 0) {
            console.log(`用户消息 - 找到${matches.length}个标记内容`);
            
            matches.forEach(match => {
              const cleanText = match.replace(textStart, '').replace(textEnd, '').trim();
              if (cleanText) {
                extractedTexts.push(cleanText);
              }
            });
          }
        }
        
        if (extractedTexts.length > 0) {
          const finalText = extractedTexts.join(' ');
          console.log('用户消息 - 自动朗读标记内文本:', finalText);
          generateTTS(finalText);
          return;
        }
        
        // 设置了标记但没找到匹配内容，不朗读
        console.log('用户消息 - 设置了标记但未找到匹配内容，跳过朗读');
      } else {
        // 没有设置标记，朗读全文
        console.log('用户消息 - 未设置标记，自动朗读全文:', message.substring(0, 100));
        generateTTS(message);
      }
    }, 500);
  });

  // 给每条消息补上小喇叭按钮：消息渲染、切换聊天时各注入一次，再加兜底巡逻
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    setTimeout(injectPlayButton, 200);
    setTimeout(ensurePersistentPlayerBar, 250);
  });
  eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
    setTimeout(injectPlayButton, 200);
    setTimeout(ensurePersistentPlayerBar, 250);
  });
  if (event_types.CHAT_CHANGED) {
    eventSource.on(event_types.CHAT_CHANGED, () => {
      setTimeout(injectPlayButton, 300);
      setTimeout(ensurePersistentPlayerBar, 350);
    });
  }
  setInterval(injectPlayButton, 2000);
}

// 克隆音色功能
async function uploadVoice() {
  const apiKey = extension_settings[extensionName].apiKey;
  const voiceName = $("#clone_voice_name").val();
  const voiceText = $("#clone_voice_text").val();
  const audioInput = $("#clone_voice_audio")[0];
  const audioFile = audioInput && audioInput.files ? audioInput.files[0] : null;
  
  if (!apiKey) {
    toastr.error("请先配置API密钥", "克隆音色错误");
    return;
  }
  
  if (!voiceName || !voiceText || !audioFile) {
    toastr.error("请填写音色名称、参考文本并选择音频文件", "克隆音色错误");
    return;
  }
  
  // 验证音色名称格式
  const namePattern = /^[a-zA-Z0-9_-]+$/;
  if (!namePattern.test(voiceName)) {
    toastr.error("音色名称只能包含英文字母、数字、下划线和连字符", "格式错误");
    return;
  }
  
  if (voiceName.length > 64) {
    toastr.error("音色名称不能超过64个字符", "格式错误");
    return;
  }

  if (audioFile.size <= 0) {
    toastr.error("参考音频文件是空的，请重新导入一段 mp3 或 wav。", "克隆音色错误");
    return;
  }

  // 前置校验：只接受音频文件（iOS 上 file.type 可能为空，要用扩展名兜底）
  const audioExts = ["mp3", "wav", "m4a", "aac", "ogg", "flac", "weba", "opus"];
  const fileExt = String(audioFile.name || "").split(".").pop().toLowerCase();
  const looksAudio = (audioFile.type && audioFile.type.startsWith("audio/")) || audioExts.includes(fileExt);
  if (!looksAudio) {
    toastr.error(`「${audioFile.name || "这个文件"}」不是音频文件。请导入 mp3 / wav / m4a 等音频，视频文件（如 mp4）硅基不收。`, "克隆音色错误");
    return;
  }
  
  try {
    console.log("开始上传音色...");

    const formData = new FormData();
    formData.append('model', 'FunAudioLLM/CosyVoice2-0.5B');
    formData.append('customName', voiceName);
    formData.append('text', voiceText);
    formData.append('file', audioFile, audioFile.name || 'reference_audio.mp3');

    let response = await fetch(`${extension_settings[extensionName].apiUrl}/uploads/audio/voice`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const fileErrorText = await response.text();
      console.error("Upload file error response:", fileErrorText);

      const base64Audio = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error("读取参考音频失败，请重新选择音频文件"));
        reader.readAsDataURL(audioFile);
      });

      response = await fetch(`${extension_settings[extensionName].apiUrl}/uploads/audio/voice`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'FunAudioLLM/CosyVoice2-0.5B',
          customName: voiceName,
          text: voiceText,
          audio: base64Audio
        })
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      let friendlyMessage = `HTTP ${response.status}: ${errorText}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson?.code === 20022 || /file not found/i.test(errorJson?.message || "")) {
          friendlyMessage = "接口没有收到参考音频文件。请重新点“导入参考音频”，选择本机 mp3/wav 后再上传；如果是手机端，尽量不要选云盘里还没下载到本机的音频。";
        }
      } catch (e) {
        if (/file not found/i.test(errorText)) {
          friendlyMessage = "接口没有收到参考音频文件。请重新导入本机音频后再上传。";
        }
      }
      throw new Error(friendlyMessage);
    }

    const data = await response.json();
    console.log("音色上传成功:", data);

    // 清空输入
    $("#clone_voice_name").val("");
    $("#clone_voice_text").val("");
    $("#clone_voice_audio").val("");
    $("#clone_voice_audio_name").text("未选择音频");

    toastr.success(`音色 "${voiceName}" 克隆成功！`, "克隆音色");

    // 刷新音色列表
    await loadCustomVoices();
    
  } catch (error) {
    console.error("Voice Clone Error:", error);
    toastr.error(`音色克隆失败: ${error.message}`, "克隆音色错误");
  }
}

// 获取自定义音色列表
async function loadCustomVoices() {
  const apiKey = extension_settings[extensionName].apiKey;
  
  if (!apiKey) return;
  
  try {
    const response = await fetch(`${extension_settings[extensionName].apiUrl}/audio/voice/list`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    console.log("自定义音色列表:", data);
    
    // 保存到设置 - 注意API返回的是result不是results
    extension_settings[extensionName].customVoices = data.result || data.results || [];
    
    // 打印第一个音色的结构以便调试
    if (extension_settings[extensionName].customVoices.length > 0) {
      console.log("第一个自定义音色结构:", extension_settings[extensionName].customVoices[0]);
    }
    
    // 更新UI显示
    updateCustomVoicesList();
    updateVoiceOptions();
    
  } catch (error) {
    console.error("Load Custom Voices Error:", error);
  }
}

// 更新自定义音色列表显示
function updateCustomVoicesList() {
  const customVoices = extension_settings[extensionName].customVoices || [];
  const listContainer = $("#custom_voices_list");
  
  if (customVoices.length === 0) {
    listContainer.html("<small>暂无自定义音色</small>");
    return;
  }
  
  let html = "";
  customVoices.forEach(voice => {
    const voiceName = voice.name || voice.customName || voice.custom_name || "未命名";
    const voiceUri = voice.uri || voice.id || voice.voice_id;
    html += `
      <div class="custom-voice-item" style="margin: 5px 0; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
        <span>${voiceName}</span>
        <button class="menu_button delete-voice" data-uri="${voiceUri}" data-name="${voiceName}" style="float: right; padding: 2px 8px; font-size: 12px;">删除</button>
      </div>
    `;
  });
  
  listContainer.html(html);
}

// 删除自定义音色
async function deleteCustomVoice(uri, name) {
  const apiKey = extension_settings[extensionName].apiKey;
  
  if (!apiKey) {
    toastr.error("请先配置API密钥", "删除音色错误");
    return;
  }
  
  if (!confirm(`确定要删除音色 "${name}" 吗？`)) {
    return;
  }
  
  try {
    const response = await fetch(`${extension_settings[extensionName].apiUrl}/audio/voice/deletions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uri: uri })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    toastr.success(`音色 "${name}" 已删除`, "删除成功");
    
    // 刷新列表
    await loadCustomVoices();
    
  } catch (error) {
    console.error("Delete Voice Error:", error);
    toastr.error(`删除失败: ${error.message}`, "删除音色错误");
  }
}

// jQuery加载时初始化
jQuery(async () => {
  const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
  $("#extensions_settings").append(settingsHtml);

  // 使用说明里的图片：相对路径会指到酒馆首页，要补扩展目录前缀
  $(".sf-guide img[data-guide]").each(function() {
    $(this).attr("src", `${extensionFolderPath}/${$(this).attr("data-guide")}`);
  });

  // 版本号动态注入（以 index.js 的 extensionVersion 为准，HTML 不再写死）
  $("#sf_version_text").text(extensionVersion);
  
  // Inline drawer 折叠/展开功能 - 使用延迟绑定
  setTimeout(() => {
    $('.siliconflow-extension-settings .inline-drawer-toggle').each(function() {
      $(this).off('click').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const $header = $(this);
        const $icon = $header.find('.inline-drawer-icon');
        const $content = $header.next('.inline-drawer-content');
        const isOpen = $content.data('open') === true;
        
        if (isOpen) {
          // 收起
          $content.data('open', false);
          $content.hide();
          $icon.removeClass('down');
        } else {
          // 展开
          $content.data('open', true);
          $content.show();
          $icon.addClass('down');
        }
      });
    });
  }, 100);
  
  // 绑定事件
  $("#save_siliconflow_settings").on("click", saveSettings);
  
  // 克隆音色功能事件
  $("#upload_voice").on("click", uploadVoice);
  $("#refresh_custom_voices").on("click", loadCustomVoices);
  $("#clone_voice_audio").on("change", function() {
    const file = this.files && this.files[0];
    $("#clone_voice_audio_name").text(file ? file.name : "未选择音频");
  });
  
  // 删除音色事件（使用事件委托）
  $(document).on("click", ".delete-voice", function() {
    const uri = $(this).data("uri");
    const name = $(this).data("name");
    deleteCustomVoice(uri, name);
  });
  
  // 自动保存复选框状态
  $("#auto_play_audio").on("change", function() {
    extension_settings[extensionName].autoPlay = $(this).prop("checked");
    saveSettingsDebounced();
    console.log("自动朗读角色消息:", $(this).prop("checked"));
  });
  
  $("#auto_play_user").on("change", function() {
    extension_settings[extensionName].autoPlayUser = $(this).prop("checked");
    saveSettingsDebounced();
    console.log("自动朗读用户消息:", $(this).prop("checked"));
  });
  
  // 符号设置自动保存
  $("#image_text_start, #image_text_end, #tts_symbol_outside_start, #tts_symbol_outside_end").on("input", function() {
    extension_settings[extensionName].textStart = $("#image_text_start").val();
    extension_settings[extensionName].textEnd = $("#image_text_end").val();
    extension_settings[extensionName].symbolOutsideStart = $("#tts_symbol_outside_start").val();
    extension_settings[extensionName].symbolOutsideEnd = $("#tts_symbol_outside_end").val();
    updateSymbolConflictUI();
    saveSettingsDebounced();
  });
  $("#tts_read_symbol_inside, #tts_read_symbol_outside").on("change", function() {
    extension_settings[extensionName].symbolReadInside = $("#tts_read_symbol_inside").prop("checked") === true;
    extension_settings[extensionName].symbolReadOutside = $("#tts_read_symbol_outside").prop("checked") === true;
    updateSymbolConflictUI();
    saveSettingsDebounced();
  });
  $("#tts_max_read_chars").on("input", function() {
    extension_settings[extensionName].ttsMaxReadChars = getTtsMaxReadChars();
    saveSettingsDebounced();
  });
  $("#tts_add_skip_tag").on("click", function() {
    addTagPairRow("skip");
  });
  $("#tts_add_read_tag").on("click", function() {
    addTagPairRow("read");
  });
  $("#tts_enable_extra_text_rules").on("change", function() {
    const enabled = $(this).prop("checked") === true;
    extension_settings[extensionName].extraTextRulesEnabled = enabled;
    updateExtraTextRulesUI(enabled);
    saveSettingsDebounced();
  });
  $(document).on("input", ".tts-tag-start", function() {
    const row = $(this).closest(".tts-tag-pair-row");
    const endInput = row.find(".tts-tag-end");
    const nextEnd = makeEndTagFromStart($(this).val());
    const previousAutoEnd = row.attr("data-auto-end") || "";
    if (!endInput.val().trim() || endInput.val().trim() === previousAutoEnd) {
      endInput.val(nextEnd);
      row.attr("data-auto-end", nextEnd);
    }
    updateTagPairPreview(row);
    extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
    extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
    saveSettingsDebounced();
  });
  $(document).on("input", ".tts-tag-end", function() {
    const row = $(this).closest(".tts-tag-pair-row");
    updateTagPairPreview(row);
    extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
    extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
    saveSettingsDebounced();
  });
  $(document).on("change", ".tts-tag-enabled", function() {
    extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
    extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
    saveSettingsDebounced();
  });
  $(document).on("click", ".tts-tag-remove", function() {
    $(this).closest(".tts-tag-pair-row").remove();
    extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
    extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
    saveSettingsDebounced();
  });
  $("#tts_read_untagged_with_required").on("change", function() {
    extension_settings[extensionName].readUntaggedWithRequired = $(this).prop("checked") === true;
    saveSettingsDebounced();
  });
  $("#test_siliconflow_connection").on("click", testConnection);

  // ===== 硅基设置自动保存（与火山/MiniMax 一致，输入即存） =====
  $("#siliconflow_api_key, #siliconflow_api_url").on("input", function() {
    extension_settings[extensionName].apiKey = String($("#siliconflow_api_key").val() || "").trim();
    extension_settings[extensionName].apiUrl = String($("#siliconflow_api_url").val() || "").trim();
    saveSettingsDebounced();
  });
  $("#tts_model").on("change", function() {
    extension_settings[extensionName].ttsModel = $(this).val();
    saveSettingsDebounced();
    updateVoiceOptions();
  });
  $("#tts_voice").on("change", function() {
    extension_settings[extensionName].ttsVoice = $(this).val();
    saveSettingsDebounced();
    console.log("选择的音色:", $(this).val());
    renderRoleVoiceMap();
  });
  $("#response_format, #sample_rate, #image_size").on("change", function() {
    extension_settings[extensionName].responseFormat = $("#response_format").val();
    extension_settings[extensionName].sampleRate = parseInt($("#sample_rate").val(), 10);
    extension_settings[extensionName].imageSize = $("#image_size").val();
    saveSettingsDebounced();
  });

  // ===== 保存API设置按钮（三引擎通用） =====
  $(document).on("click", ".sf-save-api-settings", function() {
    saveApiSettings();
  });
  $("#refresh_role_voices").on("click", function() {
    renderRoleVoiceMap();
    toastr.success("已刷新当前聊天角色", "多人音色");
  });
  $(document).on("change", ".tts-role-voice-select", function() {
    const roleName = $(this).closest(".sf-role-voice-row").attr("data-role-name");
    const voice = $(this).val();
    const map = getRoleVoiceMap();
    if (voice) map[roleName] = voice;
    else delete map[roleName];
    saveSettingsDebounced();
  });
  $("#tts_speed").on("input", function() {
    $("#tts_speed_value").text($(this).val());
  });
  $("#tts_gain").on("input", function() {
    $("#tts_gain_value").text($(this).val());
  });
  
  // TTS测试按钮
  $("#test_tts").on("click", async function() {
    primeAudioOnce(); // 用户手势内解锁音频
    // 先保存当前引擎选择的音色
    if (getEngine() === "volcano") {
      extension_settings[extensionName].volcSpeaker = $("#volc_speaker").val();
    } else if (getEngine() === "minimax") {
      extension_settings[extensionName].minimaxVoice = $("#minimax_voice").val();
    } else {
      extension_settings[extensionName].ttsVoice = $("#tts_voice").val();
    }
    const testText = $("#tts_test_text").val() || "你好，这是一个测试语音。";
    await generateTTS(testText);
  });
  
  // ===== 侧栏四块切换 =====
  $(".sf-nav-item").on("click", function() {
    const pane = $(this).attr("data-pane");
    $(".sf-nav-item").removeClass("sf-nav-active");
    $(this).addClass("sf-nav-active");
    $(".sf-pane").hide();
    $("#sf_pane_" + pane).show();
    if (pane === "cache") renderCachePanel();
  });

  // ===== 引擎切换 =====
  $("#tts_engine").on("change", function() {
    const v = $(this).val();
    extension_settings[extensionName].engine = v === "volcano" ? "volcano" : (v === "minimax" ? "minimax" : "siliconflow");
    updateEngineUI();
    saveSettingsDebounced();
    ttsLog("🔀 已切换到「" + ({ siliconflow: "硅基流动", volcano: "火山引擎", minimax: "MiniMax" }[getEngine()]) + "」");
  });

  // ===== 火山设置自动保存 =====
  $("#volc_app_id, #volc_access_key").on("input", function() {
    extension_settings[extensionName].volcAppId = String($("#volc_app_id").val() || "").trim();
    extension_settings[extensionName].volcAccessKey = String($("#volc_access_key").val() || "").trim();
    saveSettingsDebounced();
  });

  // ===== 我的复刻音色（火山） =====
  $("#volc_clone_add").on("click", function() {
    const id = String($("#volc_clone_id").val() || "").trim();
    const name = String($("#volc_clone_name").val() || "").trim() || id;
    if (!id) {
      toastr.error("请填写音色ID（S_xxx）", "复刻音色");
      return;
    }
    const s = extension_settings[extensionName];
    s.volcClonedVoices = Array.isArray(s.volcClonedVoices) ? s.volcClonedVoices : [];
    if (s.volcClonedVoices.some(v => v && v.id === id)) {
      toastr.warning("这个音色ID已经在列表里了", "复刻音色");
      return;
    }
    s.volcClonedVoices.push({ id, name });
    $("#volc_clone_id").val("");
    $("#volc_clone_name").val("");
    saveSettingsDebounced();
    renderVolcCloneList();
    buildVolcSpeakerOptions();
    renderRoleVoiceMap();
    ttsLog("🎤 已添加复刻音色：" + name + "（" + id + "）");
  });
  $(document).on("click", ".sf-clone-del", function() {
    const idx = Number($(this).attr("data-idx"));
    const list = extension_settings[extensionName]?.volcClonedVoices || [];
    if (idx >= 0 && idx < list.length) {
      const removed = list.splice(idx, 1)[0];
      saveSettingsDebounced();
      renderVolcCloneList();
      buildVolcSpeakerOptions();
      renderRoleVoiceMap();
      ttsLog("🗑 已移除复刻音色：" + (removed?.name || removed?.id || ""));
    }
  });
  $(document).on("click", ".sf-clone-verify", async function() {
    const idx = Number($(this).attr("data-idx"));
    const v = (extension_settings[extensionName]?.volcClonedVoices || [])[idx];
    if (!v) return;
    const statusEl = $("#sf_clone_status_" + idx);
    statusEl.text("查询中…").css("color", "#ffd54a");
    try {
      const r = await verifyVolcCloneVoice(v.id);
      statusEl.text(r.text).css("color", r.ok ? "#7bd88f" : "#ff8a80");
      ttsLog("🔍 复刻音色 " + v.id + " 状态：" + r.text);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      statusEl.text("❌ " + msg.slice(0, 24)).css("color", "#ff8a80").attr("title", msg);
      toastr.error(msg, "复刻音色验证");
      ttsLog("❌ 复刻音色验证失败：" + msg);
    }
  });
  $("#volc_speaker").on("change", function() {
    extension_settings[extensionName].volcSpeaker = $(this).val();
    saveSettingsDebounced();
    renderRoleVoiceMap();
  });
  $("#volc_speed").on("input", function() {
    $("#volc_speed_value").text($(this).val());
    extension_settings[extensionName].volcSpeed = parseFloat($(this).val()) || 1.0;
    saveSettingsDebounced();
  });

  // 火山测试连接：合成一句短文本并播放
  $("#test_volcano_connection").on("click", async function() {
    primeAudioOnce();
    const status = $("#volc_connection_status");
    status.text("测试中…").css("color", "#ffd54a");
    try {
      const blob = await synthesizeVolcano("你好，火山引擎连接成功。", getVolcSpeaker(), parseFloat($("#volc_speed").val()) || 1.0);
      playAudioUrl(URL.createObjectURL(blob));
      status.text("已连接").css("color", "green");
      ttsLog("✅ 火山引擎连接成功");
    } catch (e) {
      status.text("未连接").css("color", "red");
      ttsLog("❌ 火山引擎连接失败：" + (e && e.message ? e.message : e));
      toastr.error(e && e.message ? e.message : String(e), "火山引擎连接失败");
    }
  });

  // ===== MiniMax 设置自动保存 =====
  $("#minimax_api_key, #minimax_group_id, #minimax_custom_voice").on("input", function() {
    extension_settings[extensionName].minimaxApiKey = String($("#minimax_api_key").val() || "").trim();
    extension_settings[extensionName].minimaxGroupId = String($("#minimax_group_id").val() || "").trim();
    extension_settings[extensionName].minimaxCustomVoice = String($("#minimax_custom_voice").val() || "").trim();
    saveSettingsDebounced();
  });
  $("#minimax_api_host").on("change", function() {
    extension_settings[extensionName].minimaxApiHost = $(this).val();
    saveSettingsDebounced();
  });
  $("#minimax_model").on("change", function() {
    extension_settings[extensionName].minimaxModel = $(this).val();
    saveSettingsDebounced();
  });
  $("#minimax_voice").on("change", function() {
    extension_settings[extensionName].minimaxVoice = $(this).val();
    saveSettingsDebounced();
    renderRoleVoiceMap();
  });
  $("#minimax_speed").on("input", function() {
    $("#minimax_speed_value").text($(this).val());
    extension_settings[extensionName].minimaxSpeed = parseFloat($(this).val()) || 1.0;
    saveSettingsDebounced();
  });

  // MiniMax 测试连接：合成一句短文本并播放
  $("#test_minimax_connection").on("click", async function() {
    primeAudioOnce();
    const status = $("#minimax_connection_status");
    status.text("测试中…").css("color", "#ffd54a");
    try {
      const blob = await synthesizeMinimax("你好，MiniMax 连接成功。", getMinimaxVoice(), parseFloat($("#minimax_speed").val()) || 1.0);
      playAudioUrl(URL.createObjectURL(blob));
      status.text("已连接").css("color", "green");
      ttsLog("✅ MiniMax 连接成功");
    } catch (e) {
      status.text("未连接").css("color", "red");
      ttsLog("❌ MiniMax 连接失败：" + (e && e.message ? e.message : e));
      toastr.error(e && e.message ? e.message : String(e), "MiniMax 连接失败");
    }
  });

  // ===== 缓存面板操作（事件委托） =====
  $(document).on("click", ".sf-cache-play", function() {
    const entry = ttsAudioCache.get($(this).closest(".sf-cache-row").attr("data-key"));
    if (entry) {
      primeAudioOnce();
      playAudioUrl(entry.url);
    }
  });
  $(document).on("click", ".sf-cache-download", function() {
    const entry = ttsAudioCache.get($(this).closest(".sf-cache-row").attr("data-key"));
    if (!entry) return;
    const a = document.createElement("a");
    a.href = entry.url;
    a.download = `tts_${entry.engine}_${new Date(entry.time).toISOString().replace(/[:.]/g, "-")}.mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  $(document).on("click", ".sf-cache-delete", function() {
    const key = $(this).closest(".sf-cache-row").attr("data-key");
    const entry = ttsAudioCache.get(key);
    if (entry) {
      try { URL.revokeObjectURL(entry.url); } catch (e) {}
      ttsAudioCache.delete(key);
    }
    renderCachePanel();
  });
  $(document).on("click", ".sf-cache-clear", function() {
    const engine = $(this).attr("data-engine");
    ttsAudioCache.forEach((entry, key) => {
      const entryEngine = entry && (entry.engine === "volcano" || entry.engine === "minimax") ? entry.engine : "siliconflow";
      if (entryEngine === engine) {
        try { URL.revokeObjectURL(entry.url); } catch (e) {}
        ttsAudioCache.delete(key);
      }
    });
    renderCachePanel();
    const label = { siliconflow: "硅基流动", volcano: "火山引擎", minimax: "MiniMax" }[engine] || engine;
    toastr.success(`已清空${label}缓存`, "缓存");
  });
  // 缓存列头点击展开/收起（点到「清空」按钮时不触发）
  $(document).on("click", ".sf-cache-toggle", function(e) {
    if ($(e.target).closest(".sf-cache-clear").length) return;
    const engine = $(this).attr("data-engine");
    if (!engine || !(engine in cachePanelExpanded)) return;
    cachePanelExpanded[engine] = !cachePanelExpanded[engine];
    renderCachePanel();
  });

  // ===== 日志面板清空 =====
  $("#sf_log_clear").on("click", function() {
    $("#sf_settings_log_body").empty();
    const b = document.getElementById("tts-log-body");
    if (b) b.innerHTML = "";
  });

  // 加载设置
  await loadSettings();
  
  // 加载自定义音色列表
  await loadCustomVoices();
  
  // 设置消息监听器
  setupMessageListener();

  // 注入按钮高亮样式
  injectTTSStyle();

  // 启用点击事件委托（消息重绘也能接住点击）
  bindPlayButtonDelegation();

  // 首次触屏/点击时自动解锁移动端音频（只需成功一次，之后都能出声）
  $(document).on("pointerdown.ttsprime touchstart.ttsprime click.ttsprime", function () {
    primeAudioOnce();
    if (audioPrimed) $(document).off(".ttsprime");
  });

  // 初始化时给现有消息补上播放按钮
  setTimeout(injectPlayButton, 800);

  // 播放条：按开关决定是否常驻显示
  const barOn = shouldKeepPlayerBarVisible(); // 默认开
  if (barOn) {
    ensurePersistentPlayerBar();
    [600, 1500, 3000].forEach((ms) => setTimeout(ensurePersistentPlayerBar, ms));
  }
  setInterval(() => {
    injectPlayButton(); // ▶ 按钮始终维护
    const on = shouldKeepPlayerBarVisible();
    if (!on) return; // 开关关掉时不强制显示进度条
    if (!document.getElementById("tts-player-bar")) {
      ttsAudioEl = null;
      ensurePersistentPlayerBar();
    } else {
      ensurePersistentPlayerBar();
    }
  }, 2000);

  ttsLog("🟢 声林TTS已加载。点消息上的 ▶ 看每一步日志。");
  
  console.log("声林TTS语音插件已加载");
  console.log("自动朗读功能已启用，请在控制台查看调试信息");
  console.log('事件源:', eventSource);
  console.log('事件类型:', event_types);
  console.log('角色消息事件:', event_types.CHARACTER_MESSAGE_RENDERED);
  console.log('用户消息事件:', event_types.USER_MESSAGE_RENDERED);
});

export { generateTTS };

