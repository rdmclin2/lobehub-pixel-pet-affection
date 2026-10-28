# Prompts for the model-chan (模型娘) pixel sheets (scripts/art/model-chan.sh). Prints [{name, prompt}] as JSON.
# Two generated sheets per character, both 4 columns x 4 rows = 8 actions x 2 frames:
#   <id>_base  -> the 8 actions every sprite pack has (same order as pixel_prompts.py / build_pixel_pack.py)
#   <id>_extra -> the 8 states only DeepSeek's video clips had (look, sad, hungry, eat_cookie, eat_fruit, play, hatch, evolve)
# Dafeiyu (DeepSeek) is the pixel version of her existing chibi maid look from dsh-pet.
# Identity anchors are condensed from lmy414/ai-chan-sheets 设定图/<char>/提示词/A01 (CC BY-NC-SA 4.0), after the
# original designs by ZipZipPipe; outfits are made modest per docs/pet-packs.md "内容要求".
import json, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from pixel_prompts import STYLE, SAFE, BG, ROWS as BASE_ROWS

CHARS = {
 "dafeiyu": ("Dafeiyu, the DeepSeek whale-girl maid, kept in her original chibi (Q-version, super-deformed, about 3 heads tall) look from the dsh-pet desktop pet; "
             "she is an adult character drawn in cute SD style: long deep-blue hair fading to light blue at the tips with a ring-shaped ahoge, big blue eyes, small blue whale-fin ears and a small chubby blue whale tail behind her, "
             "a white maid headdress, a long-sleeved deep navy maid dress with a white apron embroidered with a tiny blue whale at the lower right, white tights and black Mary Jane shoes. "
             "Colours: deep navy, white, light blue and a touch of pale gold only"),
 "claude": ("Claude-chan, an adult woman personifying the Claude AI: very long bright orange hair reaching her knees with soft spiral curls at the tips, "
            "a large orange many-petalled chrysanthemum flower ornament with a small black ribbon on the right side of her head, calm sleepy amber-gold drooping eyes, gentle quiet expression. "
            "She wears a cream-white high-collared blouse with a ruffled stand-up collar, a wide black satin bow tie with an orange flower brooch, a short cream-white shoulder capelet with thin gold trim, "
            "puffed long sleeves with frilled cuffs, a black corset belt with gold buttons and a gold chain, an ankle-length cream-white pleated skirt with a vertical orange-red front panel and black side panels, "
            "and cream-white lace-up ankle boots. Colours: orange, amber, cream white, black and gold only"),
 "grok": ("Grok-chan, an adult woman personifying the Grok AI as a friendly gothic vampire: very long pale champagne-blonde hair in two high twin tails with black satin bows, "
          "a small black-and-gold spiked tiara with a gold ring emblem and a thin pale-gold crescent moon above it, sapphire-blue eyes, pointed elf ears, a confident mischievous grin showing two tiny fangs. "
          "She wears a long-sleeved black gothic gown buttoned up to a high neck with a wine-red lined pointed stand-up collar, white lace cuffs, a black corset sash with a gold ring emblem and a thin gold chain, "
          "an ankle-length layered black skirt with gold trim showing a wine-red underskirt, opaque black tights, and glossy black Mary Jane heels. Colours: black, wine red, gold and champagne blonde only"),
}

EXTRA_ROWS = [
    "Row 1: looking around curiously, head turned to her left (frame 1) then to her right (frame 2); then sad, head drooping and sighing with a small blue sweat drop (2 frames).",
    "Row 2: hungry, both hands on her stomach looking at an empty bowl (2 frames); then eating a round cookie held in both hands, crumbs flying (2 frames).",
    "Row 3: eating a big slice of red watermelon (2 frames); then playing with a spinning top on the ground, cheering it on (2 frames).",
    "Row 4: making her entrance, rising from a crouch inside a burst of sparkles (frame 1 crouching, frame 2 standing with arms open); then a light swaying happy dance, leaning left then right (2 frames).",
]

# Dafeiyu keeps her chibi maid look (the one exception to "adult proportions"), so her style lines drop
# the adult-proportion clause and keep the modesty one.
SD_STYLE = STYLE.replace("full body from head to feet", "full body from head to feet in chibi proportions")
SD_SAFE = "Fully covered and modest maid outfit with a high neckline and long skirt, nothing revealing."

def jobs():
    out = []
    for cid, desc in CHARS.items():
        style, safe = (SD_STYLE, SD_SAFE) if cid == "dafeiyu" else (STYLE, SAFE)
        for sheet, rows in (("base", BASE_ROWS), ("extra", EXTRA_ROWS)):
            out.append({"name": f"{cid}_{sheet}", "prompt": " ".join([style, f"The character: {desc}.", safe, *rows, BG])})
    return out

if __name__ == '__main__':
    print(json.dumps(jobs(), ensure_ascii=False))
