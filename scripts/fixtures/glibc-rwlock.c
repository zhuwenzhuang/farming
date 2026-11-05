#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* Build on modern Linux too, but exercise the compatibility ABI rather than
 * accidentally requiring the builder's glibc 2.34 pthread/startup symbols. */
__asm__(".symver pthread_create,pthread_create@GLIBC_2.2.5");
__asm__(".symver pthread_join,pthread_join@GLIBC_2.2.5");
__asm__(".symver pthread_rwlock_trywrlock,pthread_rwlock_trywrlock@GLIBC_2.2.5");
__asm__(".symver pthread_rwlock_tryrdlock,pthread_rwlock_tryrdlock@GLIBC_2.2.5");
__asm__(".symver pthread_rwlock_wrlock,pthread_rwlock_wrlock@GLIBC_2.2.5");
__asm__(".symver pthread_rwlock_rdlock,pthread_rwlock_rdlock@GLIBC_2.2.5");
__asm__(".symver pthread_rwlock_unlock,pthread_rwlock_unlock@GLIBC_2.2.5");
__asm__(".symver pthread_rwlock_destroy,pthread_rwlock_destroy@GLIBC_2.2.5");
__asm__(".symver baseline_start,__libc_start_main@GLIBC_2.2.5");
extern int baseline_start(int (*main)(int, char **, char **), int argc,
                          char **argv, void (*init)(void), void (*fini)(void),
                          void (*rtld_fini)(void), void *stack_end);
int __wrap___libc_start_main(int (*main)(int, char **, char **), int argc,
                            char **argv, void (*init)(void), void (*fini)(void),
                            void (*rtld_fini)(void), void *stack_end) {
  return baseline_start(main, argc, argv, init, fini, rtld_fini, stack_end);
}

static pthread_rwlock_t lock = PTHREAD_RWLOCK_INITIALIZER;
static int stopping;

static void check(int result) {
  if (result) {
    fprintf(stderr, "pthread error=%d\n", result);
    exit(2);
  }
}

static void *worker(void *unused) {
  (void)unused;
  unsigned long iteration = 0;
  while (!__atomic_load_n(&stopping, __ATOMIC_RELAXED)) {
    int result;
    if (iteration++ % 8) {
      result = pthread_rwlock_trywrlock(&lock);
      if (result == EBUSY) result = pthread_rwlock_wrlock(&lock);
    } else {
      result = pthread_rwlock_tryrdlock(&lock);
      if (result == EBUSY) result = pthread_rwlock_rdlock(&lock);
    }
    check(result);
    check(pthread_rwlock_unlock(&lock));
  }
  return NULL;
}

int main(void) {
  pthread_t threads[32];
  for (unsigned i = 0; i < 32; ++i)
    check(pthread_create(&threads[i], NULL, worker, NULL));
  sleep(3);
  __atomic_store_n(&stopping, 1, __ATOMIC_RELAXED);
  for (unsigned i = 0; i < 32; ++i) check(pthread_join(threads[i], NULL));
  check(pthread_rwlock_destroy(&lock));
  puts("PASS: glibc rwlock contention completed and all threads joined");
  return 0;
}
