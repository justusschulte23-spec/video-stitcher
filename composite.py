#!/usr/bin/env python3
"""
Usage: composite.py <bg_path> <product_path> <out_path> <scale> <position>
  scale    : float, fraction of background width (e.g. 0.55)
  position : center | bottom-center | top-center

Composites product (RGBA with alpha) over background, saves as JPEG.
Prints: "width,height" to stdout.
"""
import sys
from PIL import Image

bg_path, prod_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
scale    = float(sys.argv[4])
position = sys.argv[5] if len(sys.argv) > 5 else 'center'

bg      = Image.open(bg_path).convert('RGBA')
product = Image.open(prod_path).convert('RGBA')

new_w = max(1, int(bg.width * scale))
new_h = max(1, int(product.height * new_w / product.width))
product = product.resize((new_w, new_h), Image.LANCZOS)

if position == 'center':
    x = (bg.width  - new_w) // 2
    y = (bg.height - new_h) // 2
elif position == 'bottom-center':
    x = (bg.width  - new_w) // 2
    y = bg.height - new_h - int(bg.height * 0.05)
elif position == 'top-center':
    x = (bg.width  - new_w) // 2
    y = int(bg.height * 0.05)
else:
    x, y = 0, 0

result = bg.copy()
result.paste(product, (x, y), mask=product.split()[3])
result.convert('RGB').save(out_path, 'JPEG', quality=92)
print(str(result.width) + ',' + str(result.height))
