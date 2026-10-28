# Prompts for schema-1 pixel outfit sheets (one per outfit: 4 columns x 4 rows = 8 actions x 2 frames).
# The model-chan daily packs use model_chan_prompts.py instead. Prints [{name, prompt}] as JSON.
import json, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from prompts import CHARS, OUTFITS, ALL_AGES  # same characters and outfits as the illustrated art

ROWS = [
    "Row 1: standing idle, breathing calmly (2 frames), then waving hello with one hand (2 frames).",
    "Row 2: floating a little above the ground as if just picked up, legs dangling, surprised (2 frames; no hands, arms or other people in the picture), then eating a bowl of white rice with chopsticks (2 frames).",
    "Row 3: dozing while standing, eyes closed, a small pixel Z above her head (2 frames), then thinking with a finger on her chin and a small thought bubble (2 frames).",
    "Row 4: talking with her mouth open and one hand gesturing (2 frames), then cheering happily with both arms up (2 frames).",
]
STYLE = ("Pixel art sprite sheet for a desktop pet game, 16-bit SNES-era style, crisp hard-edged pixels, limited palette, "
         "no anti-aliasing, no blur. A grid of exactly 4 columns and 4 rows (16 cells), every cell the same size, with empty space between cells. "
         "Every cell shows the SAME character, full body from head to feet, the same size and standing at the same spot in her cell, facing the viewer.")
SAFE = ("She is clearly an adult woman in her mid-20s: slender adult body, small head, about 6.5 heads tall, adult face, not chibi, not childlike. "
        "Fully covered and modest: tops buttoned up to the collar or with a high neckline, no cleavage at all, nothing revealing.")
BG = "Background: perfectly flat solid pure magenta (#FF00FF) everywhere, no grid lines, no text, no labels, no shadows."

def jobs(species):
    out = []
    for o, od in OUTFITS.items():
        if species == 'dafeiyu' and o not in ALL_AGES: continue
        out.append({"name": f"{species}_{o}", "prompt": " ".join([STYLE, f"The character: {CHARS[species]}, wearing {od}.", SAFE, *ROWS, BG])})
    return out

if __name__ == '__main__':
    print(json.dumps(jobs(sys.argv[1] if len(sys.argv) > 1 else 'dafeiyu')))
