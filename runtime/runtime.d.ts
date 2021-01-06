/// <reference no-default-lib="true"/>

declare abstract class HotReloadProgram {
  abstract main(): number;
  print(num: number): void;
  sleep_seconds(seconds: number): void;
  sleep_millis(milli_seconds: number): void;
}

declare function hotreload(target: any, dummy_for_decorator: string): void;
