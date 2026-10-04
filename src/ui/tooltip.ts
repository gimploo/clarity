/**
 * Hover card for the map.
 *
 * Marker detail is the difference between "a dot on a map" and an answer a Level
 * Designer can act on, so this shows who, what, where in world coordinates and
 * how far into the match it happened.
 */
import { EVENT_TYPES, MARKER_SPECS } from '../core/types';
import { interpretEvent } from '../core/classify';
import { formatMs, shortId } from './dom';
import type { HoverTarget } from '../render/scene';

const SUBJECT_LABEL: Record<string, string> = {
  kill: 'Kill',
  death: 'Death',
  stormDeath: 'Storm death',
  loot: 'Loot pickup',
  position: 'Position sample',
};

export class Tooltip {
  readonly element: HTMLElement;
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.element = document.createElement('div');
    this.element.className = 'tooltip';
    this.element.hidden = true;
    host.append(this.element);
  }

  hide(): void {
    this.element.hidden = true;
  }

  /** `anchor` is in CSS pixels relative to the host element. */
  show(target: HoverTarget, anchorX: number, anchorY: number): void {
    const eventName = EVENT_TYPES[target.journey.e[target.index]!] ?? 'Position';
    const interpretation = interpretEvent(target.journey.e[target.index]!);
    const kind = target.kind === 'position' ? 'position' : target.kind;
    const heading = target.kind === 'position' ? SUBJECT_LABEL.position : MARKER_SPECS[target.kind].label;

    const counterparty =
      interpretation.counterparty === 'environment'
        ? 'storm'
        : interpretation.counterparty === 'bot'
          ? 'bot'
          : interpretation.counterparty === 'human'
            ? 'player'
            : '—';

    const rows: Array<[string, string]> = [
      ['player', `${shortId(target.journey.userId)}${target.journey.isBot ? ' (bot)' : ''}`],
      ['match', shortId(target.journey.matchId, 6, 4)],
      ['raw event', eventName],
    ];
    if (kind !== 'position') rows.push(['outcome', counterparty]);
    rows.push(['t', formatMs(target.t)]);
    rows.push(['x, z', `${Math.round(target.worldX)}, ${Math.round(target.worldZ)}`]);

    this.element.replaceChildren();
    this.element.append(document.createElement('b'));
    this.element.firstElementChild!.textContent = heading;

    const list = document.createElement('dl');
    for (const [key, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.append(dt, dd);
    }
    this.element.append(list);

    if (kind !== 'position') {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = interpretation.label;
      this.element.append(note);
    }

    this.element.hidden = false;

    // Flip to the other side of the cursor when close to the right/bottom edge.
    const box = this.element.getBoundingClientRect();
    const hostBox = this.host.getBoundingClientRect();
    let left = anchorX + 14;
    let top = anchorY + 14;
    if (left + box.width > hostBox.width - 8) left = anchorX - box.width - 14;
    if (top + box.height > hostBox.height - 8) top = anchorY - box.height - 14;
    this.element.style.left = `${Math.max(4, left)}px`;
    this.element.style.top = `${Math.max(4, top)}px`;
  }
}