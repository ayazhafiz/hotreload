#include <dlfcn.h>
#include <stdio.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <chrono>
#include <fstream>
#include <iostream>
#include <thread>

template <typename... Args>
void die(const char* msg, Args... args) {
  fprintf(stderr, "Runtime Error: ");
  fprintf(stderr, msg, args...);
  fflush(stderr);
  exit(1);
}

void copy_file(const char* from, const char* to) {
  std::ifstream src(from, std::ios::binary);
  std::ofstream dest(to, std::ios::binary);
  dest << src.rdbuf();
}

template <typename T>
struct HotReload {
 public:
  HotReload(const char* api, const char* libpath, const char* copypath,
            const char* lockfile)
      : api(api), libpath(libpath), copypath(copypath), lockfile(lockfile) {}

  ~HotReload() { dlclose(handle); }

  T* get() {
    assure_loaded();
    return loaded;
  }

 private:
  /// The name of the function handle to load from the "hot-reloaded" shared
  /// object.
  const char* api;
  /// The path to the compiled shared library containing the function code.
  const char* libpath;
  /// The path at which to store/read the shared library.
  /// This differs from `libpath` because when `libpath` is being recompiled, we
  /// would like the program to still be able to use code in the shared library
  /// without blocking.
  const char* copypath;
  /// A lockfile that exists iff `libpath` is being compiled by the framework
  /// runtime.
  /// This prevents us from trying to update a stale function definition "too
  /// soon"; i.e. when `libpath` is modified, we should not try to use it until
  /// it is certainly compiled.
  const char* lockfile;

  /// A cached handle to the shared object containing our `api`.
  void* handle = nullptr;
  /// A cached pointer to the `api` we want to read from the shared object.
  T* loaded = nullptr;

  /// Last time we loaded the shared object. Used to track modifications (i.e.
  /// when we should reload) a shared object.
  time_t loadtime = 0;

  bool lockfile_exists() {
    struct stat lock;
    return stat(lockfile, &lock) == 0;
  }

  void assure_loaded() {
    struct stat lib;
    stat(libpath, &lib);
    if (loadtime != lib.st_mtime) {
      if (lockfile_exists()) {
        // Delay library loading until the lockfile is gone, meaning the library
        // has actually been successfully compiled.
        return;
      }

      if (handle != nullptr) {
        if (dlclose(handle)) {
          die("dlclose failed: %s\n", dlerror());
        }
        handle = nullptr;
      }

      copy_file(libpath, copypath);

      // RTLD_NOW:   bind all references immediately. The symbol in this shared
      //             object has been requested "right now" anyway, and there
      //             should only be one symbol per shared object.
      // RTLD_LOCAL: symbols in the shared object are accessible only by the
      //             handle returned by this call to `dlopen`.
      handle = dlopen(copypath, RTLD_NOW | RTLD_LOCAL);
      if (handle == nullptr) {
        die("dlopen failed: %s\n", dlerror());
      }
      loadtime = lib.st_mtime;

      dlerror();  // clear errors
      loaded = (T*)dlsym(handle, api);
      const char* err = dlerror();
      if (err != nullptr) {
        die("dlsym failed: %s\n", err);
      }
    }
  }
};

void print(int n) {
  std::cout << n << "\n";
  std::cout << std::flush;
}

void sleep_seconds(int n) {
  std::this_thread::sleep_for(std::chrono::seconds(n));
}

void sleep_millis(int n) {
  std::this_thread::sleep_for(std::chrono::milliseconds(n));
}
