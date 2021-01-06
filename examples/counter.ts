class Counter extends HotReloadProgram {
  @hotreload
  scale(a: number): number {
    return a * 1;
  }

  @hotreload
  shift(a: number): number {
    return a + 0;
  }

  main(): number {
    for (let i = 0;; ++i) {
      let n = this.shift(this.scale(i));
      this.print(n);
      this.sleep_seconds(1);
    }
  }
}
