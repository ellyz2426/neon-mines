import {
  World,
  createSystem,
  PanelUI,
  PanelDocument,
  UIKitDocument,
  UIKit,
  Follower,
  ScreenSpace,
  eq,
  Entity,
  InputComponent,
} from '@iwsdk/core';
import {
  BoxGeometry,
  MeshStandardMaterial,
  Mesh,
  SphereGeometry,
  MeshBasicMaterial,
  Color,
  Object3D,
  PlaneGeometry,
  FogExp2,
  PointLight,
  DirectionalLight,
  AmbientLight,
  TorusGeometry,
  ConeGeometry,
  IcosahedronGeometry,
  AdditiveBlending,
  Raycaster,
  Vector2,
  Vector3,
  Group,
} from '@iwsdk/core';

// Keyboard shim (runtime has keyboard; types expose only XRInputManager)
interface KeyboardLike {
  getKeyDown(code: string): boolean;
  getKeyPressed(code: string): boolean;
  getKeyUp(code: string): boolean;
}

// ============================================================
// TYPES & CONFIG
// ============================================================
type GameState = 'title' | 'modeselect' | 'difficulty' | 'playing' | 'paused' | 'won' | 'lost' | 'leaderboard' | 'achievements' | 'stats' | 'settings' | 'help';
type GameMode = 'classic' | 'timed' | 'noflag' | 'daily' | 'zen' | 'practice';
type Difficulty = 'easy' | 'medium' | 'hard';

interface DiffConfig { rows: number; cols: number; mines: number; timeLimit: number; }
const DIFFICULTIES: Record<Difficulty, DiffConfig> = {
  easy:   { rows: 8,  cols: 8,  mines: 10, timeLimit: 300 },
  medium: { rows: 12, cols: 12, mines: 30, timeLimit: 600 },
  hard:   { rows: 16, cols: 16, mines: 60, timeLimit: 900 },
};

// Combo multiplier thresholds
const COMBO_THRESHOLDS = [
  { min: 0, mult: 1 },
  { min: 3, mult: 1.5 },
  { min: 6, mult: 2 },
  { min: 10, mult: 2.5 },
  { min: 15, mult: 3 },
  { min: 25, mult: 4 },
];
const COMBO_TIMEOUT = 3; // seconds
const HINT_COST = 25; // XP per hint
const HINT_LIMITS: Record<Difficulty, number> = { easy: 3, medium: 5, hard: 7 };

interface Theme {
  name: string; grid: string; accent: string; bg: string; fog: string;
  wall: string; tile: string; number: string[]; mine: string; flag: string; glow: string;
}
const THEMES: Theme[] = [
  { name:'Neon Holodeck', grid:'#0ff', accent:'#0ff', bg:'#000810', fog:'#001020', wall:'#0ff', tile:'#112', number:['','#0af','#0f0','#f00','#00f','#800','#0ff','#000','#888'], mine:'#f00', flag:'#ff0', glow:'#0ff' },
  { name:'Crimson Grid', grid:'#f44', accent:'#f44', bg:'#100808', fog:'#200808', wall:'#f44', tile:'#211', number:['','#f88','#f00','#ff0','#f0f','#f80','#ff8','#800','#faa'], mine:'#ff0', flag:'#0f0', glow:'#f44' },
  { name:'Toxic Neon', grid:'#0f0', accent:'#0f0', bg:'#081000', fog:'#082000', wall:'#0f0', tile:'#121', number:['','#8f0','#0ff','#ff0','#f0f','#0f8','#ff8','#080','#8f8'], mine:'#f0f', flag:'#ff0', glow:'#0f0' },
  { name:'Ultra Violet', grid:'#a0f', accent:'#a0f', bg:'#0a0018', fog:'#100020', wall:'#a0f', tile:'#212', number:['','#c8f','#f0f','#88f','#ff0','#f88','#0ff','#808','#faf'], mine:'#0ff', flag:'#0f0', glow:'#a0f' },
  { name:'Solar Blaze', grid:'#f80', accent:'#f80', bg:'#181000', fog:'#201800', wall:'#f80', tile:'#221', number:['','#fa0','#ff0','#f00','#f80','#ff8','#0f0','#880','#fda'], mine:'#0ff', flag:'#0f0', glow:'#f80' },
];

interface Achievement { id: string; name: string; desc: string; check: () => boolean; }
interface LeaderEntry { time: number; grid: string; mode: string; date: string; }

// ============================================================
// GAME STATE MANAGER
// ============================================================
class GameStateManager {
  state: GameState = 'title';
  mode: GameMode = 'classic';
  difficulty: Difficulty = 'easy';
  themeIndex = 0;
  // Grid state
  grid: number[][] = [];
  revealed: boolean[][] = [];
  flagged: boolean[][] = [];
  rows = 8; cols = 8; mineCount = 10;
  // Timer
  elapsedTime = 0;
  timerRunning = false;
  timeLimit = 300;
  // Stats
  tilesRevealed = 0;
  flagsPlaced = 0;
  firstClick = true;
  gameStarted = false;
  // Combo
  combo = 0;
  maxCombo = 0;
  comboTimer = 0;
  comboXPBonus = 0;
  // Hints
  hintsUsedThisGame = 0;
  // Career
  stats = {
    games: 0, wins: 0, bestEasy: Infinity, bestMedium: Infinity, bestHard: Infinity,
    tilesRevealed: 0, minesFlagged: 0, minesDetonated: 0,
    winStreak: 0, bestStreak: 0, playTime: 0,
    easyWins: 0, mediumWins: 0, hardWins: 0,
    bestCombo: 0, totalHintsUsed: 0,
  };
  achievements: Set<string> = new Set();
  leaderboard: LeaderEntry[] = [];
  // Audio
  masterVol = 100; sfxVol = 100; musicVol = 100;
  // XP
  xp = 0; level = 1;
  // Ach page
  achPage = 0;
  // Daily seed
  dailySeed = 0;

  get theme(): Theme { return THEMES[this.themeIndex]; }
  get totalSafeTiles(): number { return this.rows * this.cols - this.mineCount; }

  constructor() { this.load(); this.dailySeed = this.dateSeed(); }

  dateSeed(): number {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth()+1) * 100 + d.getDate();
  }

  seededRng(seed: number): () => number {
    let s = seed | 0;
    return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  getComboMultiplier(): number {
    let mult = 1;
    for (const t of COMBO_THRESHOLDS) {
      if (this.combo >= t.min) mult = t.mult;
    }
    return mult;
  }

  initGrid(firstR: number, firstC: number) {
    this.grid = Array.from({length: this.rows}, () => Array(this.cols).fill(0));
    this.revealed = Array.from({length: this.rows}, () => Array(this.cols).fill(false));
    this.flagged = Array.from({length: this.rows}, () => Array(this.cols).fill(false));

    const rng = this.mode === 'daily' ? this.seededRng(this.dailySeed + this.rows * 100 + this.cols) : Math.random;
    const forbidden = new Set<string>();
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      forbidden.add(`${firstR+dr},${firstC+dc}`);
    }

    let placed = 0;
    while (placed < this.mineCount) {
      const r = Math.floor(rng() * this.rows);
      const c = Math.floor(rng() * this.cols);
      if (this.grid[r][c] === -1 || forbidden.has(`${r},${c}`)) continue;
      this.grid[r][c] = -1;
      placed++;
    }

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.grid[r][c] === -1) continue;
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols && this.grid[nr][nc] === -1) count++;
        }
        this.grid[r][c] = count;
      }
    }
  }

  reveal(r: number, c: number): 'safe' | 'mine' | 'already' {
    if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) return 'already';
    if (this.revealed[r][c] || this.flagged[r][c]) return 'already';
    if (this.firstClick) {
      this.initGrid(r, c);
      this.firstClick = false;
      this.timerRunning = true;
      this.gameStarted = true;
    }
    if (this.grid[r][c] === -1) {
      if (this.mode === 'zen') {
        this.flagged[r][c] = true;
        this.flagsPlaced++;
        return 'safe';
      }
      this.revealed[r][c] = true;
      return 'mine';
    }
    this.revealed[r][c] = true;
    this.tilesRevealed++;
    this.stats.tilesRevealed++;
    if (this.grid[r][c] === 0) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        this.reveal(r + dr, c + dc);
      }
    }
    return 'safe';
  }

  toggleFlag(r: number, c: number): boolean {
    if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) return false;
    if (this.revealed[r][c]) return false;
    if (this.mode === 'noflag') return false;
    this.flagged[r][c] = !this.flagged[r][c];
    this.flagsPlaced += this.flagged[r][c] ? 1 : -1;
    if (this.flagged[r][c]) this.stats.minesFlagged++;
    return true;
  }

  chordReveal(r: number, c: number): 'safe' | 'mine' | 'already' {
    if (!this.revealed[r][c] || this.grid[r][c] <= 0) return 'already';
    let adjFlags = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols && this.flagged[nr][nc]) adjFlags++;
    }
    if (adjFlags !== this.grid[r][c]) return 'already';
    let result: 'safe' | 'mine' | 'already' = 'already';
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      const res = this.reveal(nr, nc);
      if (res === 'mine') result = 'mine';
      else if (res === 'safe' && result === 'already') result = 'safe';
    }
    return result;
  }

  checkWin(): boolean {
    return this.tilesRevealed >= this.totalSafeTiles;
  }

  findHintTile(): { r: number; c: number } | null {
    if (!this.gameStarted || this.firstClick) return null;
    const candidates: { r: number; c: number }[] = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (!this.revealed[r][c] && !this.flagged[r][c] && this.grid[r]?.[c] !== -1) {
          candidates.push({ r, c });
        }
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  startGame(mode: GameMode, diff: Difficulty) {
    const cfg = DIFFICULTIES[diff];
    this.mode = mode; this.difficulty = diff;
    this.rows = cfg.rows; this.cols = cfg.cols; this.mineCount = cfg.mines;
    this.timeLimit = cfg.timeLimit;
    this.grid = []; this.revealed = []; this.flagged = [];
    this.elapsedTime = 0; this.timerRunning = false;
    this.tilesRevealed = 0; this.flagsPlaced = 0;
    this.firstClick = true; this.gameStarted = false;
    this.combo = 0; this.maxCombo = 0; this.comboTimer = 0; this.comboXPBonus = 0;
    this.hintsUsedThisGame = 0;
    this.state = 'playing';
    this.stats.games++;
  }

  endGame(won: boolean) {
    this.timerRunning = false;
    // Calculate combo bonus XP
    this.comboXPBonus = Math.floor(this.maxCombo * 5 * (this.difficulty === 'hard' ? 3 : this.difficulty === 'medium' ? 2 : 1));
    if (won) {
      this.stats.wins++;
      this.stats.winStreak++;
      if (this.stats.winStreak > this.stats.bestStreak) this.stats.bestStreak = this.stats.winStreak;
      if (this.maxCombo > this.stats.bestCombo) this.stats.bestCombo = this.maxCombo;
      // Per-difficulty wins
      if (this.difficulty === 'easy') this.stats.easyWins++;
      if (this.difficulty === 'medium') this.stats.mediumWins++;
      if (this.difficulty === 'hard') this.stats.hardWins++;
      const t = this.elapsedTime;
      if (this.difficulty === 'easy' && t < this.stats.bestEasy) this.stats.bestEasy = t;
      if (this.difficulty === 'medium' && t < this.stats.bestMedium) this.stats.bestMedium = t;
      if (this.difficulty === 'hard' && t < this.stats.bestHard) this.stats.bestHard = t;
      const baseXP = Math.floor(this.mineCount * 10 + (300 - Math.min(this.elapsedTime, 300)));
      this.xp += baseXP + this.comboXPBonus;
      const lvl = Math.floor(this.xp / (100 + this.level * 50)) + 1;
      if (lvl > this.level) this.level = lvl;
      this.leaderboard.push({ time: this.elapsedTime, grid: `${this.rows}x${this.cols}`, mode: this.mode, date: new Date().toLocaleDateString() });
      this.leaderboard.sort((a, b) => a.time - b.time);
      if (this.leaderboard.length > 20) this.leaderboard.length = 20;
      this.state = 'won';
    } else {
      this.stats.winStreak = 0;
      this.stats.minesDetonated++;
      if (this.maxCombo > this.stats.bestCombo) this.stats.bestCombo = this.maxCombo;
      this.state = 'lost';
    }
    this.stats.totalHintsUsed += this.hintsUsedThisGame;
    this.save();
  }

  getEfficiency(): number {
    const totalFlags = this.flagsPlaced;
    if (totalFlags === 0) return 100;
    const correctFlags = this.countCorrectFlags();
    return Math.round((correctFlags / Math.max(totalFlags, 1)) * 100);
  }

  countCorrectFlags(): number {
    let c = 0;
    for (let r = 0; r < this.rows; r++)
      for (let col = 0; col < this.cols; col++)
        if (this.flagged[r][col] && this.grid[r]?.[col] === -1) c++;
    return c;
  }

  getRating(): string {
    if (this.tilesRevealed < this.totalSafeTiles) return 'F';
    const t = this.elapsedTime;
    const base = this.difficulty === 'easy' ? 60 : this.difficulty === 'medium' ? 180 : 360;
    if (t < base * 0.5) return 'S';
    if (t < base * 0.75) return 'A';
    if (t < base) return 'B';
    if (t < base * 1.5) return 'C';
    return 'D';
  }

  save() {
    try {
      localStorage.setItem('neon-mines-stats', JSON.stringify(this.stats));
      localStorage.setItem('neon-mines-ach', JSON.stringify([...this.achievements]));
      localStorage.setItem('neon-mines-lb', JSON.stringify(this.leaderboard));
      localStorage.setItem('neon-mines-xp', JSON.stringify({ xp: this.xp, level: this.level }));
      localStorage.setItem('neon-mines-settings', JSON.stringify({ master: this.masterVol, sfx: this.sfxVol, music: this.musicVol, theme: this.themeIndex }));
    } catch {}
  }

  load() {
    try {
      const s = localStorage.getItem('neon-mines-stats');
      if (s) Object.assign(this.stats, JSON.parse(s));
      const a = localStorage.getItem('neon-mines-ach');
      if (a) this.achievements = new Set(JSON.parse(a));
      const lb = localStorage.getItem('neon-mines-lb');
      if (lb) this.leaderboard = JSON.parse(lb);
      const xp = localStorage.getItem('neon-mines-xp');
      if (xp) { const d = JSON.parse(xp); this.xp = d.xp; this.level = d.level; }
      const set = localStorage.getItem('neon-mines-settings');
      if (set) { const d = JSON.parse(set); this.masterVol = d.master; this.sfxVol = d.sfx; this.musicVol = d.music; this.themeIndex = d.theme ?? 0; }
    } catch {}
  }
}

const GM = new GameStateManager();

// ============================================================
// ACHIEVEMENTS DEFINITIONS (75 total)
// ============================================================
const ACHIEVEMENTS: Achievement[] = [
  // ---- Wins ----
  { id:'first_clear', name:'First Clear', desc:'Win your first game', check:()=>GM.stats.wins>=1 },
  { id:'ten_wins', name:'Dedicated', desc:'Win 10 games', check:()=>GM.stats.wins>=10 },
  { id:'twenty_five_wins', name:'Sharpshooter', desc:'Win 25 games', check:()=>GM.stats.wins>=25 },
  { id:'fifty_wins', name:'Veteran', desc:'Win 50 games', check:()=>GM.stats.wins>=50 },
  { id:'hundred_wins', name:'Master Sweeper', desc:'Win 100 games', check:()=>GM.stats.wins>=100 },
  { id:'two_hundred_wins', name:'Obsession', desc:'Win 200 games', check:()=>GM.stats.wins>=200 },
  // ---- Speed ----
  { id:'easy_sub60', name:'Speed Demon', desc:'Clear Easy under 60s', check:()=>GM.stats.bestEasy<60 },
  { id:'easy_sub30', name:'Lightning', desc:'Clear Easy under 30s', check:()=>GM.stats.bestEasy<30 },
  { id:'easy_sub20', name:'Quick Scan', desc:'Clear Easy under 20s', check:()=>GM.stats.bestEasy<20 },
  { id:'easy_sub15', name:'Blink', desc:'Clear Easy under 15s', check:()=>GM.stats.bestEasy<15 },
  { id:'med_sub180', name:'Efficient', desc:'Clear Medium under 3 min', check:()=>GM.stats.bestMedium<180 },
  { id:'med_sub120', name:'Sharp Mind', desc:'Clear Medium under 2 min', check:()=>GM.stats.bestMedium<120 },
  { id:'med_sub90', name:'Razor', desc:'Clear Medium under 90s', check:()=>GM.stats.bestMedium<90 },
  { id:'hard_sub360', name:'Brave', desc:'Clear Hard under 6 min', check:()=>GM.stats.bestHard<360 },
  { id:'hard_sub240', name:'Fearless', desc:'Clear Hard under 4 min', check:()=>GM.stats.bestHard<240 },
  { id:'hard_sub180', name:'Iron Will', desc:'Clear Hard under 3 min', check:()=>GM.stats.bestHard<180 },
  // ---- Streaks ----
  { id:'streak3', name:'Hat Trick', desc:'3 wins in a row', check:()=>GM.stats.bestStreak>=3 },
  { id:'streak5', name:'Hot Streak', desc:'5 wins in a row', check:()=>GM.stats.bestStreak>=5 },
  { id:'streak7', name:'Weekly Streak', desc:'7 wins in a row', check:()=>GM.stats.bestStreak>=7 },
  { id:'streak10', name:'Unstoppable', desc:'10 wins in a row', check:()=>GM.stats.bestStreak>=10 },
  { id:'streak15', name:'Unbreakable', desc:'15 wins in a row', check:()=>GM.stats.bestStreak>=15 },
  { id:'streak20', name:'Invincible', desc:'20 wins in a row', check:()=>GM.stats.bestStreak>=20 },
  // ---- Tiles ----
  { id:'tiles100', name:'Explorer', desc:'Reveal 100 tiles', check:()=>GM.stats.tilesRevealed>=100 },
  { id:'tiles1000', name:'Cartographer', desc:'Reveal 1000 tiles', check:()=>GM.stats.tilesRevealed>=1000 },
  { id:'tiles5000', name:'Surveyor', desc:'Reveal 5000 tiles', check:()=>GM.stats.tilesRevealed>=5000 },
  { id:'tiles10k', name:'Excavator', desc:'Reveal 10,000 tiles', check:()=>GM.stats.tilesRevealed>=10000 },
  { id:'tiles25k', name:'Archaeologist', desc:'Reveal 25,000 tiles', check:()=>GM.stats.tilesRevealed>=25000 },
  // ---- Flags ----
  { id:'flags100', name:'Flag Bearer', desc:'Place 100 flags', check:()=>GM.stats.minesFlagged>=100 },
  { id:'flags500', name:'Flag Master', desc:'Place 500 flags', check:()=>GM.stats.minesFlagged>=500 },
  { id:'flags1k', name:'Signal Corps', desc:'Place 1000 flags', check:()=>GM.stats.minesFlagged>=1000 },
  // ---- Detonations ----
  { id:'det1', name:'Oops', desc:'Detonate your first mine', check:()=>GM.stats.minesDetonated>=1 },
  { id:'det10', name:'Bomb Squad', desc:'Detonate 10 mines', check:()=>GM.stats.minesDetonated>=10 },
  { id:'det25', name:'Crash Test', desc:'Detonate 25 mines', check:()=>GM.stats.minesDetonated>=25 },
  { id:'det50', name:'Pyromaniac', desc:'Detonate 50 mines', check:()=>GM.stats.minesDetonated>=50 },
  { id:'det100', name:'Walking Disaster', desc:'Detonate 100 mines', check:()=>GM.stats.minesDetonated>=100 },
  // ---- Games Played ----
  { id:'games10', name:'Getting Started', desc:'Play 10 games', check:()=>GM.stats.games>=10 },
  { id:'games25', name:'Regular', desc:'Play 25 games', check:()=>GM.stats.games>=25 },
  { id:'games50', name:'Committed', desc:'Play 50 games', check:()=>GM.stats.games>=50 },
  { id:'games100', name:'Addict', desc:'Play 100 games', check:()=>GM.stats.games>=100 },
  { id:'games200', name:'Devotee', desc:'Play 200 games', check:()=>GM.stats.games>=200 },
  { id:'games500', name:'Lifetime Member', desc:'Play 500 games', check:()=>GM.stats.games>=500 },
  // ---- Win Rate ----
  { id:'winrate80', name:'Sharp Shooter', desc:'80%+ win rate (10+ games)', check:()=>GM.stats.games>=10&&(GM.stats.wins/GM.stats.games)>=0.8 },
  { id:'winrate90', name:'Precision', desc:'90%+ win rate (20+ games)', check:()=>GM.stats.games>=20&&(GM.stats.wins/GM.stats.games)>=0.9 },
  // ---- Ratings ----
  { id:'s_rating', name:'S Rank', desc:'Get an S rating', check:()=>GM.state==='won'&&GM.getRating()==='S' },
  { id:'hard_s_rank', name:'Iron S', desc:'S rating on Hard', check:()=>GM.state==='won'&&GM.difficulty==='hard'&&GM.getRating()==='S' },
  { id:'med_s_rank', name:'Silver S', desc:'S rating on Medium', check:()=>GM.state==='won'&&GM.difficulty==='medium'&&GM.getRating()==='S' },
  // ---- Skill ----
  { id:'perfect_flag', name:'Perfect Flags', desc:'Flag only mines in a game', check:()=>GM.state==='won'&&GM.getEfficiency()===100&&GM.flagsPlaced>0 },
  { id:'no_flag_win', name:'Naked Eye', desc:'Win without using any flags', check:()=>GM.state==='won'&&GM.flagsPlaced===0 },
  { id:'no_hint_hard', name:'Pure Logic', desc:'Win Hard without using hints', check:()=>GM.state==='won'&&GM.difficulty==='hard'&&GM.hintsUsedThisGame===0 },
  // ---- Play Time ----
  { id:'play1h', name:'Dedicated Player', desc:'Play for 1 hour total', check:()=>GM.stats.playTime>=3600 },
  { id:'play5h', name:'Mine Obsessed', desc:'Play for 5 hours total', check:()=>GM.stats.playTime>=18000 },
  { id:'play10h', name:'Time Sink', desc:'Play for 10 hours total', check:()=>GM.stats.playTime>=36000 },
  { id:'play24h', name:'Full Day', desc:'Play for 24 hours total', check:()=>GM.stats.playTime>=86400 },
  // ---- Modes ----
  { id:'noflag_mode', name:'No Flag Hero', desc:'Win in No-Flag mode', check:()=>GM.state==='won'&&GM.mode==='noflag' },
  { id:'daily_done', name:'Daily Player', desc:'Complete a Daily Challenge', check:()=>GM.state==='won'&&GM.mode==='daily' },
  { id:'zen_clear', name:'Inner Peace', desc:'Clear a board in Zen mode', check:()=>GM.state==='won'&&GM.mode==='zen' },
  { id:'timed_clear', name:'Beat the Clock', desc:'Win in Timed mode', check:()=>GM.state==='won'&&GM.mode==='timed' },
  { id:'practice_clear', name:'Student', desc:'Win in Practice mode', check:()=>GM.state==='won'&&GM.mode==='practice' },
  { id:'all_modes', name:'Versatile', desc:'Win in all 6 modes', check:()=>false }, // checked separately
  { id:'all_diffs', name:'Conqueror', desc:'Win on all difficulties', check:()=>GM.stats.bestEasy<Infinity&&GM.stats.bestMedium<Infinity&&GM.stats.bestHard<Infinity },
  // ---- Difficulty Wins ----
  { id:'easy10', name:'Easy Street', desc:'Win 10 Easy games', check:()=>GM.stats.easyWins>=10 },
  { id:'med10', name:'Middle Ground', desc:'Win 10 Medium games', check:()=>GM.stats.mediumWins>=10 },
  { id:'hard10', name:'Hardened', desc:'Win 10 Hard games', check:()=>GM.stats.hardWins>=10 },
  { id:'hard25', name:'Iron Nerves', desc:'Win 25 Hard games', check:()=>GM.stats.hardWins>=25 },
  // ---- Chains ----
  { id:'fast_reveal', name:'Quick Draw', desc:'Reveal 20 tiles in 5 seconds', check:()=>false }, // checked in game
  { id:'chain_clear', name:'Chain Reaction', desc:'Auto-reveal 30+ tiles in one click', check:()=>false },
  { id:'chain50', name:'Avalanche', desc:'Auto-reveal 50+ tiles in one click', check:()=>false },
  { id:'chain100', name:'Tectonic', desc:'Auto-reveal 100+ tiles in one click', check:()=>false },
  // ---- Combo ----
  { id:'combo5', name:'Hot Combo', desc:'Reach a 5 combo', check:()=>GM.maxCombo>=5 },
  { id:'combo10', name:'Fire Combo', desc:'Reach a 10 combo', check:()=>GM.maxCombo>=10 },
  { id:'combo20', name:'Inferno', desc:'Reach a 20 combo', check:()=>GM.maxCombo>=20 },
  // ---- Hints ----
  { id:'first_hint', name:'Helping Hand', desc:'Use your first hint', check:()=>GM.stats.totalHintsUsed>=1 },
  // ---- Levels ----
  { id:'level5', name:'Rising Star', desc:'Reach level 5', check:()=>GM.level>=5 },
  { id:'level10', name:'Experienced', desc:'Reach level 10', check:()=>GM.level>=10 },
  { id:'level15', name:'Ascending', desc:'Reach level 15', check:()=>GM.level>=15 },
  { id:'level20', name:'Climbing', desc:'Reach level 20', check:()=>GM.level>=20 },
  { id:'level25', name:'Expert', desc:'Reach level 25', check:()=>GM.level>=25 },
  { id:'level30', name:'High Roller', desc:'Reach level 30', check:()=>GM.level>=30 },
  { id:'level40', name:'Elite', desc:'Reach level 40', check:()=>GM.level>=40 },
  { id:'level50', name:'Grandmaster', desc:'Reach level 50', check:()=>GM.level>=50 },
];

function checkAchievements(audio: AudioManager): string[] {
  const newAchs: string[] = [];
  for (const ach of ACHIEVEMENTS) {
    if (!GM.achievements.has(ach.id) && ach.check()) {
      GM.achievements.add(ach.id);
      newAchs.push(ach.name);
    }
  }
  if (newAchs.length > 0) {
    GM.save();
    audio.playAchievement();
  }
  return newAchs;
}

// ============================================================
// AUDIO MANAGER
// ============================================================
class AudioManager {
  ctx: AudioContext | null = null;
  droneGain: GainNode | null = null;
  musicPlaying = false;

  private getCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private sfxGain(): number { return (GM.masterVol / 100) * (GM.sfxVol / 100); }
  private musicGain(): number { return (GM.masterVol / 100) * (GM.musicVol / 100); }

  playTone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.15) {
    const ctx = this.getCtx(); const g = ctx.createGain(); const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq * (0.97 + Math.random() * 0.06);
    g.gain.value = vol * this.sfxGain(); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + dur);
  }

  playReveal() { this.playTone(880 + Math.random() * 200, 0.08, 'sine', 0.1); }
  playFlag() { this.playTone(660, 0.1, 'triangle', 0.15); this.playTone(880, 0.1, 'triangle', 0.1); }
  playUnflag() { this.playTone(440, 0.1, 'triangle', 0.1); }

  playExplosion() {
    const ctx = this.getCtx(); const g = ctx.createGain(); const o = ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = 120; o.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 0.5);
    g.gain.value = 0.3 * this.sfxGain(); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.6);
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const ng = ctx.createGain(); ng.gain.value = 0.2 * this.sfxGain();
    ng.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    src.connect(ng); ng.connect(ctx.destination); src.start(); src.stop(ctx.currentTime + 0.4);
  }

  playMineRevealTick() {
    this.playTone(200 + Math.random() * 100, 0.05, 'sawtooth', 0.08);
  }

  playWin() {
    const notes = [523, 659, 784, 1047, 1319];
    notes.forEach((f, i) => setTimeout(() => this.playTone(f, 0.3, 'sine', 0.15), i * 80));
  }

  playAchievement() {
    const notes = [660, 880, 1100, 1320, 1540];
    notes.forEach((f, i) => setTimeout(() => this.playTone(f, 0.2, 'triangle', 0.1), i * 60));
  }

  playClick() { this.playTone(600, 0.05, 'sine', 0.08); }
  playCountdown() { this.playTone(440, 0.12, 'sine', 0.12); }
  playGo() { this.playTone(880, 0.2, 'sine', 0.15); }
  playChord() { this.playTone(440, 0.1, 'sine', 0.08); this.playTone(660, 0.1, 'sine', 0.06); }

  playFloodReveal() {
    this.playTone(330 + Math.random() * 200, 0.15, 'sine', 0.06);
    this.playTone(550 + Math.random() * 200, 0.15, 'triangle', 0.04);
  }

  playCombo(level: number) {
    const baseFreq = 440 + level * 40;
    this.playTone(baseFreq, 0.08, 'triangle', 0.08);
    setTimeout(() => this.playTone(baseFreq * 1.25, 0.08, 'triangle', 0.06), 40);
  }

  playHint() {
    this.playTone(1200, 0.1, 'sine', 0.1);
    setTimeout(() => this.playTone(1400, 0.1, 'sine', 0.08), 60);
    setTimeout(() => this.playTone(1600, 0.12, 'sine', 0.06), 120);
  }

  playWarningTick(urgent: boolean) {
    if (urgent) {
      this.playTone(880, 0.05, 'square', 0.1);
      setTimeout(() => this.playTone(880, 0.05, 'square', 0.08), 80);
    } else {
      this.playTone(660, 0.06, 'square', 0.06);
    }
  }

  playNumberReveal(value: number) {
    // Different tones per number value for audio feedback
    const freqs = [0, 523, 587, 659, 698, 784, 880, 988, 1047];
    const f = freqs[value] || 523;
    this.playTone(f, 0.06, 'sine', 0.07);
  }

  startDrone() {
    if (this.musicPlaying) return;
    const ctx = this.getCtx();
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.06 * this.musicGain();
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.15;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.02;
    lfo.connect(lfoG);
    [55, 82.5, 110].forEach(f => {
      const o = ctx.createOscillator(); o.type = f === 82.5 ? 'triangle' : 'sine';
      o.frequency.value = f; lfoG.connect(o.frequency);
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 400;
      o.connect(filter); filter.connect(this.droneGain!);
      o.start();
    });
    lfo.start();
    this.droneGain.connect(ctx.destination);
    this.musicPlaying = true;
  }

  updateDroneVolume() {
    if (this.droneGain) this.droneGain.gain.value = 0.06 * this.musicGain();
  }

  stopDrone() {
    if (this.droneGain) { this.droneGain.disconnect(); this.droneGain = null; }
    this.musicPlaying = false;
  }
}

const audio = new AudioManager();

// ============================================================
// PARTICLE SYSTEM
// ============================================================
interface Particle { mesh: Mesh; vx: number; vy: number; vz: number; life: number; age: number; }
const particles: Particle[] = [];
const MAX_PARTICLES = 200;
const particleGeo = new SphereGeometry(0.012, 4, 4);

function spawnParticles(scene: Object3D, x: number, y: number, z: number, color: string, count: number, spread = 0.06) {
  for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
    const mat = new MeshBasicMaterial({ color: new Color(color), transparent: true, blending: AdditiveBlending });
    const mesh = new Mesh(particleGeo, mat);
    mesh.position.set(x + (Math.random()-0.5)*0.05, y + (Math.random()-0.5)*0.05, z + (Math.random()-0.5)*0.05);
    scene.add(mesh);
    particles.push({
      mesh, life: 0.6 + Math.random() * 0.4, age: 0,
      vx: (Math.random()-0.5) * spread, vy: Math.random() * spread * 1.5, vz: (Math.random()-0.5) * spread,
    });
  }
}

function updateParticles(delta: number, scene: Object3D) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age += delta;
    if (p.age >= p.life) { scene.remove(p.mesh); particles.splice(i, 1); continue; }
    p.vy -= 0.15 * delta;
    p.mesh.position.x += p.vx * delta;
    p.mesh.position.y += p.vy * delta;
    p.mesh.position.z += p.vz * delta;
    (p.mesh.material as MeshBasicMaterial).opacity = 1 - p.age / p.life;
  }
}

// ============================================================
// MINEFIELD MESH BUILDER (with animated reveals & mine pulse)
// ============================================================
const TILE_SIZE = 0.085;
const TILE_GAP = 0.004;
const TILE_DEPTH = 0.015;

interface TileMesh {
  base: Mesh;
  coverMesh: Mesh;
  numberMesh: Mesh | null;
  flagMesh: Mesh | null;
  mineMesh: Mesh | null;
  glowMesh: Mesh | null;
  r: number;
  c: number;
}

interface RevealAnim {
  r: number; c: number;
  elapsed: number;
  duration: number;
  startScale: number;
}

class MinefieldRenderer {
  group: Group = new Group();
  tiles: TileMesh[][] = [];
  boardWidth = 0;
  boardHeight = 0;
  hoverR = -1;
  hoverC = -1;
  revealAnims: RevealAnim[] = [];

  build(rows: number, cols: number, theme: Theme) {
    this.clear();
    this.boardWidth = cols * (TILE_SIZE + TILE_GAP);
    this.boardHeight = rows * (TILE_SIZE + TILE_GAP);
    this.tiles = [];
    this.revealAnims = [];

    // Board frame
    const frameMat = new MeshBasicMaterial({ color: new Color(theme.grid), transparent: true, opacity: 0.3, blending: AdditiveBlending });
    const frameTop = new Mesh(new BoxGeometry(this.boardWidth + 0.04, 0.008, 0.008), frameMat);
    frameTop.position.set(0, this.boardHeight / 2 + 0.012, 0);
    this.group.add(frameTop);
    const frameBot = new Mesh(new BoxGeometry(this.boardWidth + 0.04, 0.008, 0.008), frameMat.clone());
    frameBot.position.set(0, -this.boardHeight / 2 - 0.012, 0);
    this.group.add(frameBot);
    const frameLeft = new Mesh(new BoxGeometry(0.008, this.boardHeight + 0.04, 0.008), frameMat.clone());
    frameLeft.position.set(-this.boardWidth / 2 - 0.012, 0, 0);
    this.group.add(frameLeft);
    const frameRight = new Mesh(new BoxGeometry(0.008, this.boardHeight + 0.04, 0.008), frameMat.clone());
    frameRight.position.set(this.boardWidth / 2 + 0.012, 0, 0);
    this.group.add(frameRight);

    // Background plane
    const bgMat = new MeshStandardMaterial({ color: new Color(theme.tile), metalness: 0.2, roughness: 0.8, transparent: true, opacity: 0.4 });
    const bg = new Mesh(new PlaneGeometry(this.boardWidth + 0.02, this.boardHeight + 0.02), bgMat);
    bg.position.z = -0.01;
    this.group.add(bg);

    const coverGeo = new BoxGeometry(TILE_SIZE, TILE_SIZE, TILE_DEPTH);

    for (let r = 0; r < rows; r++) {
      this.tiles[r] = [];
      for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) * (TILE_SIZE + TILE_GAP);
        const y = ((rows - 1) / 2 - r) * (TILE_SIZE + TILE_GAP);

        const baseMat = new MeshStandardMaterial({ color: new Color(theme.tile), metalness: 0.3, roughness: 0.7, transparent: true, opacity: 0.3 });
        const base = new Mesh(new PlaneGeometry(TILE_SIZE * 0.95, TILE_SIZE * 0.95), baseMat);
        base.position.set(x, y, -0.005);
        this.group.add(base);

        const coverMat = new MeshStandardMaterial({ color: new Color(theme.accent), metalness: 0.5, roughness: 0.4, emissive: new Color(theme.accent), emissiveIntensity: 0.15 });
        const cover = new Mesh(coverGeo, coverMat);
        cover.position.set(x, y, TILE_DEPTH / 2);
        this.group.add(cover);

        const glowMat = new MeshBasicMaterial({ color: new Color(theme.glow), transparent: true, opacity: 0, blending: AdditiveBlending });
        const glow = new Mesh(new PlaneGeometry(TILE_SIZE * 1.1, TILE_SIZE * 1.1), glowMat);
        glow.position.set(x, y, TILE_DEPTH + 0.002);
        this.group.add(glow);

        this.tiles[r][c] = { base, coverMesh: cover, numberMesh: null, flagMesh: null, mineMesh: null, glowMesh: glow, r, c };
      }
    }
  }

  getTileWorldPos(r: number, c: number): Vector3 {
    if (!this.tiles[r]?.[c]) return new Vector3();
    return this.tiles[r][c].coverMesh.getWorldPosition(new Vector3());
  }

  startRevealAnim(r: number, c: number) {
    const tile = this.tiles[r]?.[c];
    if (!tile) return;
    this.revealAnims.push({ r, c, elapsed: 0, duration: 0.2, startScale: 1 });
  }

  revealTile(r: number, c: number, value: number, theme: Theme, animated = true) {
    const tile = this.tiles[r]?.[c];
    if (!tile) return;

    if (animated) {
      this.startRevealAnim(r, c);
    } else {
      tile.coverMesh.visible = false;
    }
    if (tile.flagMesh) tile.flagMesh.visible = false;

    if (value > 0 && value <= 8) {
      const numColor = theme.number[value] || '#fff';
      const numMat = new MeshBasicMaterial({ color: new Color(numColor), transparent: true, blending: AdditiveBlending });
      const geos = [
        null,
        new SphereGeometry(TILE_SIZE * 0.12, 8, 8),
        new BoxGeometry(TILE_SIZE * 0.2, TILE_SIZE * 0.2, TILE_SIZE * 0.1),
        new ConeGeometry(TILE_SIZE * 0.14, TILE_SIZE * 0.25, 3),
        new BoxGeometry(TILE_SIZE * 0.22, TILE_SIZE * 0.22, TILE_SIZE * 0.1),
        new IcosahedronGeometry(TILE_SIZE * 0.14),
        new TorusGeometry(TILE_SIZE * 0.1, TILE_SIZE * 0.04, 6, 6),
        new ConeGeometry(TILE_SIZE * 0.12, TILE_SIZE * 0.25, 7),
        new SphereGeometry(TILE_SIZE * 0.16, 8, 8),
      ];
      const geo = geos[value] || new SphereGeometry(TILE_SIZE * 0.12, 8, 8);
      const numMesh = new Mesh(geo, numMat);
      const pos = tile.coverMesh.position.clone();
      numMesh.position.set(pos.x, pos.y, 0.005);
      this.group.add(numMesh);
      tile.numberMesh = numMesh;

      const glowMat2 = new MeshBasicMaterial({ color: new Color(numColor), transparent: true, opacity: 0.15, blending: AdditiveBlending });
      const glowMesh = new Mesh(new SphereGeometry(TILE_SIZE * 0.25, 8, 8), glowMat2);
      glowMesh.position.copy(numMesh.position);
      this.group.add(glowMesh);

      for (let i = 0; i < value; i++) {
        const angle = (i / value) * Math.PI * 2;
        const dotMat = new MeshBasicMaterial({ color: new Color(numColor), transparent: true, opacity: 0.5, blending: AdditiveBlending });
        const dot = new Mesh(new SphereGeometry(0.003, 4, 4), dotMat);
        dot.position.set(pos.x + Math.cos(angle) * TILE_SIZE * 0.3, pos.y + Math.sin(angle) * TILE_SIZE * 0.3, 0.005);
        this.group.add(dot);
      }
    }

    (tile.base.material as MeshStandardMaterial).opacity = 0.6;
    (tile.base.material as MeshStandardMaterial).emissive = new Color(theme.accent);
    (tile.base.material as MeshStandardMaterial).emissiveIntensity = 0.05;
  }

  showMine(r: number, c: number, theme: Theme) {
    const tile = this.tiles[r]?.[c];
    if (!tile) return;
    tile.coverMesh.visible = false;
    const mineMat = new MeshBasicMaterial({ color: new Color(theme.mine), blending: AdditiveBlending });
    const mine = new Mesh(new IcosahedronGeometry(TILE_SIZE * 0.25), mineMat);
    const pos = tile.coverMesh.position.clone();
    mine.position.set(pos.x, pos.y, 0.01);
    this.group.add(mine);
    tile.mineMesh = mine;

    const glowMat = new MeshBasicMaterial({ color: new Color(theme.mine), transparent: true, opacity: 0.3, blending: AdditiveBlending });
    const glow = new Mesh(new SphereGeometry(TILE_SIZE * 0.4, 8, 8), glowMat);
    glow.position.copy(mine.position);
    this.group.add(glow);
  }

  addFlag(r: number, c: number, theme: Theme) {
    const tile = this.tiles[r]?.[c];
    if (!tile) return;
    const flagMat = new MeshBasicMaterial({ color: new Color(theme.flag), blending: AdditiveBlending });
    const flag = new Mesh(new ConeGeometry(TILE_SIZE * 0.15, TILE_SIZE * 0.3, 4), flagMat);
    const pos = tile.coverMesh.position.clone();
    flag.position.set(pos.x, pos.y, TILE_DEPTH + 0.02);
    this.group.add(flag);
    tile.flagMesh = flag;
  }

  removeFlag(r: number, c: number) {
    const tile = this.tiles[r]?.[c];
    if (!tile || !tile.flagMesh) return;
    this.group.remove(tile.flagMesh);
    tile.flagMesh = null;
  }

  highlightHintTile(r: number, c: number, theme: Theme) {
    const tile = this.tiles[r]?.[c];
    if (!tile) return;
    // Pulse the glow for hint tiles
    if (tile.glowMesh) {
      (tile.glowMesh.material as MeshBasicMaterial).color = new Color('#ff0');
      (tile.glowMesh.material as MeshBasicMaterial).opacity = 0.4;
    }
  }

  setHover(r: number, c: number) {
    if (this.hoverR === r && this.hoverC === c) return;
    if (this.hoverR >= 0 && this.tiles[this.hoverR]?.[this.hoverC]) {
      const old = this.tiles[this.hoverR][this.hoverC];
      if (old.glowMesh) (old.glowMesh.material as MeshBasicMaterial).opacity = 0;
    }
    this.hoverR = r; this.hoverC = c;
    if (r >= 0 && this.tiles[r]?.[c]) {
      const tile = this.tiles[r][c];
      if (tile.glowMesh) (tile.glowMesh.material as MeshBasicMaterial).opacity = 0.2;
    }
  }

  clearHover() { this.setHover(-1, -1); }

  updateAnimations(time: number, delta: number) {
    // Animate cover reveal (scale down)
    for (let i = this.revealAnims.length - 1; i >= 0; i--) {
      const anim = this.revealAnims[i];
      anim.elapsed += delta;
      const t = Math.min(anim.elapsed / anim.duration, 1);
      const tile = this.tiles[anim.r]?.[anim.c];
      if (tile && tile.coverMesh.visible) {
        const scale = 1 - t;
        tile.coverMesh.scale.set(scale, scale, scale);
        (tile.coverMesh.material as MeshStandardMaterial).opacity = 1 - t;
        if (t >= 1) {
          tile.coverMesh.visible = false;
          tile.coverMesh.scale.set(1, 1, 1);
          (tile.coverMesh.material as MeshStandardMaterial).opacity = 1;
          this.revealAnims.splice(i, 1);
        }
      } else {
        this.revealAnims.splice(i, 1);
      }
    }

    // Animate mine meshes (spin + pulse)
    for (let r = 0; r < this.tiles.length; r++) {
      for (let c = 0; c < (this.tiles[r]?.length ?? 0); c++) {
        const tile = this.tiles[r][c];
        if (tile.mineMesh) {
          tile.mineMesh.rotation.y = time * 2;
          tile.mineMesh.rotation.x = time * 1.5;
          // Pulse scale
          const pulse = 1 + Math.sin(time * 4 + r * 0.5 + c * 0.3) * 0.15;
          tile.mineMesh.scale.set(pulse, pulse, pulse);
        }
        if (tile.flagMesh) {
          tile.flagMesh.rotation.y = time * 1.5;
        }
        if (tile.numberMesh) {
          tile.numberMesh.rotation.y = Math.sin(time * 0.8 + r + c) * 0.3;
        }
      }
    }
  }

  clear() {
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0]);
    }
    this.tiles = [];
    this.hoverR = -1; this.hoverC = -1;
    this.revealAnims = [];
  }
}

// ============================================================
// HOLODECK ENVIRONMENT
// ============================================================
function buildEnvironment(scene: Object3D, theme: Theme) {
  const gridMat = new MeshBasicMaterial({ color: new Color(theme.grid), transparent: true, opacity: 0.08, blending: AdditiveBlending });
  for (let i = -10; i <= 10; i++) {
    const hLine = new Mesh(new BoxGeometry(20, 0.005, 0.005), gridMat.clone());
    hLine.position.set(0, 0, i);
    hLine.rotation.x = -Math.PI / 2;
    scene.add(hLine);
    const vLine = new Mesh(new BoxGeometry(0.005, 0.005, 20), gridMat.clone());
    vLine.position.set(i, 0, 0);
    scene.add(vLine);
  }
  for (let i = -10; i <= 10; i++) {
    const hLine = new Mesh(new BoxGeometry(20, 0.005, 0.005), gridMat.clone());
    hLine.position.set(0, 4, i);
    hLine.rotation.x = -Math.PI / 2;
    scene.add(hLine);
    const vLine = new Mesh(new BoxGeometry(0.005, 0.005, 20), gridMat.clone());
    vLine.position.set(i, 4, 0);
    scene.add(vLine);
  }

  const decoGeos = [new TorusGeometry(0.2, 0.04, 8, 16), new BoxGeometry(0.25, 0.25, 0.25), new SphereGeometry(0.15, 8, 8), new ConeGeometry(0.12, 0.3, 6)];
  for (let i = 0; i < 14; i++) {
    const geo = decoGeos[i % decoGeos.length];
    const mat = new MeshBasicMaterial({ color: new Color(theme.accent), transparent: true, opacity: 0.08, wireframe: true, blending: AdditiveBlending });
    const mesh = new Mesh(geo, mat);
    const angle = (i / 14) * Math.PI * 2;
    mesh.position.set(Math.cos(angle) * (3 + Math.random() * 4), 1 + Math.random() * 2, Math.sin(angle) * (3 + Math.random() * 4));
    mesh.userData.rotSpeed = 0.3 + Math.random() * 0.5;
    mesh.userData.bobSpeed = 0.5 + Math.random() * 0.5;
    mesh.userData.bobOffset = Math.random() * Math.PI * 2;
    mesh.userData.baseY = mesh.position.y;
    mesh.userData.isDeco = true;
    scene.add(mesh);
  }

  for (let i = 0; i < 40; i++) {
    const mat = new MeshBasicMaterial({ color: new Color(theme.accent), transparent: true, opacity: 0.15, blending: AdditiveBlending });
    const p = new Mesh(new SphereGeometry(0.01, 4, 4), mat);
    p.position.set((Math.random()-0.5)*12, Math.random()*4, (Math.random()-0.5)*12);
    p.userData.driftX = (Math.random()-0.5)*0.1;
    p.userData.driftY = (Math.random()-0.5)*0.05;
    p.userData.driftZ = (Math.random()-0.5)*0.1;
    p.userData.pulseSpeed = 1 + Math.random() * 2;
    p.userData.pulseOffset = Math.random() * Math.PI * 2;
    p.userData.isAmbient = true;
    scene.add(p);
  }

  const accent1 = new PointLight(new Color(theme.accent).getHex(), 0.5, 10);
  accent1.position.set(-2, 2.5, -1);
  scene.add(accent1);
  const accent2 = new PointLight(new Color(theme.glow).getHex(), 0.3, 10);
  accent2.position.set(2, 2, 1);
  scene.add(accent2);
  const dir = new DirectionalLight(0xffffff, 0.3);
  dir.position.set(0, 5, 3);
  scene.add(dir);
  const ambient = new AmbientLight(0x111122, 0.5);
  scene.add(ambient);

  scene.traverse(c => {
    if (c === scene && 'fog' in c) {
      (c as any).fog = new FogExp2(new Color(theme.fog).getHex(), 0.06);
    }
  });
}

function animateEnvironment(scene: Object3D, time: number) {
  scene.traverse(c => {
    if (c.userData.isDeco) {
      c.rotation.y += c.userData.rotSpeed * 0.01;
      c.rotation.x += c.userData.rotSpeed * 0.005;
      c.position.y = c.userData.baseY + Math.sin(time * c.userData.bobSpeed + c.userData.bobOffset) * 0.15;
    }
    if (c.userData.isAmbient) {
      c.position.x += c.userData.driftX * 0.01;
      c.position.y += c.userData.driftY * 0.01;
      c.position.z += c.userData.driftZ * 0.01;
      if (Math.abs(c.position.x) > 6) c.userData.driftX *= -1;
      if (c.position.y < 0 || c.position.y > 4) c.userData.driftY *= -1;
      if (Math.abs(c.position.z) > 6) c.userData.driftZ *= -1;
      if ((c as Mesh).material && ((c as Mesh).material as MeshBasicMaterial).opacity !== undefined) {
        ((c as Mesh).material as MeshBasicMaterial).opacity = 0.1 + 0.1 * Math.sin(time * (c.userData.pulseSpeed ?? 1) + (c.userData.pulseOffset ?? 0));
      }
    }
  });
}

// ============================================================
// FORMAT HELPERS
// ============================================================
function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const LEVEL_TITLES = ['Novice','Beginner','Learner','Student','Apprentice','Adept','Skilled','Expert','Master','Grandmaster','Sage','Oracle','Titan','Legend','Neon God'];
function getLevelTitle(level: number): string {
  const idx = Math.min(Math.floor((level - 1) / 4), LEVEL_TITLES.length - 1);
  return LEVEL_TITLES[idx];
}

// ============================================================
// MAIN GAME SYSTEM
// ============================================================
let world: World;
const minefield = new MinefieldRenderer();
const raycaster = new Raycaster();
const mouse = new Vector2();
let boardEntity: Entity | null = null;

// Track mode wins for 'all_modes' achievement
let modeWins: Set<string>;
try {
  const mw = localStorage.getItem('neon-mines-modewins');
  modeWins = mw ? new Set(JSON.parse(mw)) : new Set();
} catch { modeWins = new Set(); }

export class MinesweeperSystem extends createSystem({
  titlePanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/title.json')] },
  modePanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/modeselect.json')] },
  diffPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/difficulty.json')] },
  hudPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/hud.json')] },
  pausePanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/pause.json')] },
  gameoverPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/gameover.json')] },
  explosionPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/explosion.json')] },
  lbPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/leaderboard.json')] },
  achPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/achievements.json')] },
  statsPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/stats.json')] },
  settingsPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/settings.json')] },
  helpPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/help.json')] },
  toastPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/toast.json')] },
  countdownPanel: { required: [PanelUI, PanelDocument], where: [eq(PanelUI, 'config', './ui/countdown.json')] },
}) {
  entities: Record<string, Entity> = {};
  toastTimer = 0;
  countdownTimer = 0;
  countdownValue = 0;
  pendingMode: GameMode = 'classic';
  chainCount = 0;
  revealBurst = 0;
  revealBurstTimer = 0;
  // Sequential mine explosion
  mineExplosionQueue: { r: number; c: number }[] = [];
  mineExplosionTimer = 0;
  mineExplosionInterval = 0.08;
  // Time warning
  lastWarningTick = -1;
  // Toast queue
  toastQueue: string[] = [];

  private _kb(): KeyboardLike {
    return (this.input as unknown as { keyboard: KeyboardLike }).keyboard;
  }

  private getDoc(e: Entity): UIKitDocument | undefined {
    return PanelDocument.data.document[e.index] as UIKitDocument | undefined;
  }
  private setText(e: Entity, id: string, text: string) {
    (this.getDoc(e)?.getElementById(id) as UIKit.Text | undefined)?.setProperties({ text });
  }
  private btn(e: Entity, id: string, cb: () => void) {
    (this.getDoc(e)?.getElementById(id) as UIKit.Text | undefined)?.addEventListener('click', cb);
  }

  init() {
    // Wire all panels
    this.queries.titlePanel.subscribe('qualify', (e) => {
      this.entities.title = e;
      this.btn(e, 'btn-play', () => { GM.state = 'modeselect'; audio.playClick(); this.updateVisibility(); });
      this.btn(e, 'btn-scores', () => { GM.state = 'leaderboard'; audio.playClick(); this.updateVisibility(); this.updateLeaderboard(); });
      this.btn(e, 'btn-achievements', () => { GM.state = 'achievements'; audio.playClick(); this.updateVisibility(); this.updateAchievements(); });
      this.btn(e, 'btn-stats', () => { GM.state = 'stats'; audio.playClick(); this.updateVisibility(); this.updateStats(); });
      this.btn(e, 'btn-settings', () => { GM.state = 'settings'; audio.playClick(); this.updateVisibility(); this.updateSettings(); });
      this.btn(e, 'btn-help', () => { GM.state = 'help'; audio.playClick(); this.updateVisibility(); });
      this.setText(e, 'level-text', `Level ${GM.level} - ${getLevelTitle(GM.level)}`);
      this.updateVisibility();
    });

    this.queries.modePanel.subscribe('qualify', (e) => {
      this.entities.mode = e;
      const modes: GameMode[] = ['classic','timed','noflag','daily','zen','practice'];
      modes.forEach(m => {
        this.btn(e, `btn-${m}`, () => { this.pendingMode = m; GM.state = 'difficulty'; audio.playClick(); this.updateVisibility(); });
      });
      this.btn(e, 'btn-back', () => { GM.state = 'title'; audio.playClick(); this.updateVisibility(); });
    });

    this.queries.diffPanel.subscribe('qualify', (e) => {
      this.entities.diff = e;
      (['easy','medium','hard'] as Difficulty[]).forEach(d => {
        this.btn(e, `btn-${d}`, () => { this.startNewGame(this.pendingMode, d); audio.playClick(); });
      });
      this.btn(e, 'btn-back', () => { GM.state = 'modeselect'; audio.playClick(); this.updateVisibility(); });
    });

    this.queries.hudPanel.subscribe('qualify', (e) => {
      this.entities.hud = e;
      this.btn(e, 'btn-hint', () => { this.useHint(); });
    });

    this.queries.pausePanel.subscribe('qualify', (e) => {
      this.entities.pause = e;
      this.btn(e, 'btn-resume', () => { GM.state = 'playing'; GM.timerRunning = true; audio.playClick(); this.updateVisibility(); });
      this.btn(e, 'btn-quit', () => { GM.state = 'title'; GM.timerRunning = false; audio.playClick(); this.clearBoard(); this.updateVisibility(); });
    });

    this.queries.gameoverPanel.subscribe('qualify', (e) => {
      this.entities.gameover = e;
      this.btn(e, 'btn-rematch', () => { this.startNewGame(GM.mode, GM.difficulty); audio.playClick(); });
      this.btn(e, 'btn-menu', () => { GM.state = 'title'; audio.playClick(); this.clearBoard(); this.updateVisibility(); });
    });

    this.queries.explosionPanel.subscribe('qualify', (e) => {
      this.entities.explosion = e;
      this.btn(e, 'btn-retry', () => { this.startNewGame(GM.mode, GM.difficulty); audio.playClick(); });
      this.btn(e, 'btn-menu2', () => { GM.state = 'title'; audio.playClick(); this.clearBoard(); this.updateVisibility(); });
    });

    this.queries.lbPanel.subscribe('qualify', (e) => {
      this.entities.lb = e;
      this.btn(e, 'btn-back', () => { GM.state = 'title'; audio.playClick(); this.updateVisibility(); });
    });

    this.queries.achPanel.subscribe('qualify', (e) => {
      this.entities.ach = e;
      this.btn(e, 'btn-back', () => { GM.state = 'title'; audio.playClick(); this.updateVisibility(); });
      this.btn(e, 'btn-prev', () => { if (GM.achPage > 0) GM.achPage--; this.updateAchievements(); audio.playClick(); });
      this.btn(e, 'btn-next', () => { const maxP = Math.ceil(ACHIEVEMENTS.length / 15) - 1; if (GM.achPage < maxP) GM.achPage++; this.updateAchievements(); audio.playClick(); });
    });

    this.queries.statsPanel.subscribe('qualify', (e) => {
      this.entities.stats = e;
      this.btn(e, 'btn-back', () => { GM.state = 'title'; audio.playClick(); this.updateVisibility(); });
    });

    this.queries.settingsPanel.subscribe('qualify', (e) => {
      this.entities.settings = e;
      this.btn(e, 'btn-back', () => { GM.state = 'title'; audio.playClick(); GM.save(); this.updateVisibility(); });
      this.btn(e, 'btn-master-up', () => { GM.masterVol = Math.min(100, GM.masterVol + 10); this.updateSettings(); audio.updateDroneVolume(); });
      this.btn(e, 'btn-master-down', () => { GM.masterVol = Math.max(0, GM.masterVol - 10); this.updateSettings(); audio.updateDroneVolume(); });
      this.btn(e, 'btn-sfx-up', () => { GM.sfxVol = Math.min(100, GM.sfxVol + 10); this.updateSettings(); });
      this.btn(e, 'btn-sfx-down', () => { GM.sfxVol = Math.max(0, GM.sfxVol - 10); this.updateSettings(); });
      this.btn(e, 'btn-music-up', () => { GM.musicVol = Math.min(100, GM.musicVol + 10); this.updateSettings(); audio.updateDroneVolume(); });
      this.btn(e, 'btn-music-down', () => { GM.musicVol = Math.max(0, GM.musicVol - 10); this.updateSettings(); audio.updateDroneVolume(); });
      this.btn(e, 'btn-theme-prev', () => { GM.themeIndex = (GM.themeIndex - 1 + THEMES.length) % THEMES.length; this.updateSettings(); });
      this.btn(e, 'btn-theme-next', () => { GM.themeIndex = (GM.themeIndex + 1) % THEMES.length; this.updateSettings(); });
      this.btn(e, 'btn-reset', () => {
        localStorage.clear();
        Object.assign(GM.stats, { games:0,wins:0,bestEasy:Infinity,bestMedium:Infinity,bestHard:Infinity,tilesRevealed:0,minesFlagged:0,minesDetonated:0,winStreak:0,bestStreak:0,playTime:0,easyWins:0,mediumWins:0,hardWins:0,bestCombo:0,totalHintsUsed:0 });
        GM.achievements.clear(); GM.leaderboard = []; GM.xp = 0; GM.level = 1; modeWins.clear();
        this.updateSettings();
      });
    });

    this.queries.helpPanel.subscribe('qualify', (e) => {
      this.entities.help = e;
      this.btn(e, 'btn-back', () => { GM.state = 'title'; audio.playClick(); this.updateVisibility(); });
    });

    this.queries.toastPanel.subscribe('qualify', (e) => { this.entities.toast = e; });
    this.queries.countdownPanel.subscribe('qualify', (e) => { this.entities.countdown = e; });

    document.addEventListener('contextmenu', e => e.preventDefault());
    audio.startDrone();
  }

  useHint() {
    if (GM.state !== 'playing' || !GM.gameStarted) return;
    if (GM.xp < HINT_COST) {
      this.showToast(`Need ${HINT_COST} XP for hint`);
      return;
    }
    const hintLimit = HINT_LIMITS[GM.difficulty];
    if (GM.hintsUsedThisGame >= hintLimit) {
      this.showToast(`Max ${hintLimit} hints per game`);
      return;
    }
    const tile = GM.findHintTile();
    if (!tile) {
      this.showToast('No tiles to hint');
      return;
    }
    GM.xp -= HINT_COST;
    GM.hintsUsedThisGame++;
    // Highlight then reveal
    minefield.highlightHintTile(tile.r, tile.c, GM.theme);
    audio.playHint();
    // Auto-reveal after brief highlight
    setTimeout(() => {
      const prevRevealed = GM.tilesRevealed;
      const result = GM.reveal(tile.r, tile.c);
      if (result === 'safe') {
        this.syncRevealedTiles();
        const newRevealed = GM.tilesRevealed - prevRevealed;
        const pos = minefield.getTileWorldPos(tile.r, tile.c);
        spawnParticles(world.scene, pos.x, pos.y, pos.z, '#ff0', 6, 0.03);
        if (GM.checkWin()) this.handleWin();
      }
    }, 300);
    this.showToast(`Hint! (-${HINT_COST} XP)`);
  }

  startNewGame(mode: GameMode, diff: Difficulty) {
    this.clearBoard();
    this.mineExplosionQueue = [];
    this.lastWarningTick = -1;
    GM.startGame(mode, diff);
    minefield.build(GM.rows, GM.cols, GM.theme);
    minefield.group.position.set(0, 1.4, -1.5);
    world.scene.add(minefield.group);
    this.updateVisibility();
  }

  clearBoard() {
    if (minefield.group.parent) world.scene.remove(minefield.group);
    minefield.clear();
    this.mineExplosionQueue = [];
  }

  showToast(text: string) {
    if (this.entities.toast) {
      this.setText(this.entities.toast, 'toast-text', text);
      this.toastTimer = 2.5;
    }
  }

  queueToast(text: string) {
    this.toastQueue.push(text);
  }

  updateVisibility() {
    const s = GM.state;
    const vis: Record<string, boolean> = {
      title: s === 'title', mode: s === 'modeselect', diff: s === 'difficulty',
      hud: s === 'playing', pause: s === 'paused', gameover: s === 'won',
      explosion: s === 'lost', lb: s === 'leaderboard', ach: s === 'achievements',
      stats: s === 'stats', settings: s === 'settings', help: s === 'help',
    };
    for (const [key, entity] of Object.entries(this.entities)) {
      if (key === 'toast' || key === 'countdown') continue;
      if (entity?.object3D) entity.object3D.visible = !!vis[key];
    }
    if (this.entities.toast?.object3D) this.entities.toast.object3D.visible = this.toastTimer > 0;
    if (this.entities.countdown?.object3D) this.entities.countdown.object3D.visible = this.countdownTimer > 0;
  }

  updateHUD() {
    const e = this.entities.hud;
    if (!e) return;
    this.setText(e, 'hud-time', fmtTime(GM.elapsedTime));
    this.setText(e, 'hud-mines', `${GM.mineCount}`);
    this.setText(e, 'hud-flags', `${GM.flagsPlaced}`);
    this.setText(e, 'hud-tiles', `${GM.totalSafeTiles - GM.tilesRevealed}`);
    this.setText(e, 'hud-mode', GM.mode.toUpperCase());
    // Combo display
    this.setText(e, 'hud-combo', `${GM.combo}`);
    const mult = GM.getComboMultiplier();
    this.setText(e, 'hud-combo-mult', `x${mult}`);
    // XP display
    this.setText(e, 'hud-xp', `${GM.xp}`);
  }

  updateGameOver() {
    const e = this.entities.gameover;
    if (!e) return;
    this.setText(e, 'result-time', fmtTime(GM.elapsedTime));
    this.setText(e, 'result-mines', `${GM.mineCount}`);
    this.setText(e, 'result-grid', `${GM.rows}x${GM.cols}`);
    this.setText(e, 'result-flags', `${GM.flagsPlaced}`);
    this.setText(e, 'result-efficiency', `${GM.getEfficiency()}%`);
    this.setText(e, 'result-combo', `${GM.maxCombo}`);
    this.setText(e, 'result-hints', `${GM.hintsUsedThisGame}`);
    this.setText(e, 'result-combobonus', `+${GM.comboXPBonus} XP`);
    this.setText(e, 'result-rating', GM.getRating());
  }

  updateExplosion() {
    const e = this.entities.explosion;
    if (!e) return;
    this.setText(e, 'explode-time', fmtTime(GM.elapsedTime));
    this.setText(e, 'explode-tiles', `${GM.tilesRevealed}`);
    const pct = Math.round((GM.tilesRevealed / GM.totalSafeTiles) * 100);
    this.setText(e, 'explode-progress', `${pct}%`);
    this.setText(e, 'explode-combo', `${GM.maxCombo}`);
    this.setText(e, 'explode-hints', `${GM.hintsUsedThisGame}`);
  }

  updateLeaderboard() {
    const e = this.entities.lb;
    if (!e) return;
    for (let i = 0; i < 10; i++) {
      const entry = GM.leaderboard[i];
      this.setText(e, `r${i}-rank`, entry ? `${i+1}` : '-');
      this.setText(e, `r${i}-time`, entry ? fmtTime(entry.time) : '-');
      this.setText(e, `r${i}-grid`, entry ? entry.grid : '-');
      this.setText(e, `r${i}-mode`, entry ? entry.mode : '-');
      this.setText(e, `r${i}-date`, entry ? entry.date : '-');
    }
  }

  updateAchievements() {
    const e = this.entities.ach;
    if (!e) return;
    const page = GM.achPage;
    const start = page * 15;
    const maxPages = Math.ceil(ACHIEVEMENTS.length / 15);
    this.setText(e, 'ach-count', `${GM.achievements.size} / ${ACHIEVEMENTS.length} unlocked`);
    this.setText(e, 'ach-page', `${page+1}/${maxPages}`);
    for (let i = 0; i < 15; i++) {
      const ach = ACHIEVEMENTS[start + i];
      if (ach) {
        const unlocked = GM.achievements.has(ach.id);
        this.setText(e, `a${i}-check`, unlocked ? '[X]' : '[  ]');
        this.setText(e, `a${i}-name`, ach.name);
        this.setText(e, `a${i}-desc`, ach.desc);
      } else {
        this.setText(e, `a${i}-check`, '');
        this.setText(e, `a${i}-name`, '');
        this.setText(e, `a${i}-desc`, '');
      }
    }
  }

  updateStats() {
    const e = this.entities.stats;
    if (!e) return;
    this.setText(e, 'stat-games', `${GM.stats.games}`);
    this.setText(e, 'stat-wins', `${GM.stats.wins}`);
    this.setText(e, 'stat-winrate', GM.stats.games > 0 ? `${Math.round(GM.stats.wins / GM.stats.games * 100)}%` : '0%');
    this.setText(e, 'stat-best-easy', GM.stats.bestEasy < Infinity ? fmtTime(GM.stats.bestEasy) : '--:--');
    this.setText(e, 'stat-best-med', GM.stats.bestMedium < Infinity ? fmtTime(GM.stats.bestMedium) : '--:--');
    this.setText(e, 'stat-best-hard', GM.stats.bestHard < Infinity ? fmtTime(GM.stats.bestHard) : '--:--');
    this.setText(e, 'stat-easy-wins', `${GM.stats.easyWins}`);
    this.setText(e, 'stat-med-wins', `${GM.stats.mediumWins}`);
    this.setText(e, 'stat-hard-wins', `${GM.stats.hardWins}`);
    this.setText(e, 'stat-tiles', `${GM.stats.tilesRevealed}`);
    this.setText(e, 'stat-flagged', `${GM.stats.minesFlagged}`);
    this.setText(e, 'stat-detonated', `${GM.stats.minesDetonated}`);
    this.setText(e, 'stat-bestcombo', `${GM.stats.bestCombo}`);
    this.setText(e, 'stat-hints', `${GM.stats.totalHintsUsed}`);
    this.setText(e, 'stat-streak', `${GM.stats.winStreak}`);
    this.setText(e, 'stat-beststreak', `${GM.stats.bestStreak}`);
    this.setText(e, 'stat-playtime', `${Math.floor(GM.stats.playTime / 60)}m`);
  }

  updateSettings() {
    const e = this.entities.settings;
    if (!e) return;
    this.setText(e, 'vol-master', `${GM.masterVol}`);
    this.setText(e, 'vol-sfx', `${GM.sfxVol}`);
    this.setText(e, 'vol-music', `${GM.musicVol}`);
    this.setText(e, 'theme-name', GM.theme.name);
  }

  handleTileClick(r: number, c: number, button: 'left' | 'right' | 'middle') {
    if (GM.state !== 'playing') return;

    if (button === 'right') {
      if (GM.toggleFlag(r, c)) {
        if (GM.flagged[r][c]) {
          minefield.addFlag(r, c, GM.theme);
          audio.playFlag();
        } else {
          minefield.removeFlag(r, c);
          audio.playUnflag();
        }
      }
      return;
    }

    if (button === 'middle') {
      const prevRevealed = GM.tilesRevealed;
      const result = GM.chordReveal(r, c);
      if (result === 'mine') {
        this.handleMineHit(r, c);
        return;
      }
      if (result === 'safe') {
        const newRevealed = GM.tilesRevealed - prevRevealed;
        this.updateCombo(newRevealed);
        this.syncRevealedTiles();
        audio.playChord();
        if (GM.checkWin()) this.handleWin();
      }
      return;
    }

    // Left click
    const prevRevealed = GM.tilesRevealed;
    const result = GM.reveal(r, c);
    if (result === 'mine') {
      this.handleMineHit(r, c);
      return;
    }
    if (result === 'safe') {
      const newRevealed = GM.tilesRevealed - prevRevealed;
      this.chainCount = newRevealed;

      // Chain achievements
      if (newRevealed >= 30 && !GM.achievements.has('chain_clear')) {
        GM.achievements.add('chain_clear'); GM.save();
        this.queueToast('Chain Reaction!');
        audio.playAchievement();
      }
      if (newRevealed >= 50 && !GM.achievements.has('chain50')) {
        GM.achievements.add('chain50'); GM.save();
        this.queueToast('Avalanche!');
      }
      if (newRevealed >= 100 && !GM.achievements.has('chain100')) {
        GM.achievements.add('chain100'); GM.save();
        this.queueToast('Tectonic!');
      }

      // Update combo
      this.updateCombo(newRevealed);

      if (newRevealed > 1) audio.playFloodReveal();
      else {
        const val = GM.grid[r]?.[c] ?? 0;
        if (val > 0) audio.playNumberReveal(val);
        else audio.playReveal();
      }

      this.revealBurst += newRevealed;
      this.revealBurstTimer = 5;

      this.syncRevealedTiles();

      const pos = minefield.getTileWorldPos(r, c);
      spawnParticles(world.scene, pos.x, pos.y, pos.z, GM.theme.accent, Math.min(newRevealed, 8), 0.04);

      if (GM.checkWin()) this.handleWin();
    }
  }

  updateCombo(tilesRevealed: number) {
    GM.combo += tilesRevealed;
    GM.comboTimer = COMBO_TIMEOUT;
    if (GM.combo > GM.maxCombo) GM.maxCombo = GM.combo;

    // Combo achievements
    if (GM.combo >= 5 && !GM.achievements.has('combo5')) {
      GM.achievements.add('combo5'); GM.save();
      this.queueToast('Hot Combo!');
    }
    if (GM.combo >= 10 && !GM.achievements.has('combo10')) {
      GM.achievements.add('combo10'); GM.save();
      this.queueToast('Fire Combo!');
    }
    if (GM.combo >= 20 && !GM.achievements.has('combo20')) {
      GM.achievements.add('combo20'); GM.save();
      this.queueToast('Inferno!');
    }

    // Audio feedback at combo thresholds
    if (GM.combo >= 3) {
      audio.playCombo(Math.min(GM.combo, 25));
    }
  }

  handleWin() {
    modeWins.add(GM.mode);
    try { localStorage.setItem('neon-mines-modewins', JSON.stringify([...modeWins])); } catch {}
    if (modeWins.size >= 6 && !GM.achievements.has('all_modes')) {
      GM.achievements.add('all_modes'); GM.save();
    }
    GM.endGame(true);
    audio.playWin();
    // Reveal all mines as flags
    for (let mr = 0; mr < GM.rows; mr++)
      for (let mc = 0; mc < GM.cols; mc++)
        if (GM.grid[mr][mc] === -1 && !GM.flagged[mr][mc])
          minefield.addFlag(mr, mc, GM.theme);
    this.updateGameOver();
    const newAchs = checkAchievements(audio);
    newAchs.forEach(n => this.queueToast(n + ' unlocked!'));
    // Big win celebration particles
    spawnParticles(world.scene, 0, 1.8, -1.5, '#0f0', 40, 0.18);
    spawnParticles(world.scene, -0.3, 1.6, -1.5, GM.theme.accent, 15, 0.12);
    spawnParticles(world.scene, 0.3, 1.6, -1.5, GM.theme.glow, 15, 0.12);
    this.updateVisibility();
  }

  handleMineHit(r: number, c: number) {
    // Build sequential explosion queue
    this.mineExplosionQueue = [];
    // Start with the hit mine
    this.mineExplosionQueue.push({ r, c });
    // Add remaining mines in spiral order from hit position
    const mines: { r: number; c: number; dist: number }[] = [];
    for (let mr = 0; mr < GM.rows; mr++) {
      for (let mc = 0; mc < GM.cols; mc++) {
        if (GM.grid[mr]?.[mc] === -1 && (mr !== r || mc !== c)) {
          const dist = Math.abs(mr - r) + Math.abs(mc - c);
          mines.push({ r: mr, c: mc, dist });
        }
      }
    }
    mines.sort((a, b) => a.dist - b.dist);
    mines.forEach(m => this.mineExplosionQueue.push({ r: m.r, c: m.c }));
    this.mineExplosionTimer = 0;

    // Show first mine immediately
    const firstMine = this.mineExplosionQueue.shift()!;
    minefield.showMine(firstMine.r, firstMine.c, GM.theme);
    const pos = minefield.getTileWorldPos(firstMine.r, firstMine.c);
    spawnParticles(world.scene, pos.x, pos.y, pos.z, GM.theme.mine, 15, 0.1);
    audio.playExplosion();

    GM.endGame(false);
    // Delay showing explosion panel until chain finishes
    // (updateExplosion is called in update when queue empties)
  }

  syncRevealedTiles() {
    for (let r = 0; r < GM.rows; r++) {
      for (let c = 0; c < GM.cols; c++) {
        if (GM.revealed[r]?.[c] && minefield.tiles[r]?.[c]?.coverMesh.visible) {
          minefield.revealTile(r, c, GM.grid[r][c], GM.theme, true);
        }
      }
    }
  }

  pickTile(clientX: number, clientY: number): { r: number; c: number } | null {
    const canvas = world.renderer.domElement;
    mouse.x = (clientX / canvas.clientWidth) * 2 - 1;
    mouse.y = -(clientY / canvas.clientHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, world.camera);

    let bestDist = Infinity;
    let bestTile: { r: number; c: number } | null = null;
    for (let r = 0; r < minefield.tiles.length; r++) {
      for (let c = 0; c < (minefield.tiles[r]?.length ?? 0); c++) {
        const tile = minefield.tiles[r][c];
        if (!tile.coverMesh.visible && !GM.revealed[r]?.[c]) continue;
        const intersects = raycaster.intersectObject(tile.coverMesh.visible ? tile.coverMesh : tile.base, false);
        if (intersects.length > 0 && intersects[0].distance < bestDist) {
          bestDist = intersects[0].distance;
          bestTile = { r, c };
        }
      }
    }
    return bestTile;
  }

  update(delta: number, time: number) {
    // Timer
    if (GM.timerRunning) {
      GM.elapsedTime += delta;
      GM.stats.playTime += delta;
      if (GM.mode === 'timed' && GM.elapsedTime >= GM.timeLimit) {
        GM.endGame(false);
        this.updateExplosion();
        this.updateVisibility();
        audio.playExplosion();
      }
    }

    // Time warning (timed mode)
    if (GM.state === 'playing' && GM.mode === 'timed' && GM.timerRunning) {
      const remaining = GM.timeLimit - GM.elapsedTime;
      if (remaining > 0 && remaining <= 30) {
        const currentTick = Math.floor(remaining);
        if (currentTick !== this.lastWarningTick) {
          this.lastWarningTick = currentTick;
          audio.playWarningTick(remaining <= 10);
        }
      }
    }

    // Combo timer decay
    if (GM.comboTimer > 0 && GM.state === 'playing') {
      GM.comboTimer -= delta;
      if (GM.comboTimer <= 0) {
        GM.combo = 0;
      }
    }

    // Sequential mine explosion
    if (this.mineExplosionQueue.length > 0) {
      this.mineExplosionTimer += delta;
      if (this.mineExplosionTimer >= this.mineExplosionInterval) {
        this.mineExplosionTimer = 0;
        const m = this.mineExplosionQueue.shift()!;
        minefield.showMine(m.r, m.c, GM.theme);
        const pos = minefield.getTileWorldPos(m.r, m.c);
        spawnParticles(world.scene, pos.x, pos.y, pos.z, GM.theme.mine, 3, 0.04);
        audio.playMineRevealTick();
        // When queue empties, show the explosion panel
        if (this.mineExplosionQueue.length === 0) {
          this.updateExplosion();
          const newAchs = checkAchievements(audio);
          newAchs.forEach(n => this.queueToast(n + ' unlocked!'));
          this.updateVisibility();
        }
      }
    }

    // HUD
    if (GM.state === 'playing') this.updateHUD();

    // Toast timer + queue
    if (this.toastTimer > 0) {
      this.toastTimer -= delta;
      if (this.entities.toast?.object3D) {
        this.entities.toast.object3D.visible = this.toastTimer > 0;
      }
      if (this.toastTimer <= 0 && this.toastQueue.length > 0) {
        this.showToast(this.toastQueue.shift()!);
      }
    } else if (this.toastQueue.length > 0) {
      this.showToast(this.toastQueue.shift()!);
    }

    // Reveal burst timer (for quick_draw achievement)
    if (this.revealBurstTimer > 0) {
      this.revealBurstTimer -= delta;
      if (this.revealBurstTimer <= 0) {
        if (this.revealBurst >= 20 && !GM.achievements.has('fast_reveal')) {
          GM.achievements.add('fast_reveal');
          GM.save();
          this.showToast('Quick Draw!');
          audio.playAchievement();
        }
        this.revealBurst = 0;
      }
    }

    // Keyboard input
    const kb = this._kb();
    if (kb.getKeyDown('Escape') || kb.getKeyDown('KeyP')) {
      if (GM.state === 'playing') {
        GM.state = 'paused'; GM.timerRunning = false; this.updateVisibility();
      } else if (GM.state === 'paused') {
        GM.state = 'playing'; GM.timerRunning = true; this.updateVisibility();
      }
    }
    if (kb.getKeyDown('KeyR') && (GM.state === 'won' || GM.state === 'lost')) {
      this.startNewGame(GM.mode, GM.difficulty);
    }
    if (kb.getKeyDown('KeyH') && GM.state === 'playing') {
      this.useHint();
    }

    // XR controller input
    const rightGP = this.input.gamepads.right;
    if (rightGP) {
      if (rightGP.getButtonDown(InputComponent.B_Button)) {
        if (GM.state === 'playing') { GM.state = 'paused'; GM.timerRunning = false; this.updateVisibility(); }
      }
    }

    // Animations
    minefield.updateAnimations(time, delta);
    animateEnvironment(world.scene, time);
    updateParticles(delta, world.scene);

    // Update title level display
    if (GM.state === 'title' && this.entities.title) {
      this.setText(this.entities.title, 'level-text', `Level ${GM.level} - ${getLevelTitle(GM.level)}`);
    }
  }
}

// ============================================================
// INIT
// ============================================================
async function main() {
  const container = document.getElementById('app') as HTMLDivElement;
  world = await World.create(container, {
    xr: { offer: 'once' as const },
    render: {
      fov: 60,
      near: 0.1,
      far: 100,
      defaultLighting: false,
    },
    features: {
      physics: false,
      locomotion: false,
      grabbing: false,
    },
  });

  world.scene.fog = new FogExp2(new Color(GM.theme.fog).getHex(), 0.06);
  buildEnvironment(world.scene, GM.theme);

  world.registerSystem(MinesweeperSystem);

  const panels = [
    { config: './ui/title.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/modeselect.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/difficulty.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/hud.json', offset: [0, 0.15, -0.5] as [number,number,number], speed: 10 },
    { config: './ui/pause.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/gameover.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/explosion.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/leaderboard.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/achievements.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/stats.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/settings.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/help.json', offset: [0, 0.1, -2] as [number,number,number], speed: 5 },
    { config: './ui/toast.json', offset: [0, 0.08, -0.5] as [number,number,number], speed: 10 },
    { config: './ui/countdown.json', offset: [0, 0, -0.6] as [number,number,number], speed: 10 },
  ];

  for (const p of panels) {
    const entity = world.createTransformEntity();
    entity.addComponent(PanelUI, { config: p.config });
    entity.addComponent(Follower, {
      target: world.camera,
      offsetPosition: p.offset,
      speed: p.speed,
    });
  }

  const canvas = world.renderer.domElement;
  canvas.addEventListener('mousedown', (ev: MouseEvent) => {
    if (GM.state !== 'playing') return;
    const sys = world.getSystem(MinesweeperSystem);
    if (!sys) return;
    const tile = sys.pickTile(ev.clientX, ev.clientY);
    if (!tile) return;
    const button = ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left';
    sys.handleTileClick(tile.r, tile.c, button);
  });

  canvas.addEventListener('mousemove', (ev: MouseEvent) => {
    if (GM.state !== 'playing') return;
    const sys = world.getSystem(MinesweeperSystem);
    if (!sys) return;
    const tile = sys.pickTile(ev.clientX, ev.clientY);
    if (tile) minefield.setHover(tile.r, tile.c);
    else minefield.clearHover();
  });
}

main();
