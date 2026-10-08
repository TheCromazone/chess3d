# Piece set licenses

The SVG piece sets in this directory were taken unmodified from the lichess.org source
repository (`lichess-org/lila`, `public/piece/<set>/`, master branch, fetched 2026-10-08).
Authors and licenses below are as listed in lila's
[COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md). Only sets that allow
redistribution in a commercial product were included: no NonCommercial (NC) or
"freeware / personal use" sets.

Every file was checked before shipping: plain SVG only (svg, g, path, circle, ellipse, rect,
defs, style, linearGradient, stop), with no scripts, no event-handler attributes, no
`foreignObject`, and no external references (`href` / `url()` only point to `#ids` in the same
file).

| Directory | Set | Author | License | Upstream |
|---|---|---|---|---|
| `cburnett/` | Cburnett | [Colin M.L. Burnett](https://en.wikipedia.org/wiki/User:Cburnett) | [GPL v2 or later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) | [lila/public/piece/cburnett](https://github.com/lichess-org/lila/tree/master/public/piece/cburnett) |
| `merida/` | Merida | Armando Hernandez Marroquin | [GPL v2 or later](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) | [lila/public/piece/merida](https://github.com/lichess-org/lila/tree/master/public/piece/merida) |
| `chessnut/` | Chessnut | [Alexis Luengas](https://github.com/LexLuengas) | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) | [LexLuengas/chessnut-pieces](https://github.com/LexLuengas/chessnut-pieces) |
| `celtic/` | Celtic | [Maurizio Monge](https://github.com/maurimo/chess-art) | [MIT](https://github.com/maurimo/chess-art/blob/main/LICENSE) | [maurimo/chess-art](https://github.com/maurimo/chess-art) |
| `rhosgfx/` | RhosGFX | [RhosGFX](https://rhosgfx.itch.io/) | [CC0 1.0 (public domain)](https://creativecommons.org/publicdomain/zero/1.0/) | [lila/public/piece/rhosgfx](https://github.com/lichess-org/lila/tree/master/public/piece/rhosgfx) |

## Obligations when redistributing

- **GPL v2+ (cburnett, merida):** the SVG files are their own source code (the preferred form for
  modification), so shipping them as-is with this notice satisfies the source requirement. Keep this
  file alongside them, and if you modify a set, distribute the modified SVGs under the GPL too. Using
  the images in the app does not change the license of the app's own code, but the piece files
  themselves stay GPL.
- **Apache 2.0 (chessnut):** keep this attribution and a link to the license; mark any modified files
  as changed. No NOTICE file exists upstream.
- **MIT (celtic):** keep the copyright and permission notice below.
- **CC0 (rhosgfx):** no obligations; attribution is given as a courtesy.

### MIT notice for `celtic/`

```
MIT License

Copyright (c) Maurizio Monge

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Sets considered and excluded

cardinal, california, maestro, fresca, staunty, tatiana and the other sadsnake1 sets, caliente,
anarcandy, horsey, cooke, monarchy, minimal-warmth and xkcd are CC BY-NC(-SA), which is
NonCommercial. alpha, chess7, companion and leipzig are "freeware / personal use". These were not
included.
