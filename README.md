# Neon Mines VR

Holographic Minesweeper reimagined in VR. A floating neon grid hovers in front of you -- reveal tiles with your controller laser, flag suspected mines, deduce safe paths using glowing number clues. First logic/deduction puzzle in the Neon VR Arcade.

## Play

**Live:** [https://ellyz2426.github.io/neon-mines/](https://ellyz2426.github.io/neon-mines/)

Works in browser and VR headsets (Quest 3, etc.)

## Controls

### Browser
- **Left Click** - Reveal tile
- **Right Click** - Flag/unflag mine
- **Middle Click** - Quick reveal neighbors (chord)
- **ESC / P** - Pause
- **R** - Restart (game over)

### VR
- **Right Trigger** - Reveal tile
- **Right Grip/A** - Flag tile
- **B** - Pause
- **Laser pointer** - Aim at tiles and menus

## Game Modes

- **Classic** - Standard minesweeper
- **Timed** - Race against the clock
- **No-Flag** - Win without using any flags
- **Daily Challenge** - Same puzzle for everyone today
- **Zen** - No game over, infinite lives
- **Practice** - Learn the ropes

## Difficulties

| Level | Grid | Mines | Time Limit |
|-------|------|-------|------------|
| Easy | 8x8 | 10 | 5:00 |
| Medium | 12x12 | 30 | 10:00 |
| Hard | 16x16 | 60 | 15:00 |

## Features

- 6 game modes with distinct rules
- 3 difficulty levels (8x8, 12x12, 16x16)
- 43 achievements with localStorage persistence
- XP/Level progression (50 levels, 15 titles)
- 5 holodeck arena themes
- Chord reveal (middle click on numbered tiles)
- Flood fill auto-reveal on empty tiles
- Daily Challenge with seeded PRNG
- Top 20 leaderboard
- Career stats tracking
- 15 PanelUI spatial panels (zero HTML DOM)
- Procedural audio (15+ SFX + ambient drone)
- Particle effects (reveal bursts, mine explosions)
- Holodeck neon wireframe environment
- Full VR controller + browser support

## Tech

- IWSDK 0.4.1 (Immersive Web SDK)
- TypeScript, Three.js (super-three), ECS architecture
- PanelUI spatial UI (uikitml templates)
- Procedural Web Audio
- Dual runtime: VR + browser-first
