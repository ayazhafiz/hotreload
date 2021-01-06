import {hotreload, HotReloadProgram} from '../runtime/runtime';

class Counter extends HotReloadProgram {
  @hotreload
  scale(a: number): number {
    return a * 1;
  }

  @hotreload
  shift(a: number): number {
    return a + 0;
  }

  async main(): Promise<number> {
    for (let i = 0;; ++i) {
      let n = this.shift(this.scale(i));
      this.print(n);
      await this.sleep_seconds(1);
    }
  }
}
