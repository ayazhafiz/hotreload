class SimpleMath extends HotReloadProgram {
  @hotreload
  number_m(): number {
    return 10;
  }

  @hotreload
  number_n(): number {
    return 20;
  }

  @hotreload
  compute(a: number, b: number): number {
    return a + b;
  }

  computeMN(): number {
    let m = this.number_m();
    let n = this.number_n();
    return this.compute(m, n);
  }

  main(): number {
    while (true) {
      this.print(this.computeMN());
      this.sleep_seconds(1);
    }
  }
}
