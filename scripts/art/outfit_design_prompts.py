# Design-sheet prompts for the wardrobe (T-1261): one picture per character and group of five outfits, the
# character standing idle five times in a row, once in each outfit, for the owner to pick from before any
# full 36-frame sheet is drawn. Each picture is 5 columns (one outfit each) by 2 rows (idle, then waving). Prints [{name, prompt}] as JSON; names are <id>_design_<group>.
# usage: outfit_design_prompts.py [--char claude,grok] [--group all1,adult2]
# Outfits come in two ratings: "all" (all-ages, docs/pet-packs.md 内容要求) and "adult" (18+: only shown after
# the 18+ confirmation with adult content on; non-chibi characters only, see docs/compliance-review.md).
# Ids that src/core/outfits.js already has keep their id; the others are new.
import json, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from model_chan_prompts import CHARS, BODY, identity, arg

ALL = [
 ("scarf", "针织围巾套装", "a cosy oversized beige knit sweater, a long knitted scarf in her main accent colour, a knee-length pleated skirt, opaque tights and ankle boots"),
 ("casual", "休闲卫衣", "a loose oversized hoodie in her accent colour with the hood down, comfy jogger pants and chunky sneakers"),
 ("beret", "贝雷帽画家装", "a striped long-sleeved shirt, paint-splashed denim overall dungarees, a small flat beret worn tilted on the side of her head and canvas shoes"),
 ("pajamas", "毛绒睡衣", "fluffy long-sleeved polka-dot pajamas with long trousers in soft pastel tones of her colours, and fluffy slippers, no nightcap"),
 ("cat_ears", "猫耳家居服", "a soft pastel zip-up lounge hoodie with long sleeves, matching long lounge pants, a cat-ear headband and fluffy slippers"),
 ("yukata", "浴衣", "a long summer yukata with a flower pattern in her colours, a wide obi sash tied in a bow at the back, and wooden geta sandals"),
 ("couple_hoodie", "情侣卫衣", "a pink oversized hoodie with a big heart print on the front, a pleated mini skirt over opaque black tights and white sneakers"),
 ("flower_crown", "花冠长裙", "a flowing ankle-length white sundress with short puff sleeves, a crown of small flowers in her colours resting on her hair, and strappy sandals"),
 ("qipao", "长旗袍", "an elegant ankle-length qipao (cheongsam) in her accent colour with a high mandarin collar, short cap sleeves, embroidered flowers, side slits only up to the knee, and low heels"),
 ("idol", "偶像演出服", "a sparkly knee-length idol stage dress with layered frills, ribbons and a big bow in her colours, opaque tights, a small wrist microphone charm and shiny boots"),
]
ADULT = [
 ("maid", "性感女仆装", "a sexy short black maid dress with a low sweetheart neckline, a frilled white mini apron, a very short flared skirt, a frilled headband, black thigh-high stockings with garter straps and Mary Jane heels"),
 ("offshoulder_gown", "露背晚礼服", "a glamorous off-shoulder satin evening gown in her accent colour with a deep plunging neckline, an open back, a thigh-high leg slit, long satin gloves and stiletto heels"),
 ("retro_swimsuit", "高开衩连体泳衣", "a glossy high-cut one-piece swimsuit in her accent colour with a deep V neckline and side cut-outs at the waist, a thin gold waist chain and strappy heeled sandals"),
 ("silk_robe", "丝绸睡裙", "a short satin slip nightdress with lace trim and thin straps in her colours, a short open silk kimono robe slipping off one shoulder, and fluffy mule slippers"),
 ("office", "职场 OL", "an office-lady outfit: a fitted white blouse with the top buttons open, a tight black pencil mini skirt, sheer black pantyhose, black stiletto heels, thin glasses and a lanyard badge"),
 ("nurse", "护士服", "a tight short white nurse dress with a zip front and her accent colour trim, a small white nurse cap with a heart, white thigh-high stockings with garter straps and white heels"),
 ("stewardess", "空姐制服", "a flight attendant uniform in her accent colour: a fitted cropped jacket, a silk neck scarf, a short tight pencil skirt, sheer black pantyhose, heels and a small pillbox cap, no airline logo or text"),
 ("bunny", "兔女郎", "a bunny girl costume: a strapless glossy black satin bunny leotard, tall bunny ears headband, a white collar with a bow tie, white wrist cuffs, a fluffy tail, black fishnet pantyhose and black stiletto heels"),
 ("knit_dress", "黑丝毛衣裙", "a short off-shoulder ribbed knit sweater dress in a soft colour from her palette, sheer black thigh-high stockings with lace tops and ankle boots"),
 ("devil_cos", "小恶魔 COS", "a little-devil cosplay: a black corset top, a very short black ruffled skirt, small red devil horns headband, a thin devil tail, small bat wings, black garter stockings and platform boots"),
]
GROUPS = {"all1": ALL[:5], "all2": ALL[5:], "adult1": ADULT[:5], "adult2": ADULT[5:]}

# In the 18+ groups Groko keeps her slim build, but is described as a grown woman first: a petite figure in
# glamour clothes must never read as childlike (docs/compliance-review.md item ③).
ADULT_BODY = {"grok": ("She has a tall, slim fashion-model figure: long slender legs with thin thighs, narrow hips, a slim waist and a small bust with little cleavage, "
                      "clearly a grown woman of about 25 with a mature adult face, not curvy, not voluptuous.")}

# What stays from her own look in every outfit (her identity already keeps hair, ears, horns and wings).
KEEP = {"dafeiyu": "Keep her deep-blue whale tail with a forked fluke behind her and her whale-fin ears in every outfit."}
STYLE = ("Pixel art character outfit design sheet for a desktop pet game, 16-bit SNES-era style, crisp hard-edged pixels, limited palette, no anti-aliasing, no blur. "
         "A grid of exactly 5 columns and 2 rows (10 tall narrow cells), every cell the same size, with empty space between cells. "
         "Every cell shows the SAME character, full body from head to feet, the same height, facing the viewer. Each COLUMN is one outfit: "
         "the top row shows her standing relaxed in it, the bottom row shows her in the same outfit waving hello with a smile.")
SAFE = {
 "all": ("She is clearly an adult young woman, set age 18: adult body, small head, about 6.5 heads tall, adult face, not chibi, not childlike. "
         "All-ages fashion: nothing revealing, no cleavage, no lingerie look, cheerful friendly pose."),
 "adult": ("She is clearly an adult young woman, set age 18: adult body proportions, small head, about 6.5 heads tall, adult face, not chibi, not childlike. "
           "Adult glamour fashion that is sexy but never nude: opaque fabric always covers her nipples and crotch, nothing see-through over them, "
           "no nudity, no sexual acts; a confident playful pose."),
}

def colours(cid):
    return f"Use her own palette ({CHARS[cid].rsplit('Colours: ', 1)[1]}) for every outfit unless a colour is named."

def bg(cid):
    key = "green (#00FF00)" if cid == "gemini" else "magenta (#FF00FF)"
    return f"Background: perfectly flat solid pure {key} everywhere, no grid lines, no text, no labels, no shadows."

def jobs(only=None, groups=None):
    out = []
    for cid in CHARS:
        if only and cid not in only: continue
        for g, items in GROUPS.items():
            if groups and g not in groups: continue
            rating = "adult" if g.startswith("adult") else "all"
            cells = [f"Column {i + 1}: {desc}." for i, (_, _, desc) in enumerate(items)]
            parts = [STYLE, f"The character: {identity(cid).rstrip('.')}.", (ADULT_BODY if rating == "adult" else BODY).get(cid), KEEP.get(cid), colours(cid), "No hats except where named.",
                     SAFE[rating], *cells, bg(cid)]
            out.append({"name": f"{cid}_design_{g}", "outfits": [o for o, _, _ in items], "prompt": " ".join(p for p in parts if p)})
    return out

if __name__ == '__main__':
    only, groups = arg('--char'), arg('--group')
    print(json.dumps(jobs(only and only.split(','), groups and groups.split(',')), ensure_ascii=False))
