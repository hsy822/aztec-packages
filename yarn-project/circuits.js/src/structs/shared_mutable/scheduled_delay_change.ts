import type { UInt32 } from '../shared.js';

export class ScheduledDelayChange {
  constructor(public previous: UInt32 | undefined, public blockOfChange: UInt32, public post: UInt32 | undefined) {}

  static empty() {
    return new this(undefined, 0, undefined);
  }

  isEmpty(): boolean {
    return this.previous === undefined && this.post === undefined && this.blockOfChange === 0;
  }
}
