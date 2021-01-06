export abstract class HotReloadProgram {
  abstract main(): Promise<number>;

  print(num: number): void {
    (document.querySelector(`#app`)! as HTMLElement).innerHTML = `${num}`;
  }

  async sleep_seconds(seconds: number): Promise<void> {
    return this.sleep_millis(seconds * 1000);
  };

  async sleep_millis(milli_seconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, milli_seconds);
    });
  }
}

export function hotreload(_target: any, _dummy_for_decorator: string): void{};
