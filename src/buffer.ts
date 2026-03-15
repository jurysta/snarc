/**
 * Tier 0: In-memory circular buffer for recent observations.
 * FIFO eviction, not persisted. Provides context window for SNARC scoring.
 */

export interface RawObservation {
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  cwd: string;
  ts: string;
  exitCode?: number;
}

export class CircularBuffer {
  private items: RawObservation[];
  private head = 0;
  private count = 0;

  constructor(private capacity = 50) {
    this.items = new Array(capacity);
  }

  push(item: RawObservation): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  getAll(): RawObservation[] {
    if (this.count === 0) return [];
    const result: RawObservation[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      result.push(this.items[(start + i) % this.capacity]);
    }
    return result;
  }

  getLast(n: number): RawObservation[] {
    const all = this.getAll();
    return all.slice(-n);
  }

  get lastToolName(): string | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.items[idx]?.toolName;
  }

  get size(): number {
    return this.count;
  }
}
