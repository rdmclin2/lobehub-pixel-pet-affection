# Prompts for the model-chan meme sticker sheets (one 2x2 sheet per character). Prints [{name, prompt, captions}] as JSON.
#   python3 scripts/art/meme_prompts.py scripts/art > jobs.json
#   lh generate image -m gpt-image-2.5-sunburst -p lobehub "<prompt>"  ->  raw/<name>.png
#   python3 scripts/art/slice_memes.py raw/<name>.png src/renderer/assets/memes/<name> '["id1","id2","id3","id4"]'  (ids as in src/characters/<name>.json)
import json, sys
sys.path.insert(0, sys.argv[1])
from model_chan_prompts import CHARS
STICKERS = {
 "claude": [("让我想想", "finger on her chin, looking up thoughtfully, a small open book in her other hand"),
            ("整理笔记中", "sitting and writing neatly in a notebook with a pen, a cup of red tea beside her"),
            ("谢谢你", "a small polite bow with a shy blush and both hands together"),
            ("我不太确定", "an honest awkward smile with one sweat drop, palms up in a tiny shrug")],
 "grok":   [("哈！有意思", "a confident grin showing two tiny fangs, one hand on her hip, pointing forward"),
            ("就这？", "a smug half-lidded look, arms crossed, one eyebrow raised"),
            ("夜猫子上线", "waving cheerfully in front of a big pale crescent moon with tiny bats"),
            ("吐槽模式启动", "holding a small microphone, mid-rant with a speech-line effect, playful not angry")],
 "gemini": [("让我看看！", "leaning forward peeking through a big magnifying glass, one cat ear perked up"),
            ("好奇心爆棚", "sparkling star-shaped eyes, both fists up in excitement, tail fluffed"),
            ("多模态全开", "holding a camera in one hand and a music note and a picture card floating around her"),
            ("喵？", "head tilted in confusion, a question mark above her head, cat ears tilted")],
  "gpt":   [("很乐意帮忙！", "a bright warm smile, one hand raised in a cheerful wave, small sparkles around her"),
            ("以下是要点", "holding a long paper scroll with a neat numbered checklist, pointing at it with a pen"),
            ("让我重新生成", "sheepish smile, spinning a big circular refresh arrow above her head with one finger"),
            ("知识截止到……", "looking at a small desk calendar with a puzzled face and one sweat drop, tail curled in a question shape")],
}
out = []
for cid, items in STICKERS.items():
    cells = " ".join(f"Sticker {i+1} ({['top-left','top-right','bottom-left','bottom-right'][i]}): {pose}; caption text in bold rounded Chinese letters under her: “{cap}”." for i, (cap, pose) in enumerate(items))
    prompt = ("A 2x2 grid of four separate chat stickers (emoji meme sticker sheet) of the same anime character, each sticker centered in its own quarter on a plain pure white background with generous white space between stickers, no borders, no grid lines. "
              "Cute chibi sticker style with clean thick outlines and flat soft colours, all-ages, fully clothed and modest. "
              f"The character: {CHARS[cid]}. " + cells +
              " Draw each Chinese caption exactly as written, nothing else written anywhere; no logos, no watermarks.")
    out.append({"name": cid, "prompt": prompt, "captions": [c for c, _ in items], "poses": [p for _, p in items]})
print(json.dumps(out, ensure_ascii=False))
