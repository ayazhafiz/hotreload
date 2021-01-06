# hotreload

This is a small framework for program execution with support for [hot code reloading](https://en.wikipedia.org/wiki/Dynamic_software_updating).
There are two backends - one that compiles and runs machine code, and one that
runs JavaScript in a browser.

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Usage](#usage)
- [A summary of the framework language](#a-summary-of-the-framework-language)
- [The Native Backend and Runtime](#the-native-backend-and-runtime)
  - [Generated C++ code](#generated-c-code)
  - [Choosing a C++ compiler](#choosing-a-c-compiler)
- [The Browser Backend and Runtime](#the-browser-backend-and-runtime)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

Hot code reloading allows you to edit the source(s) of a software and view the
impact of your edits real-time in a running program. For development this is a
huge boon, as you get to see changes immediately without having to go through a
lengthy recompile or having to re-navigate to the state your program was in
before you made the edit. For examples, see the sections on backends below or
the [examples/](./examples) directory.

The framework provided by this repository is exploratory in nature, as a
demonstration of how you _could_ implement this in a production system.

The framework language is a DSL written in TypeScript. The framework supports
two backend/runtimes for hot-code reloading: a
[native backend and runtime](#the-native-backend-and-runtime) that compiles generated C++ code, and a
[browser backend and runtime](#the-brower-backend-and-runtime) that runs transpiled JS code.

## Usage

First, make sure you do `yarn install` or similar with your favorite package
manager.

`npm execute`/`yarn execute` (i.e. the `execute` script in the [`package.json`](./package.json))
is the entry point to the framework compiler/runtime execution of a program.
This must be run from the root of the repository! (At least until I fixup usage
of relative paths in the framework, which will probably never happen).

To run a single program, do `yarn execute <program.ts>`. For example, `yarn
execute examples/math.ts` runs [this example](./examples/math.ts).

By default, the native backend is targeted. Use `yarn execute --help` to see
other options.

## A summary of the framework language

The framework front-end is a DSL in the TypeScript programming language; an [example
program](./examples/math.ts) is

```typescript
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
```

A program file consists of a single TypeScript file with a single class that
extends from `HotReloadProgram`. The program entry point is the `main` function
of that class. Functions that are marked `@hotreload` will be watched for
changes by the runtime, and automatically be updated in the active state of the
program. See the below sections on runtimes and backends for information on how
this works.

The browser backend permits all valid TypeScript code; the native backend is
more constrained (see its section below for more details). The framework
"compiler" validates that the program is admissible into the runtime by linking
against the [runtime library](./runtime/runtime.d.ts); if you include that
library in your editor's `tsconfig.json` settings, your editor's TS language
service (if you have one) will be initialized in a manner that is cognizant of
the runtime definitions. The `tsconfig.json` in the [examples/](./examples)
directory is already set up to admit programs in this framework language; you
may wish to write sample programs directly in that directory.

## The Native Backend and Runtime

First, let's take a look at an example:

![Native backend demo](./examples/demo_native.gif)

So what's happening here? When targetting the native backend, the framework does
the following:

1. The input program is "compiled" (okay, it's pretty much just direct translation)
   to C++ code admissible by the [program C++ runtime](./runtime/runtime.cpp)
2. This generated C++ code is passed to the [framework native runtime](./src/runtime_native.ts)
   which
     - Allocates implementation, object, and lockfiles for functions annotated
       with `@hotreload`. These functions are compiled to shared objects and
       read lazily, on-demand by the [program C++ runtime](./runtime/runtime.cpp).
     - Constructs a total C++ program by prepending the program runtime to the
       generated C++ code.
     - Compiles the total C++ program to machine code.
     - Executes the total program machine code.
3. The [framework native runtime](./src/runtime_native.ts) now watches the input
   program for content changes. When a change to a `@hotreload` function is
   detected, the framework runtime rewrites the C++ implementation of that
   function and recompiles the shared object associated with that function.
     - Because this shared object is unique for each `@hotreload` function,
       recompilation is fast and does not affect the running state of the main
       program.
     - If there are any compilation errors, the framework runtime backs off,
       informs the user of errors, and continues as if nothing had changed.
4. The [program C++ runtime](./runtime/runtime.cpp) keeps track of modifications
   to the shared objects assocaited with `@hotreload` functions. Information on
   where these shared objects are and the functions they expose are populated
   during code generation by the framework runtime. When a `@hotreload` function
   is called by the running C++ program, the C++ runtime checks if there have
   been any changes to the associated shared object, reloads it as needed, and
   extracts the cached function handler for the call.
     - Lazy-loading of shared objects only on calls and caching of loaded
       function handlers prevents excessive work in the program runtime, and
       keeps the program's behavior closer to that of what it normally would be
       without a runtime overhead for hot code reloading.

Note that there is nothing very novel or tricky about this. Dynamic (runtime)
linking is a well-known idea, the basis for pretty much every plugin
architecture, and the reason `dlopen` and friends exist. The more interesting
part (in my opinion) is writting a framework and runtime that can naturally
translate annotations in a high-level language to dynamic loading/unloading of
libraries, for which we present one approach here.

### Generated C++ code

Although it is generally not exposed to the user, the generated C++ code can be
viewed before its compilation and execution by passing `--show-generated`.
Running the [math example](./examples/math.ts) with the native backend and this
flag gives

```cpp
INFO:  Generated C++ code:
INFO:  // /private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/5ccc37c4ec7e30fe4e18c9fe36295dd1.cpp
INFO:  extern "C" int number_m() {
INFO:    return 10;
INFO:  }
INFO:
INFO:  // /private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/720cc253b119b74bc39dc0a9b4c21007.cpp
INFO:  extern "C" int number_n() {
INFO:    return 20;
INFO:  }
INFO:
INFO:  // /private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/79a73fb38da3d020e4bbde2fcaa8b8bc.cpp
INFO:  extern "C" int compute(int a, int b) {
INFO:    return a + b;
INFO:  }
INFO:
INFO:  // /private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/45ceba1d316a84155975fbf424558ab1.cpp
INFO:  /* <runtime snipped> */
INFO:  HotReload<int()> number_m("number_m", "/private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/394cc1dd45c2719707b629dabb4a9ac0", "/private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/fe3f96cbb2bb7001db8a1c0e339761ff", "/private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/5190c93bd37b60f2e7b822b2bef65b01");
INFO:  HotReload<int()> number_n("number_n", "/private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/9719c1113773c87e22ea6dd4d9b50f20", "/private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/7549a105093b5a320ffee854bfc6e239", "/private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/7817dfddd98a73ac78ad033a443c4800");
INFO:  HotReload<int(int, int)> compute("compute", "/private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/24a8421326f62e3b845180931742fc17", "/private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/f2af23dd6e45eb90dd8b01c9a549937b", "/private/var/folders/_j/4xdvs8jj5qd6nsfk8wf6jy900000gn/T/1c9884880e691dac25282a3caa59b56c");
INFO:  int computeMN() {
INFO:    auto m = number_m.get()();
INFO:    auto n = number_n.get()();
INFO:    return compute.get()(m, n);
INFO:  }
INFO:  int main() {
INFO:    while (true) {
INFO:      print(computeMN());
INFO:      sleep_seconds(1);
INFO:    }
INFO:  }
```

As you can see, the code generation is very straightforward - it's mostly just
lifting functions out of the `Program` class and rewriting
`@hotreload`-annotated functions.

Because I don't want this project to be about TS->C++ translation, only a small
subset of the TS language can be translated to C++ (methods, while blocks,
expression statements, numbers, and function calls). The framework will issue
errors for things it doesn't know how to translate. If you want to add more
translation features, you can do so in the [`CppCodeGenerator` class in the
compiler](./src/compile.ts) -- it should be very straightforward.

### Choosing a C++ compiler

The framework reads the `CXX` environment variable to find the C++ compiler to
use. If this is unset, `c++` is used.

## The Browser Backend and Runtime

Not yet implemented.
