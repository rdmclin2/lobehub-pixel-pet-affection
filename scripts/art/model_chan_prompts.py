# Prompts for the model-chan (模型娘) pixel sheets (scripts/art/model-chan.sh). Prints [{name, prompt}] as JSON.
# --halves: each sheet as two 4 x 2 halves (<id>_<sheet>_a = rows 1-2, _b = rows 3-4), so a figure gets about
#   twice the pixels of the 1024 x 1536 canvas; this is how the 166 x 226 and the HD 332 x 452 packs were made.
# Two generated sheets per character, both 4 columns x 4 rows = 8 actions x 2 frames:
#   <id>_base  -> the 8 actions every sprite pack has (same order as pixel_prompts.py / build_pixel_pack.py)
#   <id>_extra -> the 8 states only DeepSeek's video clips had (look, sad, hungry, eat_cookie, eat_fruit, play, hatch, evolve)
# Dafeiyu (DeepSeek): her chibi (Q) look stays with the dsh-pet clips; her pixel pack is drawn at the same
# adult proportions as the other model-chan (2026-10-29: the chibi pixel version did not match them), from
# ai-chan-sheets 设定图/03_DeepSeek娘_鲸鱼娘 with covered shoulders.
# Identity anchors are condensed from lmy414/ai-chan-sheets 设定图/<char>/提示词/A01 (CC BY-NC-SA 4.0), after the
# original designs by ZipZipPipe; outfits are made modest per docs/pet-packs.md "内容要求" (Gemini's crop top,
# shorts and thigh band become a covered top, a long skirt and opaque tights; GPT's bare shoulders, thigh slit,
# thigh band and sheer overcoat become long sleeves, a closed skirt and an opaque overcoat).
import json, re, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from pixel_prompts import STYLE, SAFE, BG, ROWS as BASE_ROWS

CHARS = {
 "dafeiyu": ("Dafeiyu, an adult woman personifying DeepSeek as a gentle whale-girl maid: very long, voluminous, wavy deep-blue hair reaching her thighs, fading to light blue at the tips with light blue streaks, "
             "one thin ring-shaped ahoge curling up on top, big soft blue eyes, a calm sweet smile, and on each side of her head a deep-blue whale-fin ear with a pale blue sheen, white feathery fin edges and a small blue ribbon bow at its root. "
             "A white frilled maid headdress with white lace ribbons. She wears a long-sleeved white blouse with covered shoulders and puffed upper sleeves, lace cuffs, a small black bow tie with a blue gem at the throat, "
             "a deep navy fitted bodice with gold buttons and gold piping, a white frilled apron with a tiny blue whale embroidered at its lower right, "
             "and an ankle-length layered skirt: a deep navy outer skirt with pale gold vine embroidery and small dark bows, a blue-and-white pinstriped middle layer and a white ruffled petticoat hem. "
             "A deep-blue whale tail with a forked fluke behind her. Opaque white tights and deep navy Mary Jane shoes with a strap and small gold buckle. "
             "Colours: deep navy, blue, light blue, white and a touch of pale gold only"),
 "claude": ("Claude-chan, an adult woman personifying the Claude AI: very long bright orange hair reaching her knees with soft spiral curls at the tips, "
            "a large orange many-petalled chrysanthemum flower ornament with a small black ribbon on the right side of her head, calm sleepy amber-gold drooping eyes, gentle quiet expression. "
            "She wears a cream-white high-collared blouse with a ruffled stand-up collar, a wide black satin bow tie with an orange flower brooch, a short cream-white shoulder capelet with thin gold trim, "
            "puffed long sleeves with frilled cuffs, a black corset belt with gold buttons and a gold chain, an ankle-length cream-white pleated skirt with a vertical orange-red front panel and black side panels, "
            "and cream-white lace-up ankle boots. Colours: orange, amber, cream white, black and gold only"),
 "grok": ("Grok-chan, an adult woman personifying the Grok AI as a friendly gothic vampire: very long pale champagne-blonde hair in two high twin tails with black satin bows, "
          "a small black-and-gold spiked tiara with a gold ring emblem and a thin pale-gold crescent moon above it, sapphire-blue eyes, pointed elf ears, a confident mischievous grin showing two tiny fangs. "
          "She wears a long-sleeved black gothic gown buttoned up to a high neck with a wine-red lined pointed stand-up collar, white lace cuffs, a black corset sash with a gold ring emblem and a thin gold chain, "
          "an ankle-length layered black skirt with gold trim showing a wine-red underskirt, opaque black tights, and glossy black Mary Jane heels. Colours: black, wine red, gold and champagne blonde only"),
 "gemini": ("Gemini-chan, an adult woman personifying the Gemini AI: very long voluminous lavender-violet hair reaching below her knees, fluffy and flaring outward, fading to pink-violet at the tips, one curled ahoge on top, "
            "a pair of large pointed cat ears (violet outside, pink inside), heterochromia eyes (magenta-red on the left side of the picture, golden yellow on the right), a playful proud little smile, "
            "a dark hair band with a large concave four-pointed sparkle-star ornament (the Gemini sparkle shape, never a five-pointed star) on her right, and a fluffy lavender cat tail behind her. "
            "She wears a long-sleeved deep navy high-necked fitted top covering her midriff with a big four-pointed star emblem on the chest, a violet satin waist sash with gold trim and a thin gold waist chain with a star charm, "
            "a white-and-navy wide-sleeved open overcoat with gold edging and two long ribbon tails with star charms, an ankle-length deep navy skirt with a white ruffled underskirt hem, "
            "opaque white tights and deep violet platform shoes with iridescent soles. Colours: lavender violet, pink violet, deep navy, white and a touch of gold only"),
 "gpt": ("GPT-chan, an adult woman personifying ChatGPT as a gentle white dragon girl: extremely long, voluminous, wavy pure white hair reaching her ankles, a thick blunt fringe, one thin curled ahoge on top, "
         "a pair of white dragon horns with ring-shaped ridges curving up and back from the top of her head, long pointed elf ears with a small lavender diamond-shaped crystal earring, "
         "calm sleepy drooping pale lavender eyes, a soft gentle smile, and on the right side of her head a white rosette knot ornament (a round flower woven from looped cord) with a short silver tassel. "
         "Behind her a pair of SMALL folded dragon wings with pale translucent lavender membranes (kept close to her back, not spread wide), and a white dragon tail with diamond scales and a row of small spikes curling beside her feet. "
         "She wears a long-sleeved white Chinese-style dress with a small mandarin stand-up collar buttoned at the throat, covered shoulders, delicate white embroidery and small lavender diamond crystals down the front, "
         "wide flowing white water sleeves with ruffled cuffs and a thin silver arm ring, a thin silver chain at the waist with lavender diamond crystal pendants and silver tassels, a white rosette knot on each hip, "
         "a closed ankle-length white skirt (no slit) with a wavy ruffled hem embroidered with white roses, an opaque white floor-length overcoat with wide wavy ruffled edges, "
         "and low-heeled white pointed shoes with a white rosette knot. Draw her with clean dark grey-violet outlines so the white figure reads clearly. Colours: pure white, pale lavender and silver only, no gold, red, blue or green"),
}

EXTRA_ROWS = [
    "Row 1: looking around curiously, head turned to her left (frame 1) then to her right (frame 2); then sad, head drooping and sighing with a small blue sweat drop (2 frames).",
    "Row 2: hungry, both hands on her stomach looking at an empty bowl (2 frames); then eating a round cookie held in both hands, crumbs flying (2 frames).",
    "Row 3: eating a big slice of red watermelon (2 frames); then playing with a spinning top on the ground, cheering it on (2 frames).",
    "Row 4: making her entrance, rising from a crouch inside a burst of sparkles (frame 1 crouching, frame 2 standing with arms open); then a light swaying happy dance, leaning left then right (2 frames).",
]

GRID = "A grid of exactly 4 columns and 4 rows (16 cells)"
HALF_GRID = "A grid of exactly 4 columns and 2 rows (8 cells), each cell a tall portrait-shaped box"

def jobs(halves=False):
    out = []
    for cid, desc in CHARS.items():
        style, safe = STYLE, SAFE
        assert GRID in style
        for sheet, rows in (("base", BASE_ROWS), ("extra", EXTRA_ROWS)):
            if not halves:
                out.append({"name": f"{cid}_{sheet}", "prompt": " ".join([style, f"The character: {desc}.", safe, *rows, BG])})
                continue
            for half, part in (("a", rows[:2]), ("b", rows[2:])):
                part = [re.sub(r"^Row \d:", f"Row {i + 1}:", r) for i, r in enumerate(part)]
                out.append({"name": f"{cid}_{sheet}_{half}", "prompt": " ".join([style.replace(GRID, HALF_GRID), f"The character: {desc}.", safe, *part, BG])})
    return out

if __name__ == '__main__':
    print(json.dumps(jobs('--halves' in sys.argv), ensure_ascii=False))
