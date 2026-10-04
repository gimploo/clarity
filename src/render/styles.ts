/**
 * Colour and shape vocabulary for the map overlay.
 *
 * Chosen for a dark UI: humans are cyan, bots are magenta, and event markers use
 * a warm ramp so they stay legible on top of both path colours and the minimap.
 */

export interface Palette {
  human: string;
  humanSoft: string;
  bot: string;
  botSoft: string;
  humanPath: string;
  botPath: string;
  kill: string;
  death: string;
  stormDeath: string;
  loot: string;
  accent: string;
  text: string;
  textDim: string;
  panel: string;
  panelBorder: string;
  heatLow: string;
  heatHigh: string;
}

export const PALETTE: Palette = {
  human: '#38bdf8',
  humanSoft: 'rgba(56, 189, 248, 0.16)',
  bot: '#f472b6',
  botSoft: 'rgba(244, 114, 182, 0.16)',
  humanPath: 'rgba(56, 189, 248, 0.85)',
  botPath: 'rgba(244, 114, 182, 0.7)',
  kill: '#fb923c',
  death: '#f87171',
  stormDeath: '#a78bfa',
  loot: '#facc15',
  accent: '#38bdf8',
  text: '#e2e8f0',
  textDim: '#94a3b8',
  panel: '#0f172a',
  panelBorder: '#1e293b',
  heatLow: 'rgba(56, 189, 248, 0)',
  heatHigh: 'rgba(248, 113, 113, 0.85)',
};

export type MarkerShape = 'cross' | 'triangle' | 'diamond' | 'square';

/** Visual identity for each marker kind. */
export interface MarkerStyle {
  color: string;
  shape: MarkerShape;
  size: number;
  label: string;
  description: string;
}

export const MARKER_STYLES: Record<'kill' | 'death' | 'stormDeath' | 'loot', MarkerStyle> = {
  kill: {
    color: PALETTE.kill,
    shape: 'cross',
    size: 5,
    label: 'Kill',
    description: 'Subject killed another player or bot',
  },
  death: {
    color: PALETTE.death,
    shape: 'triangle',
    size: 6,
    label: 'Death',
    description: 'Subject was killed by another player or bot',
  },
  stormDeath: {
    color: PALETTE.stormDeath,
    shape: 'diamond',
    size: 7,
    label: 'Storm death',
    description: 'Subject died to the storm',
  },
  loot: {
    color: PALETTE.loot,
    shape: 'square',
    size: 3.5,
    label: 'Loot',
    description: 'Subject picked up an item',
  },
};

/** Draws a marker centred on (x, y). */
export function drawMarker(
  ctx: CanvasRenderingContext2D,
  shape: MarkerShape,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.beginPath();
  switch (shape) {
    case 'cross': {
      const arm = size * 1.7;
      ctx.moveTo(x - arm, y);
      ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm);
      ctx.lineTo(x, y + arm);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      return;
    }
    case 'triangle': {
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y + size * 0.8);
      ctx.lineTo(x - size, y + size * 0.8);
      ctx.closePath();
      break;
    }
    case 'diamond': {
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
      ctx.closePath();
      break;
    }
    case 'square': {
      ctx.rect(x - size, y - size, size * 2, size * 2);
      break;
    }
  }
  ctx.fillStyle = color;
  ctx.fill();
  // Dark outline keeps small markers readable over bright terrain.
  ctx.strokeStyle = 'rgba(2, 6, 23, 0.75)';
  ctx.lineWidth = 1;
  ctx.stroke();
}