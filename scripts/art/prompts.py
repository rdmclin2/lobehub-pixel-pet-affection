# Prompts for the illustrated outfit pictures (scripts/art/generate.sh) of 大肥鱼 (dafeiyu-illustrated, retired
# 2026-10-29) and the app icon ("logo"). pixel_prompts.py reuses CHARS and OUTFITS.
# The model-chan pixel packs have their own prompts: model_chan_prompts.py. Prints [{name, prompt}] as JSON.
import json
STYLE = ("Style: high-quality 2D anime illustration, clean dark lineart, soft cel shading, vibrant pastel colors. "
 "She is clearly an adult young woman, set age 18 with mature adult proportions (about 7 heads tall), adult face, not chibi, not childlike. "
 "Tasteful and fully covered, non-revealing, modest buttoned-up neckline, no cleavage. Pose: standing facing the viewer in a relaxed cute pose with a gentle smile, "
 "whole body visible from head to feet, centered, with some empty margin around her. "
 "Background: perfectly flat solid pure magenta (#FF00FF) chroma-key color, no gradient, no floor, no shadow, no other objects, no text, no watermark.")
CHARS = {
 "dafeiyu": "an adult whale-girl character: long deep-blue hair with light-blue streaks, a small chubby blue whale tail behind her, light-blue eyes, lazy and slightly smug cute expression",
}
OUTFITS = {
 "daily": "a white button-up shirt, blue jeans and white sneakers",
 "scarf": "a cozy beige knit sweater, a long red knitted scarf, a long brown skirt and short boots",
 "casual": "a loose gray hooded sweatshirt, gray sweatpants and sneakers",
 "beret": "a navy-and-white striped long-sleeve top, denim dungarees, a red beret, holding a paintbrush",
 "pajamas": "long-sleeved, long-legged pastel polka-dot pajamas with a matching nightcap and fluffy slippers, hugging a pillow",
 "cat_ears": "soft pink long-sleeved loungewear with long pants and a cat-ear headband",
 "yukata": "a long navy-blue yukata with a red obi sash and wooden geta sandals, holding a round paper fan",
 "maid": "a classic modest long-sleeved black maid dress reaching the knees, a white apron, a white headband and black tights",
 "offshoulder_gown": "an elegant wine-red floor-length off-the-shoulder evening gown with a modest high neckline, showing only her shoulders",
 "couple_hoodie": "a pink hoodie with a big heart print, blue jeans and sneakers, making a heart shape with her hands",
 "flower_crown": "a long flowing white dress with sleeves and a crown of small flowers",
 "retro_swimsuit": "a modest navy-blue retro one-piece swimsuit with a high neckline, worn with a knee-length white wrap skirt (sarong) tied at the hip with no slit, fully covering both thighs down to the knees, a wide-brimmed straw sun hat and sandals",
 "silk_robe": "a champagne-colored knee-length silk robe with the belt neatly tied, over matching long silk pajama pants, and slippers",
}
ALL_AGES = ["daily","scarf","casual","beret","pajamas","cat_ears","yukata","couple_hoodie","flower_crown"]
jobs = []
for c, cd in CHARS.items():
    for o, od in OUTFITS.items():
        if c == "dafeiyu" and o not in ALL_AGES: continue
        jobs.append({"name": f"{c}_{o}", "prompt": f"Full-body standing character illustration of {cd}. She is wearing {od}. {STYLE}"})
jobs.append({"name": "logo", "prompt": 'Square app icon for a desktop companion app called Pixel Pet. Three cute 16-bit pixel-art fan characters shown from the chest up, side by side, close together, smiling at the viewer: on the left a chibi whale girl with long deep-blue hair fading to light blue, small whale-fin ears, a white maid headdress and a navy maid dress with a white apron; in the middle a calm young woman with long bright orange curly hair, an orange multi-petal flower hair ornament, amber eyes and a cream high-collared blouse with a black ribbon; on the right a playful young woman with long pale champagne-gold twin tails, a small black-and-gold crown, sapphire eyes, tiny cute fangs and a high-collared black gothic gown with a wine-red standing collar. Both women on the middle and right are clearly adults in their mid-20s with adult faces. Crisp hard-edged pixels, limited palette, no anti-aliasing. Background: a soft rounded square with a gentle lavender-to-pink gradient and a few small pixel hearts. No text, no letters, no logos, no watermark. Fully covered, modest clothing.'})
if __name__ == '__main__':
    print(json.dumps(jobs))
