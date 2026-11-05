'use strict';
// 风格语音包 (docs/voice-packs.md §6): one pack = one voice style, not one character. Every style pack holds the
// same 通用台词 (core/voice-pack.js genericPackLines, lineSet "generic") read in a MiniMax system voice of that
// style, plus one 试听 line (`sample`) that introduces the style. scripts/voicepack-generate.js --style records
// them into catalog/voicepacks/<id>/; scripts/build-voice-catalog.js turns them into store archives and the
// index src/core/voice-catalog.json. Pure data, Electron-free.
//
// `style`: the key a pack's manifest carries (STYLE_KEYS); `label`: how the store names the style.
// `voice`: the MiniMax voice the lines are recorded with — also the engine voice of a character the owner gives
// this pack (core/voice-pack.js voiceForPack), so recorded lines and agent replies are one voice.

const STYLES = [
  {
    style: 'cute', id: 'style-cute', label: '可爱', name: '可爱 · 甜心少女', gender: 'female',
    description: '软糯甜美的少女音，句尾带点撒娇，适合元气、黏人的桌宠。',
    voice: { engine: 'minimax', voiceId: 'tianxin_xiaoling', label: 'MiniMax 甜心小玲', model: 'speech-2.8-turbo', params: { speed: 1.05, pitch: 1, vol: 1, emotion: 'happy' } },
    sample: '嗨嗨～我是软糯糯的可爱语音，以后就由我陪着你啦！',
  },
  {
    style: 'yujie', id: 'style-yujie', label: '御姐', name: '御姐 · 妩媚姐姐', gender: 'female',
    description: '低一点、慢一点的成熟女声，从容带笑，适合温柔可靠的大姐姐。',
    voice: { engine: 'minimax', voiceId: 'wumei_yujie', label: 'MiniMax 妩媚御姐', model: 'speech-2.8-turbo', params: { speed: 0.95, pitch: 0, vol: 1, emotion: 'calm' } },
    sample: '嗯，是我。累了就过来靠一会儿吧，姐姐在呢。',
  },
  {
    style: 'shaonian', id: 'style-shaonian', label: '少年', name: '少年 · 纯真学弟', gender: 'male',
    description: '清亮有活力的少年音，干净直率，适合阳光开朗的男孩子。',
    voice: { engine: 'minimax', voiceId: 'chunzhen_xuedi', label: 'MiniMax 纯真学弟', model: 'speech-2.8-turbo', params: { speed: 1.05, pitch: 0, vol: 1, emotion: 'happy' } },
    sample: '嘿！我是元气少年音，走，今天也一起加油吧！',
  },
  {
    style: 'chenwen', id: 'style-chenwen', label: '沉稳', name: '沉稳 · 可靠前辈', gender: 'male',
    description: '低沉平稳的成年男声，语速偏慢，适合冷静、靠谱的陪伴。',
    voice: { engine: 'minimax', voiceId: 'Chinese (Mandarin)_Reliable_Executive', label: 'MiniMax 沉稳高管', model: 'speech-2.8-turbo', params: { speed: 0.92, pitch: -1, vol: 1, emotion: 'calm' } },
    sample: '你好，我是沉稳的声音。事情一件件来，不着急，我陪你。',
  },
  {
    style: 'gaoxiao', id: 'style-gaoxiao', label: '搞笑', name: '搞笑 · 幽默大爷', gender: 'male',
    description: '抑扬顿挫的老顽童腔调，自带喜感，适合想天天被逗乐的你。',
    voice: { engine: 'minimax', voiceId: 'Chinese (Mandarin)_Humorous_Elder', label: 'MiniMax 搞笑大爷', model: 'speech-2.8-turbo', params: { speed: 1, pitch: 0, vol: 1, emotion: 'happy' } },
    sample: '哎哟喂，我来啦！听我说话保准你乐呵一整天，哈哈哈！',
  },
];

const STYLE_KEYS = STYLES.map((s) => s.style);
const byStyle = (key) => STYLES.find((s) => s.style === key) || null;
const labelOf = (key) => (byStyle(key) || {}).label || key;
// the version every pack recorded from this table starts at; bump a style's when its voice or lines change
const VERSION = '1.0.0';
// the line set every style pack covers (core/voice-pack.js LINE_SETS)
const LINE_SET = 'generic';

module.exports = { STYLES, STYLE_KEYS, VERSION, LINE_SET, byStyle, labelOf };
