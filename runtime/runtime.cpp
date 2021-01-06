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

  T* get() {
    assure_loaded();
    return loaded;
  }

 private:
  const char* api;
  const char* libpath;
  const char* copypath;
  const char* lockfile;

  void* handle = nullptr;
  T* loaded = nullptr;

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
